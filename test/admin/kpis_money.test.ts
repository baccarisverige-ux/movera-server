import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countDay, kpis, resumTripDay, summarize } from "../../src/admin/kpis.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * Reports › Money (contract v0.10.3, contract.json#kpis.money, owner 2026-10-28): bookings = ride price + cancel/no-show
 * fees; tips apart; refunds on the trip's day (a later refund re-sums that day); Movera earnings = commission + Movera's
 * fee share − pickup pay − driver bonuses (may be negative); each currency apart; a day is the zone's local day.
 */

let database: TestDatabase;
let driverId: string;
let riderId: string;
const now = new Date("2026-10-28T10:00:00Z");
const SE = { zone_id: "Z001", time_zone: "Europe/Stockholm", currency: "SEK" };
const owner = { actor: "admin" as const, subjectId: "adm_1", sessionId: "ses_1", zones: ["*"] };

async function trip(zoneId: string, status: string, endedAt: string, money: { fare: number; commission?: number; earnings?: number; pickup?: number; bonus?: number; currency?: string }) {
  const id = await insertTrip(database.db, riderId, { status, driverId });
  await database.db.updateTable("trips").set({
    zone_id: zoneId, currency: money.currency ?? "SEK", fare_minor: money.fare, commission_minor: money.commission ?? 0, driver_earnings_minor: money.earnings ?? 0,
    pickup_pay_minor: money.pickup ?? 0, driver_bonus_minor: money.bonus ?? 0, ended_at: new Date(endedAt),
  }).where("trip_id", "=", id).execute();
  return id;
}
let n = 0;
const entry = (tripId: string, kind: "tip" | "fee_share", amount: number) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_${++n}`, driver_id: driverId, trip_id: tripId, kind, currency: "SEK", amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: null, at: now }).execute();
const fee = (tripId: string, kind: "cancel" | "no_show", amount: number, status: "owed" | "paid" | "waived") =>
  database.db.insertInto("rider_fees").values({ trip_id: tripId, rider_id: riderId, kind, currency: "SEK", amount_minor: amount, status, carried_by: null, created_at: now, settled_at: null }).execute();
const refund = (tripId: string, amount: number) =>
  database.db.insertInto("refunds").values({ refund_id: `rfd_${++n}`, trip_id: tripId, rider_id: riderId, currency: "SEK", amount_minor: amount, reason: "Long route", status: "done", approval_id: null, destination: null, payout_to: null, payout_status: null, paid_at: null, paid_by: null, created_by: "adm_1", created_at: now }).execute();

let rideA: string;
beforeAll(async () => {
  database = await freshDatabase();
  riderId = await insertRider(database.db);
  driverId = await insertDriver(database.db);
  // 2026-10-26 in Stockholm (UTC+1).
  rideA = await trip("Z001", "completed", "2026-10-26T09:00:00Z", { fare: 25_000, commission: 5_000, earnings: 20_000, pickup: 1_500, bonus: 1_000 });
  await entry(rideA, "tip", 2_000);
  const noShow = await trip("Z001", "no_show", "2026-10-26T10:00:00Z", { fare: 25_000 });
  await fee(noShow, "no_show", 4_000, "owed");
  await entry(noShow, "fee_share", 2_500);
  const waived = await trip("Z001", "cancelled_by_rider", "2026-10-26T11:00:00Z", { fare: 25_000 });
  await fee(waived, "cancel", 3_000, "waived");
  // 23:30 UTC on the 26th is 00:30 on the 27th in Stockholm: the 27th's trip. Big bonus: Movera loses money.
  await trip("Z001", "completed", "2026-10-26T23:30:00Z", { fare: 10_000, commission: 2_000, earnings: 8_000, pickup: 500, bonus: 3_000 });
  // Paris, in euros: never added to the kronor.
  await trip("FR-PC", "completed", "2026-10-26T12:00:00Z", { fare: 3_000, commission: 600, earnings: 2_400, currency: "EUR" });
});
afterAll(async () => database.drop());

describe("KPI money (contract v0.10.3)", () => {
  it("bookings, fees, tips and Movera earnings of a zone-local day, exact in minor units", async () => {
    expect(await countDay(database.db, SE, "2026-10-26")).toMatchObject({ completedTrips: 1, noShows: 1, cancelledTrips: 1, gross: 29_000, fees: 4_000, tips: 2_000, refunds: 0, commission: 5_000, pickupPay: 1_500, driverBonus: 1_000, moveraEarnings: 4_000 });
    expect(await countDay(database.db, SE, "2026-10-27")).toMatchObject({ completedTrips: 1, gross: 10_000, fees: 0, tips: 0, moveraEarnings: -1_500 });
  });

  it("the summary keeps each currency apart; a later refund re-sums its trip's (older) day", async () => {
    await database.db.transaction().execute((trx) => summarize(trx, now, "2026-10-26"));
    const range = { fromDate: "2026-10-26", toDate: "2026-10-27" };
    const before = (await kpis(database.db, owner, range, now)).days;
    expect(before.filter((d) => d.zoneId === "Z001" || d.zoneId === "FR-PC").map((d) => [d.zoneId, d.date, d.currency, d.gross, d.moveraEarnings])).toEqual([
      ["FR-PC", "2026-10-26", "EUR", 3_000, 600], ["FR-PC", "2026-10-27", "EUR", 0, 0],
      ["Z001", "2026-10-26", "SEK", 29_000, 4_000], ["Z001", "2026-10-27", "SEK", 10_000, -1_500],
    ]);
    await refund(rideA, 3_000);
    await database.db.transaction().execute((trx) => resumTripDay(trx, rideA, now));
    const after = (await kpis(database.db, owner, { zoneId: "Z001", ...range }, now)).days;
    expect(after.map((d) => [d.date, d.source, d.refunds, d.gross])).toEqual([["2026-10-26", "summary", 3_000, 29_000], ["2026-10-27", "summary", 0, 10_000]]);
  });
});
