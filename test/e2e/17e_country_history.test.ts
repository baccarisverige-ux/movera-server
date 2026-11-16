import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sim, type Admin, type Json, type Rider } from "./harness.js";

/**
 * Live 2026-11-16 (Rules audits/impact/country-undo.md): History and Restore / Undo last publish answered 404 "No such
 * zone" for a country's standard (standard-<CC>), so a Tips & limits publish for a country could not be read back or
 * undone. They take the same scope as GET / PUT / publish: exactly one of zoneId or country.
 */

let sim: Sim;
let owner: Admin;
let rider: Rider;

beforeAll(async () => {
  sim = await Sim.start();
  owner = await sim.owner();
  rider = await sim.rider(0);
});
afterAll(async () => {
  await sim.stop();
});

const sek = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
const items = async (query: string) => {
  const page = await owner.get(`/admin/config/country_rules/history?${query}`);
  expect(page.status, JSON.stringify(page.body)).toBe(200);
  return page.body["items"] as Json[];
};

describe("History and Restore of a country's standard documents", () => {
  it("History lists the country's published versions, newest first, with the document of each", async () => {
    const before = await items("country=SE");
    expect(before.length).toBeGreaterThan(0);
    const limits = { savedPlacesPerPerson: 20, emergencyContactsPerPerson: 21 };
    const published = await sim.publish(owner, "country_rules", "SE", (doc) => ({ ...doc, limits }));
    const after = await items("country=SE&limit=2");
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ doc: "country_rules", country: "SE", version: published["version"], action: "publish", document: { limits } });
    expect(after[0]).not.toHaveProperty("zoneId");
    expect(after[1]).toMatchObject({ country: "SE", version: before[0]!["version"] });
    expect(after[1]!["document"]).toEqual(before[0]!["document"]);
    // The older page continues from the cursor.
    const page = await owner.get("/admin/config/country_rules/history?country=SE&limit=1");
    expect(page.body["nextCursor"]).toBe(String(published["version"]));
  });

  it("Undo last publish: the country's earlier version is live again as the next version, and its zones get it", async () => {
    const tips = [{ amount: sek(700), enabled: true }];
    const changed = await sim.publish(owner, "country_rules", "SE", (doc) => ({ ...doc, tips }));
    expect((await rider.get("/rider/config?zoneId=Z001")).body.tips).toEqual(tips);
    const [latest, previous] = await items("country=SE&limit=2");
    expect(latest!["version"]).toBe(changed["version"]);

    const undone = await owner.post("/admin/config/country_rules/restore", { country: "SE", version: previous!["version"], expectedVersion: latest!["version"] });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(undone.body).toMatchObject({ doc: "country_rules", country: "SE", version: latest!["version"] + 1, restoredFrom: previous!["version"] });

    const [now] = await items("country=SE&limit=1");
    expect(now).toMatchObject({ action: "restore", restoredFrom: previous!["version"], version: latest!["version"] + 1 });
    const strip = (doc: Json) => ({ ...doc, version: 0, publishedAt: "" });
    expect(strip(now!["document"])).toEqual(strip(previous!["document"]));
    const draft = (await owner.get("/admin/config/country_rules?country=SE")).body;
    expect(draft).toMatchObject({ liveVersion: latest!["version"] + 1 });
    expect(strip(draft.document)).toEqual(strip(previous!["document"]));
    // Every effect of a publish: the zones that use the standard are served the earlier tips again.
    expect((await rider.get("/rider/config?zoneId=Z001")).body.tips).toEqual(previous!["document"]["tips"]);
    // One audit line for the restore, on the country's scope.
    const line = await sim.db.selectFrom("admin_audit").select(["zone_id", "detail"]).where("action", "=", "config.publish").where("target_id", "=", "country_rules").orderBy("audit_id", "desc").executeTakeFirstOrThrow();
    expect(line).toMatchObject({ zone_id: "standard-SE", detail: { restoredFrom: previous!["version"] } });

    expect((await owner.post("/admin/config/country_rules/restore", { country: "SE", version: now!["version"], expectedVersion: now!["version"] })).body).toMatchObject({ reason: "already_live" });
    expect((await owner.post("/admin/config/country_rules/restore", { country: "SE", version: 9999, expectedVersion: now!["version"] })).body).toMatchObject({ reason: "version_not_found" });
    expect((await owner.post("/admin/config/country_rules/restore", { country: "SE", version: previous!["version"], expectedVersion: latest!["version"] })).body).toMatchObject({ code: "version_mismatch" });
  });

  it("the other country documents too (pricing), and a zone's own history is as before", async () => {
    const before = (await owner.get("/admin/config/pricing/history?country=SE&limit=1")).body["items"] as Json[];
    expect(before).toHaveLength(1);
    await sim.publish(owner, "pricing", "SE", (doc) => ({ ...doc }));
    const [latest, previous] = (await owner.get("/admin/config/pricing/history?country=SE&limit=2")).body["items"] as Json[];
    expect(previous!["version"]).toBe(before[0]!["version"]);
    const undone = await owner.post("/admin/config/pricing/restore", { country: "SE", version: previous!["version"], expectedVersion: latest!["version"] });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(undone.body).toMatchObject({ country: "SE", restoredFrom: previous!["version"] });

    await sim.publish(owner, "country_rules", "Z006", (doc) => ({ ...doc, tips: [{ amount: sek(900), enabled: true }] }));
    const zone = await items("zoneId=Z006");
    expect(zone[0]).toMatchObject({ zoneId: "Z006", action: "publish" });
    expect(zone[0]).not.toHaveProperty("country");
  });

  it("names exactly one of zoneId or country; an unknown zone or country is 404; another country's admin is refused", async () => {
    expect((await owner.get("/admin/config/country_rules/history")).body).toMatchObject({ code: "invalid_request", reason: "scope_required" });
    expect((await owner.get("/admin/config/country_rules/history?zoneId=Z001&country=SE")).body).toMatchObject({ reason: "scope_required" });
    expect((await owner.post("/admin/config/country_rules/restore", { version: 1, expectedVersion: 2 })).body).toMatchObject({ reason: "scope_required" });
    expect((await owner.get("/admin/config/country_rules/history?country=DE")).body).toMatchObject({ code: "not_found", reason: "country_not_found" });
    expect((await owner.get("/admin/config/country_rules/history?zoneId=NOPE")).body).toMatchObject({ code: "not_found", reason: "zone_not_found" });
    expect((await owner.post("/admin/config/country_rules/restore", { country: "DE", version: 1, expectedVersion: 2 })).body).toMatchObject({ reason: "country_not_found" });
    // The onboarding settings exist per country only.
    expect((await owner.get("/admin/config/onboarding/history?zoneId=Z001")).body).toMatchObject({ reason: "scope_country_only" });
    expect((await owner.get("/admin/config/onboarding/history?country=SE")).status).toBe(200);

    const local = await sim.admin("config", ["Z001"]);
    expect((await local.get("/admin/config/country_rules/history?country=SE")).status).toBe(200);
    const paris = await sim.admin("config", ["FR-PC"]);
    expect((await paris.get("/admin/config/country_rules/history?country=SE")).body).toMatchObject({ code: "forbidden", reason: "zone_out_of_scope" });
    const [latest, previous] = await items("country=SE&limit=2");
    expect((await paris.post("/admin/config/country_rules/restore", { country: "SE", version: previous!["version"], expectedVersion: latest!["version"] })).body).toMatchObject({ code: "forbidden" });
  });
});
