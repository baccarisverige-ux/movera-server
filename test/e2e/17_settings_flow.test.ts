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

  it("names exactly one of zoneId or country; country_rules is per country only; a zone admin cannot set a country", async () => {
    expect((await owner.get("/admin/config/pricing")).body).toMatchObject({ code: "invalid_request", reason: "scope_required" });
    expect((await owner.get("/admin/config/pricing?zoneId=Z001&country=SE")).body).toMatchObject({ reason: "scope_required" });
    expect((await owner.get("/admin/config/country_rules?zoneId=Z001")).body).toMatchObject({ reason: "country_only" });
    expect((await owner.get("/admin/config/pricing?country=DE")).body).toMatchObject({ reason: "country_not_found" });
    const local = await sim.admin("config", ["Z001"]);
    expect((await local.get("/admin/config/pricing?country=SE")).body).toMatchObject({ code: "forbidden", reason: "zone_out_of_scope" });
  });
});

describe("country rules (§6.5)", () => {
  it("tips, raise steps and driver bonus limits are set once per country and reach every app document of it", async () => {
    const tips = [{ amount: sek(500), enabled: true }, { amount: sek(1500), enabled: true }];
    const raiseSteps = [{ amount: sek(2500), enabled: true }];
    const driverBonus = { defaultLimit: sek(15000), hardMax: sek(80000) };
    const first = { version: 1, publishedAt: sim.clock.now.toISOString(), country: "SE", currency: "SEK", tips, raiseSteps, driverBonus };
    const before = (await rider.get("/rider/config?zoneId=Z003")).body;
    await sim.publish(owner, "country_rules", "SE", (doc) => doc, first);
    const zoneOwn = (await rider.get("/rider/config?zoneId=Z003")).body;
    expect(zoneOwn).toMatchObject({ tips, raiseSteps, version: before.version + 1 });
    expect((await rider.get("/rider/config?zoneId=Z001")).body).toMatchObject({ tips, raiseSteps, usesStandard: true });
    expect((await a.get("/driver/config?zoneId=Z001")).body).toMatchObject({ driverBonus });
    // A zone document saved later keeps the country's values, whatever the admin sent.
    await sim.publish(owner, "rider_app_config", "Z003", (doc) => ({ ...doc, tips: [{ amount: sek(9900), enabled: true }] }));
    expect((await rider.get("/rider/config?zoneId=Z003")).body.tips).toEqual(tips);
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

  it("10 declined Exclusive offers in a row take the driver offline; Radar in between neither counts nor breaks the run", async () => {
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

  it("going online starts the run again", async () => {
    await sim.advance(1);
    await a.goOnline(PLACES.nearSergels);
    await missExclusive();
    expect((await a.get("/driver/profile")).body["onlineStatus"]).toBe("online");
  });
});
