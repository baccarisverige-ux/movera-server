import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { driverReservations } from "../../src/reservations/service.js";
import { adminAdjust } from "../../src/admin/trips.js";
import type { Principal } from "../../src/auth/guard.js";
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
const SUPER: Principal = { actor: "admin", subjectId: "adm_m23", sessionId: "s_m23", zones: ["*"], role: "super", perms: [] } as unknown as Principal;
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

/**
 * BQ-M23 supervisor must-fix 1 (Rules audits/impact/m23-booked-drivertotal-supervisor.md; owner G8 Q3 "One number",
 * contract.json#finish.driverMoney.rule; J6): an admin can change the driver's pay of a booked ride he holds (status
 * accepted, POST /admin/trips/{id}/adjust driverPay). The Booked rides row then shows the new pay, the same number as
 * the trip's driverTotal (TripProjection, driverTotalOf): the change is kept, capped so the pay never shows below 0.
 */
describe("BQ-M23 MF1: Booked rides driverTotal includes the admin's driver-pay change (J6)", () => {
  const adjust = async (tripId: string, amountMinor: number, currency: string) => {
    const trip = await database.db.selectFrom("trips").select("version").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    const out = await database.db.transaction().execute((trx) => adminAdjust(trx, SUPER, tripId, { expectedVersion: trip.version, driverPay: { amountMinor, currency }, reason: "M23 test" } as never, NOW));
    expect(out.status).toBe(200);
  };
  const tripTotal = async (tripId: string) => {
    const trip = (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow()) as unknown as TripRow;
    return (tripProjection(trip, "driver") as Record<string, unknown>)["driverTotal"];
  };

  for (const c of [
    { currency: "SEK", earnings: 18_950, pickupPay: 1_500, bonus: 2_000, up: 24_450, down: 20_450 },
    { currency: "TND", earnings: 12_350, pickupPay: 650, bonus: 2_000, up: 17_000, down: 13_000 },
  ]) {
    it(`${c.currency}: admin types the pay up, then down; the row's driverTotal = the typed pay = the trip's driverTotal`, async () => {
      const driverId = await insertDriver(database.db);
      const tripId = await booked(driverId, c);
      await adjust(tripId, c.up, c.currency);
      expect((await row(driverId, tripId))["driverTotal"]).toEqual({ amountMinor: c.up, currency: c.currency });
      expect(await tripTotal(tripId)).toEqual({ amountMinor: c.up, currency: c.currency });
      await adjust(tripId, c.down, c.currency);
      const item = await row(driverId, tripId);
      expect(item["driverTotal"]).toEqual({ amountMinor: c.down, currency: c.currency });
      expect(await tripTotal(tripId)).toEqual(item["driverTotal"]);
      // earnings stays the trip line (the change is its own line, not in earnings).
      expect(item["earnings"]).toEqual({ amountMinor: c.earnings, currency: c.currency });
    });
  }

  it("the change is capped: a big cut shown on the row never takes the pay below 0", async () => {
    const driverId = await insertDriver(database.db);
    const tripId = await booked(driverId, { currency: "TND", earnings: 3_000, pickupPay: 0, bonus: 0 });
    // A later re-price shrank the earnings under a kept cut: the stored change (−5 DT) is more than the pay (3 DT).
    await database.db.updateTable("trips").set({ driver_adjustments_minor: -5_000 }).where("trip_id", "=", tripId).execute();
    expect((await row(driverId, tripId))["driverTotal"]).toEqual({ amountMinor: 0, currency: "TND" });
    expect(await tripTotal(tripId)).toEqual({ amountMinor: 0, currency: "TND" });
  });
});
