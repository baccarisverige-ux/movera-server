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

  /**
   * The admin's "Undo last Tips & limits save" (admin webapp/src/live/tipsUndo.ts). One save publishes the country's
   * country_rules and then its rider_app_config, each with the save's id as the publish note. Undo finds them by that
   * note in History and restores the rider document first, then country_rules (whose restore writes the tips into the
   * rider document again), each with `country`.
   */
  it("a Tips & limits save is found again by its note, and undone in the admin's order (rider document, then the rules)", async () => {
    const note = "Tips & limits save 2026-11-16T05:18:42Z/k3x9aa";
    const publishWith = async (doc: "country_rules" | "rider_app_config", change: (document: Json) => Json) => {
      const draft = (await owner.get(`/admin/config/${doc}?country=SE`)).body;
      const put = await owner.put(`/admin/config/${doc}`, { expectedVersion: draft["version"], country: "SE", document: change(structuredClone(draft["document"])) });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      const published = await owner.post(`/admin/config/${doc}/publish`, { expectedVersion: put.body["version"], country: "SE", note });
      expect(published.status, JSON.stringify(published.body)).toBe(200);
      return published.body["version"] as number;
    };
    const history = async (doc: string) => (await owner.get(`/admin/config/${doc}/history?country=SE&limit=10`)).body["items"] as Json[];
    const strip = (doc: Json) => ({ ...doc, version: 0, publishedAt: "" });
    const rulesBefore = (await history("country_rules"))[0]!;
    const riderBefore = (await history("rider_app_config"))[0]!;

    const tips = [{ amount: sek(1300), enabled: true }];
    const rulesVersion = await publishWith("country_rules", (doc) => ({ ...doc, tips }));
    const riderVersion = await publishWith("rider_app_config", (doc) => ({ ...doc, tipRules: { ...doc["tipRules"], customAmount: !doc["tipRules"]?.customAmount } }));

    // History says which documents the save published together, and what was live before each.
    const rules = await history("country_rules");
    const riderDoc = await history("rider_app_config");
    expect(rules[0]).toMatchObject({ version: rulesVersion, note });
    expect(riderDoc[0]).toMatchObject({ version: riderVersion, note });
    // The rules publish wrote the new tips into the rider document as a version of its own, below the save's.
    expect(riderDoc[1]!["note"]).toMatch(/^tips and limits v/);
    expect(riderDoc[1]!["document"]["tips"]).toEqual(tips);

    const undo = "Undo Tips & limits save 2026-11-16T05:18:42Z/k3x9aa";
    const rider1 = await owner.post("/admin/config/rider_app_config/restore", { country: "SE", version: riderDoc[1]!["version"], expectedVersion: riderVersion, note: undo });
    expect(rider1.status, JSON.stringify(rider1.body)).toBe(200);
    const rules1 = await owner.post("/admin/config/country_rules/restore", { country: "SE", version: rules[1]!["version"], expectedVersion: rulesVersion, note: undo });
    expect(rules1.status, JSON.stringify(rules1.body)).toBe(200);

    expect(strip((await history("country_rules"))[0]!["document"])).toEqual(strip(rulesBefore["document"]));
    const riderNow = (await history("rider_app_config"))[0]!;
    expect(strip(riderNow["document"])).toEqual(strip(riderBefore["document"]));
    expect((await rider.get("/rider/config?zoneId=Z001")).body.tips).toEqual(rulesBefore["document"]["tips"]);
    // The restores carry the undo's note, not a save id: the same save is not offered as undoable twice.
    expect((await history("country_rules"))[0]).toMatchObject({ action: "restore", note: undo });
  });

  /**
   * Owner Q-SCS-2 (2026-11-16 20:06 UTC, "No, keep current (Rec.)"; Rules audits/impact/safe-config-saves.md): Undo /
   * History Restore of a country's Tips & limits brings back the old tips and limits only. The payout mode, the payout
   * day and time and the debt limits stay as they are now (they are changed in Finance › Payouts settings only).
   */
  it("Restore of country_rules keeps the current payout mode, payout schedule and debt limits (MONEY, Q-SCS-2)", async () => {
    const oldTips = [{ amount: sek(1100), enabled: true }];
    const old = await sim.publish(owner, "country_rules", "SE", (doc) => {
      const next: Json = { ...doc, tips: oldTips, payoutMode: "manual", payoutSchedule: { frequency: "weekly", day: "monday", time: "08:00" }, maxRiderDebt: sek(30000), driverOwesLimit: { enabled: false, max: null } };
      return next;
    });
    const nowSchedule = { frequency: "every_2_weeks", day: "friday", time: "16:30" };
    const live = await sim.publish(owner, "country_rules", "SE", (doc) => {
      const next: Json = { ...doc, tips: [{ amount: sek(1200), enabled: true }], payoutMode: "automatic", payoutSchedule: nowSchedule, maxRiderDebt: sek(50000) };
      delete next["driverOwesLimit"];
      return next;
    }, undefined, ["driverOwesLimit"]);
    const undone = await owner.post("/admin/config/country_rules/restore", { country: "SE", version: old["version"], expectedVersion: live["version"] });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    const [now] = await items("country=SE&limit=1");
    const document = now!["document"] as Json;
    expect(document["tips"]).toEqual(oldTips);
    expect(document["payoutMode"]).toBe("automatic");
    expect(document["payoutSchedule"]).toEqual(nowSchedule);
    expect(document["maxRiderDebt"]).toEqual(sek(50000));
    expect(document).not.toHaveProperty("driverOwesLimit");
    const draft = (await owner.get("/admin/config/country_rules?country=SE")).body;
    expect(draft.document["payoutMode"]).toBe("automatic");
    expect(draft.document["maxRiderDebt"]).toEqual(sek(50000));
  });

  /**
   * v0.18.123 guard x Q-SCS-2: a payout / debt key the live document lacks but the unpublished draft still has must not
   * come back through Restore (the guard would copy it from the draft unless Restore names it in removeKeys).
   */
  it("Restore does not bring back a payout / debt key that only the unpublished draft has (MONEY, Q-SCS-2 x kept keys)", async () => {
    const old = await sim.publish(owner, "country_rules", "SE", (doc) => ({ ...doc, tips: [{ amount: sek(1300), enabled: true }], driverOwesLimit: { enabled: true, max: sek(90000) } }));
    const live = await sim.publish(owner, "country_rules", "SE", (doc) => {
      const next: Json = { ...doc, tips: [{ amount: sek(1400), enabled: true }] };
      delete next["driverOwesLimit"];
      return next;
    }, undefined, ["driverOwesLimit"]);
    expect(live["document"] ?? (await items("country=SE&limit=1"))[0]!["document"]).not.toHaveProperty("driverOwesLimit");
    // An unpublished draft that sets a debt limit again (not published).
    const draft = (await owner.get("/admin/config/country_rules?country=SE")).body;
    const saved = await owner.put("/admin/config/country_rules", { expectedVersion: draft["version"], country: "SE", document: { ...draft["document"], driverOwesLimit: { enabled: true, max: sek(70000) } } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const undone = await owner.post("/admin/config/country_rules/restore", { country: "SE", version: old["version"], expectedVersion: live["version"] });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    const [now] = await items("country=SE&limit=1");
    expect(now!["document"]).not.toHaveProperty("driverOwesLimit");
    expect((now!["document"] as Json)["tips"]).toEqual([{ amount: sek(1300), enabled: true }]);
  });

  /** Owner 2026-11-17: Undo / Restore keeps the current call settings (calls.adminCallRoles, calls.phoneProvider), like Q-SCS-2. */
  it("Restore keeps the current call roles and phone provider; the rest of calls is restored", async () => {
    const old = await sim.publish(owner, "country_rules", "SE", (doc) => ({ ...doc, tips: [{ amount: sek(1500), enabled: true }], calls: { ...((doc["calls"] as Json) ?? {}), on: false, adminCallRoles: ["super"], phoneProvider: "none" } }));
    const live = await sim.publish(owner, "country_rules", "SE", (doc) => ({ ...doc, tips: [{ amount: sek(1600), enabled: true }], calls: { ...((doc["calls"] as Json) ?? {}), on: true, adminCallRoles: ["super", "ops"], phoneProvider: "twilio" } }));
    const undone = await owner.post("/admin/config/country_rules/restore", { country: "SE", version: old["version"], expectedVersion: live["version"] });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    const [now] = await items("country=SE&limit=1");
    const calls = (now!["document"] as Json)["calls"] as Json;
    expect(calls["adminCallRoles"]).toEqual(["super", "ops"]);
    expect(calls["phoneProvider"]).toBe("twilio");
    expect(calls["on"]).toBe(false);
    expect((now!["document"] as Json)["tips"]).toEqual([{ amount: sek(1500), enabled: true }]);
  });

  /** v0.18.133 review M1 (pricingHistory.restoreKeeps): Restore keeps today's CountryRules.payoutLinesOn. */
  it("Restore keeps the current payout lines switch (MONEY, v0.18.133)", async () => {
    const old = await sim.publish(owner, "country_rules", "SE", (doc) => ({ ...doc, tips: [{ amount: sek(1700), enabled: true }], payoutLinesOn: false }));
    const live = await sim.publish(owner, "country_rules", "SE", (doc) => ({ ...doc, tips: [{ amount: sek(1800), enabled: true }], payoutLinesOn: true }));
    const undone = await owner.post("/admin/config/country_rules/restore", { country: "SE", version: old["version"], expectedVersion: live["version"] });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    const [now] = await items("country=SE&limit=1");
    expect((now!["document"] as Json)["payoutLinesOn"]).toBe(true);
    expect((now!["document"] as Json)["tips"]).toEqual([{ amount: sek(1700), enabled: true }]);
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
