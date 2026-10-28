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

/** Contract v0.10.1: activation needs every required driver document approved; tests that activate seed them here. */
export async function approveDriverDocuments(db: Db, driverId: string, only?: string[]): Promise<void> {
  const { requiredDocuments } = await import("../../src/drivers/onboardingRules.js");
  const row = await db.selectFrom("drivers").select("country").where("driver_id", "=", driverId).executeTakeFirstOrThrow();
  const now = new Date();
  for (const type of only ?? requiredDocuments(row.country, "driver")) {
    await db
      .insertInto("documents")
      .values({ document_id: newId("doc"), driver_id: driverId, owner_kind: "driver", owner_id: driverId, type, status: "approved", reviewed_at: now, reviewed_by: "seed", created_at: now, updated_at: now })
      .onConflict((c) => c.columns(["owner_kind", "owner_id", "type"]).doUpdateSet({ status: "approved", reviewed_at: now, updated_at: now }))
      .execute();
  }
}

/** Contract v0.10.1: a car is picked only with every required car document approved. */
export async function approveVehicleDocuments(db: Db, vehicleId: string, driverId: string, country: string, only?: string[]): Promise<void> {
  const { requiredDocuments } = await import("../../src/drivers/onboardingRules.js");
  const now = new Date();
  for (const type of only ?? requiredDocuments(country, "vehicle")) {
    await db
      .insertInto("documents")
      .values({ document_id: newId("doc"), driver_id: driverId, owner_kind: "vehicle", owner_id: vehicleId, type, status: "approved", reviewed_at: now, reviewed_by: "seed", created_at: now, updated_at: now })
      .onConflict((c) => c.columns(["owner_kind", "owner_id", "type"]).doUpdateSet({ status: "approved", reviewed_at: now, updated_at: now }))
      .execute();
  }
}

/** Approves every required fleet (company) document on the owner's account. */
export async function approveFleetDocuments(db: Db, ownerId: string, only?: string[]): Promise<void> {
  const { requiredDocuments } = await import("../../src/drivers/onboardingRules.js");
  const row = await db.selectFrom("drivers").select("country").where("driver_id", "=", ownerId).executeTakeFirstOrThrow();
  await approveDriverDocuments(db, ownerId, only ?? requiredDocuments(row.country, "fleet"));
}
