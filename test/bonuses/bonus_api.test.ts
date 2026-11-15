import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { schemaProblem } from "../../src/contract/schemas.js";
import { boundsOf, type Polygon } from "../../src/zones/geometry.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, newKey, signIn, testWorld } from "../support/world.js";

/**
 * v0.18.103 BQ-V44 (contract.json#bonusCampaigns.endpoints / .permissions / .errors): the admin routes (drivers.read to
 * read, drivers.bonuses to write, zone scope, audit, expectedVersion, never deleted) and the driver routes
 * (GET /driver/bonuses, POST /driver/bonuses/opened). SEK and TND (3 decimals).
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-14T10:00:00Z") };

let adminAt = -1;
let adminHeaders: Record<string, string> | undefined;
/** A super admin signed in at the test clock (an access token lasts 15 min, and the clock moves days). */
async function A(): Promise<Record<string, string>> {
  const t = clock.now.getTime();
  if (adminHeaders === undefined || t < adminAt || t - adminAt > 600_000) {
    adminHeaders = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    adminAt = t;
  }
  return adminHeaders;
}
const NAMES = { sv: "Helgbonus", fr: "Bonus du week-end", en: "Weekend bonus" };
const SE_ZONE: Polygon = [[59.2, 17.8], [59.2, 18.3], [59.5, 18.3], [59.5, 17.8]];
const SE_AREA: Polygon = [[59.32, 18.05], [59.32, 18.09], [59.34, 18.09], [59.34, 18.05]];
const TN_AREA: Polygon = [[36.79, 10.16], [36.79, 10.2], [36.82, 10.2], [36.82, 10.16]];
const body = (over: Record<string, unknown> = {}) => ({ zoneId: "Z001", names: NAMES, measure: "trips", target: 10, amount: { amountMinor: 15_000, currency: "SEK" }, startDate: "2026-11-16", endDate: "2026-11-22", polygon: SE_AREA, ...over });

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.updateTable("zones").set({ polygon: JSON.stringify(SE_ZONE), ...boundsOf(SE_ZONE) }).where("zone_id", "=", "Z001").execute();
});
afterAll(async () => {
  await app?.close();
  await database?.drop();
});

const create = async (over: Record<string, unknown> = {}, headers?: Record<string, string>) => call(app, "POST", "/admin/bonuses", headers ?? (await A()), body(over));
const audits = async (bonusId: string) => (await database.db.selectFrom("admin_audit").select(["action", "zone_id"]).where("target_id", "=", bonusId).orderBy("at").execute()).map((a) => a.action);

describe("admin: permissions and zone scope", () => {
  it("a viewer (drivers.read only) reads but cannot create; support (no drivers.read) cannot read", async () => {
    const made = (await create()).json();
    const viewer = (await adminSession(app, database.db, "viewer", { now: clock.now })).headers;
    expect((await call(app, "GET", `/admin/bonuses/${made.bonusId}`, viewer)).statusCode).toBe(200);
    const refused = await create({}, viewer);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().reason).toBe("missing_permission");
    for (const path of ["pause", "resume", "end"]) expect((await call(app, "POST", `/admin/bonuses/${made.bonusId}/${path}`, viewer, { expectedVersion: 1 })).json().reason).toBe("missing_permission");
    expect((await call(app, "PUT", `/admin/bonuses/${made.bonusId}`, viewer, { expectedVersion: 1, names: NAMES })).json().reason).toBe("missing_permission");
    const support = (await adminSession(app, database.db, "support", { now: clock.now })).headers;
    for (const path of ["/admin/bonuses", `/admin/bonuses/${made.bonusId}`, `/admin/bonuses/${made.bonusId}/drivers`]) {
      const res = await call(app, "GET", path, support);
      expect(res.statusCode).toBe(403);
      expect(res.json().reason).toBe("missing_permission");
    }
    // The ops role has drivers.bonuses.
    const ops = (await adminSession(app, database.db, "ops", { now: clock.now })).headers;
    expect((await create({}, ops)).statusCode).toBe(201);
  });

  it("an admin limited to Z002: 403 zone_out_of_scope on Z001 (create, read, change, drivers, list filter); his list leaves Z001 out", async () => {
    const made = (await create()).json();
    const z2 = (await adminSession(app, database.db, "super", { zoneIds: ["Z002"], now: clock.now })).headers;
    const tries = [
      await create({}, z2),
      await call(app, "GET", `/admin/bonuses/${made.bonusId}`, z2),
      await call(app, "GET", `/admin/bonuses/${made.bonusId}/drivers`, z2),
      await call(app, "PUT", `/admin/bonuses/${made.bonusId}`, z2, { expectedVersion: 1, names: NAMES }),
      await call(app, "POST", `/admin/bonuses/${made.bonusId}/pause`, z2, { expectedVersion: 1 }),
      await call(app, "GET", "/admin/bonuses?zoneId=Z001", z2),
    ];
    for (const res of tries) expect({ status: res.statusCode, reason: res.json().reason }).toEqual({ status: 403, reason: "zone_out_of_scope" });
    const list = (await call(app, "GET", "/admin/bonuses", z2)).json();
    expect(list.items).toEqual([]);
    expect(await audits(made.bonusId)).toEqual(["bonus.create"]);
  });

  it("no token 401; a driver token 403", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/bonuses" })).statusCode).toBe(401);
    const driver = (await signIn(app, TEST_PHONES[3]!, "driver")).headers;
    expect((await call(app, "GET", "/admin/bonuses", driver)).statusCode).toBe(403);
    const rider = (await signIn(app, TEST_PHONES[4]!, "rider")).headers;
    expect((await call(app, "GET", "/driver/bonuses", rider)).statusCode).toBe(403);
  });
});

describe("admin: create, edit, pause, resume, end (audited; expectedVersion; never deleted)", () => {
  it("SEK: the whole life of a campaign, each write audited", async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c).toMatchObject({ zoneId: "Z001", country: "SE", currency: "SEK", timeZone: "Europe/Stockholm", names: NAMES, measure: "trips", target: 10, amount: { amountMinor: 15_000, currency: "SEK" }, startDate: "2026-11-16", endDate: "2026-11-22", status: "active", state: "scheduled", version: 1, driversWithProgress: 0, driversEarned: 0, paidTotal: { amountMinor: 0, currency: "SEK" }, bounds: { south: 59.32, west: 18.05, north: 59.34, east: 18.09 } });
    expect(c.bonusId).toMatch(/^bon_/);
    const put = await call(app, "PUT", `/admin/bonuses/${c.bonusId}`, await A(), { expectedVersion: 1, names: { ...NAMES, en: "Big weekend" }, endDate: "2026-11-29" });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ version: 2, endDate: "2026-11-29", names: { en: "Big weekend" } });
    // A stale version: 409 version_mismatch, nothing changes.
    const stale = await call(app, "POST", `/admin/bonuses/${c.bonusId}/pause`, await A(), { expectedVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("version_mismatch");
    // Only names and a later end date change: any other field 400 bonus_field_fixed; an earlier end 400 bonus_dates_invalid.
    for (const fixed of [{ target: 3 }, { amount: { amountMinor: 1, currency: "SEK" } }, { polygon: SE_AREA }, { startDate: "2026-11-17" }, { measure: "online_hours" }, { zoneId: "Z002" }]) {
      const r = await call(app, "PUT", `/admin/bonuses/${c.bonusId}`, await A(), { expectedVersion: 2, ...fixed });
      expect({ status: r.statusCode, reason: r.json().reason }).toEqual({ status: 400, reason: "bonus_field_fixed" });
    }
    const earlier = await call(app, "PUT", `/admin/bonuses/${c.bonusId}`, await A(), { expectedVersion: 2, endDate: "2026-11-20" });
    expect(earlier.json().reason).toBe("bonus_dates_invalid");
    const tooLong = await call(app, "PUT", `/admin/bonuses/${c.bonusId}`, await A(), { expectedVersion: 2, endDate: "2027-02-16" });
    expect(tooLong.json().reason).toBe("bonus_dates_invalid");
    // resume needs paused: 409 invalid_transition.
    expect((await call(app, "POST", `/admin/bonuses/${c.bonusId}/resume`, await A(), { expectedVersion: 2 })).json().code).toBe("invalid_transition");
    clock.now = new Date("2026-11-17T09:00:00Z");
    const paused = (await call(app, "POST", `/admin/bonuses/${c.bonusId}/pause`, await A(), { expectedVersion: 2 })).json();
    expect(paused).toMatchObject({ status: "paused", state: "paused", version: 3 });
    expect((await call(app, "POST", `/admin/bonuses/${c.bonusId}/pause`, await A(), { expectedVersion: 3 })).json().code).toBe("invalid_transition");
    const resumed = (await call(app, "POST", `/admin/bonuses/${c.bonusId}/resume`, await A(), { expectedVersion: 3 })).json();
    expect(resumed).toMatchObject({ status: "active", state: "active", version: 4 });
    const ended = (await call(app, "POST", `/admin/bonuses/${c.bonusId}/end`, await A(), { expectedVersion: 4 })).json();
    expect(ended).toMatchObject({ status: "ended", state: "ended", version: 5, endedAt: clock.now.toISOString() });
    // Ended: 409 conflict bonus_ended on every change; the campaign stays (never deleted, Rule 21).
    for (const r of [
      await call(app, "PUT", `/admin/bonuses/${c.bonusId}`, await A(), { expectedVersion: 5, names: NAMES }),
      await call(app, "POST", `/admin/bonuses/${c.bonusId}/resume`, await A(), { expectedVersion: 5 }),
      await call(app, "POST", `/admin/bonuses/${c.bonusId}/end`, await A(), { expectedVersion: 5 }),
    ]) expect({ status: r.statusCode, code: r.json().code, reason: r.json().reason }).toEqual({ status: 409, code: "conflict", reason: "bonus_ended" });
    expect((await call(app, "GET", `/admin/bonuses/${c.bonusId}`, await A())).json().status).toBe("ended");
    expect((await call(app, "GET", "/admin/bonuses?state=ended&zoneId=Z001", await A())).json().items.map((i: { bonusId: string }) => i.bonusId)).toContain(c.bonusId);
    expect(await audits(c.bonusId)).toEqual(["bonus.create", "bonus.update", "bonus.pause", "bonus.resume", "bonus.end"]);
    clock.now = new Date("2026-11-14T10:00:00Z");
  });

  it("the same Idempotency-Key replays the first answer (one campaign)", async () => {
    const key = newKey();
    const a = await call(app, "POST", "/admin/bonuses", await A(), body({ names: { ...NAMES, en: "Once" } }), key);
    const b = await call(app, "POST", "/admin/bonuses", await A(), body({ names: { ...NAMES, en: "Once" } }), key);
    expect(b.statusCode).toBe(201);
    expect(b.json().bonusId).toBe(a.json().bonusId);
    const rows = await database.db.selectFrom("bonus_campaigns").select("bonus_id").where("names", "@>", JSON.stringify({ en: "Once" }) as never).execute();
    expect(rows).toHaveLength(1);
  });

  it("the largest amount is the admin setting CountryRules.bonusCampaignMax of the zone (else the country default)", async () => {
    // ARN (an airport zone in SE) with its own rules: 500,00 kr.
    const arn = await database.db.selectFrom("zones").select("polygon").where("zone_id", "=", "ARN").executeTakeFirstOrThrow();
    const area = (arn.polygon as Polygon).slice(0, 3) as Polygon;
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "ARN", version: 1, document: JSON.stringify({ bonusCampaignMax: { amountMinor: 50_000, currency: "SEK" } }), published_at: clock.now, published_by: null }).execute();
    const over = await create({ zoneId: "ARN", polygon: area, amount: { amountMinor: 50_001, currency: "SEK" } });
    expect(over.json().reason).toBe("bonus_amount_above_max");
    expect((await create({ zoneId: "ARN", polygon: area, amount: { amountMinor: 50_000, currency: "SEK" } })).statusCode).toBe(201);
    // Z001 keeps the country default 2 000,00 kr.
    expect((await create({ amount: { amountMinor: 200_000, currency: "SEK" } })).statusCode).toBe(201);
    expect((await create({ amount: { amountMinor: 200_001, currency: "SEK" } })).json().reason).toBe("bonus_amount_above_max");
  });

  it("TND: minor units ×1000 (20.000 DT); the list pages newest first", async () => {
    const tn = await create({ zoneId: "TN-TC", polygon: TN_AREA, amount: { amountMinor: 20_000, currency: "TND" } });
    expect(tn.statusCode, tn.body).toBe(201);
    expect(tn.json()).toMatchObject({ currency: "TND", country: "TN", timeZone: "Africa/Tunis", amount: { amountMinor: 20_000, currency: "TND" }, paidTotal: { amountMinor: 0, currency: "TND" } });
    const first = (await call(app, "GET", "/admin/bonuses?limit=2", await A())).json();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await call(app, "GET", `/admin/bonuses?limit=2&cursor=${first.nextCursor}`, await A())).json();
    expect(second.items[0].bonusId).not.toBe(first.items[1].bonusId);
    expect(first.items[0].createdAt >= first.items[1].createdAt).toBe(true);
    expect((await call(app, "GET", "/admin/bonuses?nope=1", await A())).json().reason).toBe("unknown_filter");
  });
});

describe("driver: GET /driver/bonuses and POST /driver/bonuses/opened", () => {
  it("only the campaigns of his zones; NEW until he opens them; ended ones he took part in stay 30 days", async () => {
    const phone = TEST_PHONES[5]!;
    const headers = (await signIn(app, phone, "driver")).headers;
    const driverId = (await database.db.selectFrom("drivers").select("driver_id").where("phone", "=", phone).executeTakeFirstOrThrow()).driver_id;
    await database.db.updateTable("drivers").set({ zone_ids: ["TN-TC"], account_status: "active" }).where("driver_id", "=", driverId).execute();
    const a = (await create({ zoneId: "TN-TC", polygon: TN_AREA, amount: { amountMinor: 30_000, currency: "TND" }, startDate: "2026-11-14", endDate: "2026-11-20" })).json();
    const b = (await create({ zoneId: "TN-TC", polygon: TN_AREA, amount: { amountMinor: 40_000, currency: "TND" }, startDate: "2026-11-25", endDate: "2026-11-30", measure: "online_hours", target: 10 })).json();
    const se = (await create()).json();
    const list = (await call(app, "GET", "/driver/bonuses", headers)).json();
    const mine = list.items.filter((i: { bonusId: string }) => [a.bonusId, b.bonusId, se.bonusId].includes(i.bonusId));
    expect(mine.map((i: { bonusId: string }) => i.bonusId)).toEqual([a.bonusId, b.bonusId]);
    expect(mine[0]).toMatchObject({ state: "active", measure: "trips", progress: { done: 0, target: 10 }, earned: false, isNew: true, amount: { amountMinor: 30_000, currency: "TND" }, timeZone: "Africa/Tunis", startDate: "2026-11-14", endDate: "2026-11-20" });
    expect(mine[1]).toMatchObject({ state: "scheduled", measure: "online_hours", progress: { done: 0, target: 600 }, isNew: true });
    expect(list.items.some((i: { bonusId: string }) => i.bonusId === se.bonusId)).toBe(false);
    const opened = await call(app, "POST", "/driver/bonuses/opened", headers, { bonusIds: [a.bonusId, se.bonusId] });
    expect(opened.statusCode).toBe(204);
    const again = (await call(app, "GET", "/driver/bonuses", headers)).json().items;
    expect(again.find((i: { bonusId: string }) => i.bonusId === a.bonusId).isNew).toBe(false);
    expect(again.find((i: { bonusId: string }) => i.bonusId === b.bonusId).isNew).toBe(true);
    // The Z001 campaign is not his: nothing is written for it.
    expect(await database.db.selectFrom("bonus_progress").select("bonus_id").where("driver_id", "=", driverId).where("bonus_id", "=", se.bonusId).execute()).toEqual([]);
    expect((await call(app, "POST", "/driver/bonuses/opened", headers, { bonusIds: [] })).statusCode).toBe(400);
    // Ended with progress: listed for 30 days after the end, then gone; ended without progress: gone at once.
    await database.db.updateTable("bonus_progress").set({ trips: 2 }).where("driver_id", "=", driverId).where("bonus_id", "=", a.bonusId).execute();
    clock.now = new Date("2026-12-01T10:00:00Z");
    const later = (await call(app, "GET", "/driver/bonuses", (await signIn(app, phone, "driver")).headers)).json().items;
    expect(later.find((i: { bonusId: string }) => i.bonusId === a.bonusId)).toMatchObject({ state: "ended", progress: { done: 2, target: 10 } });
    expect(later.some((i: { bonusId: string }) => i.bonusId === b.bonusId)).toBe(false);
    clock.now = new Date("2026-12-21T10:00:00Z");
    expect((await call(app, "GET", "/driver/bonuses", (await signIn(app, phone, "driver")).headers)).json().items.some((i: { bonusId: string }) => i.bonusId === a.bonusId)).toBe(false);
    clock.now = new Date("2026-11-14T10:00:00Z");
  });
});

describe("every answer is the contract's shape (openapi.yaml 0.18.103)", () => {
  it("BonusCampaign, BonusCampaignPage, BonusProgressPage, DriverBonusList", async () => {
    clock.now = new Date("2026-11-14T10:00:00Z");
    const c = (await create({ startDate: "2026-11-14" })).json();
    expect(schemaProblem("BonusCampaign", c)).toBeNull();
    const phone = TEST_PHONES[2]!;
    const headers = (await signIn(app, phone, "driver")).headers;
    const driverId = (await database.db.selectFrom("drivers").select("driver_id").where("phone", "=", phone).executeTakeFirstOrThrow()).driver_id;
    await database.db.updateTable("drivers").set({ zone_ids: ["Z001"], account_status: "active" }).where("driver_id", "=", driverId).execute();
    await database.db.insertInto("bonus_progress").values({ bonus_id: c.bonusId, driver_id: driverId, trips: 3, updated_at: clock.now }).execute();
    const ended = (await call(app, "POST", `/admin/bonuses/${c.bonusId}/end`, await A(), { expectedVersion: 1 })).json();
    expect(schemaProblem("BonusCampaign", ended)).toBeNull();
    expect(ended).toMatchObject({ driversWithProgress: 1, driversEarned: 0 });
    expect(schemaProblem("BonusCampaignPage", (await call(app, "GET", "/admin/bonuses?state=ended", await A())).json())).toBeNull();
    const progress = (await call(app, "GET", `/admin/bonuses/${c.bonusId}/drivers`, await A())).json();
    expect(schemaProblem("BonusProgressPage", progress)).toBeNull();
    expect(progress.items).toEqual([{ driverId, firstName: expect.any(String), progress: { done: 3, target: 10 }, earned: false }]);
    const mine = (await call(app, "GET", "/driver/bonuses", headers)).json();
    expect(schemaProblem("DriverBonusList", mine)).toBeNull();
    expect(mine.items.find((i: { bonusId: string }) => i.bonusId === c.bonusId)).toMatchObject({ state: "ended", progress: { done: 3, target: 10 } });
  });
});
