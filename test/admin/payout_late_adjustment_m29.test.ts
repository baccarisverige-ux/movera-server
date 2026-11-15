import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/guard.js";
import { driverPayouts, listPayouts, makePayouts, markPayoutPaid } from "../../src/admin/payouts.js";
import { adminDriverBonus, adminRefund } from "../../src/admin/trips.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { commissionOf } from "../../src/rules/commission.js";
import { adminDriverPay } from "../../src/trips/finish.js";
import { tripProjection } from "../../src/trips/projection.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * BQ-M29 (M28 builder 2026-11-14, Rules plan/BUILD-QUEUE-2026-11-13.md:499; M28 supervisor §3.2 "BQ-M29 must REUSE the M28
 * machinery"; owner s06:1263 "Movera commission is how much Movera keeps, everywhere"): a pay change after the paid end
 * (adminDriverPay, finish.driverMoney.payChange) and the driver's share taken back by a refund (adminRefund fromDriver) are
 * `adjustment` entries written at their own time. They are inside the trip's moveraKeepsNow (driver_adjustments_minor is in
 * the driver's one number), but can be booked in a LATER payout than the trip entry. Each one moves Movera gets once, in the
 * payout that pays it, as M28 does for a late bonus: the trip's payout does not move, never twice, and a paid (frozen,
 * BQ-M26) payout never moves. Sweden (SEK) and Tunisia (TND).
 */

let database: TestDatabase;
let riderId: string;
const SUPER: Principal = { actor: "admin", subjectId: "adm_m29", sessionId: "s_m29", zones: ["*"], role: "super", perms: [] } as unknown as Principal;
const WEEK1 = { from: new Date("2026-11-02T00:00:00Z"), to: new Date("2026-11-09T00:00:00Z") };
const WEEK2 = { from: new Date("2026-11-09T00:00:00Z"), to: new Date("2026-11-16T00:00:00Z") };
const IN = new Date("2026-11-04T10:00:00Z");
const LATER = new Date("2026-11-10T12:00:00Z");
type Money = { amountMinor: number; currency: string };
const m = (amountMinor: number, currency: string): Money => ({ amountMinor, currency });

let n = 0;
const entry = (tripId: string, driverId: string, kind: "trip" | "fee_share" | "adjustment", amount: number, currency: string, cash = 0, at = IN) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_m29_${++n}`, driver_id: driverId, trip_id: tripId, kind, currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: cash, at }).execute();

/** A paid (completed, cash) trip with its trip entry, as finish.ts leaves it. */
async function paidTrip(driverId: string, t: { currency: string; fare: number; earnings: number; lines?: Array<{ code: string; amount: Money }> }): Promise<TripRow> {
  const id = await insertTrip(database.db, riderId, { status: "completed", driverId });
  const lines = t.lines ?? [{ code: "base", amount: m(t.fare, t.currency) }];
  await database.db.updateTable("trips").set({
    currency: t.currency, fare_minor: t.fare, booked_fare_minor: t.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: t.earnings, pickup_pay_minor: 0, driver_bonus_minor: 0,
    commission_minor: commissionOf(t.fare, lines, t.earnings, 0, 0), driver_adjustments_minor: 0, lost_driver_paid_minor: 0, payment_method: "cash", ended_at: IN,
    ended_by_command: "complete", payment_status: "captured", cash_collected_minor: t.fare,
  }).where("trip_id", "=", id).execute();
  await entry(id, driverId, "trip", t.earnings, t.currency, t.fare);
  return row(id);
}
const row = async (id: string) => (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
/** The admin's pay change on the ended trip (POST /admin/trips/{id}/driver-pay, the real code path). */
async function payChange(tripId: string, change: Money, at = LATER) {
  const t = await row(tripId);
  await database.db.transaction().execute((trx) => adminDriverPay(trx, SUPER, tripId, { expectedVersion: t.version, change, reason: "M29 test" }, at));
}
async function lateBonus(tripId: string, amount: Money, at = LATER) {
  const t = await row(tripId);
  await database.db.transaction().execute((trx) => adminDriverBonus(trx, SUPER, tripId, { expectedVersion: t.version, amount }, at));
}
const pay = async (driverId: string, week: { from: Date; to: Date }) =>
  (await database.db.transaction().execute((trx) => makePayouts(trx, { driverId, from: week.from, to: week.to, source: "manual", by: null }, new Date(week.to.getTime() + 3_600_000))))[0]!;
const markPaid = (payoutId: string, at: Date) => database.db.transaction().execute((trx) => markPayoutPaid(trx, SUPER, payoutId, {}, at));
async function summary(driverId: string, payoutId: string) {
  const mine = (await driverPayouts(database.db, driverId, { limit: 10 })).items.find((p) => p.payoutId === payoutId)!;
  const admin = (await listPayouts(database.db, SUPER, { limit: 10, driverId })).items.find((p) => p.payoutId === payoutId)!;
  return { mine: mine.summary!, admin: admin.summary! };
}
const keepsNow = async (tripId: string) => (tripProjection(await row(tripId), "admin")["moveraKeepsNow"] as Money).amountMinor;

beforeAll(async () => {
  database = await freshDatabase();
  riderId = await insertRider(database.db);
});
afterAll(async () => {
  await database.drop();
});

const CASES = [
  { name: "SEK", currency: "SEK", fare: 20_000, earnings: 15_000, change: 1_000, movera: 5_000, bonus: 500 },
  // TND 3 decimals: 22.000 DT ride (20.000 + 2.000 app fee), driver 16.000 DT, Movera 6.000 DT; a 1.500 DT pay change.
  { name: "TND", currency: "TND", fare: 22_000, earnings: 16_000, change: 1_500, movera: 6_000, bonus: 750, lines: [{ code: "base", amount: m(20_000, "TND") }, { code: "app_fee", amount: m(2_000, "TND") }] },
] as const;

describe.each(CASES)("BQ-M29 ($name): a pay change after the paid end moves Movera gets once, in the payout that pays it", (c) => {
  const lines = "lines" in c ? [...c.lines] : undefined;
  const trip = (d: string) => paidTrip(d, { currency: c.currency, fare: c.fare, earnings: c.earnings, ...(lines ? { lines } : {}) });
  const base = { driverGets: m(c.earnings, c.currency), moveraGets: m(c.movera, c.currency) };

  it("trip in payout 1, a + pay change in payout 2: payout 2's Movera gets goes down by it, payout 1 does not move, never twice", async () => {
    const d = await insertDriver(database.db);
    const t = await trip(d);
    const p1 = await pay(d, WEEK1);
    const before = await summary(d, p1.payout_id);
    expect(before.admin).toEqual(base);

    await payChange(t.trip_id, m(c.change, c.currency));
    const p2 = await pay(d, WEEK2);
    const one = await summary(d, p1.payout_id);
    const two = await summary(d, p2.payout_id);
    expect(one).toEqual(before);
    expect(two.admin).toEqual({ driverGets: m(c.change, c.currency), moveraGets: m(-c.change, c.currency) });
    expect(two.mine).toEqual(two.admin);
    expect(one.admin.moveraGets.amountMinor + two.admin.moveraGets.amountMinor).toBe(await keepsNow(t.trip_id));
    expect(await keepsNow(t.trip_id)).toBe(c.movera - c.change);
  });

  it("a − pay change (pay lowered) in payout 2: payout 2's Movera gets goes UP by it, payout 1 does not move", async () => {
    const d = await insertDriver(database.db);
    const t = await trip(d);
    const p1 = await pay(d, WEEK1);
    await payChange(t.trip_id, m(-c.change, c.currency));
    const p2 = await pay(d, WEEK2);
    expect(await summary(d, p1.payout_id)).toEqual({ mine: base, admin: base });
    const two = await summary(d, p2.payout_id);
    expect(two.admin).toEqual({ driverGets: m(-c.change, c.currency), moveraGets: m(c.change, c.currency) });
    expect(two.mine).toEqual(two.admin);
    expect(c.movera + two.admin.moveraGets.amountMinor).toBe(await keepsNow(t.trip_id));
  });

  it("trip and pay change in the same payout: counted once, not twice", async () => {
    const d = await insertDriver(database.db);
    const t = await trip(d);
    await payChange(t.trip_id, m(c.change, c.currency), new Date("2026-11-05T12:00:00Z"));
    const p1 = await pay(d, WEEK1);
    const s = await summary(d, p1.payout_id);
    expect(s.admin).toEqual({ driverGets: m(c.earnings + c.change, c.currency), moveraGets: m(c.movera - c.change, c.currency) });
    expect(s.mine).toEqual(s.admin);
  });

  it("pay change written before payout 2 exists: payout 1 stays unchanged meanwhile, and payout 2 takes it off when made", async () => {
    const d = await insertDriver(database.db);
    const t = await trip(d);
    const p1 = await pay(d, WEEK1);
    await payChange(t.trip_id, m(c.change, c.currency));
    expect((await summary(d, p1.payout_id)).admin).toEqual(base);
    const p2 = await pay(d, WEEK2);
    expect((await summary(d, p2.payout_id)).admin.moveraGets).toEqual(m(-c.change, c.currency));
    expect((await summary(d, p1.payout_id)).admin).toEqual(base);
  });

  it("frozen paid payout 1 (BQ-M26) never moves; payout 2 takes the pay change off", async () => {
    const d = await insertDriver(database.db);
    const t = await trip(d);
    const p1 = await pay(d, WEEK1);
    await markPaid(p1.payout_id, new Date("2026-11-09T09:00:00Z"));
    const frozen = await summary(d, p1.payout_id);
    expect(frozen.admin).toEqual(base);
    await payChange(t.trip_id, m(c.change, c.currency));
    const p2 = await pay(d, WEEK2);
    expect(await summary(d, p1.payout_id)).toEqual(frozen);
    const two = await summary(d, p2.payout_id);
    expect(two.admin).toEqual({ driverGets: m(c.change, c.currency), moveraGets: m(-c.change, c.currency) });
    expect(two.mine).toEqual(two.admin);
  });

  it("payout 1 marked paid after the pay change was written (not booked in it yet): frozen without it; payout 2 takes it off once", async () => {
    const d = await insertDriver(database.db);
    const t = await trip(d);
    const p1 = await pay(d, WEEK1);
    await payChange(t.trip_id, m(c.change, c.currency));
    await markPaid(p1.payout_id, new Date("2026-11-11T09:00:00Z"));
    const stored = await database.db.selectFrom("payouts").select("paid_summary").where("payout_id", "=", p1.payout_id).executeTakeFirstOrThrow();
    expect(stored.paid_summary).toEqual({ admin: base, driver: base });
    const p2 = await pay(d, WEEK2);
    expect((await summary(d, p2.payout_id)).admin.moveraGets).toEqual(m(-c.change, c.currency));
    expect(await summary(d, p1.payout_id)).toEqual({ mine: base, admin: base });
  });

  it("a refund taken from the driver booked in payout 2: his share taken back raises payout 2's Movera gets; the refund itself stays on the trip's payout", async () => {
    const d = await insertDriver(database.db);
    const t = await trip(d);
    const p1 = await pay(d, WEEK1);
    const refund = c.fare / 4;
    const share = Math.round((refund * c.earnings) / c.fare);
    const res = await database.db.transaction().execute((trx) => adminRefund(trx, SUPER, t.trip_id, { expectedVersion: t.version, amount: m(refund, c.currency), reason: "M29 test", fromDriver: true }, LATER));
    expect(res.status).toBe(201);
    const p2 = await pay(d, WEEK2);
    const two = await summary(d, p2.payout_id);
    expect(two.admin).toEqual({ driverGets: m(-share, c.currency), moveraGets: m(share, c.currency) });
    expect(two.mine).toEqual(two.admin);
    // Payout 1 (unpaid, live): the trip with the refund Movera paid (no entry of its own), without the share booked in payout 2.
    const one = await summary(d, p1.payout_id);
    expect(one.admin).toEqual({ driverGets: m(c.earnings, c.currency), moveraGets: m(c.movera - refund, c.currency) });
    expect(one.admin.moveraGets.amountMinor + two.admin.moveraGets.amountMinor).toBe(await keepsNow(t.trip_id));
  });

  it("M28 + M29 together: a late bonus in payout 2 and a pay change in payout 3, each taken off once where it is paid", async () => {
    const d = await insertDriver(database.db);
    const t = await trip(d);
    const p1 = await pay(d, WEEK1);
    await lateBonus(t.trip_id, m(c.bonus, c.currency));
    const p2 = await pay(d, WEEK2);
    const WEEK3 = { from: WEEK2.to, to: new Date("2026-11-23T00:00:00Z") };
    await payChange(t.trip_id, m(c.change, c.currency), new Date("2026-11-17T12:00:00Z"));
    const p3 = await pay(d, WEEK3);
    const [one, two, three] = [await summary(d, p1.payout_id), await summary(d, p2.payout_id), await summary(d, p3.payout_id)];
    expect(one.admin).toEqual(base);
    expect(two.admin).toEqual({ driverGets: m(c.bonus, c.currency), moveraGets: m(-c.bonus, c.currency) });
    expect(three.admin).toEqual({ driverGets: m(c.change, c.currency), moveraGets: m(-c.change, c.currency) });
    for (const s of [one, two, three]) expect(s.mine).toEqual(s.admin);
    expect(one.admin.moveraGets.amountMinor + two.admin.moveraGets.amountMinor + three.admin.moveraGets.amountMinor).toBe(await keepsNow(t.trip_id));
  });

  it("a no-show (no paid end) with its share taken back in a later payout: not a pay change of a paid trip, Movera gets as before", async () => {
    const d = await insertDriver(database.db);
    const share = c.change;
    const id = await insertTrip(database.db, riderId, { status: "no_show", driverId: d });
    // As adminReverseNoShow(takeBackDriverShare) leaves it: fee waived, share 0, commission 0; the fee share and its take-back.
    await database.db.updateTable("trips").set({ currency: c.currency, fare_minor: 0, fare_lines: JSON.stringify([]), driver_earnings_minor: 0, commission_minor: 0, driver_adjustments_minor: 0, ended_at: IN, ended_by_command: "no_show", payment_status: null }).where("trip_id", "=", id).execute();
    await entry(id, d, "fee_share", share, c.currency);
    await entry(id, d, "adjustment", -share, c.currency, 0, LATER);
    const p1 = await pay(d, WEEK1);
    const p2 = await pay(d, WEEK2);
    expect((await summary(d, p1.payout_id)).admin).toEqual({ driverGets: m(share, c.currency), moveraGets: m(0, c.currency) });
    const two = await summary(d, p2.payout_id);
    expect(two.admin).toEqual({ driverGets: m(-share, c.currency), moveraGets: m(0, c.currency) });
    expect(two.mine).toEqual(two.admin);
  });
});
