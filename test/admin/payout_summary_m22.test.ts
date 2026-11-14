import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/guard.js";
import { driverPayouts, listPayouts, makePayouts } from "../../src/admin/payouts.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { commissionOf } from "../../src/rules/commission.js";
import { tripProjection } from "../../src/trips/projection.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * BQ-M22 part 2 (contract v0.18.89 §90, contract.json#priceDisplay.payoutSummary; owner 2026-11-14 "how much driver get and
 * how much movera get thats all no details"; s06:1278 "Movera gets = commission + app fee as one amount"): Payout.summary
 * { driverGets, moveraGets } on the driver's and the admin's payouts, amounts only.
 * driverGets = the sum of each of the period's trips' driverTotal + each of his entries not inside a trip's driverTotal
 * (cancel / no-show shares, a lost-driver payment), each once. moveraGets = what Movera keeps now on each of the period's
 * trips (the admin view's moveraKeepsNow = moneySplit.movera) + Movera's share of the period's cancel / no-show fees.
 * v0.18.90 (moneyBase.lostDriverPaid.kpi): a lost-driver payment is taken off once — through the admin moneySplit.movera
 * of the trip, never again from the lost driver's own entry. Sweden (SEK), France (EUR), Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
let riderId: string;
const SUPER: Principal = { actor: "admin", subjectId: "adm_m22", sessionId: "s_m22", zones: ["*"], role: "super", perms: [] } as unknown as Principal;
const FROM = new Date("2026-11-02T00:00:00Z");
const TO = new Date("2026-11-09T00:00:00Z");
const IN = new Date("2026-11-04T10:00:00Z");
type Money = { amountMinor: number; currency: string };

let n = 0;
const entry = (tripId: string, driverId: string, kind: "trip" | "pickup_pay" | "bonus" | "fee_share" | "tip" | "adjustment", amount: number, currency: string, cash = 0) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_m22_${++n}`, driver_id: driverId, trip_id: tripId, kind, currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: cash, at: IN }).execute();

async function trip(driverId: string, m: { status: string; currency: string; fare: number; lines?: Array<{ code: string; amount: Money }>; earnings: number; commission?: number; paid?: boolean; tip?: number; change?: number }): Promise<TripRow> {
  const id = await insertTrip(database.db, riderId, { status: m.status, driverId });
  const lines = m.lines ?? [{ code: m.paid ? "base" : "cancel_fee", amount: { amountMinor: m.fare, currency: m.currency } }];
  await database.db.updateTable("trips").set({
    currency: m.currency, fare_minor: m.fare, booked_fare_minor: m.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: m.earnings, pickup_pay_minor: 0, driver_bonus_minor: 0,
    commission_minor: m.commission ?? commissionOf(m.fare, lines, m.earnings, 0, 0), driver_adjustments_minor: m.change ?? 0, payment_method: "cash", ended_at: IN,
    ended_by_command: m.paid ? "complete" : "no_show", payment_status: m.paid ? "captured" : null, cash_collected_minor: m.paid ? m.fare : null,
    tip: m.tip ? JSON.stringify({ amount: { amountMinor: m.tip, currency: m.currency }, method: "cash", driverShare: { amountMinor: m.tip, currency: m.currency } }) : null,
  }).where("trip_id", "=", id).execute();
  return (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
}
const pay = (driverId: string) => database.db.transaction().execute((trx) => makePayouts(trx, { driverId, from: FROM, to: TO, source: "manual", by: null }, new Date("2026-11-10T00:00:00Z")));
const adminMovera = (t: TripRow) => (tripProjection(t, "admin") as { moneySplit: { movera: Money } }).moneySplit.movera.amountMinor;
async function summaries(driverId: string) {
  const mine = (await driverPayouts(database.db, driverId, { limit: 10 })).items;
  const admin = (await listPayouts(database.db, SUPER, { limit: 10, driverId })).items;
  return { mine, admin };
}

beforeAll(async () => {
  database = await freshDatabase();
  riderId = await insertRider(database.db);
});
afterAll(async () => {
  await database.drop();
});

describe("BQ-M22: Payout.summary { driverGets, moveraGets } (priceDisplay.payoutSummary)", () => {
  it("SEK: trips with a tip and a later pay change, a no-show share, and a reassigned trip — each amount once", async () => {
    const a = await insertDriver(database.db);
    const b = await insertDriver(database.db);
    // X: 200 kr, he gets 150 kr + a 20 kr cash tip + a 10 kr pay change → driverTotal 180 kr; Movera keeps 40 kr.
    const x = await trip(b, { status: "completed", currency: "SEK", fare: 20_000, earnings: 15_000, paid: true, tip: 2_000, change: 1_000 });
    await entry(x.trip_id, b, "trip", 15_000, "SEK", 20_000);
    await entry(x.trip_id, b, "tip", 2_000, "SEK", 2_000);
    await entry(x.trip_id, b, "adjustment", 1_000, "SEK");
    // Y: reassigned — A lost it and was paid 30 kr (his own bonus entry), B completed it for 150 kr.
    const y = await trip(b, { status: "completed", currency: "SEK", fare: 20_000, earnings: 15_000, paid: true });
    await entry(y.trip_id, a, "bonus", 3_000, "SEK");
    await entry(y.trip_id, b, "trip", 15_000, "SEK", 20_000);
    // Z: a 65 kr no-show, half his (32,50 kr), half Movera's (feeColumns: commission = Movera's share).
    const z = await trip(b, { status: "no_show", currency: "SEK", fare: 6_500, earnings: 3_250 });
    await entry(z.trip_id, b, "fee_share", 3_250, "SEK");
    expect(await pay(a)).toHaveLength(1);
    expect(await pay(b)).toHaveLength(1);

    const forB = await summaries(b);
    const expected = { driverGets: { amountMinor: 18_000 + 15_000 + 3_250, currency: "SEK" }, moveraGets: { amountMinor: 4_000 + adminMovera(y) + 3_250, currency: "SEK" } };
    expect(forB.mine[0]!.summary).toEqual(expected);
    expect(forB.admin[0]!.summary).toEqual(expected);
    // Movera's part of Y is the admin moneySplit.movera (v0.18.90: the lost-driver payment taken off there, once).
    expect(adminMovera(y)).toBeLessThanOrEqual(5_000);
    // A: the 30 kr is his money; Movera's part is never taken off again from his entry.
    const forA = await summaries(a);
    expect(forA.mine[0]!.summary).toEqual({ driverGets: { amountMinor: 3_000, currency: "SEK" }, moveraGets: { amountMinor: 0, currency: "SEK" } });
    expect(forA.admin[0]!.summary).toEqual(forA.mine[0]!.summary);
  });

  it("TND (3 decimals): contract example — rider 22.000 DT (20.000 + 2.000 app fee), driver 16.000 DT, Movera gets 6.000 DT", async () => {
    const c = await insertDriver(database.db);
    const lines = [{ code: "base", amount: { amountMinor: 20_000, currency: "TND" } }, { code: "app_fee", amount: { amountMinor: 2_000, currency: "TND" } }];
    const t = await trip(c, { status: "completed", currency: "TND", fare: 22_000, lines, earnings: 16_000, paid: true });
    await entry(t.trip_id, c, "trip", 16_000, "TND", 22_000);
    await pay(c);
    const { mine, admin } = await summaries(c);
    expect(mine[0]!.summary).toEqual({ driverGets: { amountMinor: 16_000, currency: "TND" }, moveraGets: { amountMinor: 6_000, currency: "TND" } });
    expect(admin[0]!.summary).toEqual(mine[0]!.summary);
  });

  it("EUR: a cancel share only (2,50 € of a 5,00 € fee) — driver gets 2,50 €, Movera gets 2,50 €; the driver view stays amounts only", async () => {
    const d = await insertDriver(database.db);
    const t = await trip(d, { status: "cancelled_by_rider", currency: "EUR", fare: 500, earnings: 250 });
    await entry(t.trip_id, d, "fee_share", 250, "EUR");
    await pay(d);
    const { mine, admin } = await summaries(d);
    expect(mine[0]!.summary).toEqual({ driverGets: { amountMinor: 250, currency: "EUR" }, moveraGets: { amountMinor: 250, currency: "EUR" } });
    expect(admin[0]!.summary).toEqual(mine[0]!.summary);
    expect(Object.keys(mine[0]!.summary!).sort()).toEqual(["driverGets", "moveraGets"]);
    expect(mine[0]).not.toHaveProperty("lines");
  });
});
