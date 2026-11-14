import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/guard.js";
import { driverPayouts, listPayouts, makePayouts, markPayoutPaid } from "../../src/admin/payouts.js";
import { adminDriverBonus } from "../../src/admin/trips.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { commissionOf } from "../../src/rules/commission.js";
import { tripProjection } from "../../src/trips/projection.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * BQ-M28 (V44 supervisor 2026-11-14, Rules audits/impact/v44-driver-bonuses-supervisor.md §2.3 "Not part of V44"; owner
 * s06:1263 "Movera commission is how much Movera keeps, everywhere"): an admin bonus written after the paid end (BQ-M19
 * afterPaidEnd, adminDriverBonus) is its own entry and can land in a LATER payout than its trip. Each such entry lowers
 * Movera gets once, in the payout that pays it (payoutSummary.entries "a late entry counts in the payout that pays it";
 * frozenWhenPaid "such a change shows only where it is booked"): the later payout's Movera gets goes down by it, the trip's
 * payout does not move, never twice, and a paid (frozen, BQ-M26) payout never moves. Sweden (SEK) and Tunisia (TND).
 */

let database: TestDatabase;
let riderId: string;
const SUPER: Principal = { actor: "admin", subjectId: "adm_m28", sessionId: "s_m28", zones: ["*"], role: "super", perms: [] } as unknown as Principal;
const WEEK1 = { from: new Date("2026-11-02T00:00:00Z"), to: new Date("2026-11-09T00:00:00Z") };
const WEEK2 = { from: new Date("2026-11-09T00:00:00Z"), to: new Date("2026-11-16T00:00:00Z") };
const IN = new Date("2026-11-04T10:00:00Z");
const LATER = new Date("2026-11-10T12:00:00Z");
type Money = { amountMinor: number; currency: string };
const m = (amountMinor: number, currency: string): Money => ({ amountMinor, currency });

let n = 0;
const entry = (tripId: string, driverId: string, kind: "trip" | "bonus", amount: number, currency: string, cash = 0, at = IN) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_m28_${++n}`, driver_id: driverId, trip_id: tripId, kind, currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: cash, at }).execute();

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
/** The admin's "Add money for driver" on the completed trip (M19 afterPaidEnd, the real code path). */
async function lateBonus(tripId: string, amount: Money, at = LATER) {
  const t = await row(tripId);
  await database.db.transaction().execute((trx) => adminDriverBonus(trx, SUPER, tripId, { expectedVersion: t.version, amount }, at));
}
const pay = async (driverId: string, week: { from: Date; to: Date }) =>
  (await database.db.transaction().execute((trx) => makePayouts(trx, { driverId, from: week.from, to: week.to, source: "manual", by: null }, new Date(week.to.getTime() + 3_600_000))))[0]!;
const markPaid = (payoutId: string, at: Date) => database.db.transaction().execute((trx) => markPayoutPaid(trx, SUPER, payoutId, {}, at));
/** Both views of one payout's summary. */
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
  { name: "SEK", currency: "SEK", fare: 20_000, earnings: 15_000, bonus: 1_000, movera: 5_000 },
  // TND 3 decimals: 22.000 DT ride (20.000 + 2.000 app fee), driver 16.000 DT, Movera 6.000 DT; a 1.500 DT late bonus.
  { name: "TND", currency: "TND", fare: 22_000, earnings: 16_000, bonus: 1_500, movera: 6_000, lines: [{ code: "base", amount: m(20_000, "TND") }, { code: "app_fee", amount: m(2_000, "TND") }] },
] as const;

describe.each(CASES)("BQ-M28 ($name): an after-paid-end bonus lowers Movera gets once, in the payout that pays it", (c) => {
  const lines = "lines" in c ? [...c.lines] : undefined;

  it("trip in payout 1, late bonus in payout 2: payout 2's Movera gets goes down by the bonus, payout 1 does not move, never twice", async () => {
    const d = await insertDriver(database.db);
    const t = await paidTrip(d, { currency: c.currency, fare: c.fare, earnings: c.earnings, ...(lines ? { lines } : {}) });
    const p1 = await pay(d, WEEK1);
    const before = await summary(d, p1.payout_id);
    expect(before.admin).toEqual({ driverGets: m(c.earnings, c.currency), moveraGets: m(c.movera, c.currency) });

    await lateBonus(t.trip_id, m(c.bonus, c.currency));
    const p2 = await pay(d, WEEK2);
    const one = await summary(d, p1.payout_id);
    const two = await summary(d, p2.payout_id);
    // Payout 1 (unpaid, live) is unchanged: the bonus is not booked there.
    expect(one).toEqual(before);
    // Payout 2 pays only the bonus: Driver gets it, Movera gets goes down by it (both views).
    expect(two.admin).toEqual({ driverGets: m(c.bonus, c.currency), moveraGets: m(-c.bonus, c.currency) });
    expect(two.mine).toEqual(two.admin);
    // No double count: across both payouts Movera gets = what Movera keeps now on the trip.
    expect(one.admin.moveraGets.amountMinor + two.admin.moveraGets.amountMinor).toBe(await keepsNow(t.trip_id));
    expect(await keepsNow(t.trip_id)).toBe(c.movera - c.bonus);
  });

  it("trip and late bonus in the same payout: taken off once, not twice", async () => {
    const d = await insertDriver(database.db);
    const t = await paidTrip(d, { currency: c.currency, fare: c.fare, earnings: c.earnings, ...(lines ? { lines } : {}) });
    await lateBonus(t.trip_id, m(c.bonus, c.currency), new Date("2026-11-05T12:00:00Z"));
    const p1 = await pay(d, WEEK1);
    const s = await summary(d, p1.payout_id);
    expect(s.admin).toEqual({ driverGets: m(c.earnings + c.bonus, c.currency), moveraGets: m(c.movera - c.bonus, c.currency) });
    expect(s.mine).toEqual(s.admin);
  });

  it("late bonus written before payout 2 exists: payout 1 stays unchanged meanwhile, and payout 2 takes it off when made", async () => {
    const d = await insertDriver(database.db);
    const t = await paidTrip(d, { currency: c.currency, fare: c.fare, earnings: c.earnings, ...(lines ? { lines } : {}) });
    const p1 = await pay(d, WEEK1);
    await lateBonus(t.trip_id, m(c.bonus, c.currency));
    // The bonus entry is in no payout yet: it is not booked in payout 1, so payout 1 does not move.
    expect((await summary(d, p1.payout_id)).admin).toEqual({ driverGets: m(c.earnings, c.currency), moveraGets: m(c.movera, c.currency) });
    const p2 = await pay(d, WEEK2);
    expect((await summary(d, p2.payout_id)).admin.moveraGets).toEqual(m(-c.bonus, c.currency));
    expect((await summary(d, p1.payout_id)).admin.moveraGets).toEqual(m(c.movera, c.currency));
  });

  it("frozen paid payout 1 (BQ-M26) never moves; payout 2 takes the bonus off", async () => {
    const d = await insertDriver(database.db);
    const t = await paidTrip(d, { currency: c.currency, fare: c.fare, earnings: c.earnings, ...(lines ? { lines } : {}) });
    const p1 = await pay(d, WEEK1);
    await markPaid(p1.payout_id, new Date("2026-11-09T09:00:00Z"));
    const frozen = await summary(d, p1.payout_id);
    expect(frozen.admin).toEqual({ driverGets: m(c.earnings, c.currency), moveraGets: m(c.movera, c.currency) });

    await lateBonus(t.trip_id, m(c.bonus, c.currency));
    const p2 = await pay(d, WEEK2);
    expect(await summary(d, p1.payout_id)).toEqual(frozen);
    const two = await summary(d, p2.payout_id);
    expect(two.admin).toEqual({ driverGets: m(c.bonus, c.currency), moveraGets: m(-c.bonus, c.currency) });
    expect(two.mine).toEqual(two.admin);
  });

  it("payout 1 marked paid after the late bonus was written (not booked in it yet): frozen without it; payout 2 takes it off once", async () => {
    const d = await insertDriver(database.db);
    const t = await paidTrip(d, { currency: c.currency, fare: c.fare, earnings: c.earnings, ...(lines ? { lines } : {}) });
    const p1 = await pay(d, WEEK1);
    await lateBonus(t.trip_id, m(c.bonus, c.currency));
    await markPaid(p1.payout_id, new Date("2026-11-11T09:00:00Z"));
    const stored = await database.db.selectFrom("payouts").select("paid_summary").where("payout_id", "=", p1.payout_id).executeTakeFirstOrThrow();
    const base = { driverGets: m(c.earnings, c.currency), moveraGets: m(c.movera, c.currency) };
    expect(stored.paid_summary).toEqual({ admin: base, driver: base });
    const p2 = await pay(d, WEEK2);
    expect((await summary(d, p2.payout_id)).admin.moveraGets).toEqual(m(-c.bonus, c.currency));
    expect(await summary(d, p1.payout_id)).toEqual({ mine: base, admin: base });
  });
});
