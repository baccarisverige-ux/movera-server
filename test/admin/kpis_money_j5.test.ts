import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countDay, resumTripDay } from "../../src/admin/kpis.js";
import { commissionOf } from "../../src/rules/commission.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * S5 J5 (contract v0.18.82 moneyBase.kpiMoney + kpis.money, owner 107 "Yes, count + fix old days (Rec.)", S07 T3):
 * gross = the fares WITHOUT the outstanding_fee line of every PAID trip end (completed, ended early by the rider, ended by
 * the driver with the rider on board) + the fees charged that day, each fee counted once; commission = the trips'
 * moneyBase.commission; moveraEarnings = commission + Movera's fee share − Movera's pay changes (adjustment entries; a
 * refund taken from the driver nets out) − refunds. Sweden (SEK) and Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
let driverId: string;
let riderId: string;
const now = new Date("2026-10-28T10:00:00Z");
const SE = { zone_id: "Z001", time_zone: "Europe/Stockholm", currency: "SEK" };
const TN = { zone_id: "TN-TC", time_zone: "Africa/Tunis", currency: "TND" };

type Line = { code: string; amount: { amountMinor: number; currency: string } };
async function trip(zone: { zone_id: string; currency: string }, status: string, endedAt: string, m: { fare: number; lines?: Line[]; earnings?: number; pickup?: number; bonus?: number; paid?: boolean }) {
  const id = await insertTrip(database.db, riderId, { status, driverId });
  const lines = m.lines ?? [{ code: "base", amount: { amountMinor: m.fare, currency: zone.currency } }];
  const earnings = m.earnings ?? 0;
  const pickup = m.pickup ?? 0;
  const bonus = m.bonus ?? 0;
  await database.db.updateTable("trips").set({
    zone_id: zone.zone_id, currency: zone.currency, fare_minor: m.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: earnings,
    pickup_pay_minor: pickup, driver_bonus_minor: bonus, commission_minor: commissionOf(m.fare, lines, earnings, pickup, bonus),
    ended_at: new Date(endedAt), payment_status: m.paid ? "captured" : null,
  }).where("trip_id", "=", id).execute();
  // A paid trip end writes its earnings entries (src/trips/ride/finish.ts creditTrip).
  if (m.paid) {
    await entry(id, "trip", earnings, zone.currency);
    if (pickup) await entry(id, "pickup_pay", pickup, zone.currency);
    if (bonus) await entry(id, "bonus", bonus, zone.currency);
  }
  return id;
}
let n = 0;
const entry = (tripId: string, kind: "tip" | "fee_share" | "trip" | "pickup_pay" | "bonus" | "adjustment", amount: number, currency = "SEK") =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_j5_${++n}`, driver_id: driverId, trip_id: tripId, kind, currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: null, at: now }).execute();
const fee = (tripId: string, kind: "cancel" | "no_show", amount: number, status: "owed" | "paid" | "waived", currency = "SEK") =>
  database.db.insertInto("rider_fees").values({ trip_id: tripId, rider_id: riderId, kind, currency, amount_minor: amount, status, carried_by: null, created_at: now, settled_at: null }).execute();
const refund = (tripId: string, amount: number) =>
  database.db.insertInto("refunds").values({ refund_id: `rfd_j5_${++n}`, trip_id: tripId, rider_id: riderId, currency: "SEK", amount_minor: amount, reason: "Long route", status: "done", approval_id: null, destination: null, payout_to: null, payout_status: null, paid_at: null, paid_by: null, created_by: "adm_1", created_at: now }).execute();

const debtLines = (base: number, debt: number, currency: string): Line[] => [
  { code: "base", amount: { amountMinor: base, currency } },
  { code: "outstanding_fee", amount: { amountMinor: debt, currency } },
];

let paidWithDebt: string;
let riderEarly: string;
beforeAll(async () => {
  database = await freshDatabase();
  riderId = await insertRider(database.db);
  driverId = await insertDriver(database.db);
  // 2026-10-25 (Stockholm): a no-show, fee 240 kr, paid later with the next trip.
  const noShow = await trip(SE, "no_show", "2026-10-25T10:00:00Z", { fare: 0 });
  await fee(noShow, "no_show", 24_000, "paid");
  await entry(noShow, "fee_share", 12_000);
  // 2026-10-26: the next trip carries the 240 kr (outstanding_fee line): fare 318 kr, the ride itself 78 kr.
  paidWithDebt = await trip(SE, "completed", "2026-10-26T09:00:00Z", { fare: 31_800, lines: debtLines(7_800, 24_000, "SEK"), earnings: 6_005, paid: true });
  // The rider ends early (captured): 60 kr driven.
  riderEarly = await trip(SE, "cancelled_by_rider", "2026-10-26T10:00:00Z", { fare: 6_000, earnings: 4_500, paid: true });
  // The driver ends with the rider on board (captured): run P6, 95 kr with 1,05 kr pickup pay.
  await trip(SE, "cancelled_by_driver", "2026-10-26T11:00:00Z", { fare: 9_500, earnings: 6_922, pickup: 105, paid: true });
  // A rider cancel before boarding with a 30 kr fee: only the fee is money (the trip's fare was never paid).
  const cancelled = await trip(SE, "cancelled_by_rider", "2026-10-26T12:00:00Z", { fare: 25_000 });
  await fee(cancelled, "cancel", 3_000, "owed");
  await entry(cancelled, "fee_share", 1_500);
  // Tunisia, 2026-10-26 (Africa/Tunis): a 2.000 DT old fee paid with a 12.500 DT trip; a rider early end of 4.250 DT.
  const tnNoShow = await trip(TN, "no_show", "2026-10-25T10:00:00Z", { fare: 0 });
  await fee(tnNoShow, "no_show", 2_000, "paid", "TND");
  await trip(TN, "completed", "2026-10-26T09:00:00Z", { fare: 12_500, lines: debtLines(10_500, 2_000, "TND"), earnings: 8_000, pickup: 500, paid: true });
  await trip(TN, "cancelled_by_rider", "2026-10-26T10:00:00Z", { fare: 4_250, earnings: 3_000, paid: true });
});
afterAll(async () => database.drop());

describe("S5 J5: KPI money per moneyBase.kpiMoney (owner 107)", () => {
  it("a 240 kr fee paid on the next trip counts once: on its own day, not again in the next trip's gross", async () => {
    expect(await countDay(database.db, SE, "2026-10-25")).toMatchObject({ gross: 24_000, fees: 24_000 });
    const day = await countDay(database.db, SE, "2026-10-26");
    // 78 + 60 + 95 kr of paid trip ends (no 240 kr debt line, no unpaid 250 kr fare of the cancelled trip) + 30 kr fee.
    expect(day.gross).toBe(7_800 + 6_000 + 9_500 + 3_000);
    expect(day.fees).toBe(3_000);
  });

  it("a rider early end and a driver end on board (both captured) are in gross, commission and driver earnings", async () => {
    const day = await countDay(database.db, SE, "2026-10-26");
    // commission = moneyBase.commission per trip: 78 − 60,05 | 60 − 45 | 95 − 69,22 − 1,05 (P6: 24,73 kr).
    expect(day.commission).toBe(1_795 + 1_500 + 2_473);
    expect(day.driverEarnings).toBe(6_005 + 4_500 + 6_922);
    expect(day.pickupPay).toBe(105);
    expect(day.completedTrips).toBe(1);
    // Movera keeps commission + its fee share (30 − 15 kr).
    expect(day.moveraEarnings).toBe(1_795 + 1_500 + 2_473 + 1_500);
  });

  it("Movera's pay changes and a refund lower the day; a refund taken from the driver nets out; the stored day is re-summed", async () => {
    const before = await countDay(database.db, SE, "2026-10-26");
    // Admin driver-pay +10 kr on the debt trip (Movera pays it, not in commission).
    await entry(paidWithDebt, "adjustment", 1_000);
    expect((await countDay(database.db, SE, "2026-10-26")).moveraEarnings).toBe(before.moveraEarnings - 1_000);
    // Refund 20 kr of the rider's early end, 15 kr of it taken from the driver: Movera loses 5 kr.
    await refund(riderEarly, 2_000);
    await entry(riderEarly, "adjustment", -1_500);
    await database.db.transaction().execute((trx) => resumTripDay(trx, riderEarly, now));
    const stored = await database.db.selectFrom("kpi_days").select(["refunds_minor", "movera_earnings_minor", "gross_minor", "commission_minor"]).where("zone_id", "=", "Z001").where("day", "=", "2026-10-26").executeTakeFirstOrThrow();
    expect(Number(stored.refunds_minor)).toBe(2_000);
    expect(Number(stored.movera_earnings_minor)).toBe(before.moveraEarnings - 1_000 - 2_000 + 1_500);
    expect(Number(stored.gross_minor)).toBe(before.gross);
    expect(Number(stored.commission_minor)).toBe(before.commission);
  });

  it("a Tunisia day in TND (3 decimals): fee once, early end in, debt line out", async () => {
    expect(await countDay(database.db, TN, "2026-10-25")).toMatchObject({ gross: 2_000, fees: 2_000 });
    expect(await countDay(database.db, TN, "2026-10-26")).toMatchObject({
      gross: 10_500 + 4_250,
      commission: (12_500 - 2_000 - 8_000 - 500) + (4_250 - 3_000),
      driverEarnings: 11_000,
      pickupPay: 500,
      fees: 0,
      moveraEarnings: 2_000 + 1_250,
    });
  });
});
