import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { driverReservations } from "../../src/reservations/service.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * v0.18.179 (contract.json#reservationRouteLine; owner 2026-11-28 "map must show the REAL route", 18:44 "Build the
 * scheduled-route fix NOW"): every DriverReservation item carries the trip's stored Google polyline (trips.route_polyline,
 * from the booking quote) as routePolyline, so Bokade resor and Bokningsdetaljer draw the real road route with 0 Google calls.
 * No stored route -> no field (the app shows the pins only).
 */
let database: TestDatabase;
let riderId: string;
const NOW = new Date("2026-11-28T08:00:00Z");
const AT = new Date("2026-11-28T14:00:00Z");
const LINE = "c`ojJ{_bkBp@}AjAoCdAiC";

async function booked(driverId: string, polyline: string | null): Promise<string> {
  const id = await insertTrip(database.db, riderId, { status: "accepted", kind: "scheduled", driverId });
  const state = { mode: "list", rideType: "normal", dispatchAt: AT.toISOString(), freeChangeUntil: AT.toISOString(), noDriver: false };
  await database.db.updateTable("trips").set({ scheduled_at: AT, accepted_at: NOW, reservation: JSON.stringify(state), route_polyline: polyline }).where("trip_id", "=", id).execute();
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

describe("v0.18.179 DriverReservation.routePolyline", () => {
  it("sends the stored Google polyline of the booked trip", async () => {
    const driverId = await insertDriver(database.db);
    const tripId = await booked(driverId, LINE);
    expect((await row(driverId, tripId))["routePolyline"]).toBe(LINE);
  });

  it("no stored route: no field (never an empty string, never a made-up line)", async () => {
    const driverId = await insertDriver(database.db);
    const tripId = await booked(driverId, null);
    expect(await row(driverId, tripId)).not.toHaveProperty("routePolyline");
  });
});
