import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countDay } from "../../src/admin/kpis.js";
import { redactProjection } from "../../src/realtime/events.js";
import { commissionOf } from "../../src/rules/commission.js";
import { tripProjection } from "../../src/trips/projection.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/**
 * BQ-M21 (contract v0.18.90 moneyBase.lostDriverPaid; owner 2026-11-13 23:42 UTC "Movera commission is how much movera
 * keep", Rules decisions/session-2026-11-06.md:1263; M19 supervisor note): on a REASSIGNED trip Movera paid the driver who
 * lost it (POST /admin/trips/{id}/reassign driverBonus). What Movera keeps on the trip leaves that payment out:
 * - admin view: moneySplit.lostDriverPaid (when > 0); moneySplit.movera = riderPaid − driverTotal − debtCollected −
 *   lostDriverPaid; moveraKeepsNow = moneySplit.movera (the admin "Movera commission" rows).
 * - driver view and driver stream: moveraKeepsNow stays what Movera keeps from HIS trip (another driver's money is never
 *   sent to him); never moneySplit. Rider view and rider stream: none of it.
 * - KPI moveraEarnings already takes the payment off once (BQ-M19) and equals moneySplit.movera per trip: not twice.
 * Sweden (SEK) and Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
let app: FastifyInstance;
let admin: Record<string, string>;
let driverA: string;
let driverB: string;
let driverC: string;
const clock = { now: new Date("2026-11-13T10:00:00Z") };
const SE = { zone_id: "Z001", time_zone: "Europe/Stockholm", currency: "SEK" };
const TN = { zone_id: "TN-TC", time_zone: "Africa/Tunis", currency: "TND" };
type Zone = typeof SE;
type Line = { code: string; amount: { amountMinor: number; currency: string } };
type M = { amountMinor: number; currency: string };

let n = 0;
const row = (tripId: string) => database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
const version = async (tripId: string) => (await row(tripId)).version;
const money = (amountMinor: number, currency: string) => ({ amountMinor, currency });

/** A live trip a driver holds (accepted), in the zone's currency; its own rider (one live trip per rider). */
async function heldTrip(zone: Zone, driverId: string) {
  const id = await insertTrip(database.db, await insertRider(database.db), { status: "accepted", driverId });
  await database.db.updateTable("trips").set({ zone_id: zone.zone_id, currency: zone.currency, payment_method: "cash" }).where("trip_id", "=", id).execute();
  return id;
}
async function reassign(tripId: string, bonus: M) {
  const res = await call(app, "POST", `/admin/trips/${tripId}/reassign`, admin, { expectedVersion: await version(tripId), reasonCode: "admin_driver_request", note: "Driver stuck", driverBonus: bonus });
  expect(res.statusCode, res.body).toBe(200);
}
/** The next driver accepts (as the dispatch leaves the row). */
const accept = (tripId: string, driverId: string) =>
  database.db.updateTable("trips").set({ driver_id: driverId, status: "accepted", version: sql`version + 1` }).where("trip_id", "=", tripId).execute();
/** The trip completes with `driverId` on day `endedAt`, with its paid-end entries (creditTrip). */
async function complete(zone: Zone, tripId: string, driverId: string, endedAt: string, m: { fare: number; lines?: Line[]; earnings: number; pickup?: number; bonus?: number }) {
  const lines = m.lines ?? [{ code: "base", amount: money(m.fare, zone.currency) }];
  const pickup = m.pickup ?? 0;
  const bonus = m.bonus ?? 0;
  const commission = commissionOf(m.fare, lines, m.earnings, pickup, bonus);
  await database.db.updateTable("trips").set({
    driver_id: driverId, status: "completed", fare_minor: m.fare, booked_fare_minor: m.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: m.earnings,
    pickup_pay_minor: pickup, driver_bonus_minor: bonus, commission_minor: commission, ended_at: new Date(endedAt), updated_at: new Date(endedAt),
    payment_status: "captured", cash_collected_minor: m.fare, ended_by_command: "complete", version: sql`version + 1`,
  }).where("trip_id", "=", tripId).execute();
  const entry = (kind: "trip" | "pickup_pay" | "bonus", amount: number, c: number | null = null) =>
    database.db.insertInto("earnings_entries").values({ entry_id: `ern_m21_${++n}`, driver_id: driverId, trip_id: tripId, kind, currency: zone.currency, amount_minor: amount, gross_minor: null, commission_minor: c, cash_minor: null, at: new Date(endedAt) }).execute();
  await entry("trip", m.earnings, commission);
  if (pickup) await entry("pickup_pay", pickup);
  if (bonus) await entry("bonus", bonus);
  return commission;
}
type Split = { riderPaid: M; driverTotal: M; movera: M; debtCollected: M; refunded: M; lostDriverPaid?: M };
/** Every view of the trip: admin route, driver view, both streams (redacted from the stored admin projection), rider. */
async function views(tripId: string) {
  const adminRoute = (await call(app, "GET", `/admin/trips/${tripId}`, admin)).json() as Record<string, unknown>;
  const r = await row(tripId);
  const stored = tripProjection(r, "admin");
  return { adminRoute, split: adminRoute["moneySplit"] as Split, driver: tripProjection(r, "driver"), driverStream: redactProjection(stored, "driver"), rider: tripProjection(r, "rider"), riderStream: redactProjection(stored, "rider") };
}
function noLeak(v: Awaited<ReturnType<typeof views>>, ownTrip: M) {
  // The driver: what Movera keeps from his own trip, never moneySplit or the lost driver's money.
  for (const d of [v.driver, v.driverStream]) {
    expect(d).not.toHaveProperty("moneySplit");
    expect(d["moveraKeepsNow"]).toEqual(ownTrip);
    expect(JSON.stringify(d)).not.toContain("lostDriverPaid");
  }
  for (const rider of [v.rider, v.riderStream]) {
    expect(rider).not.toHaveProperty("moveraKeepsNow");
    expect(rider).not.toHaveProperty("moneySplit");
    expect(JSON.stringify(rider)).not.toContain("lostDriverPaid");
  }
}
const sumUp = (s: Split) => s.driverTotal.amountMinor + s.movera.amountMinor + s.debtCollected.amountMinor + (s.lostDriverPaid?.amountMinor ?? 0);

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  driverA = await insertDriver(database.db);
  driverB = await insertDriver(database.db);
  driverC = await insertDriver(database.db);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("BQ-M21: the lost driver's payment is taken off what Movera keeps on a reassigned trip", () => {
  it("SEK: A loses the trip with 30 kr, B completes 200 kr (150 kr pay) → Movera commission 20 kr (admin); B still sees 50 kr", async () => {
    const id = await heldTrip(SE, driverA);
    await reassign(id, money(3_000, "SEK"));
    await accept(id, driverB);
    const commission = await complete(SE, id, driverB, "2026-11-20T10:00:00Z", { fare: 20_000, earnings: 15_000 });
    expect(commission).toBe(5_000);
    const v = await views(id);
    expect(v.adminRoute["commission"]).toEqual(money(5_000, "SEK")); // stored: what Movera kept from B's trip
    expect(v.split.lostDriverPaid).toEqual(money(3_000, "SEK"));
    expect(v.split.movera).toEqual(money(2_000, "SEK"));
    expect(v.adminRoute["moveraKeepsNow"]).toEqual(v.split.movera);
    expect(sumUp(v.split)).toBe(v.split.riderPaid.amountMinor);
    noLeak(v, money(5_000, "SEK"));
    // KPI: the 30 kr is taken off once (BQ-M19), the same number as the trip's moneySplit.movera — not twice.
    const day = await countDay(database.db, SE, "2026-11-20");
    expect(day).toMatchObject({ commission: 5_000, driverBonus: 3_000 });
    expect(day.moveraEarnings).toBe(v.split.movera.amountMinor);
  });

  it("SEK, reassigned twice: A 30 kr, B 20 kr, C completes with a 10 kr bonus inside commission → both payments taken off", async () => {
    const id = await heldTrip(SE, driverA);
    await reassign(id, money(3_000, "SEK"));
    await accept(id, driverB);
    await reassign(id, money(2_000, "SEK"));
    await accept(id, driverC);
    const commission = await complete(SE, id, driverC, "2026-11-21T10:00:00Z", { fare: 30_000, earnings: 22_000, pickup: 500, bonus: 1_000 });
    expect(commission).toBe(6_500);
    const v = await views(id);
    expect(v.split.lostDriverPaid).toEqual(money(5_000, "SEK"));
    expect(v.split.driverTotal).toEqual(money(23_500, "SEK"));
    expect(v.split.movera).toEqual(money(1_500, "SEK"));
    expect(v.adminRoute["moveraKeepsNow"]).toEqual(money(1_500, "SEK"));
    expect(sumUp(v.split)).toBe(30_000);
    noLeak(v, money(6_500, "SEK"));
    const day = await countDay(database.db, SE, "2026-11-21");
    expect(day.moveraEarnings).toBe(1_500);
  });

  it("SEK: the lost driver gets the trip back and completes it → his earlier payment is still taken off once", async () => {
    const id = await heldTrip(SE, driverA);
    await reassign(id, money(2_500, "SEK"));
    await accept(id, driverA);
    await complete(SE, id, driverA, "2026-11-22T10:00:00Z", { fare: 20_000, earnings: 15_000 });
    const v = await views(id);
    expect(v.split.lostDriverPaid).toEqual(money(2_500, "SEK"));
    expect(v.split.movera).toEqual(money(2_500, "SEK"));
    const day = await countDay(database.db, SE, "2026-11-22");
    expect(day.moveraEarnings).toBe(2_500);
  });

  it("TND (3 decimals): an old 2.000 DT fee on the trip, A loses it with 1.250 DT, B completes → Movera commission 0.750 DT", async () => {
    const id = await heldTrip(TN, driverA);
    await reassign(id, money(1_250, "TND"));
    await accept(id, driverB);
    const lines: Line[] = [{ code: "base", amount: money(10_500, "TND") }, { code: "outstanding_fee", amount: money(2_000, "TND") }];
    const commission = await complete(TN, id, driverB, "2026-11-20T09:00:00Z", { fare: 12_500, lines, earnings: 8_000, pickup: 500 });
    expect(commission).toBe(2_000);
    const v = await views(id);
    expect(v.split.debtCollected).toEqual(money(2_000, "TND"));
    expect(v.split.lostDriverPaid).toEqual(money(1_250, "TND"));
    expect(v.split.movera).toEqual(money(750, "TND"));
    expect(v.adminRoute["moveraKeepsNow"]).toEqual(money(750, "TND"));
    expect(sumUp(v.split)).toBe(12_500);
    noLeak(v, money(2_000, "TND"));
    const day = await countDay(database.db, TN, "2026-11-20");
    expect(day.moveraEarnings).toBe(750);
  });

  it("TND, reassigned twice (1.000 + 0.500 DT), no lost-driver money on a trip without reassign", async () => {
    const id = await heldTrip(TN, driverA);
    await reassign(id, money(1_000, "TND"));
    await accept(id, driverB);
    await reassign(id, money(500, "TND"));
    await accept(id, driverC);
    await complete(TN, id, driverC, "2026-11-21T09:00:00Z", { fare: 20_000, earnings: 16_000 });
    const v = await views(id);
    expect(v.split.lostDriverPaid).toEqual(money(1_500, "TND"));
    expect(v.split.movera).toEqual(money(2_500, "TND"));
    noLeak(v, money(4_000, "TND"));
    // A plain trip: no lostDriverPaid key at all, moveraKeepsNow = commission.
    const plain = await heldTrip(TN, driverB);
    await complete(TN, plain, driverB, "2026-11-21T11:00:00Z", { fare: 20_000, earnings: 16_000 });
    const p = await views(plain);
    expect(p.split).not.toHaveProperty("lostDriverPaid");
    expect(p.split.movera).toEqual(money(4_000, "TND"));
  });

  it("the reassign's stored event already carries it (admin stream), and the driver stream of it never does", async () => {
    const id = await heldTrip(SE, driverA);
    await reassign(id, money(1_000, "SEK"));
    const last = await database.db.selectFrom("trip_events").select(["projection"]).where("trip_id", "=", id).orderBy("sequence", "desc").limit(1).executeTakeFirstOrThrow();
    const stored = last.projection as Record<string, unknown>;
    expect((stored["moneySplit"] as Split).lostDriverPaid).toEqual(money(1_000, "SEK"));
    expect(JSON.stringify(redactProjection(stored, "driver"))).not.toContain("lostDriverPaid");
    expect(JSON.stringify(redactProjection(stored, "rider"))).not.toContain("lostDriverPaid");
  });

  it("cancel with a lost-driver payment: the admin view shows it on the cancelled trip; the parts still add up", async () => {
    const id = await heldTrip(SE, driverB);
    const res = await call(app, "POST", `/admin/trips/${id}/cancel`, admin, { expectedVersion: await version(id), reasonCode: "admin_operational", note: "Road closed", driverBonus: money(4_000, "SEK") });
    expect(res.statusCode, res.body).toBe(200);
    const answer = res.json() as { moneySplit?: Split };
    expect(answer.moneySplit?.lostDriverPaid).toEqual(money(4_000, "SEK"));
    const v = await views(id);
    expect(v.split.lostDriverPaid).toEqual(money(4_000, "SEK"));
    expect(sumUp(v.split)).toBe(v.split.riderPaid.amountMinor);
    expect(v.driver).not.toHaveProperty("moveraKeepsNow");
  });

  it("migration 0107 backfills trips paid before it: every bonus entry of a trip with no paid end, other drivers' on a paid trip", async () => {
    const paid = await heldTrip(SE, driverB);
    await database.db.insertInto("earnings_entries").values({ entry_id: `ern_m21_${++n}`, driver_id: driverA, trip_id: paid, kind: "bonus", currency: "SEK", amount_minor: 3_000, gross_minor: null, commission_minor: null, cash_minor: null, at: clock.now }).execute();
    await complete(SE, paid, driverB, "2026-11-23T10:00:00Z", { fare: 20_000, earnings: 15_000, bonus: 1_000 });
    const expired = await heldTrip(SE, driverA);
    await database.db.updateTable("trips").set({ status: "expired", ended_at: clock.now }).where("trip_id", "=", expired).execute();
    await database.db.insertInto("earnings_entries").values({ entry_id: `ern_m21_${++n}`, driver_id: driverA, trip_id: expired, kind: "bonus", currency: "SEK", amount_minor: 700, gross_minor: null, commission_minor: null, cash_minor: null, at: clock.now }).execute();
    await database.db.updateTable("trips").set({ lost_driver_paid_minor: 0 }).where("trip_id", "in", [paid, expired]).execute();
    await sql.raw(readFileSync(new URL("../../migrations/0107_lost_driver_paid.sql", import.meta.url), "utf8")).execute(database.db);
    expect(Number((await row(paid)).lost_driver_paid_minor)).toBe(3_000);
    expect(Number((await row(expired)).lost_driver_paid_minor)).toBe(700);
    expect((await views(paid)).split.movera).toEqual(money(1_000, "SEK"));
  });
});
