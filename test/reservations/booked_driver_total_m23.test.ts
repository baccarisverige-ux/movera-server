import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { driverReservations } from "../../src/reservations/service.js";
import { tripProjection } from "../../src/trips/projection.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * BQ-M23 (contract v0.18.96, contract.json#priceDisplay.bookedRide; owner s06:1164 "on the offer when come he see only
 * how much he get"): every DriverReservation item carries driverTotal = the trip's driverEarnings + pickupPay +
 * driverBonus (the same formula as Offer.driverTotal), so the driver app's Booked rides list shows what he gets from the
 * server and never works it out. Before, the row had only `earnings` (the trip line without bonus and pickup pay).
 * SEK and TND (3 decimals: a whole 65 DT is 65000 minor and stays exact).
 */

let database: TestDatabase;
let riderId: string;
const NOW = new Date("2026-11-20T08:00:00Z");
const AT = new Date("2026-11-20T14:00:00Z");

async function booked(driverId: string, m: { currency: string; earnings: number; pickupPay: number; bonus: number }): Promise<string> {
  const id = await insertTrip(database.db, riderId, { status: "accepted", kind: "scheduled", driverId });
  const state = { mode: "list", rideType: "normal", dispatchAt: AT.toISOString(), freeChangeUntil: AT.toISOString(), noDriver: false };
  await database.db.updateTable("trips").set({
    currency: m.currency, scheduled_at: AT, accepted_at: NOW, driver_earnings_minor: m.earnings, pickup_pay_minor: m.pickupPay, driver_bonus_minor: m.bonus,
    bonus_exclusive_minor: m.bonus, bonus_radar_minor: m.bonus, reservation: JSON.stringify(state),
  }).where("trip_id", "=", id).execute();
  return id;
}
const row = async (driverId: string, tripId: string) => (await driverReservations(database.db, driverId, "accepted", NOW)).items.find((i) => i["tripId"] === tripId)!;

beforeAll(async () => {
  database = await freshDatabase();
  riderId = await insertRider(database.db);
});
afterAll(async () => {
  await database.drop();
});

describe("BQ-M23 Booked rides: DriverReservation.driverTotal = what the driver gets", () => {
  it("SEK: earnings + pickup pay + Movera's bonus, one server number; earnings stays the trip line", async () => {
    const driverId = await insertDriver(database.db);
    const tripId = await booked(driverId, { currency: "SEK", earnings: 18_950, pickupPay: 1_500, bonus: 2_000 });
    const item = await row(driverId, tripId);
    expect(item["driverTotal"]).toEqual({ amountMinor: 22_450, currency: "SEK" });
    expect(item["earnings"]).toEqual({ amountMinor: 18_950, currency: "SEK" });
  });

  it("SEK whole amount: 65,00 kr stays 6500 minor (no rounding, no lost decimals)", async () => {
    const driverId = await insertDriver(database.db);
    const tripId = await booked(driverId, { currency: "SEK", earnings: 6_000, pickupPay: 0, bonus: 500 });
    expect((await row(driverId, tripId))["driverTotal"]).toEqual({ amountMinor: 6_500, currency: "SEK" });
  });

  it("TND (3 decimals): 12.350 DT + 0.650 DT pickup pay + 2.000 DT bonus = 15.000 DT", async () => {
    const driverId = await insertDriver(database.db);
    const tripId = await booked(driverId, { currency: "TND", earnings: 12_350, pickupPay: 650, bonus: 2_000 });
    const item = await row(driverId, tripId);
    expect(item["driverTotal"]).toEqual({ amountMinor: 15_000, currency: "TND" });
    expect(item["earnings"]).toEqual({ amountMinor: 12_350, currency: "TND" });
  });

  it("no bonus and no pickup pay: driverTotal = earnings (sent even then, never left for the phone)", async () => {
    const driverId = await insertDriver(database.db);
    const tripId = await booked(driverId, { currency: "TND", earnings: 9_125, pickupPay: 0, bonus: 0 });
    expect((await row(driverId, tripId))["driverTotal"]).toEqual({ amountMinor: 9_125, currency: "TND" });
  });

  it("privacy: the rider's view of the same booked ride never carries driverTotal or the driver's pay", async () => {
    const driverId = await insertDriver(database.db);
    const tripId = await booked(driverId, { currency: "SEK", earnings: 18_950, pickupPay: 1_500, bonus: 2_000 });
    const trip = (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow()) as unknown as TripRow;
    const rider = tripProjection(trip, "rider") as Record<string, unknown>;
    for (const key of ["driverTotal", "driverEarnings", "driverBonus", "pickupPay", "earnings"]) expect(rider).not.toHaveProperty(key);
  });
});
