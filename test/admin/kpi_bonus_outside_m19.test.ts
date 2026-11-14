import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countDay, summarize } from "../../src/admin/kpis.js";
import { redactProjection } from "../../src/realtime/events.js";
import { commissionOf } from "../../src/rules/commission.js";
import { tripProjection } from "../../src/trips/projection.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/**
 * BQ-M19 (contract v0.18.87 moneyBase.bonusOutsideCommission + moneyBase.commissionRow; owner 107 "Yes, count + fix old
 * days (Rec.)", the approved B2.4 plan naming the lost-driver bonus; owner 2026-11-13 "Movera commission is how much
 * movera keep"):
 * - moveraEarnings takes the bonus entries OUTSIDE the trip's commission off once. Inside is decided by the stored
 *   commission, never by timestamps: on a paid trip inside = fare − debtCollected − driverEarnings − pickupPay − commission;
 *   outside = the trip's bonus entries − inside; on a trip with no paid end every bonus entry is outside.
 * - An admin bonus on a completed trip never rewrites trips.commission_minor (nor the trip's earnings entry).
 * - TripProjection.moveraKeepsNow = moneySplit.movera on paid trips, driver and admin views; absent otherwise; never to the rider.
 * Sweden (SEK) and Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
let app: FastifyInstance;
let admin: Record<string, string>;
let riderId: string;
let driverA: string;
let driverB: string;
const clock = { now: new Date("2026-11-13T10:00:00Z") };
const SE = { zone_id: "Z001", time_zone: "Europe/Stockholm", currency: "SEK" };
const TN = { zone_id: "TN-TC", time_zone: "Africa/Tunis", currency: "TND" };

type Line = { code: string; amount: { amountMinor: number; currency: string } };
let n = 0;
const entry = (tripId: string, driverId: string, kind: "trip" | "pickup_pay" | "bonus", amount: number, currency: string, commission: number | null = null) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_m19_${++n}`, driver_id: driverId, trip_id: tripId, kind, currency, amount_minor: amount, gross_minor: null, commission_minor: commission, cash_minor: null, at: clock.now }).execute();

/** A trip row as the server leaves it; `commission` overrides the formula (an old row a later bonus rewrote). */
async function trip(zone: typeof SE, status: string, endedAt: string, m: { driverId: string; fare: number; lines?: Line[]; earnings?: number; pickup?: number; bonus?: number; paid?: boolean; commission?: number }) {
  const id = await insertTrip(database.db, riderId, { status, driverId: m.driverId });
  const lines = m.lines ?? [{ code: "base", amount: { amountMinor: m.fare, currency: zone.currency } }];
  const earnings = m.earnings ?? 0;
  const pickup = m.pickup ?? 0;
  const bonus = m.bonus ?? 0;
  const commission = m.commission ?? commissionOf(m.fare, lines, earnings, pickup, bonus);
  await database.db.updateTable("trips").set({
    zone_id: zone.zone_id, currency: zone.currency, fare_minor: m.fare, booked_fare_minor: m.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: earnings,
    pickup_pay_minor: pickup, driver_bonus_minor: bonus, commission_minor: commission, payment_method: "cash",
    ended_at: new Date(endedAt), updated_at: new Date(endedAt), payment_status: m.paid ? "captured" : null, cash_collected_minor: m.paid ? m.fare : null,
    ended_by_command: m.paid ? "complete" : "cancel",
  }).where("trip_id", "=", id).execute();
  return { id, commission };
}
const debtLines = (base: number, debt: number, currency: string): Line[] => [
  { code: "base", amount: { amountMinor: base, currency } },
  { code: "outstanding_fee", amount: { amountMinor: debt, currency } },
];

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  riderId = await insertRider(database.db);
  driverA = await insertDriver(database.db);
  driverB = await insertDriver(database.db);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("BQ-M19: bonus entries outside commission are taken off moveraEarnings once (moneyBase.bonusOutsideCommission)", () => {
  it("SEK reassign: A gets a 30 kr lost-driver bonus, B completes with a 10 kr bonus inside commission → only the 30 kr is taken off", async () => {
    // B: 200 kr fare, 150 kr earnings, 10 kr bonus at the paid end → commission 40 kr.
    const { id, commission } = await trip(SE, "completed", "2026-11-02T10:00:00Z", { driverId: driverB, fare: 20_000, earnings: 15_000, bonus: 1_000, paid: true });
    expect(commission).toBe(4_000);
    await entry(id, driverA, "bonus", 3_000, "SEK"); // payLostDriver, written before B took the trip
    await entry(id, driverB, "trip", 15_000, "SEK", 4_000);
    await entry(id, driverB, "bonus", 1_000, "SEK"); // creditTrip at the paid end: inside commission
    const day = await countDay(database.db, SE, "2026-11-02");
    expect(day).toMatchObject({ commission: 4_000, driverBonus: 4_000 });
    expect(day.moveraEarnings).toBe(4_000 - 3_000);
  });

  it("SEK cancelled trip with a 15 kr lost-driver bonus (no paid end): every bonus entry is outside", async () => {
    const { id } = await trip(SE, "cancelled_by_admin", "2026-11-03T10:00:00Z", { driverId: driverA, fare: 25_000 });
    await entry(id, driverA, "bonus", 1_500, "SEK");
    const day = await countDay(database.db, SE, "2026-11-03");
    expect(day).toMatchObject({ commission: 0, driverBonus: 1_500 });
    expect(day.moveraEarnings).toBe(-1_500);
  });

  it("SEK bonus after the paid end (commission kept at the end): the 20 kr is taken off once", async () => {
    // 300 kr, 240 kr earnings, commission 60 kr kept; a later 20 kr bonus grew driver_bonus_minor and wrote its entry.
    const { id } = await trip(SE, "completed", "2026-11-04T10:00:00Z", { driverId: driverA, fare: 30_000, earnings: 24_000, bonus: 2_000, paid: true, commission: 6_000 });
    await entry(id, driverA, "trip", 24_000, "SEK", 6_000);
    await entry(id, driverA, "bonus", 2_000, "SEK");
    const day = await countDay(database.db, SE, "2026-11-04");
    expect(day.commission).toBe(6_000);
    expect(day.moveraEarnings).toBe(6_000 - 2_000);
  });

  it("SEK old row whose commission a later bonus rewrote (before v0.18.87): the bonus is inside, never taken off twice", async () => {
    // Same trip, but :293 rewrote the commission to 40 kr: the 20 kr is already off it.
    const { id } = await trip(SE, "completed", "2026-11-05T10:00:00Z", { driverId: driverA, fare: 30_000, earnings: 24_000, bonus: 2_000, paid: true });
    await entry(id, driverA, "trip", 24_000, "SEK", 6_000);
    await entry(id, driverA, "bonus", 2_000, "SEK");
    // Plus a lost-driver bonus on another trip the same day: that one is still taken off.
    const lost = await trip(SE, "cancelled_by_admin", "2026-11-05T11:00:00Z", { driverId: driverB, fare: 9_000 });
    await entry(lost.id, driverB, "bonus", 500, "SEK");
    const day = await countDay(database.db, SE, "2026-11-05");
    expect(day.commission).toBe(4_000);
    expect(day.moveraEarnings).toBe(4_000 - 500);
  });

  it("TND (3 decimals): reassign with an old 2.000 DT fee on the trip, a bonus after the end, a cancel with a lost-driver bonus", async () => {
    // 12.500 DT incl. a 2.000 DT outstanding_fee line, 8.000 DT earnings, 0.500 DT pickup, 1.000 DT bonus at the end.
    const reassigned = await trip(TN, "completed", "2026-11-02T09:00:00Z", { driverId: driverB, fare: 12_500, lines: debtLines(10_500, 2_000, "TND"), earnings: 8_000, pickup: 500, bonus: 1_000, paid: true });
    expect(reassigned.commission).toBe(1_000);
    await entry(reassigned.id, driverA, "bonus", 1_250, "TND");
    await entry(reassigned.id, driverB, "bonus", 1_000, "TND");
    // 4.250 DT, 3.000 DT earnings, commission 1.250 DT kept; a later 0.750 DT bonus.
    const after = await trip(TN, "completed", "2026-11-02T10:00:00Z", { driverId: driverA, fare: 4_250, earnings: 3_000, bonus: 750, paid: true, commission: 1_250 });
    await entry(after.id, driverA, "bonus", 750, "TND");
    const cancelled = await trip(TN, "cancelled_by_admin", "2026-11-02T11:00:00Z", { driverId: driverA, fare: 6_000 });
    await entry(cancelled.id, driverA, "bonus", 2_000, "TND");
    const day = await countDay(database.db, TN, "2026-11-02");
    expect(day).toMatchObject({ commission: 1_000 + 1_250, driverBonus: 1_250 + 1_000 + 750 + 2_000 });
    expect(day.moveraEarnings).toBe(1_000 + 1_250 - 1_250 - 750 - 2_000);
  });
});

/** A completed trip that ended on an older day, its paid-end entries, and that day already stored in kpi_days. */
async function storedTrip(zone: typeof SE, day: string) {
  const { id } = await trip(zone, "completed", `${day}T10:00:00Z`, { driverId: driverA, fare: 30_000, earnings: 24_000, paid: true });
  await entry(id, driverA, "trip", 24_000, zone.currency, 6_000);
  await database.db.transaction().execute((trx) => summarize(trx, clock.now, day));
  return id;
}
const version = async (tripId: string) => (await database.db.selectFrom("trips").select("version").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).version;
const storedMovera = async (zone: string, day: string) =>
  Number((await database.db.selectFrom("kpi_days").select("movera_earnings_minor").where("zone_id", "=", zone).where("day", "=", day).executeTakeFirstOrThrow()).movera_earnings_minor);
const row = (tripId: string) => database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();

describe("BQ-M19: an admin bonus after the paid end keeps the commission; moveraKeepsNow = moneySplit.movera", () => {
  for (const c of [{ zone: SE, day: "2026-11-08", bonus: 2_000 }, { zone: TN, day: "2026-11-09", bonus: 1_500 }] as const) {
    it(`${c.zone.currency}: POST /admin/trips/{id}/driver-bonus on a completed trip → commission and its entry unchanged, Movera keeps less`, async () => {
      const tripId = await storedTrip(c.zone, c.day);
      const before = await storedMovera(c.zone.zone_id, c.day);
      const res = await call(app, "POST", `/admin/trips/${tripId}/driver-bonus`, admin, { expectedVersion: await version(tripId), amount: { amountMinor: c.bonus, currency: c.zone.currency } });
      expect(res.statusCode, res.body).toBe(200);
      const after = await row(tripId);
      expect(Number(after.commission_minor)).toBe(6_000);
      expect(Number(after.driver_bonus_minor)).toBe(c.bonus);
      const entries = await database.db.selectFrom("earnings_entries").select(["kind", "amount_minor", "commission_minor"]).where("trip_id", "=", tripId).orderBy("kind").execute();
      expect(entries.map((e) => [e.kind, Number(e.amount_minor), e.commission_minor === null ? null : Number(e.commission_minor)])).toEqual([["bonus", c.bonus, null], ["trip", 24_000, 6_000]]);
      // The stored day: the bonus is taken off once (outside commission).
      expect(await storedMovera(c.zone.zone_id, c.day)).toBe(before - c.bonus);
      // What Movera keeps now, on the admin route and on the driver view.
      const view = (await call(app, "GET", `/admin/trips/${tripId}`, admin)).json();
      expect(view.commission).toEqual({ amountMinor: 6_000, currency: c.zone.currency });
      expect(view.moneySplit.movera).toEqual({ amountMinor: 6_000 - c.bonus, currency: c.zone.currency });
      expect(view.moveraKeepsNow).toEqual(view.moneySplit.movera);
      const driver = tripProjection(after, "driver");
      expect(driver).not.toHaveProperty("moneySplit");
      expect(driver.moveraKeepsNow).toEqual(view.moneySplit.movera);
    });
  }

  it("SEK: POST /admin/trips/{id}/cancel with a lost-driver bonus → today's moveraEarnings drop by it", async () => {
    const id = await insertTrip(database.db, riderId, { status: "accepted", driverId: driverB });
    await database.db.updateTable("trips").set({ zone_id: "Z001" }).where("trip_id", "=", id).execute();
    const before = await countDay(database.db, SE, "2026-11-13");
    const res = await call(app, "POST", `/admin/trips/${id}/cancel`, admin, { expectedVersion: await version(id), reasonCode: "admin_operational", note: "Road closed", driverBonus: { amountMinor: 5_000, currency: "SEK" } });
    expect(res.statusCode, res.body).toBe(200);
    const day = await countDay(database.db, SE, "2026-11-13");
    expect(day.driverBonus).toBe(before.driverBonus + 5_000);
    expect(day.moveraEarnings).toBe(before.moveraEarnings - 5_000);
    // Not a paid trip: no moveraKeepsNow on any view.
    const cancelled = await row(id);
    expect(tripProjection(cancelled, "admin")).not.toHaveProperty("moveraKeepsNow");
    expect(tripProjection(cancelled, "driver")).not.toHaveProperty("moveraKeepsNow");
  });

  it("moveraKeepsNow: equals moneySplit.movera on a paid trip (driver, admin, driver stream); never to the rider; absent before the paid end", async () => {
    const { id } = await trip(SE, "completed", "2026-11-10T10:00:00Z", { driverId: driverA, fare: 9_500, earnings: 6_922, pickup: 105, paid: true });
    const paid = await row(id);
    const adminView = tripProjection(paid, "admin");
    expect((adminView.moneySplit as { movera: unknown }).movera).toEqual({ amountMinor: 2_473, currency: "SEK" });
    expect(adminView.moveraKeepsNow).toEqual((adminView.moneySplit as { movera: unknown }).movera);
    expect(tripProjection(paid, "driver").moveraKeepsNow).toEqual({ amountMinor: 2_473, currency: "SEK" });
    expect(tripProjection(paid, "rider")).not.toHaveProperty("moveraKeepsNow");
    // The stored event is the admin projection: the driver stream keeps it, the rider stream drops it.
    expect(redactProjection(adminView, "driver").moveraKeepsNow).toEqual({ amountMinor: 2_473, currency: "SEK" });
    expect(redactProjection(adminView, "rider")).not.toHaveProperty("moveraKeepsNow");
    // A trip on its way (no paid end yet).
    const onTrip = await insertTrip(database.db, riderId, { status: "in_trip", driverId: driverA });
    const live = await row(onTrip);
    expect(tripProjection(live, "admin")).not.toHaveProperty("moveraKeepsNow");
    expect(tripProjection(live, "driver")).not.toHaveProperty("moveraKeepsNow");
  });
});
