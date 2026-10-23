import type { Db } from "../../src/db/db.js";
import { newId } from "../../src/ids.js";

/** Minimal rows for database tests; real commands build these through the trip service. */
export async function insertRider(db: Db, overrides: { riderId?: string; phone?: string } = {}): Promise<string> {
  const riderId = overrides.riderId ?? newId("rdr");
  await db
    .insertInto("riders")
    .values({ rider_id: riderId, phone: overrides.phone ?? `+4670${Math.floor(1_000_000 + Math.random() * 8_999_999)}`, email: null, language: null })
    .execute();
  return riderId;
}

export async function insertDriver(db: Db, overrides: { driverId?: string } = {}): Promise<string> {
  const driverId = overrides.driverId ?? newId("drv");
  await db
    .insertInto("drivers")
    .values({ driver_id: driverId, phone: `+4673${Math.floor(1_000_000 + Math.random() * 8_999_999)}`, online_since: null, vehicle_id: null, scheduled_rides: null })
    .execute();
  return driverId;
}

export async function insertTrip(
  db: Db,
  riderId: string,
  overrides: { tripId?: string; status?: string; kind?: "live" | "scheduled"; driverId?: string | null } = {},
): Promise<string> {
  const tripId = overrides.tripId ?? newId("trp");
  const place = (name: string) => JSON.stringify({ lat: 59.33, lng: 18.06, address: name });
  await db
    .insertInto("trips")
    .values({
      trip_id: tripId,
      rider_id: riderId,
      driver_id: overrides.driverId ?? null,
      vehicle_id: null,
      zone_id: "stockholm",
      kind: overrides.kind ?? "live",
      category_id: "standard",
      status: overrides.status ?? "searching",
      ended_by_command: null,
      scheduled_at: null,
      accepted_at: null,
      search_started_at: null,
      pickup: place("Pickup"),
      dropoff: place("Dropoff"),
      quote_id: null,
      currency: "SEK",
      fare_minor: 25_000,
      booked_fare_minor: 25_000,
      payment_method: "card",
      payment_method_id: null,
      payment_status: null,
      waiting: null,
      cancellation: null,
    })
    .execute();
  return tripId;
}
