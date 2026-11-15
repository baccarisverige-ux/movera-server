import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeDay } from "../../src/admin/kpis.js";
import { buildApp } from "../../src/app.js";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { award, countingHooks, forgetBonusCampaigns, type CampaignRow } from "../../src/bonuses/counting.js";
import { e164, samePhone } from "../../src/bonuses/rules.js";
import { forgetGeometry } from "../../src/config/geometryCache.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { readEnv } from "../../src/env.js";
import { commissionOf } from "../../src/rules/commission.js";
import { driverEarnings } from "../../src/trips/ride/earnings.js";
import { creditTrip } from "../../src/trips/ride/finish.js";
import { boundsOf, type Polygon } from "../../src/zones/geometry.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip, seedPhone } from "../support/seed.js";
import { call, fixedRouter, signIn, testWorld } from "../support/world.js";

/**
 * v0.18.110 BQ-V44 safety (Rules audits/impact/v44-driver-bonuses-supervisor.md §2.1 MF1/MF2, §4 MF3/MF7, round-2 notes
 * 2-4; NET supervisor V44-N1):
 * - two server copies award at once (trip ends and location posts): one entry, every call still succeeds;
 * - the unique index is the second guard; a lost race is a no-op; a broken counting step never fails the caller;
 * - a campaign ended on another copy stops counting at once (SQL re-check, not the 30 s cache);
 * - "offline 9 min, back online, backdated batch" through the real location handler adds nothing;
 * - MF7 phones compared in E.164 form (spaces, 00 prefix);
 * - EarningsPeriod.bonus is the period's bonus entries and is NOT added to net a second time;
 * - the KPI summary row (summarizeDay, used by the nightly job and resumTripDay) holds the award once.
 */

let database: TestDatabase;
let app: FastifyInstance;
let copy: FastifyInstance;
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
const SE_ZONE: Polygon = [[59.2, 17.8], [59.2, 18.3], [59.5, 18.3], [59.5, 17.8]];
const AREA: Polygon = [[59.32, 18.05], [59.32, 18.09], [59.34, 18.09], [59.34, 18.05]];
const IN = { lat: 59.33, lng: 18.07 };
const NAMES = { sv: "Kampanj", fr: "Campagne", en: "Campaign" };

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  // A second server copy on the same database (Rule 33), with its own memory (campaign cache, config cache).
  copy = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "world-test-secret".padEnd(48, "w") }), logger: false, db: database.db, clock: () => clock.now, router: fixedRouter });
  await database.db.updateTable("zones").set({ polygon: JSON.stringify(SE_ZONE), ...boundsOf(SE_ZONE) }).where("zone_id", "=", "Z001").execute();
  forgetGeometry();
});
afterAll(async () => {
  await copy?.close();
  await app?.close();
  await database?.drop();
});

async function campaign(over: Record<string, unknown> = {}) {
  const at = clock.now;
  clock.now = new Date("2026-11-14T10:00:00Z");
  const res = await call(app, "POST", "/admin/bonuses", await A(), { zoneId: "Z001", names: NAMES, measure: "trips", target: 2, amount: { amountMinor: 15_000, currency: "SEK" }, startDate: "2026-11-16", endDate: "2026-11-22", polygon: AREA, ...over });
  expect(res.statusCode, res.body).toBe(201);
  clock.now = at;
  return res.json() as { bonusId: string; version: number };
}
async function zoneDriver(phone = seedPhone("+4673")) {
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ zone_ids: ["Z001"], account_status: "active", phone }).where("driver_id", "=", id).execute();
  return id;
}
async function paidTrip(driverId: string, riderId: string, at: Date, pickup = IN, extra: { bonus?: number } = {}): Promise<TripRow> {
  const id = await insertTrip(database.db, riderId, { status: "accepted", driverId });
  const lines = [{ code: "base", amount: { amountMinor: 20_000, currency: "SEK" } }];
  const bonus = extra.bonus ?? 0;
  await database.db.updateTable("trips").set({
    zone_id: "Z001", pickup: JSON.stringify({ ...pickup, address: "Pickup" }), status: "completed", fare_minor: 20_000, fare_lines: JSON.stringify(lines), driver_earnings_minor: 16_000,
    pickup_pay_minor: 0, driver_bonus_minor: bonus, commission_minor: commissionOf(20_000, lines, 16_000, 0, bonus), ended_at: at, payment_status: "captured",
  }).where("trip_id", "=", id).execute();
  return (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
}
const end = (trip: TripRow, at: Date) => database.db.transaction().execute((trx) => creditTrip(trx, trip, at));
const entries = (bonusId: string) => database.db.selectFrom("earnings_entries").select(["driver_id", "amount_minor", "at", "trip_id", "kind"]).where("bonus_id", "=", bonusId).execute();
const progress = (bonusId: string, driverId: string) => database.db.selectFrom("bonus_progress").selectAll().where("bonus_id", "=", bonusId).where("driver_id", "=", driverId).executeTakeFirst();

describe("MF1: the award once, with two server copies at once", () => {
  it("two trips of one driver end at the same moment on two copies (target reached by both): both trip ends succeed, ONE entry", async () => {
    const c = await campaign();
    const d = await zoneDriver();
    const at = new Date("2026-11-17T09:00:00Z");
    clock.now = at;
    await end(await paidTrip(d, await insertRider(database.db), at), at);
    const [t1, t2] = [await paidTrip(d, await insertRider(database.db), at), await paidTrip(d, await insertRider(database.db), at)];
    const results = await Promise.allSettled([end(t1, at), end(t2, at)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    // Both trip ends wrote their own trip entry.
    for (const t of [t1, t2]) expect(await database.db.selectFrom("earnings_entries").select("entry_id").where("trip_id", "=", t.trip_id).where("kind", "=", "trip").execute()).toHaveLength(1);
    const paid = await entries(c.bonusId);
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ driver_id: d, kind: "bonus", trip_id: null, amount_minor: "15000" });
    expect((await progress(c.bonusId, d))!).toMatchObject({ trips: 2, earned_at: at });
  });

  it("many drivers, many trips at once across both copies' transactions: each who reaches the target is paid exactly once", async () => {
    const c = await campaign({ target: 1 });
    const at = new Date("2026-11-18T09:00:00Z");
    clock.now = at;
    const drivers = [await zoneDriver(), await zoneDriver(), await zoneDriver()];
    const trips: TripRow[] = [];
    for (const d of drivers) for (let i = 0; i < 3; i++) trips.push(await paidTrip(d, await insertRider(database.db), at));
    const results = await Promise.allSettled(trips.map((t) => end(t, at)));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const paid = await entries(c.bonusId);
    expect(paid.map((e) => e.driver_id).sort()).toEqual([...drivers].sort());
  });

  it("the unique index refuses a second entry (second guard); award() after it is a no-op, never an error", async () => {
    const c = await campaign({ target: 1 });
    const d = await zoneDriver();
    const at = new Date("2026-11-18T10:00:00Z");
    clock.now = at;
    await end(await paidTrip(d, await insertRider(database.db), at), at);
    expect(await entries(c.bonusId)).toHaveLength(1);
    await expect(database.db.insertInto("earnings_entries").values({ entry_id: "ern_v44_dup", driver_id: d, trip_id: null, kind: "bonus", currency: "SEK", amount_minor: 15_000, gross_minor: null, commission_minor: null, cash_minor: null, at, bonus_id: c.bonusId }).execute()).rejects.toThrow(/earnings_bonus_once/);
    // A copy that passed the gate on a stale row (earned_at reset): the insert meets the index and does nothing.
    await database.db.updateTable("bonus_progress").set({ earned_at: null }).where("bonus_id", "=", c.bonusId).where("driver_id", "=", d).execute();
    const row = { bonusId: c.bonusId, zoneId: "Z001", measure: "trips", target: 1, amountMinor: 15_000, currency: "SEK" } as unknown as CampaignRow;
    expect(await database.db.transaction().execute((trx) => award(trx, row, d, at))).toBeNull();
    expect(await entries(c.bonusId)).toHaveLength(1);
    expect((await progress(c.bonusId, d))!.entry_id).toEqual((await database.db.selectFrom("earnings_entries").select("entry_id").where("bonus_id", "=", c.bonusId).executeTakeFirstOrThrow()).entry_id);
  });

  it("the same last fix posted twice at once on two copies: both posts 200, one write wins, ONE entry", async () => {
    const c = await campaign({ measure: "online_hours", target: 1 });
    const phone = TEST_PHONES[1]!;
    await signIn(app, phone, "driver");
    const d = (await database.db.selectFrom("drivers").select("driver_id").where("phone", "=", phone).executeTakeFirstOrThrow()).driver_id;
    const since = new Date("2026-11-19T08:00:00Z");
    await database.db.updateTable("drivers").set({ zone_ids: ["Z001"], account_status: "active", online_status: "online", online_since: since }).where("driver_id", "=", d).execute();
    // 59 min 30 s counted already; the last counted fix 08:59:30.
    const last = new Date("2026-11-19T08:59:30Z");
    await database.db.insertInto("bonus_progress").values({ bonus_id: c.bonusId, driver_id: d, online_seconds: 3570, last_inside_at: last, last_received_at: last, last_lat: IN.lat, last_lng: IN.lng, updated_at: last }).execute();
    clock.now = new Date("2026-11-19T09:00:00Z");
    const fix = { fixes: [{ ...IN, accuracy: 5, measuredAt: clock.now.toISOString() }] };
    // Both copies hold a token of this moment (the copy's sign-in refreshes the same session, one phone).
    const headers = (await signIn(app, phone, "driver")).headers;
    const copyHeaders = (await signIn(copy, phone, "driver")).headers;
    const [a, b] = await Promise.all([call(app, "POST", "/driver/location", headers, fix), call(copy, "POST", "/driver/location", copyHeaders, fix)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const paid = await entries(c.bonusId);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.at).toEqual(clock.now);
    expect((await progress(c.bonusId, d))!.online_seconds).toBe(3600);
    await database.db.updateTable("drivers").set({ online_status: "offline", zone_ids: [] }).where("driver_id", "=", d).execute();
  });

  it("a counting step that breaks never fails the trip end or the location post (savepoint)", async () => {
    const c = await campaign({ target: 1 });
    const d = await zoneDriver();
    const at = new Date("2026-11-19T12:00:00Z");
    clock.now = at;
    countingHooks.beforeCount = async (trx) => { await sql`SELECT 1 / 0`.execute(trx); };
    try {
      const t = await paidTrip(d, await insertRider(database.db), at);
      await end(t, at);
      expect(await database.db.selectFrom("earnings_entries").select("kind").where("trip_id", "=", t.trip_id).execute()).not.toHaveLength(0);
      expect(await entries(c.bonusId)).toEqual([]);
      const h = await campaign({ measure: "online_hours", target: 1 });
      const phone = TEST_PHONES[2]!;
      const headers = (await signIn(app, phone, "driver")).headers;
      const id = (await database.db.selectFrom("drivers").select("driver_id").where("phone", "=", phone).executeTakeFirstOrThrow()).driver_id;
      await database.db.updateTable("drivers").set({ zone_ids: ["Z001"], account_status: "active", online_status: "online", online_since: new Date(at.getTime() - 60_000) }).where("driver_id", "=", id).execute();
      const res = await call(app, "POST", "/driver/location", headers, { fixes: [{ ...IN, accuracy: 5, measuredAt: at.toISOString() }] });
      expect(res.statusCode).toBe(200);
      expect(res.json().accepted).toBe(1);
      expect(await progress(h.bonusId, id)).toBeUndefined();
      await database.db.updateTable("drivers").set({ online_status: "offline", zone_ids: [] }).where("driver_id", "=", id).execute();
    } finally {
      delete countingHooks.beforeCount;
    }
  });
});

describe("MF2: a campaign paused or ended on another copy stops counting at once (SQL re-check, not the cache)", () => {
  it("online hours: the cache still holds it, the other copy ended it; the next fix adds nothing", async () => {
    const c = await campaign({ measure: "online_hours", target: 2 });
    const phone = TEST_PHONES[3]!;
    const d = (await signIn(app, phone, "driver"), (await database.db.selectFrom("drivers").select("driver_id").where("phone", "=", phone).executeTakeFirstOrThrow()).driver_id);
    const since = new Date("2026-11-20T08:00:00Z");
    await database.db.updateTable("drivers").set({ zone_ids: ["Z001"], account_status: "active", online_status: "online", online_since: since }).where("driver_id", "=", d).execute();
    const post = async (at: string) => {
      clock.now = new Date(at);
      return call(app, "POST", "/driver/location", (await signIn(app, phone, "driver")).headers, { fixes: [{ ...IN, accuracy: 5, measuredAt: clock.now.toISOString() }] });
    };
    await post("2026-11-20T08:00:00Z");
    await post("2026-11-20T08:01:00Z");
    expect((await progress(c.bonusId, d))!.online_seconds).toBe(60);
    // "Another copy" ends it: the row changes, this copy's cache is not told.
    await database.db.updateTable("bonus_campaigns").set({ status: "ended", ended_at: new Date("2026-11-20T08:01:10Z") }).where("bonus_id", "=", c.bonusId).execute();
    await post("2026-11-20T08:02:00Z");
    expect((await progress(c.bonusId, d))!.online_seconds).toBe(60);
    // Trips too: the trip read is SQL only.
    const t = await campaign({ target: 1 });
    await database.db.updateTable("bonus_campaigns").set({ status: "paused", pauses: JSON.stringify([["2026-11-20T08:00:00Z", null]]) }).where("bonus_id", "=", t.bonusId).execute();
    const td = await zoneDriver();
    const at = new Date("2026-11-20T09:00:00Z");
    await end(await paidTrip(td, await insertRider(database.db), at), at);
    expect(await progress(t.bonusId, td)).toBeUndefined();
    await database.db.updateTable("drivers").set({ online_status: "offline", zone_ids: [] }).where("driver_id", "=", d).execute();
    forgetBonusCampaigns();
  });
});

describe("MF3 (supervisor note 3): offline 9 min, back online, then a backdated batch — through POST /driver/location", () => {
  it("the made-up fixes of the offline time are before online_since: nothing is added; the next real fix after the gap adds 0", async () => {
    const c = await campaign({ measure: "online_hours", target: 1 });
    const phone = TEST_PHONES[4]!;
    await signIn(app, phone, "driver");
    const d = (await database.db.selectFrom("drivers").select("driver_id").where("phone", "=", phone).executeTakeFirstOrThrow()).driver_id;
    const setStatus = (online: boolean, at: Date) => database.db.updateTable("drivers").set({ online_status: online ? "online" : "offline", online_since: online ? at : null }).where("driver_id", "=", d).execute();
    await database.db.updateTable("drivers").set({ zone_ids: ["Z001"], account_status: "active" }).where("driver_id", "=", d).execute();
    const post = async (now: string, times: string[]) => {
      clock.now = new Date(now);
      const res = await call(app, "POST", "/driver/location", (await signIn(app, phone, "driver")).headers, { fixes: times.map((t) => ({ ...IN, accuracy: 5, measuredAt: t })) });
      expect(res.statusCode).toBe(200);
      return res.json();
    };
    await setStatus(true, new Date("2026-11-21T10:00:00Z"));
    await post("2026-11-21T10:00:00Z", ["2026-11-21T10:00:00Z"]);
    await post("2026-11-21T10:01:00Z", ["2026-11-21T10:01:00Z"]);
    expect((await progress(c.bonusId, d))!.online_seconds).toBe(60);
    // Offline at 10:01:30 (as setAvailability writes it); a post while offline is not stored at all.
    await setStatus(false, new Date("2026-11-21T10:01:30Z"));
    expect((await post("2026-11-21T10:05:00Z", ["2026-11-21T10:05:00Z"])).accepted).toBe(0);
    // Back online at 10:10:30, then one batch dated 100 s apart over the 9 offline minutes.
    await setStatus(true, new Date("2026-11-21T10:10:30Z"));
    const backdated = ["10:01:40", "10:03:20", "10:05:00", "10:06:40", "10:08:20", "10:10:00"].map((t) => `2026-11-21T${t}Z`);
    expect((await post("2026-11-21T10:10:30Z", backdated)).accepted).toBe(6);
    expect((await progress(c.bonusId, d))!.online_seconds).toBe(60);
    // The first real fix after coming back: gap from 10:01:00 > 120 s → adds 0 (it is the new start); the next adds 60 s.
    await post("2026-11-21T10:11:00Z", ["2026-11-21T10:11:00Z"]);
    expect((await progress(c.bonusId, d))!.online_seconds).toBe(60);
    await post("2026-11-21T10:12:00Z", ["2026-11-21T10:12:00Z"]);
    expect((await progress(c.bonusId, d))!.online_seconds).toBe(120);
    await database.db.updateTable("drivers").set({ online_status: "offline", zone_ids: [] }).where("driver_id", "=", d).execute();
  });
});

describe("MF7 (supervisor note 2): the driver's own phone in another form still never counts", () => {
  it("e164: spaces, dashes and a 00 prefix are the same number", () => {
    expect(e164("+46 70-111 22 33")).toBe("+46701112233");
    expect(e164("0046701112233")).toBe("+46701112233");
    expect(e164("(+216) 20.123.456")).toBe("+21620123456");
    expect(samePhone("0046701112233", "+46701112233")).toBe(true);
    expect(samePhone("+46701112234", "+46701112233")).toBe(false);
    expect(samePhone(null, "+46701112233")).toBe(false);
  });

  it("creditTrip: riders stored as '+46 70 111 22 33' and '0046701112233' with the driver on +46701112233 do not count; another rider does", async () => {
    const c = await campaign({ target: 3 });
    const own = "+46701112299";
    const d = await zoneDriver(own);
    const at = new Date("2026-11-21T09:00:00Z");
    clock.now = at;
    await end(await paidTrip(d, await insertRider(database.db, { phone: "+46 70 111 22 99" }), at), at);
    await end(await paidTrip(d, await insertRider(database.db, { phone: "0046701112299" }), new Date(at.getTime() + 60_000)), new Date(at.getTime() + 60_000));
    expect((await progress(c.bonusId, d))!.trips).toBe(0);
    await end(await paidTrip(d, await insertRider(database.db), new Date(at.getTime() + 120_000)), new Date(at.getTime() + 120_000));
    expect((await progress(c.bonusId, d))!.trips).toBe(1);
  });
});

describe("money around the award (NET V44-N1, MF8)", () => {
  it("SEK: EarningsPeriod.bonus = trip bonus + campaign; net counts them once (the same as the payout's entries)", async () => {
    const c = await campaign({ target: 1, amount: { amountMinor: 25_000, currency: "SEK" } });
    const d = await zoneDriver();
    const at = new Date("2026-11-22T09:00:00Z");
    clock.now = at;
    await end(await paidTrip(d, await insertRider(database.db), at, IN, { bonus: 3_000 }), at);
    expect(await entries(c.bonusId)).toHaveLength(1);
    const report = await driverEarnings(database.db, d, { period: "day", timeZone: "Europe/Stockholm", currency: "SEK" }, new Date("2026-11-22T12:00:00Z"));
    const p = report.periods[0]!;
    // Every open trips campaign of this file counts the trip (D14); this one pays 250,00 kr, the others their amounts.
    const camps = await database.db.selectFrom("earnings_entries").select(sql<string>`sum(amount_minor)`.as("s")).where("driver_id", "=", d).where("bonus_id", "is not", null).executeTakeFirstOrThrow();
    expect(Number(camps.s)).toBeGreaterThanOrEqual(25_000);
    expect(p.bonus).toEqual({ amountMinor: 3_000 + Number(camps.s), currency: "SEK" });
    // net = trip 160,00 + the bonus entries (nothing else) — the bonus field is a part already inside net, not added again.
    expect(p.net).toEqual({ amountMinor: 16_000 + 3_000 + Number(camps.s), currency: "SEK" });
    const sum = await database.db.selectFrom("earnings_entries").select(sql<string>`sum(amount_minor)`.as("s")).where("driver_id", "=", d).executeTakeFirstOrThrow();
    expect(p.net.amountMinor).toBe(Number(sum.s));
  });

  it("the KPI summary row of the award's local day holds the campaign once (summarizeDay: the nightly job, resumTripDay, kpi-resum)", async () => {
    const zone = { zone_id: "Z001", time_zone: "Europe/Stockholm", currency: "SEK" };
    const day = "2026-11-22";
    await database.db.transaction().execute((trx) => summarizeDay(trx, zone, day, new Date("2026-11-23T03:00:00Z")));
    const first = await database.db.selectFrom("kpi_days").selectAll().where("zone_id", "=", "Z001").where("day", "=", day as never).executeTakeFirstOrThrow();
    const awards = await sql<{ n: string }>`SELECT coalesce(sum(e.amount_minor), 0) AS n FROM earnings_entries e JOIN bonus_campaigns c ON c.bonus_id = e.bonus_id
      WHERE c.zone_id = 'Z001' AND (e.at AT TIME ZONE 'Europe/Stockholm')::date = ${day}::date`.execute(database.db);
    const tripBonuses = await sql<{ n: string }>`SELECT coalesce(sum(e.amount_minor), 0) AS n FROM earnings_entries e JOIN trips t ON t.trip_id = e.trip_id
      WHERE e.kind = 'bonus' AND t.zone_id = 'Z001' AND (t.ended_at AT TIME ZONE 'Europe/Stockholm')::date = ${day}::date`.execute(database.db);
    expect(Number(awards.rows[0]!.n)).toBeGreaterThanOrEqual(25_000);
    expect(Number(first.driver_bonus_minor)).toBe(Number(awards.rows[0]!.n) + Number(tripBonuses.rows[0]!.n));
    // Again (a re-run, kpi-resum): the same row, the award still once.
    await database.db.transaction().execute((trx) => summarizeDay(trx, zone, day, new Date("2026-11-24T03:00:00Z")));
    const again = await database.db.selectFrom("kpi_days").selectAll().where("zone_id", "=", "Z001").where("day", "=", day as never).executeTakeFirstOrThrow();
    expect({ b: again.driver_bonus_minor, m: again.movera_earnings_minor }).toEqual({ b: first.driver_bonus_minor, m: first.movera_earnings_minor });
  });
});
