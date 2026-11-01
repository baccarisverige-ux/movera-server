import { sql } from "kysely";
import { TERMS_REASON, termsAccepted } from "../content/routes.js";
import { schemaProblem } from "../contract/schemas.js";
import type { Executor, Trx } from "../db/db.js";
import { appendTripEvent } from "../db/tripLog.js";
import { DRIVER_SILENCE, maybeNearDropoff } from "../trips/ride.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { zoneAt } from "../config/zoneLookup.js";
import { DRIVER_ASSIGNED } from "../rules/transitions.js";
import { scheduleTimer } from "../jobs/timers.js";
import { CLEAR_OFFLINE_REASON } from "./offlineReason.js";
import { documentSummaries } from "../documents/service.js";
import { EXTRA_CATEGORIES, carRuleProblems, categoryProblem, liveRequiredDocuments, onboardingSettings, type Fuel } from "./onboardingSettings.js";
import { expiredBlockers, pickableCars, vehicleCountry, vehicleDocumentBlockers } from "./readiness.js";
import { signUpView } from "./reminders.js";
import { DRIVER_HOME, areaView, hasFreshPosition } from "./presence.js";
import { RIDERS_ONLINE_WINDOW_SECONDS, ridersOnlineByZone } from "../riders/presence.js";

/**
 * Drivers: profile, going online and offline, and location (contract §2 Driver, §3.3, §4, §12). A driver can be
 * online only with an active account and an approved vehicle; while on a trip they cannot go offline. Every fix
 * keeps the driver's latest position (driver_locations, never the driver row, so it never waits on a command);
 * during a trip each fix also goes to the trip's trace and stream as a `location` event.
 */

/** No fix for this long: excluded from dispatch and shown as stale, still online (contract §12). */
export const STALE_AFTER_SECONDS = 120;
/**
 * G5 live re-test (coordinator decision 2026-11-01; the contract has no field): a phone standing still re-sends its last
 * OS fix, which keeps received_at fresh (presence and auto-offline use received_at). Where the PLACE matters the fix's own
 * age counts too: dispatch candidacy, offer distance and riders' nearby cars only take a fix measured in the last 5 min
 * (same as the default noFixMinutes); an ETA from a fix measured more than STALE_AFTER_SECONDS ago is "stale".
 */
export const DISPATCH_FIX_MAX_AGE_SECONDS = 300;
export const ETA_FIX_MAX_AGE_SECONDS = STALE_AFTER_SECONDS;
/** Fixes older than this, or from the future, are dropped. */
const MAX_FIX_AGE_MS = 10 * 60 * 1000;
const MAX_FIX_AHEAD_MS = 60 * 1000;

export type DriverRow = {
  driver_id: string;
  phone: string;
  first_name: string;
  account_status: string;
  online_status: string;
  zone_ids: string[];
  category_ids: string[];
  vehicle_id: string | null;
  scheduled_rides: unknown;
  rating_sum: number;
  rating_count: number;
  version: number;
  // v0.5.3 (§14)
  account_type: "driver" | "fleet" | null;
  last_name: string;
  date_of_birth: Date | null;
  email: string | null;
  country: string | null;
  city_id: string | null;
  language: string | null;
  terms_accepted_at: Date | null;
  fleet_id: string | null;
  fleet_linked_at: Date | null;
  // v0.18.6 (owner "Send the real reason")
  offline_reason?: string | null;
  offline_note?: string | null;
  offline_at?: Date | null;
};

type Fix = { lat: number; lng: number; accuracy: number; heading?: number; speedMps?: number; moving?: boolean; measuredAt: string };

export async function loadDriver(ex: Executor, driverId: string, lock = false): Promise<DriverRow> {
  let query = ex.selectFrom("drivers").selectAll().where("driver_id", "=", driverId);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new ApiError("not_found", "No such driver.", { reason: "driver_not_found" });
  return row as unknown as DriverRow;
}

async function activeTripOf(ex: Executor, driverId: string) {
  return ex.selectFrom("trips").select(["trip_id", "status", "version", "driver_silent_alert"]).where("driver_id", "=", driverId).where("status", "in", [...DRIVER_ASSIGNED]).executeTakeFirst();
}

export async function driverView(ex: Executor, row: DriverRow, viewer: "driver" | "admin"): Promise<Record<string, unknown>> {
  const location = await ex.selectFrom("driver_locations").selectAll().where("driver_id", "=", row.driver_id).executeTakeFirst();
  const active = await activeTripOf(ex, row.driver_id);
  const fleet = row.fleet_id ? await ex.selectFrom("fleets").select(["fleet_id", "name", "status", "owner_driver_id", "created_at"]).where("fleet_id", "=", row.fleet_id).executeTakeFirst() : undefined;
  const dob = row.date_of_birth;
  return {
    driverId: row.driver_id,
    accountStatus: row.account_status,
    onlineStatus: row.online_status,
    // v0.18.6 (owner "Send the real reason"): why the server set him offline, while he is offline.
    ...(row.online_status === "offline" && row.offline_reason ? { offlineReason: row.offline_reason, ...(row.offline_note ? { offlineNote: row.offline_note } : {}), ...(row.offline_at ? { offlineAt: row.offline_at.toISOString() } : {}) } : {}),
    ...(location ? { moving: location.moving } : {}),
    firstName: row.first_name,
    ...(row.rating_count > 0 ? { rating: Math.round((row.rating_sum / row.rating_count) * 100) / 100 } : {}),
    zoneIds: row.zone_ids,
    categoryIds: row.category_ids,
    ...(row.vehicle_id ? { vehicleId: row.vehicle_id } : {}),
    documents: await documentSummaries(ex, "driver", row.driver_id),
    // v0.5.3 (§14): the sign-up details, the fleet and the documents this account needs.
    ...(row.account_type ? { accountType: row.account_type } : {}),
    ...(row.last_name ? { lastName: row.last_name } : {}),
    ...(dob ? { dateOfBirth: dob instanceof Date ? dob.toISOString().slice(0, 10) : String(dob) } : {}),
    ...(row.email ? { email: row.email } : {}),
    ...(row.country ? { country: row.country } : {}),
    ...(row.city_id ? { cityId: row.city_id } : {}),
    ...(row.language ? { language: row.language } : {}),
    ...(row.terms_accepted_at ? { termsAcceptedAt: row.terms_accepted_at.toISOString() } : {}),
    ...(fleet
      ? { fleet: { fleetId: fleet.fleet_id, name: fleet.name, role: fleet.owner_driver_id === row.driver_id ? "owner" : "member", status: fleet.status, linkedAt: (row.fleet_linked_at ?? fleet.created_at).toISOString() } }
      : {}),
    ...(row.account_type === "fleet" ? { payoutTo: "self" } : row.account_type === "driver" && fleet ? { payoutTo: "fleet" } : {}),
    ...(row.account_type ? { pendingFleetInvitations: await pendingInvitations(ex, row) } : {}),
    // v0.18.0 (§27): the lists of the country's onboarding settings (the admin's), else the contract defaults.
    requiredDocuments: await liveRequiredDocuments(ex, row.country, "driver"),
    ...(row.account_type === "fleet" ? { requiredFleetDocuments: await liveRequiredDocuments(ex, row.country, "fleet") } : {}),
    ...(active ? { activeTripId: active.trip_id } : {}),
    ...(row.scheduled_rides ? { scheduledRides: row.scheduled_rides } : {}),
    // v0.18.4 (G3-R2): the driver is told when his latest position is outside all his zones (no trips there).
    ...(viewer === "driver" ? await areaView(ex, row) : {}),
    version: row.version,
    ...(viewer === "admin" ? await signUpView(ex, row) : {}),
    ...(viewer === "admin" && location
      ? {
          location: fixView(location),
          lastFixAt: location.received_at.toISOString(),
        }
      : {}),
  };
}

/** v0.5.3: invitations waiting for this account's answer (a driver's incoming invites, an owner's incoming requests). */
async function pendingInvitations(ex: Executor, row: Pick<DriverRow, "driver_id" | "account_type">): Promise<number> {
  const q =
    row.account_type === "fleet"
      ? ex
          .selectFrom("fleet_invitations")
          .innerJoin("fleets", "fleets.fleet_id", "fleet_invitations.fleet_id")
          .where("fleets.owner_driver_id", "=", row.driver_id)
          .where("fleet_invitations.direction", "=", "driver_request")
      : ex.selectFrom("fleet_invitations").where("fleet_invitations.driver_id", "=", row.driver_id).where("fleet_invitations.direction", "=", "owner_invite");
  const n = await q
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("fleet_invitations.status", "=", "pending")
    .where("fleet_invitations.expires_at", ">", sql<Date>`now()`)
    .executeTakeFirstOrThrow();
  return Number(n.n);
}

export function fixView(row: { lat: number; lng: number; accuracy: number; heading: number | null; speed_mps: number | null; moving: boolean; measured_at: Date }) {
  return {
    lat: row.lat,
    lng: row.lng,
    accuracy: row.accuracy,
    ...(row.heading !== null ? { heading: row.heading } : {}),
    ...(row.speed_mps !== null ? { speedMps: row.speed_mps } : {}),
    moving: row.moving,
    measuredAt: row.measured_at.toISOString(),
  };
}

export async function getDriverProfile(ex: Executor, driverId: string) {
  return driverView(ex, await loadDriver(ex, driverId), "driver");
}

function stale(row: DriverRow, ex: Executor) {
  return async () => driverView(ex, await loadDriver(ex, row.driver_id), "driver");
}

export async function updateDriverProfile(trx: Trx, driverId: string, body: unknown, now: Date) {
  const problem = schemaProblem("DriverProfileUpdate", body);
  if (problem !== null) throw badRequest(`The profile change is not valid: ${problem}.`, "invalid_body");
  const update = body as { expectedVersion: number; firstName?: string; vehicleId?: string; categoryIds?: string[] };
  const row = await loadDriver(trx, driverId, true);
  if (row.version !== update.expectedVersion) throw new ApiError("version_mismatch", "Your profile changed since you last saw it.", { projection: await stale(row, trx)() });
  let categoryIds = update.categoryIds;
  if (update.vehicleId !== undefined) {
    const vehicle = await trx.selectFrom("vehicles").selectAll().where("vehicle_id", "=", update.vehicleId).forUpdate().executeTakeFirst();
    // v0.5.3: one of the fleet's cars, or (a driver from before v0.5.3) the driver's own.
    const mine = vehicle !== undefined && (vehicle.fleet_id !== null ? vehicle.fleet_id === row.fleet_id : vehicle.driver_id === driverId);
    if (vehicle === undefined || !mine) throw badRequest("That vehicle is not yours.", "vehicle_not_found");
    if (vehicle.status !== "approved") throw badRequest("That vehicle is not approved yet.", "vehicle_not_approved");
    // v0.10.1: only a car whose required documents are all approved can be picked.
    const carMissing = await vehicleDocumentBlockers(trx, vehicle, now, driverId);
    if (carMissing.length > 0) throw new ApiError("documents_not_approved", "That car's documents are not all approved.", { reason: "vehicle_documents_not_approved", details: carMissing });
    if (vehicle.fleet_id !== null && vehicle.driver_id !== null && vehicle.driver_id !== driverId) {
      // One car, one driver at a time: in use while the other driver is online or on a trip; an offline driver's pick moves.
      const other = await trx.selectFrom("drivers").select(["online_status", "vehicle_id"]).where("driver_id", "=", vehicle.driver_id).executeTakeFirst();
      if (other && other.vehicle_id === vehicle.vehicle_id && other.online_status !== "offline") {
        throw new ApiError("conflict", "Another driver is driving this car right now.", { reason: "vehicle_in_use" });
      }
      if (other && other.vehicle_id === vehicle.vehicle_id) await trx.updateTable("drivers").set({ vehicle_id: null, updated_at: now }).where("driver_id", "=", vehicle.driver_id).execute();
    }
    if (vehicle.fleet_id !== null) {
      await releaseCar(trx, driverId);
      await trx.updateTable("vehicles").set({ driver_id: driverId, updated_at: now }).where("vehicle_id", "=", vehicle.vehicle_id).execute();
    }
    categoryIds ??= row.category_ids.length ? vehicle.category_ids.filter((c) => row.category_ids.includes(c)) : vehicle.category_ids;
  }
  if (categoryIds !== undefined) {
    const vehicleId = update.vehicleId ?? row.vehicle_id;
    const vehicle = vehicleId ? await trx.selectFrom("vehicles").select("category_ids").where("vehicle_id", "=", vehicleId).executeTakeFirst() : undefined;
    const allowed = vehicle?.category_ids ?? [];
    const outside = categoryIds.filter((c) => !allowed.includes(c));
    if (outside.length) throw badRequest(`Your car is not approved for ${outside.join(", ")}.`, "category_not_allowed");
  }
  await trx
    .updateTable("drivers")
    .set({
      ...(update.firstName !== undefined ? { first_name: update.firstName.trim() } : {}),
      ...(update.vehicleId !== undefined ? { vehicle_id: update.vehicleId } : {}),
      ...(categoryIds !== undefined ? { category_ids: categoryIds } : {}),
      version: row.version + 1,
      updated_at: now,
    })
    .where("driver_id", "=", driverId)
    .execute();
  return driverView(trx, await loadDriver(trx, driverId), "driver");
}

/** POST /driver/availability: online or offline (contract: 409 with the Driver when it cannot be). */
export async function setAvailability(trx: Trx, driverId: string, body: { expectedVersion: number; onlineStatus: "online" | "offline"; location?: Fix }, now: Date) {
  // The fix first: on a trip it locks the trip row, and the lock order is trip, then driver.
  if (body.location) await storeFixes(trx, driverId, [body.location], undefined, now);
  const row = await loadDriver(trx, driverId, true);
  const refuse = async (message: string, reason: string) => new ApiError("invalid_transition", message, { reason, projection: await stale(row, trx)() });
  if (row.version !== body.expectedVersion) throw new ApiError("version_mismatch", "Your status changed since you last saw it.", { projection: await stale(row, trx)() });
  // On a trip the driver already counts as online; "online" must not turn on_trip into free.
  if (body.onlineStatus === row.online_status || (body.onlineStatus === "online" && row.online_status === "on_trip")) return driverView(trx, row, "driver");
  if (body.onlineStatus === "online") {
    if (row.account_status !== "active") throw await refuse("Your account is not active yet.", "account_not_active");
    // v0.5.3: a driver account works for a fleet; the fleet must be approved (not blocked).
    if (row.account_type === "driver" && row.fleet_id === null) throw await refuse("Join a fleet first.", "no_fleet");
    if (row.fleet_id !== null) {
      const fleet = await trx.selectFrom("fleets").select("status").where("fleet_id", "=", row.fleet_id).executeTakeFirst();
      if (fleet?.status !== "approved") throw await refuse("Your fleet is not approved.", "fleet_not_approved");
    }
    // v0.18.0 (owner items 1 and 3): an expired required document keeps the driver offline while blockAtExpiry is on.
    const expired = await expiredBlockers(trx, row, now);
    if (expired.length > 0) throw new ApiError("documents_not_approved", "A document has expired; upload a new one.", { reason: "documents_expired", details: expired, projection: await stale(row, trx)() });
    // v0.18.0 (owner item 9): no car picked; a fleet with no car that can be picked says so.
    if (row.vehicle_id === null) {
      if (row.fleet_id !== null && (await pickableCars(trx, row.fleet_id, now, driverId)).length === 0) throw await refuse("Your fleet has no approved car yet.", "fleet_no_approved_car");
      throw await refuse("Choose an approved car first.", "no_vehicle");
    }
    const vehicle = await trx.selectFrom("vehicles").select(["vehicle_id", "status", "driver_id", "fleet_id"]).where("vehicle_id", "=", row.vehicle_id).executeTakeFirst();
    if (vehicle?.status !== "approved") throw await refuse("Your car is not approved.", "vehicle_not_approved");
    const carMissing = await vehicleDocumentBlockers(trx, vehicle, now, driverId);
    if (carMissing.length > 0) throw new ApiError("documents_not_approved", "Your car's documents are not all approved.", { reason: "vehicle_documents_not_approved", details: carMissing, projection: await stale(row, trx)() });
    if (vehicle.fleet_id !== null && vehicle.driver_id !== driverId) throw await refuse("Another driver has this car now; pick a car again.", "vehicle_in_use");
    if (row.category_ids.length === 0) throw await refuse("No car type is chosen.", "no_category");
    // v0.10.0 §19 Legal: new terms published with reaccept must be accepted before going online.
    const fix = await trx.selectFrom("driver_locations").select("zone_id").where("driver_id", "=", driverId).executeTakeFirst();
    const zones = [...row.zone_ids, ...(fix?.zone_id ? [fix.zone_id] : [])];
    if (!(await termsAccepted(trx, "driver", driverId, zones))) throw await refuse("Accept the new terms first.", TERMS_REASON);
    // v0.18.4 (decision 2, G3-R5): a fresh position, last, so the reason card shows the first thing to fix. Outside
    // his zones he still goes online (G3-R2); the answer says outsideArea.
    if (!(await hasFreshPosition(trx, driverId, now))) throw await refuse("Turn on location to go online.", DRIVER_HOME.locationRequired.reason);
  } else if (await activeTripOf(trx, driverId)) {
    throw await refuse("Finish or hand back your trip before going offline.", "on_trip");
  }
  const online = body.onlineStatus === "online";
  await trx
    .updateTable("drivers")
    .set({ online_status: body.onlineStatus, online_since: online ? now : null, ...(online ? { last_free_at: now } : {}), ...CLEAR_OFFLINE_REASON, version: row.version + 1, updated_at: now })
    .where("driver_id", "=", driverId)
    .execute();
  // Going offline withdraws the driver's open offers (a job locks each trip in turn).
  if (!online) await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: driverId, dueAt: now, payload: {} });
  return driverView(trx, await loadDriver(trx, driverId), "driver");
}

/** POST /driver/location: up to 50 fixes; answers how many were taken. */
export async function postLocations(trx: Trx, driverId: string, body: unknown, now: Date): Promise<{ accepted: number; serverTime: string; outsideArea?: boolean }> {
  const problem = schemaProblem("LocationBatch", body);
  if (problem !== null) throw badRequest(`The location batch is not valid: ${problem}.`, "invalid_body");
  const batch = body as { fixes: Fix[]; tripId?: string };
  const accepted = await storeFixes(trx, driverId, batch.fixes, batch.tripId, now);
  // v0.18.4 (G3-R2): so the app can show "You are not eligible to drive in this area" when he drives out.
  const driver = await trx.selectFrom("drivers").select(["driver_id", "zone_ids", "language"]).where("driver_id", "=", driverId).executeTakeFirst();
  return { accepted, serverTime: now.toISOString(), ...(driver ? await areaView(trx, driver) : {}) };
}

async function storeFixes(trx: Trx, driverId: string, fixes: Fix[], _tripId: string | undefined, now: Date): Promise<number> {
  const fresh = fixes
    .map((fix) => ({ fix, at: new Date(fix.measuredAt) }))
    .filter(({ at }) => !Number.isNaN(at.getTime()) && now.getTime() - at.getTime() <= MAX_FIX_AGE_MS && at.getTime() - now.getTime() <= MAX_FIX_AHEAD_MS)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (fresh.length === 0) return 0;
  const latest = fresh[fresh.length - 1]!;
  const zone = await zoneAt(trx, latest.fix);
  const values = {
    driver_id: driverId,
    lat: latest.fix.lat,
    lng: latest.fix.lng,
    accuracy: latest.fix.accuracy,
    heading: latest.fix.heading ?? null,
    speed_mps: latest.fix.speedMps ?? null,
    moving: latest.fix.moving ?? false,
    measured_at: latest.at,
    received_at: now,
    zone_id: zone?.zoneId ?? null,
  };
  // Only a newer fix replaces the stored one (batches can arrive out of order on a bad connection).
  // G5 live re-test: the same fix sent again (a phone standing still re-sends its last OS fix with the OS's own
  // time) refreshes received_at, so the driver is neither stale (120 s) nor set offline while the app keeps sending.
  await trx
    .insertInto("driver_locations")
    .values(values)
    .onConflict((c) => c.column("driver_id").doUpdateSet(values).where("driver_locations.measured_at", "<=", latest.at))
    .execute();

  // On a trip, the trip is the one the server knows, whatever tripId the app sent.
  const active = await activeTripOf(trx, driverId);
  if (active) {
    await trx
      .insertInto("trip_locations")
      .values(fresh.map(({ fix, at }) => ({ trip_id: active.trip_id, driver_id: driverId, measured_at: at, lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, heading: fix.heading ?? null, speed_mps: fix.speedMps ?? null, moving: fix.moving ?? false })))
      .onConflict((c) => c.columns(["trip_id", "measured_at", "driver_id"]).doNothing())
      .execute();
    // One location event per batch, with the newest fix; it never changes the projection version (§4).
    await appendTripEvent(trx, { tripId: active.trip_id, kind: "location", version: active.version, occurredAt: now, location: { ...latest.fix, measuredAt: latest.at.toISOString() } });
    await maybeNearDropoff(trx, active, latest.fix, now);
    // Car lost (contract v0.7.0 §15): the position is back, so the silence check runs now and takes the alarm down.
    if (active.driver_silent_alert) await scheduleTimer(trx, { kind: DRIVER_SILENCE, refId: active.trip_id, dueAt: now });
  }
  return fresh.length;
}

/* ---------------------------------------------------------------- vehicles */

export type VehicleRow = { vehicle_id: string; driver_id: string | null; fleet_id: string | null; make: string; model: string; year: number; color: string; plate: string; seats: number; category_ids: string[]; status: string; version: number; fuel?: Fuel | null };
export const vehicleView = (v: VehicleRow) => ({
  vehicleId: v.vehicle_id,
  make: v.make,
  model: v.model,
  year: v.year,
  color: v.color,
  plate: v.plate,
  seats: v.seats,
  categoryIds: v.category_ids,
  status: v.status,
  version: v.version,
  ...(v.fuel ? { fuel: v.fuel } : {}),
  ...(v.fleet_id ? { fleetId: v.fleet_id } : {}),
  ...(v.fleet_id && v.driver_id ? { driverId: v.driver_id } : {}),
});

/** Vehicle with its v0.5.3 fields: who has it picked, whether that driver is out with it, its documents. */
/**
 * v0.18.0 (owner decision 19): `viewer` is the driver who asks. The fleet's owner sees the car's documents; a member
 * sees no car documents, only whether he can pick the car (pickable, notPickableReason). No viewer = an admin.
 */
export async function vehicleFullView(ex: Executor, v: VehicleRow, viewer?: { driverId: string; owner: boolean }) {
  let inUse = false;
  let country: string | null = null;
  if (v.fleet_id) {
    const fleet = await ex.selectFrom("fleets").select("country").where("fleet_id", "=", v.fleet_id).executeTakeFirst();
    country = fleet?.country ?? null;
    if (v.driver_id) {
      const picker = await ex.selectFrom("drivers").select(["online_status", "vehicle_id"]).where("driver_id", "=", v.driver_id).executeTakeFirst();
      inUse = picker?.vehicle_id === v.vehicle_id && picker.online_status !== "offline";
    }
  } else if (v.driver_id) {
    const owner = await ex.selectFrom("drivers").select("country").where("driver_id", "=", v.driver_id).executeTakeFirst();
    country = owner?.country ?? null;
  }
  const pick = viewer ? await pickability(ex, v, viewer.driverId, inUse) : undefined;
  // v0.18.3 (R2): the rules the car breaks now, for the admin's red warning and the fleet owner.
  const ruleProblems = !viewer || viewer.owner ? await rulesBrokenBy(ex, v, country) : [];
  // v0.18.5 (G2-D5.3, vehicleRules.fitCategories): the categories the admin may give this car.
  const fit = !viewer || viewer.owner ? await fitCategories(ex, v, country) : undefined;
  return {
    ...vehicleView(v),
    ...(v.fleet_id ? { inUse } : {}),
    ...(ruleProblems.length > 0 ? { ruleProblems } : {}),
    ...(fit ? { fitCategories: fit } : {}),
    ...(viewer && !viewer.owner ? {} : { documents: await documentSummaries(ex, "vehicle", v.vehicle_id), requiredDocuments: await liveRequiredDocuments(ex, country, "vehicle") }),
    ...(pick ? { pickable: pick.reason === null, ...(pick.reason ? { notPickableReason: pick.reason } : {}) } : {}),
  };
}

/** v0.18.5 (G2-D5.3): the country's ride categories that are on, and the extras, that the car fits now. */
export async function fitCategories(ex: Executor, v: Pick<VehicleRow, "year" | "seats"> & { fuel?: Fuel | null }, country: string | null): Promise<string[] | undefined> {
  if (!country) return undefined;
  const settings = await onboardingSettings(ex, country);
  const car = { year: v.year, seats: v.seats, fuel: v.fuel ?? null };
  const all = [...new Set([...settings.vehicles.categories.filter((r) => r.on).map((r) => r.category), ...EXTRA_CATEGORIES])];
  return all.filter((c) => categoryProblem(car, settings, c) === null);
}

/** v0.18.3 (R2, vehicleRules.approval): "<category>:<problem>" for every car rule of its country the car breaks. */
export async function rulesBrokenBy(ex: Executor, v: Pick<VehicleRow, "year" | "seats" | "category_ids"> & { fuel?: Fuel | null }, country: string | null): Promise<string[]> {
  if (!country) return [];
  return carRuleProblems({ year: v.year, seats: v.seats, fuel: v.fuel ?? null }, await onboardingSettings(ex, country), v.category_ids);
}

/** Whether `driverId` can pick the car now, and why not (contract.json#driverOnboarding.carDocuments). */
async function pickability(ex: Executor, v: VehicleRow, driverId: string, inUse: boolean): Promise<{ reason: string | null }> {
  if (v.status !== "approved") return { reason: "vehicle_not_approved" };
  if ((await vehicleDocumentBlockers(ex, v, new Date(), driverId)).length > 0) return { reason: "vehicle_documents_not_approved" };
  if (inUse && v.driver_id !== driverId) return { reason: "vehicle_in_use" };
  return { reason: null };
}

/** The driver's car goes back to the fleet pool (v0.5.3). */
export async function releaseCar(trx: Trx, driverId: string): Promise<void> {
  await trx.updateTable("vehicles").set({ driver_id: null }).where("driver_id", "=", driverId).where("fleet_id", "is not", null).execute();
}

/** GET /driver/vehicles: the fleet's cars (a member sees the approved ones), or a pre-v0.5.3 driver's own. */
export async function listVehicles(ex: Executor, driverId: string) {
  const me = await loadDriver(ex, driverId);
  let q = ex.selectFrom("vehicles").selectAll();
  if (me.fleet_id !== null) {
    // v0.18.0 (owner decision 19): a member sees every car of the fleet, with whether he can pick it.
    q = q.where("fleet_id", "=", me.fleet_id);
  } else {
    q = q.where("driver_id", "=", driverId).where("fleet_id", "is", null);
  }
  const rows = await q.orderBy("created_at").execute();
  const items = [];
  const owner = me.account_type === "fleet" || me.fleet_id === null;
  for (const r of rows) items.push(await vehicleFullView(ex, r as unknown as VehicleRow, { driverId, owner }));
  return { items, nextCursor: null };
}

export async function addVehicle(trx: Trx, driverId: string, body: unknown, now: Date) {
  const problem = schemaProblem("VehicleRequest", body);
  if (problem !== null) throw badRequest(`The vehicle is not valid: ${problem}.`, "invalid_body");
  const v = body as { make: string; model: string; year: number; color: string; plate: string; seats?: number; categoryIds?: string[]; fuel?: Fuel };
  const me = await loadDriver(trx, driverId);
  // v0.5.3: fleet accounts own the cars; a driver account picks one of its fleet's.
  if (me.account_type === "driver") throw new ApiError("forbidden", "Your fleet adds its cars; you pick one of them.", { reason: "fleet_vehicles_only" });
  const fleetId = me.account_type === "fleet" ? me.fleet_id : null;
  // v0.18.0 (owner item 11): every category must fit the country's car rules.
  const country = await vehicleCountry(trx, { fleet_id: fleetId, driver_id: driverId });
  if (country) {
    const settings = await onboardingSettings(trx, country);
    const car = { year: v.year, seats: v.seats ?? 4, fuel: v.fuel ?? null };
    // v0.18.5 (G2-D5.3, "The owner never decide !!"): the categories the app sends are ignored; the admin gives them
    // on approval. The car is still held to the country's base year (car:year_too_old).
    const problems = carRuleProblems(car, settings, []);
    if (problems.length > 0) throw new ApiError("invalid_request", "The car does not fit every chosen category.", { reason: "category_not_allowed", details: problems });
  }
  const vehicleId = newId("veh", now.getTime());
  try {
    await trx
      .insertInto("vehicles")
      .values({ vehicle_id: vehicleId, driver_id: fleetId ? null : driverId, fleet_id: fleetId, make: v.make, model: v.model, year: v.year, color: v.color, plate: v.plate.toUpperCase(), seats: v.seats ?? 4, category_ids: [], fuel: v.fuel ?? null, created_at: now, updated_at: now })
      .execute();
  } catch (error) {
    if ((error as { constraint?: string }).constraint === "vehicles_plate") throw new ApiError("conflict", "A car with this plate is already registered.", { reason: "plate_taken" });
    throw error;
  }
  // A new car waits for an admin's review (status pending).
  const row = await trx.selectFrom("vehicles").selectAll().where("vehicle_id", "=", vehicleId).executeTakeFirstOrThrow();
  return vehicleFullView(trx, row as unknown as VehicleRow);
}

/* ---------------------------------------------------------------- admin views */

export async function liveDrivers(ex: Executor, zoneId: string | undefined, zones: string[], now: Date) {
  let query = ex
    .selectFrom("drivers")
    .leftJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .leftJoin("vehicles", "vehicles.vehicle_id", "drivers.vehicle_id")
    .select([
      "drivers.driver_id", "drivers.first_name", "drivers.online_status", "drivers.vehicle_id", "drivers.zone_ids",
      "driver_locations.lat", "driver_locations.lng", "driver_locations.accuracy", "driver_locations.heading", "driver_locations.speed_mps", "driver_locations.moving", "driver_locations.measured_at", "driver_locations.received_at", "driver_locations.zone_id",
      "vehicles.plate",
    ])
    .where("drivers.online_status", "!=", "offline");
  if (zoneId) query = query.where("driver_locations.zone_id", "=", zoneId);
  const rows = await query.execute();
  const items = [];
  for (const r of rows) {
    const where = r.zone_id ?? r.zone_ids[0] ?? null;
    if (!zones.includes("*") && (where === null || !zones.includes(where))) continue;
    const active = await activeTripOf(ex, r.driver_id);
    const hasFix = r.lat !== null && r.measured_at !== null && r.received_at !== null;
    items.push({
      driverId: r.driver_id,
      firstName: r.first_name,
      onlineStatus: r.online_status,
      ...(r.moving !== null ? { moving: r.moving } : {}),
      ...(hasFix ? { location: fixView({ lat: r.lat!, lng: r.lng!, accuracy: r.accuracy!, heading: r.heading, speed_mps: r.speed_mps, moving: r.moving ?? false, measured_at: r.measured_at! }), lastFixAt: r.received_at!.toISOString() } : {}),
      stale: !hasFix || now.getTime() - r.received_at!.getTime() > STALE_AFTER_SECONDS * 1000,
      ...(active ? { activeTripId: active.trip_id, tripStatus: active.status } : {}),
      ...(r.vehicle_id ? { vehicleId: r.vehicle_id } : {}),
      ...(r.plate ? { plate: r.plate } : {}),
      ...(where ? { zoneId: where } : {}),
    });
  }
  // v0.18.4 (G3-R4): real riders online per zone, for the Dashboard.
  const ridersOnline = await ridersOnlineByZone(ex, zones, now);
  // v0.18.4 (G3-D5): supply and demand per zone, one rule for the Dashboard's rows and its shortage alert.
  const zoneSupply = await zoneSupplyOf(ex, items, [...ridersOnline.map((r) => r.zoneId), ...items.flatMap((d) => (d.zoneId ? [d.zoneId] : []))], zones);
  return { items, staleAfterSeconds: STALE_AFTER_SECONDS, serverTime: now.toISOString(), ridersOnline, ridersOnlineWindowSeconds: RIDERS_ONLINE_WINDOW_SECONDS, zoneSupply };
}

export async function tripTrace(ex: Executor, tripId: string) {
  const trip = await ex.selectFrom("trips").select(["trip_id", "updated_at"]).where("trip_id", "=", tripId).executeTakeFirst();
  if (trip === undefined) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
  const fixes = await ex.selectFrom("trip_locations").selectAll().where("trip_id", "=", tripId).orderBy("measured_at").execute();
  if (fixes.length === 0 && Date.now() - trip.updated_at.getTime() > 30 * 24 * 3600_000) throw new ApiError("not_found", "This trace was deleted after 30 days.", { reason: "trace_deleted" });
  return { tripId, fixes: fixes.map((f) => fixView(f)), keptUntil: new Date(trip.updated_at.getTime() + 30 * 24 * 3600_000).toISOString() };
}

/* ---------------------------------------------------------------- test drivers (CLI) */

/** Creates or updates an approved test driver with an approved car (owner decision 13). */
export async function seedDriver(
  trx: Trx,
  input: { phone: string; firstName: string; make: string; model: string; year: number; color: string; plate: string; categoryIds: string[]; zoneIds: string[] },
  now: Date = new Date(),
): Promise<{ driverId: string; vehicleId: string }> {
  const existing = await trx.selectFrom("drivers").select(["driver_id", "vehicle_id", "version"]).where("phone", "=", input.phone).executeTakeFirst();
  const driverId = existing?.driver_id ?? newId("drv", now.getTime());
  if (!existing) await trx.insertInto("drivers").values({ driver_id: driverId, phone: input.phone, online_since: null, vehicle_id: null, scheduled_rides: null }).execute();
  const plate = input.plate.toUpperCase();
  const car = await trx.selectFrom("vehicles").select("vehicle_id").where("driver_id", "=", driverId).where("plate", "=", plate).executeTakeFirst();
  const vehicleId = car?.vehicle_id ?? newId("veh", now.getTime());
  const vehicle = { make: input.make, model: input.model, year: input.year, color: input.color, plate, category_ids: input.categoryIds, status: "approved" as const, updated_at: now };
  if (car) await trx.updateTable("vehicles").set(vehicle).where("vehicle_id", "=", vehicleId).execute();
  else await trx.insertInto("vehicles").values({ vehicle_id: vehicleId, driver_id: driverId, created_at: now, ...vehicle }).execute();
  await trx
    .updateTable("drivers")
    .set({ first_name: input.firstName, account_status: "active", vehicle_id: vehicleId, category_ids: input.categoryIds, zone_ids: input.zoneIds, version: (existing?.version ?? 1) + 1, updated_at: now })
    .where("driver_id", "=", driverId)
    .execute();
  return { driverId, vehicleId };
}

/**
 * Contract v0.18.4 §29 (contract.json#driverHome.zoneSupply, owner G3-D5 "Fix it"): every driver online or on_trip
 * counts in his LiveDriver.zoneId, stale or not; free = online with no active trip; waiting = live requests with no
 * driver yet; short when waiting > free.
 */
async function zoneSupplyOf(ex: Executor, drivers: Array<{ onlineStatus: string; activeTripId?: string; zoneId?: string }>, shown: string[], zones: string[]) {
  const waitingRows = await ex
    .selectFrom("trips")
    .select(["zone_id", (eb) => eb.fn.countAll<string>().as("n")])
    .where("kind", "=", "live")
    .where("status", "in", ["requested", "searching", "offered"])
    .where("driver_id", "is", null)
    .groupBy("zone_id")
    .execute();
  const inScope = (z: string) => zones.includes("*") || zones.includes(z);
  const list = [...new Set([...shown, ...waitingRows.map((r) => r.zone_id)])].filter(inScope).sort();
  return list.map((zoneId) => {
    const here = drivers.filter((d) => d.zoneId === zoneId);
    const free = here.filter((d) => d.onlineStatus === "online" && !d.activeTripId).length;
    const waiting = Number(waitingRows.find((r) => r.zone_id === zoneId)?.n ?? 0);
    const level = waiting === 0 ? "ok" : waiting <= free ? "tight" : "short";
    return { zoneId, online: here.length, free, busy: here.length - free, waiting, level, shortage: level === "short" };
  });
}
