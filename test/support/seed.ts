import type { Db } from "../../src/db/db.js";
import { newId } from "../../src/ids.js";

/**
 * Seed phones (BQ-O16): unique by construction, never by luck. Math.random once gave two drivers in one test database
 * the same number (duplicate drivers_phone_key in test/cleanup/payouts.test.ts). Now: a per-process counter plus the
 * worker (VITEST_POOL_ID, else pid), so two seeds in one run never share a number. The +4672 (rider) / +4673 (driver)
 * ranges are never typed in by hand in tests (those use +4670…), so a seed never takes a fixed test number either.
 */
let seedPhoneCount = 0;
const seedWorker = Number(process.env.VITEST_POOL_ID ?? process.pid) % 1000;
export function seedPhone(prefix: "+4672" | "+4673"): string {
  seedPhoneCount += 1;
  if (seedPhoneCount > 9_999) throw new Error("seedPhone: more than 9 999 seeded phones in one worker; widen the number");
  return `${prefix}${String(seedWorker).padStart(3, "0")}${String(seedPhoneCount).padStart(4, "0")}`;
}

/** Minimal rows for database tests; real commands build these through the trip service. */
export async function insertRider(db: Db, overrides: { riderId?: string; phone?: string } = {}): Promise<string> {
  const riderId = overrides.riderId ?? newId("rdr");
  await db
    .insertInto("riders")
    .values({ rider_id: riderId, phone: overrides.phone ?? seedPhone("+4672"), email: null, language: null })
    .execute();
  return riderId;
}

export async function insertDriver(db: Db, overrides: { driverId?: string } = {}): Promise<string> {
  const driverId = overrides.driverId ?? newId("drv");
  await db
    .insertInto("drivers")
    .values({ driver_id: driverId, phone: seedPhone("+4673"), online_since: null, vehicle_id: null, scheduled_rides: null })
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

/** Contract v0.14.0: activation needs every required driver document approved; tests that activate seed them here. */
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

/** Contract v0.14.0: a car is picked only with every required car document approved. */
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

/**
 * v0.18.166 (contract.json#signupV2): the sign-up fields SE and FR require by default, added to a POST /driver/onboarding
 * body that does not carry them: the address, and for Sweden a personnummer matching dateOfBirth (valid Luhn digit).
 */
export function signup<T>(body: T): T {
  const b = body as Record<string, unknown>;
  if (b === null || typeof b !== "object") return body;
  const out: Record<string, unknown> = { address: { street: "Storgatan 1", postalCode: "111 22", city: "Stockholm" }, ...b };
  const dob = typeof b["dateOfBirth"] === "string" ? (b["dateOfBirth"] as string) : "";
  if (b["country"] === "SE" && b["personalNumber"] === undefined && /^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    const nine = `${dob.replace(/-/g, "").slice(2)}123`;
    let sum = 0;
    for (let i = 0; i < 9; i++) { let v = Number(nine[i]) * (i % 2 === 0 ? 2 : 1); if (v > 9) v -= 9; sum += v; }
    out["personalNumber"] = `${dob.replace(/-/g, "")}-123${(10 - (sum % 10)) % 10}`;
  }
  return out as T;
}
