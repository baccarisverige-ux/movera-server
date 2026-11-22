import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { driverEarnings } from "../../src/trips/ride/earnings.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * v0.18.146 (contract.json#driverRideCounts; audit apps-every-control 2026-11-20 N5 "Resor 6" next to "Visa alla 7
 * resor"; owner 2026-11-20 "Must see all kind"): each period counts every ride of the driver by kind, from trips, so a
 * cancel or no-show that earned nothing counts too. Fail-before: no rideCounts, and a day with only such rides is missing.
 */
let database: TestDatabase;
const now = new Date("2026-11-20T12:00:00.000Z");
const tz = "Europe/Stockholm";

beforeAll(async () => {
  database = await freshDatabase();
  const driverId = await insertDriver(database.db, { driverId: "drv_rc" });
  const other = await insertDriver(database.db, { driverId: "drv_rc_other" });
  const riderId = await insertRider(database.db);
  const ride = async (status: string, endedAt: string, opts: { driver?: string; currency?: string } = {}) => {
    const tripId = await insertTrip(database.db, riderId, { driverId: opts.driver ?? driverId, status });
    await database.db.updateTable("trips").set({ ended_at: new Date(endedAt), currency: opts.currency ?? "SEK" }).where("trip_id", "=", tripId).execute();
    return tripId;
  };
  // Day 1 (18 Nov): 2 completed (with earnings entries), 1 cancelled by the rider (no fee), 1 no-show (no fee).
  const c1 = await ride("completed", "2026-11-18T09:00:00Z");
  const c2 = await ride("completed", "2026-11-18T10:00:00Z");
  await ride("cancelled_by_rider", "2026-11-18T11:00:00Z");
  await ride("no_show", "2026-11-18T12:00:00Z");
  // Day 2 (19 Nov): only a cancel by the driver and one by the system: no earnings entry that day.
  await ride("cancelled_by_driver", "2026-11-19T09:00:00Z");
  await ride("cancelled_by_system", "2026-11-19T10:00:00Z");
  // Not his, not ended, other currency: never counted.
  await ride("completed", "2026-11-18T09:30:00Z", { driver: other });
  await insertTrip(database.db, riderId, { driverId, status: "driver_to_pickup" });
  await ride("completed", "2026-11-18T13:00:00Z", { currency: "EUR" });
  await database.db
    .insertInto("earnings_entries")
    .values([c1, c2].map((tripId, i) => ({ entry_id: `ee_rc_${i}`, driver_id: driverId, trip_id: tripId, kind: "trip" as const, currency: "SEK", amount_minor: 10_000, gross_minor: 12_000, commission_minor: 2_000, cash_minor: 0, at: new Date(`2026-11-18T1${i}:00:00Z`) })))
    .execute();
});
afterAll(async () => {
  await database.drop();
});

describe("v0.18.146 rideCounts: every ride kind of the period, from trips", () => {
  it("day periods: counts per kind; a day with only cancels is sent with zero money", async () => {
    const report = await driverEarnings(database.db, "drv_rc", { period: "day", from: "2026-11-17T23:00:00Z", timeZone: tz, currency: "SEK" }, now);
    expect(report.periods.map((p) => [p.periodStart, p.tripCount, p.rideCounts])).toEqual([
      ["2026-11-17T23:00:00.000Z", 2, { completed: 2, cancelled: 1, noShow: 1 }],
      ["2026-11-18T23:00:00.000Z", 0, { completed: 0, cancelled: 2, noShow: 0 }],
    ]);
    const day2 = report.periods[1]!;
    expect(day2.periodEnd).toBe("2026-11-19T23:00:00.000Z");
    expect(day2.net).toEqual({ amountMinor: 0, currency: "SEK" });
  });

  it("week period: one total of all kinds (6 rides, 2 completed)", async () => {
    const report = await driverEarnings(database.db, "drv_rc", { period: "week", from: "2026-11-15T23:00:00Z", timeZone: tz, currency: "SEK" }, now);
    expect(report.periods).toHaveLength(1);
    expect(report.periods[0]).toMatchObject({ tripCount: 2, rideCounts: { completed: 2, cancelled: 3, noShow: 1 } });
  });
});
