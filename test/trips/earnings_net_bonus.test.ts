import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { payoutLines } from "../../src/admin/payouts.js";
import { commissionOf } from "../../src/rules/commission.js";
import { driverEarnings } from "../../src/trips/ride/earnings.js";
import { creditTrip } from "../../src/trips/ride/finish.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/**
 * BQ-NET (Rules audits/impact/v44-driver-bonuses-supervisor.md §3 SF1): GET /driver/earnings `EarningsPeriod.net` counts
 * every `bonus` earnings entry, as the payout does (payoutLines: the bonus line):
 * - the trip bonus written at the paid end (creditTrip, finish.ts);
 * - an admin bonus after the paid end (POST /admin/trips/{id}/driver-bonus on a completed trip, admin/trips.ts);
 * - the lost-driver payment (POST /admin/trips/{id}/reassign driverBonus, admin/trips.ts payLostDriver).
 * Fail-before: net left every bonus out (earnings.ts:39), so Home today, Wallet this week and History showed less than
 * the payout pays. Card trips (no cash in the car), so net = the payout amount for the same entries.
 * Sweden (SEK, 2 decimals) and Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
let app: FastifyInstance;
let admin: Record<string, string>;
const clock = { now: new Date("2026-11-14T10:00:00Z") };
const SE = { zone_id: "Z001", time_zone: "Europe/Stockholm", currency: "SEK" };
const TN = { zone_id: "TN-TC", time_zone: "Africa/Tunis", currency: "TND" };
type Zone = typeof SE;

const row = (tripId: string) => database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
const money = (amountMinor: number, currency: string) => ({ amountMinor, currency });

/** A card trip the driver finished in the zone, with its paid-end entries written by the server's creditTrip. */
async function completed(zone: Zone, driverId: string, m: { fare: number; earnings: number; pickup: number; bonus: number }) {
  const id = await insertTrip(database.db, await insertRider(database.db), { status: "accepted", driverId });
  const lines = [{ code: "base", amount: money(m.fare, zone.currency) }];
  await database.db.updateTable("trips").set({
    zone_id: zone.zone_id, currency: zone.currency, payment_method: "card", status: "completed", fare_minor: m.fare, booked_fare_minor: m.fare,
    fare_lines: JSON.stringify(lines), driver_earnings_minor: m.earnings, pickup_pay_minor: m.pickup, driver_bonus_minor: m.bonus,
    commission_minor: commissionOf(m.fare, lines, m.earnings, m.pickup, m.bonus), ended_at: clock.now, updated_at: clock.now,
    payment_status: "captured", ended_by_command: "complete", version: sql`version + 1`,
  }).where("trip_id", "=", id).execute();
  const trip = await row(id);
  await database.db.transaction().execute((trx) => creditTrip(trx, trip, clock.now));
  return id;
}

/** Today's period of the driver's report, in the zone's clock and currency (what the driver app shows as net). */
async function today(zone: Zone, driverId: string) {
  const report = await driverEarnings(database.db, driverId, { period: "day", timeZone: zone.time_zone, currency: zone.currency }, clock.now);
  expect(report.periods).toHaveLength(1);
  return report.periods[0]!;
}

/** What a payout of all his entries pays (the server's payoutLines over the same rows). */
async function payoutOf(driverId: string, currency: string) {
  const entries = await database.db.selectFrom("earnings_entries").selectAll().where("driver_id", "=", driverId).where("currency", "=", currency).execute();
  return payoutLines(entries.map((e) => ({ kind: e.kind, amountMinor: Number(e.amount_minor), cashMinor: Number(e.cash_minor ?? 0), waitingMinor: 0 })));
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

const cases = [
  { zone: SE, fare: 20_000, earnings: 15_000, pickup: 1_000, tripBonus: 3_000, afterEnd: 2_000, lost: 2_500 },
  { zone: TN, fare: 20_000, earnings: 15_000, pickup: 1_000, tripBonus: 1_500, afterEnd: 1_250, lost: 1_000 },
] as const;

describe("BQ-NET: EarningsPeriod.net counts every bonus entry, as the payout does", () => {
  for (const c of cases) {
    const cur = c.zone.currency;

    it(`${cur}: the trip bonus written at the paid end (finish.ts creditTrip) is in net`, async () => {
      const driverId = await insertDriver(database.db);
      await completed(c.zone, driverId, { fare: c.fare, earnings: c.earnings, pickup: c.pickup, bonus: c.tripBonus });
      const p = await today(c.zone, driverId);
      expect(p.net).toEqual(money(c.earnings + c.pickup + c.tripBonus, cur));
      expect(p.net.amountMinor).toBe((await payoutOf(driverId, cur)).amountMinor);
    });

    it(`${cur}: an admin bonus after the paid end (POST /admin/trips/{id}/driver-bonus on a completed trip) is in net`, async () => {
      const driverId = await insertDriver(database.db);
      const tripId = await completed(c.zone, driverId, { fare: c.fare, earnings: c.earnings, pickup: c.pickup, bonus: 0 });
      const res = await call(app, "POST", `/admin/trips/${tripId}/driver-bonus`, admin, { expectedVersion: (await row(tripId)).version, amount: money(c.afterEnd, cur) });
      expect(res.statusCode, res.body).toBe(200);
      const p = await today(c.zone, driverId);
      expect(p.net).toEqual(money(c.earnings + c.pickup + c.afterEnd, cur));
      expect(p.net.amountMinor).toBe((await payoutOf(driverId, cur)).amountMinor);
    });

    it(`${cur}: the lost-driver payment (POST /admin/trips/{id}/reassign driverBonus) is in the lost driver's net`, async () => {
      const driverId = await insertDriver(database.db);
      const tripId = await insertTrip(database.db, await insertRider(database.db), { status: "accepted", driverId });
      await database.db.updateTable("trips").set({ zone_id: c.zone.zone_id, currency: cur, payment_method: "card" }).where("trip_id", "=", tripId).execute();
      const res = await call(app, "POST", `/admin/trips/${tripId}/reassign`, admin, { expectedVersion: (await row(tripId)).version, reasonCode: "admin_driver_request", note: "Driver stuck", driverBonus: money(c.lost, cur) });
      expect(res.statusCode, res.body).toBe(200);
      const p = await today(c.zone, driverId);
      expect(p.tripCount).toBe(0);
      expect(p.net).toEqual(money(c.lost, cur));
      expect(p.net.amountMinor).toBe((await payoutOf(driverId, cur)).amountMinor);
    });

    it(`${cur}: all three on one driver's day → net = the sum the payout pays for those entries (its bonus line included)`, async () => {
      const driverId = await insertDriver(database.db);
      const lostTrip = await insertTrip(database.db, await insertRider(database.db), { status: "accepted", driverId });
      await database.db.updateTable("trips").set({ zone_id: c.zone.zone_id, currency: cur, payment_method: "card" }).where("trip_id", "=", lostTrip).execute();
      const lost = await call(app, "POST", `/admin/trips/${lostTrip}/reassign`, admin, { expectedVersion: (await row(lostTrip)).version, reasonCode: "admin_driver_request", note: "Driver stuck", driverBonus: money(c.lost, cur) });
      expect(lost.statusCode, lost.body).toBe(200);
      const tripId = await completed(c.zone, driverId, { fare: c.fare, earnings: c.earnings, pickup: c.pickup, bonus: c.tripBonus });
      const after = await call(app, "POST", `/admin/trips/${tripId}/driver-bonus`, admin, { expectedVersion: (await row(tripId)).version, amount: money(c.afterEnd, cur) });
      expect(after.statusCode, after.body).toBe(200);
      const p = await today(c.zone, driverId);
      const payout = await payoutOf(driverId, cur);
      expect(payout.lines.find((l) => l.code === "bonus")?.amountMinor).toBe(c.tripBonus + c.afterEnd + c.lost);
      expect(p.net).toEqual(money(c.earnings + c.pickup + c.tripBonus + c.afterEnd + c.lost, cur));
      expect(p.net.amountMinor).toBe(payout.amountMinor);
      // The other money fields are unchanged by the fix (adjustments is not where a bonus goes).
      expect(p.adjustments).toEqual(money(0, cur));
      expect(p.pickupPay).toEqual(money(c.pickup, cur));
      // v0.18.110 BQ-V44 (NET supervisor V44-N1): EarningsPeriod.bonus now comes, = the period's bonus entries, a part
      // ALREADY inside net — net above is the same number as before the field (not counted twice).
      expect(p.bonus).toEqual(money(c.tripBonus + c.afterEnd + c.lost, cur));
      expect(p).not.toHaveProperty("paidToMovera");
    });
  }
});
