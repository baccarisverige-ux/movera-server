import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR, contract } from "../../src/contract/contract.js";
import { KEPT_KEYS } from "../../src/config/keptKeys.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, testWorld } from "../support/world.js";

/**
 * v0.18.123 SF-F1-3 (owner Q-SCS-1 "Keep values, save rest (Rec.)", contract.json#configDocs.keptKeys) and job 6
 * (alertDesk.commands.settingsKeepKinds). Rule 36: fails on main — a stale tab's PUT that leaves out the payout and debt
 * settings, the call roles or reaskAfterSeconds wipes them; an alert settings save drops a kind it does not know.
 */
let database: TestDatabase;
let app: FastifyInstance;
let admin: Record<string, string>;
const clock = { now: new Date("2026-11-17T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const base = () => {
  const r = sample("rider_app_config"), d = sample("driver_app_config");
  return { version: 1, publishedAt: clock.now.toISOString(), country: "SE", currency: "SEK", tips: r.tips ?? [], raiseSteps: r.raiseSteps ?? [], driverBonus: d.driverBonus ?? {} };
};
const money = {
  payoutMode: "manual",
  payoutSchedule: { frequency: "every_2_weeks", day: "friday", time: "09:30" },
  maxRiderDebt: { amountMinor: 45000, currency: "SEK" },
  driverOwesLimit: { enabled: true, max: { amountMinor: 200000, currency: "SEK" } },
};
const calls = { on: true, adminCallRoles: ["super", "ops"], phoneProvider: "twilio" };
const put = (doc: string, body: Record<string, unknown>) => call(app, "PUT", `/admin/config/${doc}`, admin, body);
const get = async (doc: string, scope: string) => (await call(app, "GET", `/admin/config/${doc}?${scope}`, admin)).json();
const lastAudit = async (action: string) =>
  (await database.db.selectFrom("admin_audit").select("detail").where("action", "=", action).orderBy("audit_id", "desc").limit(1).executeTakeFirstOrThrow()).detail as Record<string, unknown>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("kept keys of a config save (v0.18.123, SF-F1-3)", () => {
  it("the server's list is the contract's list", () => {
    const kk = (contract as unknown as { configDocs: { keptKeys: Record<string, unknown> } }).configDocs.keptKeys;
    expect(KEPT_KEYS).toEqual({ country_rules: kk["country_rules"], dispatch: kk["dispatch"] });
  });

  it("an old tab's country_rules save keeps payout mode, schedule, debt limits and call settings; the answer and the audit say so", async () => {
    const first = await put("country_rules", { expectedVersion: 1, country: "SE", document: { ...base(), ...money, calls } });
    expect(first.statusCode).toBe(200);
    // The pre-F1 / pre-U2 bundle: rebuilds the document without the payout keys and with its own calls block.
    const stale = await put("country_rules", { expectedVersion: first.json().version, country: "SE", document: { ...base(), tips: [], calls: { on: false } } });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().document).toMatchObject({ ...money, tips: [], calls: { on: false, adminCallRoles: ["super", "ops"], phoneProvider: "twilio" } });
    expect([...stale.json().keptKeys].sort()).toEqual([...KEPT_KEYS.country_rules!].sort());
    expect((await get("country_rules", "country=SE")).document).toMatchObject(money);
    expect((await lastAudit("config.draft"))["kept"]).toEqual(stale.json().keptKeys);
  });

  it("a save that sends the keys saves them as sent and keeps nothing", async () => {
    const now = await get("country_rules", "country=SE");
    const res = await put("country_rules", { expectedVersion: now.version, country: "SE", document: { ...base(), ...money, payoutMode: "automatic", calls } });
    expect(res.json().document.payoutMode).toBe("automatic");
    expect(res.json().keptKeys).toBeUndefined();
    expect((await lastAudit("config.draft"))["kept"]).toBeUndefined();
  });

  it("removeKeys really removes a kept key; an unknown one is 400 unknown_kept_key and nothing is saved", async () => {
    const now = await get("country_rules", "country=SE");
    const bad = await put("country_rules", { expectedVersion: now.version, country: "SE", document: base(), removeKeys: ["tips"] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().reason).toBe("unknown_kept_key");
    expect((await get("country_rules", "country=SE")).version).toBe(now.version);
    const res = await put("country_rules", { expectedVersion: now.version, country: "SE", document: { ...base(), calls }, removeKeys: ["maxRiderDebt", "payoutSchedule"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().document.maxRiderDebt).toBeUndefined();
    expect(res.json().document.payoutSchedule).toBeUndefined();
    expect(res.json().document).toMatchObject({ payoutMode: "automatic", driverOwesLimit: money.driverOwesLimit });
    expect([...res.json().keptKeys].sort()).toEqual(["driverOwesLimit", "payoutMode"]);
  });

  it("a zone with no own document keeps nothing (no Standard-only key gets into a zone document)", async () => {
    const res = await put("country_rules", { expectedVersion: 1, zoneId: "Z001", document: base() });
    expect(res.statusCode).toBe(200);
    expect(res.json().document.payoutMode).toBeUndefined();
    expect(res.json().keptKeys).toBeUndefined();
  });

  it("dispatch: an old Save draft keeps radar / exclusive reaskAfterSeconds", async () => {
    const d = sample("dispatch_document");
    const first = await put("dispatch", { expectedVersion: 1, zoneId: "Z001", document: { ...d, radar: { ...d.radar, reaskAfterSeconds: 90 }, exclusive: { ...d.exclusive, reaskAfterSeconds: 120 } } });
    expect(first.statusCode).toBe(200);
    const stale = await put("dispatch", { expectedVersion: first.json().version, zoneId: "Z001", document: { ...d, radar: { ...d.radar, seconds: 20 } } });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().document.radar).toMatchObject({ seconds: 20, reaskAfterSeconds: 90 });
    expect(stale.json().document.exclusive.reaskAfterSeconds).toBe(120);
    expect([...stale.json().keptKeys].sort()).toEqual(["exclusive.reaskAfterSeconds", "radar.reaskAfterSeconds"]);
  });
});

describe("alert settings keep a stored kind a stale body lacks (v0.18.123 job 6)", () => {
  it("keeps stored kinds and other keys of kinds; sent kinds win; the audit lists the kept kinds", async () => {
    const book = (await call(app, "GET", "/admin/alerts/book?country=SE", admin)).json();
    const first = await call(app, "PUT", "/admin/alerts/settings", admin, { country: "SE", expectedRev: book.rev, settings: { kinds: { long_wait: { on: true }, rule: { on: true, level: "high" } } } });
    expect(first.statusCode).toBe(200);
    const stale = await call(app, "PUT", "/admin/alerts/settings", admin, { country: "SE", expectedRev: first.json().rev, settings: { kinds: { long_wait: { on: false } }, sound: true } });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().settings).toEqual({ kinds: { long_wait: { on: false }, rule: { on: true, level: "high" } }, sound: true });
    expect((await lastAudit("alert.settings"))["keptKinds"]).toEqual(["rule"]);
    const noKinds = await call(app, "PUT", "/admin/alerts/settings", admin, { country: "SE", expectedRev: stale.json().rev, settings: { sound: false } });
    expect(noKinds.json().settings.kinds).toEqual({ long_wait: { on: false }, rule: { on: true, level: "high" } });
  });
});
