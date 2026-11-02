import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { bookAndAccept, drive, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * Contract v0.8.0 settings flow (owner 2026-10-27): the country standard, server-stamped versions, country rules,
 * publish without a second admin, a booked trip keeps its rules, auto-offline after 10 Exclusive misses only.
 * Cases from contracts/fixtures/settings_flow.json where the fixture has them.
 */

const flow = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/settings_flow.json`, "utf8")) as {
  versions: Array<{ steps: Array<{ publish: "standard" | "own"; adminVersion: number; expect: number }> }>;
};

let sim: Sim;
let rider: Rider;
let a: Driver;
let owner: Admin;

beforeAll(async () => {
  sim = await Sim.start();
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
});

const sek = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
const ledger = (tripId: string) => sim.db.selectFrom("earnings_entries").select(["kind", "amount_minor"]).where("trip_id", "=", tripId).execute();

describe("country standard (§6.4)", () => {
  it("a zone without its own settings is served its country's standard, marked usesStandard, with the zone's id", async () => {
    const served = await rider.get("/rider/config?zoneId=Z001");
    expect(served.status).toBe(200);
    expect(served.body).toMatchObject({ zoneId: "Z001", country: "SE", currency: "SEK", usesStandard: true });
    const draft = await owner.get("/admin/config/pricing?zoneId=Z001");
    expect(draft.body).toMatchObject({ zoneId: "Z001", usesStandard: true, liveVersion: 0, document: { zoneId: "Z001" } });
    const standard = await owner.get("/admin/config/pricing?country=SE");
    expect(standard.body).toMatchObject({ country: "SE", document: { zoneId: "standard-SE", currency: "SEK" } });
    expect(standard.body).not.toHaveProperty("usesStandard");
  });

  it("the server stamps the versions; a zone's own document continues above the standard's and never uses it again", async () => {
    const zone = "Z003";
    const stream = await sim.stream(`/rider/config/stream?zoneId=${zone}`, rider.token);
    // The fixture starts from nothing; here the seed already published the standard once or more.
    const base = (await rider.get(`/rider/config?zoneId=${zone}`)).body["version"] as number;
    for (const step of flow.versions[0]!.steps) {
      await sim.publish(owner, "rider_app_config", step.publish === "standard" ? "SE" : zone, (doc) => ({ ...doc, version: step.adminVersion }));
      const served = (await rider.get(`/rider/config?zoneId=${zone}`)).body;
      expect(served.version, JSON.stringify(step)).toBe(base + step.expect);
    }
    const own = (await rider.get(`/rider/config?zoneId=${zone}`)).body;
    expect(own).not.toHaveProperty("usesStandard");
    // config_published reached the zone for every version it was served (the standard's while it used it).
    await stream.waitFor((e) => e.data["version"] === base + flow.versions[0]!.steps.at(-1)!.expect);
    expect((await owner.get(`/admin/config/rider_app_config?zoneId=${zone}`)).body["usesStandard"]).toBe(false);
  });

  it("names exactly one of zoneId or country; a zone admin cannot set another country", async () => {
    expect((await owner.get("/admin/config/pricing")).body).toMatchObject({ code: "invalid_request", reason: "scope_required" });
    expect((await owner.get("/admin/config/pricing?zoneId=Z001&country=SE")).body).toMatchObject({ reason: "scope_required" });
    expect((await owner.get("/admin/config/pricing?country=DE")).body).toMatchObject({ reason: "country_not_found" });
    // Owner 2026-10-27: any admin of the country with the right edits its standard; an admin of another country does not.
    const local = await sim.admin("config", ["Z001"]);
    expect((await local.get("/admin/config/pricing?country=SE")).status).toBe(200);
    const paris = await sim.admin("config", ["FR-PC"]);
    expect((await paris.get("/admin/config/pricing?country=SE")).body).toMatchObject({ code: "forbidden", reason: "zone_out_of_scope" });
  });

  it("Go back to Standard: the zone uses the standard again, above its last own version; its own versions stay in the history", async () => {
    const zone = "Z004";
    const ownPub = await sim.publish(owner, "dispatch", zone, (doc) => ({ ...doc, radar: { ...doc["radar"], seconds: 40 } }));
    await sim.publish(owner, "dispatch", zone, (doc) => doc);
    const draft = (await owner.get(`/admin/config/dispatch?zoneId=${zone}`)).body;
    expect(draft["usesStandard"]).toBe(false);
    const viewer = await sim.admin("viewer");
    expect((await viewer.post("/admin/config/dispatch/use-standard", { zoneId: zone, expectedVersion: draft["version"] })).body).toMatchObject({ reason: "missing_permission" });
    expect((await owner.post("/admin/config/dispatch/use-standard", { zoneId: zone, expectedVersion: draft["version"] + 5 })).body).toMatchObject({ code: "version_mismatch" });
    const back = await owner.post("/admin/config/dispatch/use-standard", { zoneId: zone, expectedVersion: draft["version"] });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body["version"]).toBe(ownPub["version"] + 2);
    const after = (await owner.get(`/admin/config/dispatch?zoneId=${zone}`)).body;
    expect(after).toMatchObject({ usesStandard: true, liveVersion: 0, document: { radar: { seconds: 15 } } });
    const history = await sim.db.selectFrom("config_history").select("version").where("doc", "=", "dispatch").where("zone_id", "=", zone).execute();
    expect(history.map((h) => h.version).sort()).toEqual([ownPub["version"], ownPub["version"] + 1]);
    expect((await owner.post("/admin/config/dispatch/use-standard", { zoneId: zone, expectedVersion: 1 })).body).toMatchObject({ reason: "already_standard" });
    // v0.8.1: tips and limits have a standard too; a zone without its own has nothing to go back from.
    expect((await owner.post("/admin/config/country_rules/use-standard", { zoneId: zone, expectedVersion: 1 })).body).toMatchObject({ reason: "already_standard" });
  });
});

describe("country rules (§6.5)", () => {
  it("tips, raise steps and driver bonus limits are set once per country and reach every app document of it", async () => {
    const tips = [{ amount: sek(500), enabled: true }, { amount: sek(1500), enabled: true }];
    const raiseSteps = [{ amount: sek(2500), enabled: true }];
    const driverBonus = { defaultLimit: sek(15000), hardMax: sek(80000) };
    const first = { version: 1, publishedAt: sim.clock.now.toISOString(), country: "SE", currency: "SEK", tips, raiseSteps, driverBonus };
    const before = (await rider.get("/rider/config?zoneId=Z003")).body;
    // Deep fix 2026-11-02: the sample settings already seed the country rules (no 404); the admin changes them.
    await sim.publish(owner, "country_rules", "SE", (doc) => ({ ...doc, tips, raiseSteps, driverBonus }), first);
    const zoneOwn = (await rider.get("/rider/config?zoneId=Z003")).body;
    expect(zoneOwn).toMatchObject({ tips, raiseSteps, version: before.version + 1 });
    expect((await rider.get("/rider/config?zoneId=Z001")).body).toMatchObject({ tips, raiseSteps, usesStandard: true });
    expect((await a.get("/driver/config?zoneId=Z001")).body).toMatchObject({ driverBonus });
    // A zone document saved later keeps the country's values, whatever the admin sent.
    await sim.publish(owner, "rider_app_config", "Z003", (doc) => ({ ...doc, tips: [{ amount: sek(9900), enabled: true }] }));
    expect((await rider.get("/rider/config?zoneId=Z003")).body.tips).toEqual(tips);
  });

  it("v0.8.1 (owner 2026-10-28): a zone's own tips and limits reach only that zone; the standard's the zones without their own; Go back to Standard", async () => {
    const own = { tips: [{ amount: sek(700), enabled: true }], raiseSteps: [{ amount: sek(3000), enabled: true }], driverBonus: { defaultLimit: sek(12000), hardMax: sek(70000) } };
    const zBefore = (await rider.get("/rider/config?zoneId=Z006")).body;
    expect(zBefore.usesStandard).toBe(true);
    const draft = await owner.get("/admin/config/country_rules?zoneId=Z006");
    expect(draft.body).toMatchObject({ zoneId: "Z006", usesStandard: true, document: { country: "SE" } });
    expect(draft.body.document).not.toHaveProperty("zoneId");
    await sim.publish(owner, "country_rules", "Z006", (doc) => ({ ...doc, ...own }));
    // Z006 was on the standard app documents: it now has its own, with its own tips, at a higher version.
    const z1 = (await rider.get("/rider/config?zoneId=Z006")).body;
    expect(z1).toMatchObject({ tips: own.tips, raiseSteps: own.raiseSteps });
    expect(z1).not.toHaveProperty("usesStandard");
    expect(z1.version).toBeGreaterThan(zBefore.version);
    expect((await a.get("/driver/config?zoneId=Z006")).body).toMatchObject({ driverBonus: own.driverBonus });
    // Other zones keep the standard's.
    const standardTips = (await owner.get("/admin/config/country_rules?country=SE")).body.document.tips;
    expect((await rider.get("/rider/config?zoneId=Z003")).body.tips).toEqual(standardTips);
    expect((await rider.get("/rider/config?zoneId=Z005")).body.tips).toEqual(standardTips);
    // A new standard reaches the zones without their own rules, never Z006.
    const newStandard = [{ amount: sek(1000), enabled: true }];
    await sim.publish(owner, "country_rules", "SE", (doc) => ({ ...doc, tips: newStandard }));
    expect((await rider.get("/rider/config?zoneId=Z003")).body.tips).toEqual(newStandard);
    expect((await rider.get("/rider/config?zoneId=Z005")).body.tips).toEqual(newStandard);
    expect((await rider.get("/rider/config?zoneId=Z006")).body.tips).toEqual(own.tips);
    // Z006's app documents saved later keep Z006's rules.
    await sim.publish(owner, "rider_app_config", "Z006", (doc) => ({ ...doc, tips: [{ amount: sek(9900), enabled: true }] }));
    expect((await rider.get("/rider/config?zoneId=Z006")).body.tips).toEqual(own.tips);
    // Go back to Standard: Z006 takes the standard's tips again.
    const zoneDraft = (await owner.get("/admin/config/country_rules?zoneId=Z006")).body;
    expect(zoneDraft.usesStandard).toBe(false);
    const back = await owner.post("/admin/config/country_rules/use-standard", { zoneId: "Z006", expectedVersion: zoneDraft.version });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await rider.get("/rider/config?zoneId=Z006")).body.tips).toEqual(newStandard);
    expect((await owner.get("/admin/config/country_rules?zoneId=Z006")).body.usesStandard).toBe(true);
  });
});

describe("booked trips keep their rules (§6.6)", () => {
  it("a no-show after a later publish charges the booking-time fee and share", async () => {
    const { tripId, driver } = await bookAndAccept(sim, rider, a);
    await sim.publish(owner, "pricing", "SE", (doc) => {
      const economy = doc["categories"]["economy"];
      return { ...doc, categories: { ...doc["categories"], economy: { ...economy, waiting: { ...economy.waiting, noShowFee: sek(9900) } } } };
    });
    await sim.publish(owner, "driver_app_config", "SE", (doc: Json) => ({ ...doc, waiting: { ...doc["waiting"], driverSharePct: 40 }, cancelFees: { ...doc["cancelFees"], driverSharePct: 50 } }));
    await drive(driver, tripId, "arrived");
    await sim.advance(5 * 60 + 1);
    const res = await driver.command(tripId, "no-show", { reasonCode: "rider_no_show" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "no_show", cancellation: { fee: sek(6500) } });
    expect(await ledger(tripId)).toEqual([{ kind: "fee_share", amount_minor: "5200" }]);
    // A trip booked now gets the new rules.
    const next = await bookAndAccept(sim, rider, a);
    await drive(next.driver, next.tripId, "arrived");
    await sim.advance(5 * 60 + 1);
    const later = await next.driver.command(next.tripId, "no-show", { reasonCode: "rider_no_show" });
    expect(later.body).toMatchObject({ cancellation: { fee: sek(9900) } });
    expect(await ledger(next.tripId)).toEqual([{ kind: "fee_share", amount_minor: "3960" }]);
  });
});

describe("auto-offline (§6.7)", () => {
  const missExclusive = async () => {
    const { tripId } = await rider.book();
    await sim.tick();
    const offer = await a.offerFor(tripId);
    expect(offer?.["kind"]).toBe("exclusive");
    const res = await a.decline(offer!);
    await rider.command(tripId, "cancel", { reasonCode: "plans_changed" });
    return res;
  };
  const force = async (mode: "radar" | "exclusive") => {
    const control = (await owner.get("/admin/zones/Z001/dispatch-control")).body;
    const res = await owner.put("/admin/zones/Z001/dispatch-control", { expectedVersion: control["version"] ?? 0, paused: false, mode });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };

  it("10 declined Exclusive offers in a row take the driver offline; a declined Radar offer in between does not count", async () => {
    await a.moveTo(PLACES.nearSergels);
    if ((await a.get("/driver/profile")).body["onlineStatus"] !== "online") await a.goOnline(PLACES.nearSergels);
    const feed = await a.offerFeed();
    await force("exclusive");
    for (let i = 0; i < 9; i++) await missExclusive();
    await force("radar");
    const radar = await rider.book();
    await sim.tick();
    const radarOffer = await a.offerFor(radar.tripId);
    expect(radarOffer?.["kind"]).toBe("radar");
    await a.decline(radarOffer!);
    await rider.command(radar.tripId, "cancel", { reasonCode: "plans_changed" });
    expect((await a.get("/driver/profile")).body["onlineStatus"]).toBe("online");
    await force("exclusive");
    await missExclusive();
    expect((await a.get("/driver/profile")).body["onlineStatus"]).toBe("offline");
    const last = await feed.waitFor((e) => e.data["driverOffline"] === true);
    expect(last.data).toMatchObject({ kind: "offer_updated", offer: { kind: "exclusive", status: "declined" } });
  });

  it("any accepted offer, also Radar, sets the count back to 0", async () => {
    await sim.advance(1);
    await a.goOnline(PLACES.nearSergels);
    await force("exclusive");
    for (let i = 0; i < 9; i++) await missExclusive();
    await force("radar");
    const radar = await rider.book();
    await sim.tick();
    const offer = await a.offerFor(radar.tripId);
    expect((await a.accept(offer!)).status).toBe(200);
    await rider.command(radar.tripId, "cancel", { reasonCode: "plans_changed" });
    await sim.advance(1);
    await force("exclusive");
    await missExclusive();
    expect((await a.get("/driver/profile")).body["onlineStatus"]).toBe("online");
  });

  it("going online starts the run again", async () => {
    await sim.advance(1);
    await a.goOnline(PLACES.nearSergels);
    await missExclusive();
    expect((await a.get("/driver/profile")).body["onlineStatus"]).toBe("online");
  });
});
