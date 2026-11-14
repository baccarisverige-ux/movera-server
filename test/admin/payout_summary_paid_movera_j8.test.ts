import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/guard.js";
import { driverPaidMovera } from "../../src/admin/driversOwing.js";
import { driverPayouts, listPayouts, makePayouts } from "../../src/admin/payouts.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { commissionOf } from "../../src/rules/commission.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * J8 x M22 / M26 money fix (Rules handover/build-plans-2026-11-13/J8-group-rebase.txt "MONEY CONFLICT"):
 * 1. Payout.summary "Driver gets" is his earnings for the period, all trips (owner, decisions/session-2026-11-06.md:1277);
 *    a "Driver paid Movera" entry (kind paid_to_movera) is money FROM the driver, not earnings: it is in neither
 *    Driver gets nor Movera gets, in the payout it closes nor in the next payout (the rest above the carried part).
 *    The payout's own amount / lines stay as they are.
 * 2. A payout that "Driver paid Movera" covers is paid, so its summary is frozen at that moment (owner M26: a paid
 *    payout's numbers never change), the same as Mark as paid.
 */

let database: TestDatabase;
let riderId: string;
const SUPER: Principal = { actor: "admin", subjectId: "adm_j8pm", sessionId: "s_j8pm", zones: ["*"], role: "super", perms: [] } as unknown as Principal;
const FROM = new Date("2026-11-02T00:00:00Z");
const TO = new Date("2026-11-09T00:00:00Z");
const IN = new Date("2026-11-04T10:00:00Z");
const RUN = new Date("2026-11-10T00:00:00Z");
const PAID_AT = new Date("2026-11-12T09:00:00Z");
const NEXT_IN = new Date("2026-11-13T10:00:00Z");
const NEXT_RUN = new Date("2026-11-17T00:00:00Z");
type Money = { amountMinor: number; currency: string };
const m = (amountMinor: number, currency: string): Money => ({ amountMinor, currency });

let n = 0;
const entry = (tripId: string | null, driverId: string, kind: "trip" | "bonus" | "adjustment", amount: number, currency: string, cash = 0, at = IN) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_j8pm_${++n}`, driver_id: driverId, trip_id: tripId, kind, currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: cash, at }).execute();

async function paidTrip(driverId: string, t: { currency: string; fare: number; earnings: number; lines?: Array<{ code: string; amount: Money }> }): Promise<TripRow> {
  const id = await insertTrip(database.db, riderId, { status: "completed", driverId });
  const lines = t.lines ?? [{ code: "base", amount: m(t.fare, t.currency) }];
  await database.db.updateTable("trips").set({
    currency: t.currency, fare_minor: t.fare, booked_fare_minor: t.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: t.earnings, pickup_pay_minor: 0, driver_bonus_minor: 0,
    commission_minor: commissionOf(t.fare, lines, t.earnings, 0, 0), driver_adjustments_minor: 0, lost_driver_paid_minor: 0, payment_method: "cash", ended_at: IN,
    ended_by_command: "complete", payment_status: "captured", cash_collected_minor: t.fare,
  }).where("trip_id", "=", id).execute();
  return (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
}
const pay = async (driverId: string, from = FROM, to = TO, at = RUN) => (await database.db.transaction().execute((trx) => makePayouts(trx, { driverId, from, to, source: "manual", by: null }, at)))[0]!;
const paidMovera = (driverId: string, owed: Money, amount: Money) =>
  database.db.transaction().execute((trx) => driverPaidMovera(trx, SUPER, driverId, { expectedOwed: owed, amount, reason: "Bank transfer" }, PAID_AT));
async function views(driverId: string, payoutId: string) {
  const mine = (await driverPayouts(database.db, driverId, { limit: 10 })).items.find((p) => p.payoutId === payoutId)!;
  const admin = (await listPayouts(database.db, SUPER, { limit: 10, driverId })).items.find((p) => p.payoutId === payoutId)!;
  return { mine: mine.summary, admin: admin.summary };
}
const payoutRow = (payoutId: string) => database.db.selectFrom("payouts").select(["status", "amount_minor", "paid_summary"]).where("payout_id", "=", payoutId).executeTakeFirstOrThrow();

beforeAll(async () => {
  database = await freshDatabase();
  riderId = await insertRider(database.db);
});
afterAll(async () => {
  await database.drop();
});

describe("J8: Driver paid Movera is not in Driver gets / Movera gets (owner s06:1277 'his earnings for the period')", () => {
  it("SEK: a carried −100 kr payout closed by Driver paid Movera 100 kr never shows Driver gets 100 kr; its amount stays −100 kr", async () => {
    const d = await insertDriver(database.db);
    // The carried rest as the J8 probe had it: an open payout of −100 kr (its entries are in an older, paid payout).
    const id = `pyt_j8pm_${++n}`;
    await database.db.insertInto("payouts").values({ payout_id: id, driver_id: d, zone_id: null, currency: "SEK", amount_minor: -10_000, lines: JSON.stringify([]), trip_count: 0, source: "weekly", period_start: FROM, period_end: TO, note: null, created_by: null, created_at: RUN }).execute();
    await paidMovera(d, m(10_000, "SEK"), m(10_000, "SEK"));
    const row = await payoutRow(id);
    expect(row.status).toBe("paid");
    expect(Number(row.amount_minor)).toBe(-10_000);
    // Fail-before (the probe): driverGets 10 000 = "Driver gets 100,00 kr" on a payout where he PAID Movera 100 kr.
    const v = await views(d, id);
    expect(v.admin).toEqual({ driverGets: m(0, "SEK"), moveraGets: m(0, "SEK") });
    expect(v.mine).toEqual({ driverGets: m(0, "SEK"), moveraGets: m(0, "SEK") });
  });

  it("SEK: a cash trip (200 kr cash, he earns 160 kr) carried −40 kr, closed by Driver paid Movera 40 kr: Driver gets 160 kr, Movera gets 40 kr", async () => {
    const d = await insertDriver(database.db);
    const t = await paidTrip(d, { currency: "SEK", fare: 20_000, earnings: 16_000 });
    await entry(t.trip_id, d, "trip", 16_000, "SEK", 20_000);
    const carried = await pay(d);
    expect(Number(carried.amount_minor)).toBe(-4_000);
    const before = await views(d, carried.payout_id);
    expect(before.admin).toEqual({ driverGets: m(16_000, "SEK"), moveraGets: m(4_000, "SEK") });
    await paidMovera(d, m(4_000, "SEK"), m(4_000, "SEK"));
    // Fail-before: driverGets 20 000 (his 160 kr earnings + the 40 kr he PAID Movera).
    expect(await views(d, carried.payout_id)).toEqual(before);
    expect(Number((await payoutRow(carried.payout_id)).amount_minor)).toBe(-4_000);
  });

  it("SEK: the part above the carried rest (50 kr) goes to the next payout as a paid_to_movera line, but not into its Driver gets", async () => {
    const d = await insertDriver(database.db);
    await entry(null, d, "adjustment", -10_000, "SEK");
    const carried = await pay(d);
    // This week: a 10 kr bonus and a −60 kr correction, unpaid: −50 kr more owed. Owed 150 kr, he pays 150 kr.
    await entry(null, d, "bonus", 1_000, "SEK", 0, NEXT_IN);
    await entry(null, d, "adjustment", -6_000, "SEK", 0, NEXT_IN);
    await paidMovera(d, m(15_000, "SEK"), m(15_000, "SEK"));
    expect((await payoutRow(carried.payout_id)).status).toBe("paid");
    const next = await pay(d, TO, NEXT_RUN, NEXT_RUN);
    // The payout's own maths stay: 10 − 60 + 50 = 0 kr, with its paid_to_movera line.
    expect(Number(next.amount_minor)).toBe(0);
    expect((next.lines as Array<{ code: string; amountMinor: number }>).find((l) => l.code === "paid_to_movera")?.amountMinor).toBe(5_000);
    // Fail-before: driverGets 0 (10 − 60 + 50); his earnings for the period are 10 − 60 = −50 kr.
    const v = await views(d, next.payout_id);
    expect(v.admin).toEqual({ driverGets: m(-5_000, "SEK"), moveraGets: m(0, "SEK") });
    expect(v.mine).toEqual(v.admin);
  });

  it("TND (3 decimals): 22.000 DT cash trip, he earns 16.000 DT, carried −6.000 DT closed by Driver paid Movera 6.000 DT: Driver gets 16.000 DT, Movera gets 6.000 DT", async () => {
    const d = await insertDriver(database.db);
    const lines = [{ code: "base", amount: m(20_000, "TND") }, { code: "app_fee", amount: m(2_000, "TND") }];
    const t = await paidTrip(d, { currency: "TND", fare: 22_000, lines, earnings: 16_000 });
    await entry(t.trip_id, d, "trip", 16_000, "TND", 22_000);
    const carried = await pay(d);
    expect(Number(carried.amount_minor)).toBe(-6_000);
    await paidMovera(d, m(6_000, "TND"), m(6_000, "TND"));
    // Fail-before: driverGets 22.000 DT.
    const v = await views(d, carried.payout_id);
    expect(v.mine).toEqual({ driverGets: m(16_000, "TND"), moveraGets: m(6_000, "TND") });
    expect(v.admin).toEqual(v.mine);
  });

  it("TND: a part payment of 2.500 DT on the −6.000 DT payout leaves it open; its live Driver gets stays 16.000 DT", async () => {
    const d = await insertDriver(database.db);
    const lines = [{ code: "base", amount: m(20_000, "TND") }, { code: "app_fee", amount: m(2_000, "TND") }];
    const t = await paidTrip(d, { currency: "TND", fare: 22_000, lines, earnings: 16_000 });
    await entry(t.trip_id, d, "trip", 16_000, "TND", 22_000);
    const carried = await pay(d);
    await paidMovera(d, m(6_000, "TND"), m(2_500, "TND"));
    expect((await payoutRow(carried.payout_id)).status).toBe("pending");
    // Fail-before: driverGets 18.500 DT.
    expect((await views(d, carried.payout_id)).admin).toEqual({ driverGets: m(16_000, "TND"), moveraGets: m(6_000, "TND") });
  });
});

describe("J8: a payout closed by Driver paid Movera is frozen at that moment (owner M26 'a paid payout's numbers never change')", () => {
  it("SEK: paid_summary is written in the same step; a later pay change on its trip does not move it", async () => {
    const d = await insertDriver(database.db);
    const t = await paidTrip(d, { currency: "SEK", fare: 20_000, earnings: 16_000 });
    await entry(t.trip_id, d, "trip", 16_000, "SEK", 20_000);
    const carried = await pay(d);
    await paidMovera(d, m(4_000, "SEK"), m(4_000, "SEK"));
    const frozen = { driverGets: m(16_000, "SEK"), moveraGets: m(4_000, "SEK") };
    // Fail-before: paid_summary null (frozen only at the next server start, at the values of that moment).
    expect((await payoutRow(carried.payout_id)).paid_summary).toEqual({ admin: frozen, driver: frozen });
    await database.db.updateTable("trips").set({ driver_adjustments_minor: 1_000 }).where("trip_id", "=", t.trip_id).execute();
    expect(await views(d, carried.payout_id)).toEqual({ mine: frozen, admin: frozen });
  });

  it("TND: paid_summary 16.000 / 6.000 DT is written when Driver paid Movera closes the payout; a 2.000 DT refund afterwards does not move it", async () => {
    const d = await insertDriver(database.db);
    const lines = [{ code: "base", amount: m(20_000, "TND") }, { code: "app_fee", amount: m(2_000, "TND") }];
    const t = await paidTrip(d, { currency: "TND", fare: 22_000, lines, earnings: 16_000 });
    await entry(t.trip_id, d, "trip", 16_000, "TND", 22_000);
    const carried = await pay(d);
    await paidMovera(d, m(6_000, "TND"), m(6_000, "TND"));
    const frozen = { driverGets: m(16_000, "TND"), moveraGets: m(6_000, "TND") };
    expect((await payoutRow(carried.payout_id)).paid_summary).toEqual({ admin: frozen, driver: frozen });
    await database.db.updateTable("trips").set({ refunded_minor: 2_000, payment_status: "partially_refunded" }).where("trip_id", "=", t.trip_id).execute();
    expect(await views(d, carried.payout_id)).toEqual({ mine: frozen, admin: frozen });
  });
});
