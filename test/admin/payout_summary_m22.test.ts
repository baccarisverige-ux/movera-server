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
 * v0.18.92 (payoutSummary.entries; supervisor MF1 / MF2 / G2): the payout's OWN entries (payout_id), never the date
 * period (manual + weekly over one week, late / carried entries); driverGets = Σ its entries; moveraGets per viewer (the
 * driver's view never takes another driver's lost-driver payment off; the admin's does, once: through a paid trip's
 * moneySplit.movera, or, on a trip with no paid end, from the lost driver's bonus entry in the payout that pays it).
 */

let database: TestDatabase;
let riderId: string;
const SUPER: Principal = { actor: "admin", subjectId: "adm_m22", sessionId: "s_m22", zones: ["*"], role: "super", perms: [] } as unknown as Principal;
const FROM = new Date("2026-11-02T00:00:00Z");
const TO = new Date("2026-11-09T00:00:00Z");
const IN = new Date("2026-11-04T10:00:00Z");
type Money = { amountMinor: number; currency: string };

let n = 0;
const entry = (tripId: string, driverId: string, kind: "trip" | "pickup_pay" | "bonus" | "fee_share" | "tip" | "adjustment", amount: number, currency: string, cash = 0, at = IN) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_m22_${++n}`, driver_id: driverId, trip_id: tripId, kind, currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: cash, at }).execute();

async function trip(driverId: string, m: { status: string; currency: string; fare: number; lines?: Array<{ code: string; amount: Money }>; earnings: number; commission?: number; paid?: boolean; tip?: number; change?: number; lost?: number }): Promise<TripRow> {
  const id = await insertTrip(database.db, riderId, { status: m.status, driverId });
  const lines = m.lines ?? [{ code: m.paid ? "base" : "cancel_fee", amount: { amountMinor: m.fare, currency: m.currency } }];
  await database.db.updateTable("trips").set({
    currency: m.currency, fare_minor: m.fare, booked_fare_minor: m.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: m.earnings, pickup_pay_minor: 0, driver_bonus_minor: 0,
    commission_minor: m.commission ?? commissionOf(m.fare, lines, m.earnings, 0, 0), driver_adjustments_minor: m.change ?? 0, lost_driver_paid_minor: m.lost ?? 0, payment_method: "cash", ended_at: IN,
    ended_by_command: m.paid ? "complete" : "no_show", payment_status: m.paid ? "captured" : null, cash_collected_minor: m.paid ? m.fare : null,
    tip: m.tip ? JSON.stringify({ amount: { amountMinor: m.tip, currency: m.currency }, method: "cash", driverShare: { amountMinor: m.tip, currency: m.currency } }) : null,
  }).where("trip_id", "=", id).execute();
  return (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
}
const pay = (driverId: string, range: { from?: Date; to?: Date; source?: "manual" | "weekly"; entriesFrom?: Date } = {}) =>
  database.db.transaction().execute((trx) => makePayouts(trx, { driverId, from: range.from ?? FROM, to: range.to ?? TO, source: range.source ?? "manual", by: null, ...(range.entriesFrom ? { entriesFrom: range.entriesFrom } : {}) }, new Date("2026-11-20T00:00:00Z")));
const adminMovera = (t: TripRow) => (tripProjection(t, "admin") as { moneySplit: { movera: Money } }).moneySplit.movera.amountMinor;
const sek = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
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
  it("SEK: tip, pay change, no-show share and a reassigned trip — each amount once; the driver's and the admin's Movera gets differ by the lost-driver payment (MF2)", async () => {
    const a = await insertDriver(database.db);
    const b = await insertDriver(database.db);
    // X: 200 kr, he gets 150 kr + a 20 kr cash tip + a 10 kr pay change → 180 kr; Movera keeps 40 kr.
    const x = await trip(b, { status: "completed", currency: "SEK", fare: 20_000, earnings: 15_000, paid: true, tip: 2_000, change: 1_000 });
    await entry(x.trip_id, b, "trip", 15_000, "SEK", 20_000);
    await entry(x.trip_id, b, "tip", 2_000, "SEK", 2_000);
    await entry(x.trip_id, b, "adjustment", 1_000, "SEK");
    // Y: reassigned — A lost it and was paid 30 kr (his bonus entry; lost_driver_paid 30 kr), B completed it for 150 kr.
    const y = await trip(b, { status: "completed", currency: "SEK", fare: 20_000, earnings: 15_000, paid: true, lost: 3_000 });
    await entry(y.trip_id, a, "bonus", 3_000, "SEK");
    await entry(y.trip_id, b, "trip", 15_000, "SEK", 20_000);
    // Z: a 65 kr no-show, half his (32,50 kr), half Movera's (feeColumns: commission = Movera's share).
    const z = await trip(b, { status: "no_show", currency: "SEK", fare: 6_500, earnings: 3_250 });
    await entry(z.trip_id, b, "fee_share", 3_250, "SEK");
    expect(await pay(a)).toHaveLength(1);
    expect(await pay(b)).toHaveLength(1);
    expect(adminMovera(y)).toBe(2_000);

    const forB = await summaries(b);
    // Admin: Movera keeps 40 + 20 (the 30 kr lost-driver payment off once) + 32,50 kr.
    expect(forB.admin[0]!.summary).toEqual({ driverGets: sek(36_250), moveraGets: sek(4_000 + 2_000 + 3_250) });
    // Driver: what Movera keeps from HIS trips (50 kr on Y) — another driver's money is never shown to him.
    expect(forB.mine[0]!.summary).toEqual({ driverGets: sek(36_250), moveraGets: sek(4_000 + 5_000 + 3_250) });
    // A: the 30 kr is his money; Y has a paid end, so it is taken off only through Y (admin), never again here.
    const forA = await summaries(a);
    expect(forA.mine[0]!.summary).toEqual({ driverGets: sek(3_000), moveraGets: sek(0) });
    expect(forA.admin[0]!.summary).toEqual({ driverGets: sek(3_000), moveraGets: sek(0) });
  });

  it("G2 SEK: a lost-driver payment on a trip with no paid end (admin cancel) is taken off once — in the admin view of the payout that pays it", async () => {
    const a = await insertDriver(database.db);
    const w = await trip(a, { status: "cancelled_by_admin", currency: "SEK", fare: 25_000, earnings: 0, lost: 1_500 });
    await entry(w.trip_id, a, "bonus", 1_500, "SEK");
    await pay(a);
    const { mine, admin } = await summaries(a);
    expect(admin[0]!.summary).toEqual({ driverGets: sek(1_500), moveraGets: sek(-1_500) });
    expect(mine[0]!.summary).toEqual({ driverGets: sek(1_500), moveraGets: sek(0) });
  });

  it("MF1 SEK: a manual payout and the weekly payout of the same week never count a trip twice", async () => {
    const e = await insertDriver(database.db);
    const t1 = await trip(e, { status: "completed", currency: "SEK", fare: 12_000, earnings: 10_000, paid: true });
    await entry(t1.trip_id, e, "trip", 10_000, "SEK", 12_000, new Date("2026-11-03T10:00:00Z"));
    const t2 = await trip(e, { status: "completed", currency: "SEK", fare: 10_000, earnings: 8_000, paid: true });
    await entry(t2.trip_id, e, "trip", 8_000, "SEK", 10_000, new Date("2026-11-06T10:00:00Z"));
    expect(await pay(e, { to: new Date("2026-11-05T00:00:00Z") })).toHaveLength(1);
    expect(await pay(e, { source: "weekly" })).toHaveLength(1);
    const { mine, admin } = await summaries(e);
    const byAmount = (list: typeof mine) => list.map((p) => p.summary).sort((x, y) => x!.driverGets.amountMinor - y!.driverGets.amountMinor);
    expect(byAmount(mine)).toEqual([{ driverGets: sek(8_000), moveraGets: sek(2_000) }, { driverGets: sek(10_000), moveraGets: sek(2_000) }]);
    expect(byAmount(admin)).toEqual(byAmount(mine));
  });

  it("MF1 SEK: a late pay change of an already paid week is in the payout that pays it (carried entries); the paid payout does not move", async () => {
    const f = await insertDriver(database.db);
    const g = await trip(f, { status: "completed", currency: "SEK", fare: 20_000, earnings: 15_000, paid: true });
    await entry(g.trip_id, f, "trip", 15_000, "SEK", 20_000);
    const [first] = await pay(f, { source: "weekly" });
    // After the payout: a 10 kr pay change dated in the paid week; the next weekly run carries it (entriesFrom).
    await database.db.updateTable("trips").set({ driver_adjustments_minor: 1_000 }).where("trip_id", "=", g.trip_id).execute();
    await entry(g.trip_id, f, "adjustment", 1_000, "SEK", 0, new Date("2026-11-05T10:00:00Z"));
    const [second] = await pay(f, { source: "weekly", from: TO, to: new Date("2026-11-16T00:00:00Z"), entriesFrom: new Date(0) });
    expect(second).toBeDefined();
    const { admin } = await summaries(f);
    const of = (id: string) => admin.find((p) => p.payoutId === id)!.summary;
    // The paid payout keeps his 150 kr; the next one pays (and shows) the 10 kr. BQ-M29 (pay change counted where it is
    // paid, as BQ-M28's late bonus): Movera's 40 kr (50 − 10, kept now) once in all — 50 kr on the trip's payout, −10 kr on
    // the payout that pays the pay change (before M29: 40 kr on the trip's payout, 0 on the second).
    expect(of(first!.payout_id)).toEqual({ driverGets: sek(15_000), moveraGets: sek(5_000) });
    expect(of(second!.payout_id)).toEqual({ driverGets: sek(1_000), moveraGets: sek(-1_000) });
  });

  it("S3 SEK: the lost driver gets the trip back and completes it — his earlier 25 kr payment is in his Driver gets", async () => {
    const h = await insertDriver(database.db);
    const k = await trip(h, { status: "completed", currency: "SEK", fare: 20_000, earnings: 15_000, paid: true, lost: 2_500 });
    await entry(k.trip_id, h, "bonus", 2_500, "SEK");
    await entry(k.trip_id, h, "trip", 15_000, "SEK", 20_000);
    await pay(h);
    const { mine, admin } = await summaries(h);
    expect(admin[0]!.summary).toEqual({ driverGets: sek(17_500), moveraGets: sek(2_500) });
    expect(mine[0]!.summary).toEqual({ driverGets: sek(17_500), moveraGets: sek(5_000) });
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
