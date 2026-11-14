import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commissionOf } from "../../src/rules/commission.js";
import { driverEarnings } from "../../src/trips/ride/earnings.js";
import { creditTrip } from "../../src/trips/ride/finish.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * S5 J5 (contract v0.18.82 moneyBase.commission, B2.4 / S07 M5, run P6): ONE commission for every paid trip end —
 * commission = fare − debtCollected − driverEarnings − pickupPay − driverBonus. The trip row (KPIs, TripProjection) and
 * the trip's earnings entry (driver earnings report) hold the same number. Before: the earnings entry left pickup pay and
 * the bonus in (95 kr trip, 1,05 kr pickup pay → 25,78 kr against 24,73 kr on the trip).
 */

let database: TestDatabase;
let driverId: string;
let riderId: string;
const now = new Date("2026-11-13T10:00:00Z");

type Line = { code: string; amount: { amountMinor: number; currency: string } };
async function ended(status: string, currency: string, m: { fare: number; lines?: Line[]; earnings: number; pickup?: number; bonus?: number }) {
  const id = await insertTrip(database.db, riderId, { status, driverId });
  const lines = m.lines ?? [{ code: "base", amount: { amountMinor: m.fare, currency } }];
  const pickup = m.pickup ?? 0;
  const bonus = m.bonus ?? 0;
  await database.db.updateTable("trips").set({
    zone_id: currency === "TND" ? "TN-TC" : "Z001", currency, fare_minor: m.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: m.earnings,
    pickup_pay_minor: pickup, driver_bonus_minor: bonus, commission_minor: commissionOf(m.fare, lines, m.earnings, pickup, bonus),
    ended_at: now, payment_status: "captured", cash_collected_minor: m.fare,
  }).where("trip_id", "=", id).execute();
  const row = await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow();
  await database.db.transaction().execute((trx) => creditTrip(trx, row, now));
  return id;
}
async function both(tripId: string) {
  const trip = await database.db.selectFrom("trips").select("commission_minor").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  const entry = await database.db.selectFrom("earnings_entries").select(["commission_minor", "gross_minor"]).where("trip_id", "=", tripId).where("kind", "=", "trip").executeTakeFirstOrThrow();
  return { trip: Number(trip.commission_minor), entry: Number(entry.commission_minor), gross: Number(entry.gross_minor) };
}

beforeAll(async () => {
  database = await freshDatabase();
  riderId = await insertRider(database.db);
  driverId = await insertDriver(database.db);
});
afterAll(async () => database.drop());

describe("S5 J5: one commission on the trip and its earnings entry (moneyBase.commission)", () => {
  it("run P6: 95 kr completed, 1,05 kr pickup pay → 24,73 kr on both (was 25,78 on the entry)", async () => {
    const id = await ended("completed", "SEK", { fare: 9_500, earnings: 6_922, pickup: 105 });
    expect(await both(id)).toEqual({ trip: 2_473, entry: 2_473, gross: 9_500 });
  });

  it("a Movera bonus is out of the commission on both", async () => {
    const id = await ended("completed", "SEK", { fare: 20_000, earnings: 15_000, pickup: 200, bonus: 1_000 });
    expect(await both(id)).toEqual({ trip: 3_800, entry: 3_800, gross: 20_000 });
  });

  it("the driver ends with the rider on board carrying an old 240 kr fee: the debt is out on both (and out of gross)", async () => {
    const lines: Line[] = [{ code: "base", amount: { amountMinor: 9_500, currency: "SEK" } }, { code: "outstanding_fee", amount: { amountMinor: 24_000, currency: "SEK" } }];
    const id = await ended("cancelled_by_driver", "SEK", { fare: 33_500, lines, earnings: 6_922, pickup: 105 });
    expect(await both(id)).toEqual({ trip: 2_473, entry: 2_473, gross: 9_500 });
  });

  it("a rider early end in Tunisia (TND, 3 decimals): 12.500 DT, 0.750 DT pickup pay → 2.750 DT on both", async () => {
    const id = await ended("cancelled_by_rider", "TND", { fare: 12_500, earnings: 9_000, pickup: 750 });
    expect(await both(id)).toEqual({ trip: 2_750, entry: 2_750, gross: 12_500 });
  });

  it("the driver's earnings report (GET /driver/earnings) shows the trips' commission", async () => {
    const report = await driverEarnings(database.db, driverId, { period: "day", from: "2026-11-13T00:00:00Z", to: "2026-11-14T00:00:00Z", timeZone: "Europe/Stockholm", currency: "SEK" }, now);
    const trips = await database.db.selectFrom("trips").select("commission_minor").where("driver_id", "=", driverId).where("currency", "=", "SEK").execute();
    const sum = trips.reduce((s, t) => s + Number(t.commission_minor), 0);
    expect(report.periods.map((p) => p.commission.amountMinor)).toEqual([sum]);
    expect(sum).toBe(2_473 + 3_800 + 2_473);
  });
});
