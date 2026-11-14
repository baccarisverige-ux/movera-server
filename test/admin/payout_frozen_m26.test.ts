import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/guard.js";
import { driverPayouts, listPayouts, makePayouts, markPayoutPaid } from "../../src/admin/payouts.js";
import { freezePaidPayoutSummaries } from "../../src/admin/payoutSummary.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { commissionOf } from "../../src/rules/commission.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * BQ-M26 (M24 supervisor N1, Rules audits/impact/server-m24-m22-supervisor.md:178; audits/impact/m26-payout-frozen.md):
 * a PAID payout's numbers never change (contract.json#priceDisplay.payoutSummary.frozenWhenPaid). Payout.summary
 * { driverGets, moveraGets } is frozen per view (driver, admin) when the payout is marked paid and served from
 * payouts.paid_summary (migration 0109) from then on; a later pay change or refund on one of its trips moves only
 * unpaid payouts. Payouts already paid before the deploy are frozen once at deploy (freezePaidPayoutSummaries, at start).
 */

let database: TestDatabase;
let riderId: string;
const SUPER: Principal = { actor: "admin", subjectId: "adm_m26", sessionId: "s_m26", zones: ["*"], role: "super", perms: [] } as unknown as Principal;
const FROM = new Date("2026-11-02T00:00:00Z");
const TO = new Date("2026-11-09T00:00:00Z");
const IN = new Date("2026-11-04T10:00:00Z");
const PAID_AT = new Date("2026-11-20T09:00:00Z");
type Money = { amountMinor: number; currency: string };
const m = (amountMinor: number, currency: string): Money => ({ amountMinor, currency });

let n = 0;
const entry = (tripId: string, driverId: string, kind: "trip" | "bonus" | "adjustment", amount: number, currency: string, cash = 0, at = IN) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_m26_${++n}`, driver_id: driverId, trip_id: tripId, kind, currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: cash, at }).execute();

async function paidTrip(driverId: string, t: { currency: string; fare: number; earnings: number; lines?: Array<{ code: string; amount: Money }>; lost?: number }): Promise<TripRow> {
  const id = await insertTrip(database.db, riderId, { status: "completed", driverId });
  const lines = t.lines ?? [{ code: "base", amount: m(t.fare, t.currency) }];
  await database.db.updateTable("trips").set({
    currency: t.currency, fare_minor: t.fare, booked_fare_minor: t.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: t.earnings, pickup_pay_minor: 0, driver_bonus_minor: 0,
    commission_minor: commissionOf(t.fare, lines, t.earnings, 0, 0), driver_adjustments_minor: 0, lost_driver_paid_minor: t.lost ?? 0, payment_method: "cash", ended_at: IN,
    ended_by_command: "complete", payment_status: "captured", cash_collected_minor: t.fare,
  }).where("trip_id", "=", id).execute();
  return (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
}
const pay = async (driverId: string) => (await database.db.transaction().execute((trx) => makePayouts(trx, { driverId, from: FROM, to: TO, source: "manual", by: null }, new Date("2026-11-19T00:00:00Z"))))[0]!;
const markPaid = (payoutId: string) => database.db.transaction().execute((trx) => markPayoutPaid(trx, SUPER, payoutId, {}, PAID_AT));
async function views(driverId: string) {
  const mine = (await driverPayouts(database.db, driverId, { limit: 10 })).items[0]!;
  const admin = (await listPayouts(database.db, SUPER, { limit: 10, driverId })).items[0]!;
  return { mine: mine.summary, admin: admin.summary };
}
/** A later pay change (+10 kr to the driver, Movera pays) on the trip, after the payout. */
const payChange = (tripId: string, amount: number) => database.db.updateTable("trips").set({ driver_adjustments_minor: amount }).where("trip_id", "=", tripId).execute();
/** A later refund Movera pays to the rider (lowers what Movera keeps on the trip). */
const refund = (tripId: string, amount: number) => database.db.updateTable("trips").set({ refunded_minor: amount, payment_status: "partially_refunded" }).where("trip_id", "=", tripId).execute();

beforeAll(async () => {
  database = await freshDatabase();
  riderId = await insertRider(database.db);
});
afterAll(async () => {
  await database.drop();
});

describe("BQ-M26: a paid payout's summary is frozen when it is marked paid", () => {
  it("SEK: a refund and a pay change after Mark as paid do not move the paid summary (driver and admin views, which differ)", async () => {
    const a = await insertDriver(database.db);
    const b = await insertDriver(database.db);
    // 200 kr trip, he gets 150 kr; A lost it before and was paid 30 kr (admin view takes it off).
    const t = await paidTrip(b, { currency: "SEK", fare: 20_000, earnings: 15_000, lost: 3_000 });
    await entry(t.trip_id, a, "bonus", 3_000, "SEK");
    await entry(t.trip_id, b, "trip", 15_000, "SEK", 20_000);
    const payout = await pay(b);
    const before = await views(b);
    expect(before.admin).toEqual({ driverGets: m(15_000, "SEK"), moveraGets: m(2_000, "SEK") });
    expect(before.mine).toEqual({ driverGets: m(15_000, "SEK"), moveraGets: m(5_000, "SEK") });

    const answer = await markPaid(payout.payout_id);
    expect(answer.summary).toEqual(before.admin);
    const stored = await database.db.selectFrom("payouts").select("paid_summary").where("payout_id", "=", payout.payout_id).executeTakeFirstOrThrow();
    expect(stored.paid_summary).toEqual({ admin: before.admin, driver: before.mine });

    await refund(t.trip_id, 5_000);
    await payChange(t.trip_id, 1_000);
    expect(await views(b)).toEqual(before);
  });

  it("SEK: an unpaid payout stays live (the same later pay change moves it)", async () => {
    const d = await insertDriver(database.db);
    const t = await paidTrip(d, { currency: "SEK", fare: 20_000, earnings: 15_000 });
    await entry(t.trip_id, d, "trip", 15_000, "SEK", 20_000);
    await pay(d);
    expect((await views(d)).admin).toEqual({ driverGets: m(15_000, "SEK"), moveraGets: m(5_000, "SEK") });
    await payChange(t.trip_id, 1_000);
    expect((await views(d)).admin).toEqual({ driverGets: m(15_000, "SEK"), moveraGets: m(4_000, "SEK") });
  });

  it("TND (3 decimals): 22.000 DT ride, Movera gets 6.000 DT frozen; a 2.000 DT refund afterwards does not move it", async () => {
    const c = await insertDriver(database.db);
    const lines = [{ code: "base", amount: m(20_000, "TND") }, { code: "app_fee", amount: m(2_000, "TND") }];
    const t = await paidTrip(c, { currency: "TND", fare: 22_000, lines, earnings: 16_000 });
    await entry(t.trip_id, c, "trip", 16_000, "TND", 22_000);
    const payout = await pay(c);
    await markPaid(payout.payout_id);
    await refund(t.trip_id, 2_000);
    const after = await views(c);
    expect(after.mine).toEqual({ driverGets: m(16_000, "TND"), moveraGets: m(6_000, "TND") });
    expect(after.admin).toEqual(after.mine);
  });

  it("backfill (freeze at deploy): a payout paid before the deploy is frozen once, at the values of that moment; unpaid payouts are left live", async () => {
    const e = await insertDriver(database.db);
    const t = await paidTrip(e, { currency: "SEK", fare: 20_000, earnings: 15_000 });
    await entry(t.trip_id, e, "trip", 15_000, "SEK", 20_000);
    const payout = await pay(e);
    // Paid by an older server: status paid, no frozen summary yet; a pay change came after the payment, before the deploy.
    await database.db.updateTable("payouts").set({ status: "paid", paid_at: PAID_AT, paid_by: "adm_old" }).where("payout_id", "=", payout.payout_id).execute();
    await payChange(t.trip_id, 1_000);
    const f = await insertDriver(database.db);
    const u = await paidTrip(f, { currency: "SEK", fare: 10_000, earnings: 8_000 });
    await entry(u.trip_id, f, "trip", 8_000, "SEK", 10_000);
    const unpaid = await pay(f);

    expect(await freezePaidPayoutSummaries(database.db)).toBeGreaterThanOrEqual(1);
    const atDeploy = { driverGets: m(15_000, "SEK"), moveraGets: m(4_000, "SEK") };
    expect(await views(e)).toEqual({ mine: atDeploy, admin: atDeploy });
    // After the deploy nothing moves it, and running the freeze again changes nothing.
    await refund(t.trip_id, 3_000);
    expect(await freezePaidPayoutSummaries(database.db)).toBe(0);
    expect(await views(e)).toEqual({ mine: atDeploy, admin: atDeploy });
    const left = await database.db.selectFrom("payouts").select("paid_summary").where("payout_id", "=", unpaid.payout_id).executeTakeFirstOrThrow();
    expect(left.paid_summary).toBeNull();
  });
});
