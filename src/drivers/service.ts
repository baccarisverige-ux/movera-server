import { sql } from "kysely";
import { refuseOldApp, type AppClient } from "../config/appUpdate.js";
import { NOT_HELD } from "../reservations/view.js";
import { drivingTimeOf, resetOnOnline } from "./drivingTime.js";
import { scheduleRideCheckScan } from "../safety/rideCheckServer.js";
import { TERMS_REASON, termsAccepted } from "../content/routes.js";
import { schemaProblem } from "../contract/schemas.js";
import type { Executor, Trx } from "../db/db.js";
import { appendTripEvent } from "../db/tripLog.js";
import { DRIVER_SILENCE, maybeNearDropoff, maybePickupGeofence } from "../trips/ride.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { zoneAt } from "../config/zoneLookup.js";
import { DRIVER_ASSIGNED } from "../rules/transitions.js";
import { scheduleTimer } from "../jobs/timers.js";
import { CLEAR_OFFLINE_REASON } from "./offlineReason.js";
import { availabilityOnTrip, noteFixAfterOutage, offlineAfterTripView } from "./presence.js";
import { documentSummaries, documentSummariesOf } from "../documents/service.js";
import { EXTRA_CATEGORIES, carRuleProblems, categoryProblem, liveRequiredDocuments, onboardingSettings, onboardingSettingsOf, requiredOf, type Fuel, type OnboardingSettings } from "./onboardingSettings.js";
import { expiredBlockers, pickableCars, vehicleCountry, vehicleDocumentBlockers } from "./readiness.js";
import { signUpOf } from "./reminders.js";
import { DRIVER_HOME, areaView, hasFreshPosition } from "./presence.js";
import { RIDERS_ONLINE_WINDOW_SECONDS, ridersOnlineByZone } from "../riders/presence.js";
import { onDriverPosition } from "../airportQueue/service.js";
import { etaOnPosition } from "../trips/etaNow.js";
import { countFixes } from "../bonuses/counting.js";

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
/**
 * S7 B3.1 (owner W2 Q112 "Yes, short limit", 2026-11-15): the longest one row-lock wait of the GPS transaction (the trip
 * row a trip command holds, or a timer row a job runs). The same 2 s as a timer transaction (jobs/timers.ts
 * TIMER_LOCK_TIMEOUT_MS): like a timer, a GPS batch is a whole transaction that queues behind a trip command and is sent
 * again. A normal command holds the trip row far shorter, so the limit never refuses a healthy race
 * (test/e2e/50_gps_vs_trip_command.test.ts); the 50 / 200 ms limits (presence.ts, alerts/detector.ts) guard optional
 * savepoint steps and would. 2 s is under the driver app's 10 s send tick and 15 s request limit, and it frees the
 * pooled connection instead of holding it up to DATABASE_STATEMENT_TIMEOUT_MS (30 s). When it runs out Postgres raises
 * 55P03, nothing of the batch is stored, and app.ts answers 503 server_busy with Retry-After: 2 (db.ts isDatabaseBusy),
 * which the driver app's sender pauses on and then sends its fix again.
 * Only POST /driver/location (postLocations) sets it; going online with a position does not (supervisor SF-1).
 */
export const GPS_LOCK_TIMEOUT_MS = 2000;

export type DriverRow = {
  offline_after_trip?: boolean;
  next_trips_off?: boolean;
  offline_after_trip_at?: Date | null;
  driver_id: string;
  /** v0.18.17 (owner BL-Q4). */
  home_area?: unknown;
  payout_hold_at?: Date | null;
  payout_hold_reason?: string | null;
  payout_hold_by?: string | null;
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
  email_verified_at?: Date | null;
  first_activated_at?: Date | null;
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
  // v0.18.13 (driving-time limits)
  went_offline_at?: Date | null;
  driving_since?: Date | null;
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
  // v0.18.17 (contract.json#bookLater): a booked ride held for later (scheduled, accepted) is not the current trip.
  return ex.selectFrom("trips").select(["trip_id", "status", "version", "driver_silent_alert", "pickup", "dropoff", "eta"]).where("driver_id", "=", driverId).where("status", "in", [...DRIVER_ASSIGNED]).where(NOT_HELD).executeTakeFirst();
}

type LocationRow = { lat: number; lng: number; accuracy: number; heading: number | null; speed_mps: number | null; moving: boolean; measured_at: Date; received_at: Date };
type FleetRow = { fleet_id: string; name: string; status: string; owner_driver_id: string | null; created_at: Date };
type Summaries = Awaited<ReturnType<typeof documentSummariesOf>> extends Map<string, infer V> ? V : never;

/** What driverView reads besides the driver row, per driver. */
type ViewParts = { location: LocationRow | undefined; active: { trip_id: string } | undefined; fleet: FleetRow | undefined; documents: Summaries; pendingInvitations: number; settings: OnboardingSettings; signUp: Record<string, unknown> };

const firstBy = <T,>(list: T[], key: (t: T) => string | null) => {
  const m = new Map<string, T>();
  for (const t of list) {
    const k = key(t);
    if (k !== null && !m.has(k)) m.set(k, t);
  }
  return m;
};

/**
 * S06 F9: driverView's reads for many drivers, a fixed number of queries whatever their count (each kind with IN).
 * The admin drivers list used to cost ~10 queries per driver. One after another, not Promise.all: one request must not
 * take nine pool connections at once.
 */
async function viewParts(ex: Executor, rows: DriverRow[], viewer: "driver" | "admin", now: Date): Promise<Map<string, ViewParts>> {
  const ids = rows.map((r) => r.driver_id);
  const out = new Map<string, ViewParts>();
  if (ids.length === 0) return out;
  const fleetIds = [...new Set(rows.flatMap((r) => (r.fleet_id ? [r.fleet_id] : [])))];
  const members = rows.filter((r) => r.account_type === "driver").map((r) => r.driver_id);
  const owners = rows.filter((r) => r.account_type === "fleet").map((r) => r.driver_id);
  const signingUp = viewer === "admin" ? rows.filter((r) => r.account_status === "pending" || r.account_status === "on_hold") : [];
  const noCreated = signingUp.filter((r) => !(r as { created_at?: Date }).created_at).map((r) => r.driver_id);
  const locations = await ex.selectFrom("driver_locations").selectAll().where("driver_id", "in", ids).execute();
  // v0.18.17 (contract.json#bookLater): a booked ride held for later (scheduled, accepted) is not the current trip.
  const active = await ex.selectFrom("trips").select(["trip_id", "driver_id"]).where("driver_id", "in", ids).where("status", "in", [...DRIVER_ASSIGNED]).where(NOT_HELD).execute();
  const fleets = fleetIds.length ? await ex.selectFrom("fleets").select(["fleet_id", "name", "status", "owner_driver_id", "created_at"]).where("fleet_id", "in", fleetIds).execute() : [];
  const documents = await documentSummariesOf(ex, "driver", ids);
  // v0.5.3: invitations waiting for this account's answer (a driver's incoming invites, an owner's incoming requests),
  // by the command's clock, not the database's (a test clock or a slow request must not change the answer).
  const memberInvites = members.length
    ? await ex.selectFrom("fleet_invitations").select(["fleet_invitations.driver_id as id", (eb) => eb.fn.countAll<string>().as("n")])
        .where("fleet_invitations.driver_id", "in", members).where("fleet_invitations.direction", "=", "owner_invite")
        .where("fleet_invitations.status", "=", "pending").where("fleet_invitations.expires_at", ">", now).groupBy("fleet_invitations.driver_id").execute()
    : [];
  const ownerInvites = owners.length
    ? await ex.selectFrom("fleet_invitations").innerJoin("fleets", "fleets.fleet_id", "fleet_invitations.fleet_id").select(["fleets.owner_driver_id as id", (eb) => eb.fn.countAll<string>().as("n")])
        .where("fleets.owner_driver_id", "in", owners).where("fleet_invitations.direction", "=", "driver_request")
        .where("fleet_invitations.status", "=", "pending").where("fleet_invitations.expires_at", ">", now).groupBy("fleets.owner_driver_id").execute()
    : [];
  const settings = await onboardingSettingsOf(ex, rows.map((r) => r.country));
  const sent = signingUp.length ? await ex.selectFrom("sign_up_reminders").select(["driver_id", "sent_at"]).where("driver_id", "in", signingUp.map((r) => r.driver_id)).orderBy("sent_at", "desc").execute() : [];
  const created = noCreated.length ? await ex.selectFrom("drivers").select(["driver_id", "created_at"]).where("driver_id", "in", noCreated).execute() : [];
  const locationOf = firstBy(locations, (l) => l.driver_id);
  const activeOf = firstBy(active, (t) => t.driver_id);
  const fleetOf = firstBy(fleets, (f) => f.fleet_id);
  const invites = new Map<string, number>([...memberInvites, ...ownerInvites].map((r) => [r.id ?? "", Number(r.n)]));
  const createdOf = new Map(created.map((r) => [r.driver_id, r.created_at]));
  const sentOf = new Map<string, Date[]>();
  for (const r of sent) sentOf.set(r.driver_id, [...(sentOf.get(r.driver_id) ?? []), r.sent_at]);
  const signingUpIds = new Set(signingUp.map((r) => r.driver_id));
  for (const row of rows) {
    const rowSettings = settings.get(row.country ?? "")!;
    const createdAt = (row as { created_at?: Date }).created_at ?? createdOf.get(row.driver_id);
    out.set(row.driver_id, {
      location: locationOf.get(row.driver_id) as LocationRow | undefined,
      active: activeOf.get(row.driver_id),
      fleet: row.fleet_id ? (fleetOf.get(row.fleet_id) as FleetRow | undefined) : undefined,
      documents: documents.get(row.driver_id) ?? [],
      pendingInvitations: invites.get(row.driver_id) ?? 0,
      settings: rowSettings,
      signUp: signingUpIds.has(row.driver_id) && createdAt ? signUpOf(createdAt, rowSettings, sentOf.get(row.driver_id) ?? [], now) : {},
    });
  }
  return out;
}

/** S06 F9: driverView of many drivers (the admin drivers list); the same output, a fixed number of queries. */
export async function driverViews(ex: Executor, rows: DriverRow[], viewer: "driver" | "admin", now: Date = new Date()): Promise<Array<Record<string, unknown>>> {
  const parts = await viewParts(ex, rows, viewer, now);
  const out = [];
  for (const row of rows) out.push(await driverView(ex, row, viewer, now, parts.get(row.driver_id)));
  return out;
}

export async function driverView(ex: Executor, row: DriverRow, viewer: "driver" | "admin", now: Date = new Date(), parts?: ViewParts): Promise<Record<string, unknown>> {
  const { location, active, fleet, documents, pendingInvitations, settings, signUp } = parts ?? (await viewParts(ex, [row], viewer, now)).get(row.driver_id)!;
  const dob = row.date_of_birth;
  return {
    driverId: row.driver_id,
    accountStatus: row.account_status,
    // v0.18.39 A2 (owner Q4, contract.json#payoutHold): admin view only.
    ...(viewer === "admin" && row.payout_hold_at ? { payoutHold: { reason: row.payout_hold_reason ?? "", at: row.payout_hold_at.toISOString(), ...(row.payout_hold_by ? { by: row.payout_hold_by } : {}) } } : {}),
    onlineStatus: row.online_status,
    ...offlineAfterTripView(row),
    // v0.18.65 §86: next-trip offers stopped for his current trip.
    nextTripsOff: row.next_trips_off === true,
    // v0.18.6 (owner "Send the real reason"): why the server set him offline, while he is offline.
    ...(row.online_status === "offline" && row.offline_reason ? { offlineReason: row.offline_reason, ...(row.offline_note ? { offlineNote: row.offline_note } : {}), ...(row.offline_at ? { offlineAt: row.offline_at.toISOString() } : {}) } : {}),
    ...(location ? { moving: location.moving } : {}),
    firstName: row.first_name,
    ...(row.rating_count > 0 ? { rating: Math.round((row.rating_sum / row.rating_count) * 100) / 100 } : {}),
    zoneIds: row.zone_ids,
    categoryIds: row.category_ids,
    ...(row.vehicle_id ? { vehicleId: row.vehicle_id } : {}),
    documents,
    // v0.5.3 (§14): the sign-up details, the fleet and the documents this account needs.
    ...(row.account_type ? { accountType: row.account_type } : {}),
    ...(row.last_name ? { lastName: row.last_name } : {}),
    ...(dob ? { dateOfBirth: dob instanceof Date ? dob.toISOString().slice(0, 10) : String(dob) } : {}),
    ...(row.email ? { email: row.email } : {}),
    // G30 v0.18.76 (contract.json#emailVerified.field): when the current e-mail was proven; never masked.
    ...(row.email && row.email_verified_at ? { emailVerifiedAt: row.email_verified_at.toISOString() } : {}),
    ...(row.country ? { country: row.country } : {}),
    ...(row.city_id ? { cityId: row.city_id } : {}),
    ...(row.language ? { language: row.language } : {}),
    ...(row.terms_accepted_at ? { termsAcceptedAt: row.terms_accepted_at.toISOString() } : {}),
    ...(fleet
      ? { fleet: { fleetId: fleet.fleet_id, name: fleet.name, role: fleet.owner_driver_id === row.driver_id ? "owner" : "member", status: fleet.status, linkedAt: (row.fleet_linked_at ?? fleet.created_at).toISOString() } }
      : {}),
    // v0.18.13 (contract.json#drivingLimits.projection): counted driving time against the limit.
    ...(viewer === "driver" ? { drivingTime: await drivingTimeOf(ex, { driver_id: row.driver_id, zone_ids: row.zone_ids, driving_since: row.driving_since ?? null, offlineSince: row.online_status === "offline" ? (row.went_offline_at ?? null) : null }, now) } : {}),
    ...(row.account_type === "fleet" ? { payoutTo: "self" } : row.account_type === "driver" && fleet ? { payoutTo: "fleet" } : {}),
    ...(row.account_type ? { pendingFleetInvitations: pendingInvitations } : {}),
    // v0.18.0 (§27): the lists of the country's onboarding settings (the admin's), else the contract defaults.
    requiredDocuments: row.country ? requiredOf(settings, "driver") : [],
    ...(row.account_type === "fleet" ? { requiredFleetDocuments: row.country ? requiredOf(settings, "fleet") : [] } : {}),
    ...(active ? { activeTripId: active.trip_id } : {}),
    // v0.18.17 (owner BL-Q4): the driver's home area, set in the driver app; admins see it too.
    ...(row.home_area ? { homeArea: row.home_area } : {}),
    ...(row.scheduled_rides ? { scheduledRides: row.scheduled_rides } : {}),
    // v0.18.4 (G3-R2): the driver is told when his latest position is outside all his zones (no trips there).
    ...(viewer === "driver" ? await areaView(ex, row) : {}),
    version: row.version,
    // 2026-11-09: the command's clock, like every other time here (the real clock made the admin "stuck" flag drift from the sweeps).
    ...(viewer === "admin" ? signUp : {}),
    ...(viewer === "admin" && location
      ? {
          location: fixView(location),
          lastFixAt: location.received_at.toISOString(),
        }
      : {}),
  };
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

export async function getDriverProfile(ex: Executor, driverId: string, now: Date = new Date()) {
  return driverView(ex, await loadDriver(ex, driverId), "driver", now);
}

function stale(row: DriverRow, ex: Executor) {
  return async () => driverView(ex, await loadDriver(ex, row.driver_id), "driver", new Date());
}

export async function updateDriverProfile(trx: Trx, driverId: string, body: unknown, now: Date) {
  const problem = schemaProblem("DriverProfileUpdate", body);
  if (problem !== null) throw badRequest(`The profile change is not valid: ${problem}.`, "invalid_body");
  const update = body as { expectedVersion: number; firstName?: string; vehicleId?: string; categoryIds?: string[]; language?: "sv" | "fr" | "en" };
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
      // v0.18.12: the app language, saved to the account so server notices follow it (G9 live 2026-11-02).
      ...(update.language !== undefined ? { language: update.language } : {}),
      ...(update.vehicleId !== undefined ? { vehicle_id: update.vehicleId } : {}),
      ...(categoryIds !== undefined ? { category_ids: categoryIds } : {}),
      version: row.version + 1,
      updated_at: now,
    })
    .where("driver_id", "=", driverId)
    .execute();
  return driverView(trx, await loadDriver(trx, driverId), "driver", now);
}

/** POST /driver/availability: online or offline (contract: 409 with the Driver when it cannot be). */
export async function setAvailability(trx: Trx, driverId: string, body: { expectedVersion: number; onlineStatus: "online" | "offline"; location?: Fix }, now: Date, app?: AppClient | null) {
  // The fix first: on a trip it locks the trip row, and the lock order is trip, then driver.
  if (body.location) {
    const facts = await locationFacts(trx, driverId);
    if (facts) await storeFixes(trx, driverId, [body.location], undefined, now, facts);
  }
  const row = await loadDriver(trx, driverId, true);
  const refuse = async (message: string, reason: string) => new ApiError("invalid_transition", message, { reason, projection: await stale(row, trx)() });
  if (row.version !== body.expectedVersion) throw new ApiError("version_mismatch", "Your status changed since you last saw it.", { projection: await stale(row, trx)() });
  // v0.18.37 §61: on a trip, offline = after all his trips, online = undo (presence.ts).
  if (await availabilityOnTrip(trx, row, body.onlineStatus, now)) return driverView(trx, await loadDriver(trx, driverId), "driver", now);
  // On a trip the driver already counts as online; "online" must not turn on_trip into free.
  if (body.onlineStatus === row.online_status || (body.onlineStatus === "online" && row.online_status === "on_trip")) return driverView(trx, row, "driver", now);
  if (body.onlineStatus === "online") {
    // v0.18.154 P16c (contract.json#appUpdate.server): an Android / iOS driver app below the minimum of his zones (and the
    // zone of his last position) does not go online (426). Never on a trip: that case returned above.
    // Review SF (safety first): a driver who holds a booked ride (accepted, not started) is never refused: the booked
    // rider depends on him, and starting it needs him online (reservations/service.ts startReservation).
    const holdsBooked = app ? await trx.selectFrom("trips").select("trip_id").where("driver_id", "=", driverId).where("kind", "=", "scheduled").where("status", "=", "accepted").limit(1).executeTakeFirst() : undefined;
    const at = await trx.selectFrom("driver_locations").select("zone_id").where("driver_id", "=", driverId).executeTakeFirst();
    if (holdsBooked === undefined) await refuseOldApp(trx, "driver_app_config", [...row.zone_ids, ...(at?.zone_id ? [at.zone_id] : [])], app);
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
    // v0.18.13 (contract.json#drivingLimits): the counter starts again after the offline rest; over the limit → refused.
    const since = await resetOnOnline(trx, { driver_id: row.driver_id, zone_ids: row.zone_ids, went_offline_at: row.went_offline_at ?? null, driving_since: row.driving_since ?? null }, now);
    // BQ-V21: refused while resting → canDriveAt counts from when he went offline (the admin's reset hours).
    const time = await drivingTimeOf(trx, { driver_id: row.driver_id, zone_ids: row.zone_ids, driving_since: since, offlineSince: row.online_status === "offline" ? (row.went_offline_at ?? null) : null }, now);
    if (time.reached) {
      throw new ApiError("conflict", "You reached the driving-time limit. Rest offline before driving again.", {
        reason: "driving_limit_reached",
        details: [`drivenMinutes:${time.drivenMinutes}`, `maxMinutes:${time.maxMinutes}`, ...(time.canDriveAt ? [`canDriveAt:${time.canDriveAt}`] : [])],
        projection: await stale(row, trx)(),
      });
    }
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
  return driverView(trx, await loadDriver(trx, driverId), "driver", now);
}

/** POST /driver/location: up to 50 fixes; answers how many were taken. */
export async function postLocations(trx: Trx, driverId: string, body: unknown, now: Date): Promise<{ accepted: number; serverTime: string; outsideArea?: boolean }> {
  const problem = schemaProblem("LocationBatch", body);
  if (problem !== null) throw badRequest(`The location batch is not valid: ${problem}.`, "invalid_body");
  const batch = body as { fixes: Fix[]; tripId?: string };
  // Stress T-A part 3 (owner 2026-11-10, RESULT-3.md): the driver row, his active trip and whether he has an open
  // airport queue entry come in ONE statement (they were read 3 + 1 times); zones and areas come from memory.
  const facts = await locationFacts(trx, driverId, GPS_LOCK_TIMEOUT_MS);
  // v0.18.52 §74 (owner Q15 'Not stored', 2026-11-09): a batch from an offline or suspended driver with no active trip
  // is not stored — no position on the admin map, no stale-fix work — whatever an old app or a sender not stopped sends.
  // Only here: going online stores its own fix (availability) before the status flips.
  const offline = facts !== undefined && (facts.online_status === "offline" || facts.online_status === "suspended") && facts.active === undefined;
  const stored = offline || facts === undefined ? { accepted: 0 } : await storeFixes(trx, driverId, batch.fixes, batch.tripId, now, facts);
  // v0.18.4 (G3-R2): so the app can show "You are not eligible to drive in this area" when he drives out.
  return { accepted: stored.accepted, serverTime: now.toISOString(), ...(facts ? await areaView(trx, facts, stored.position) : {}) };
}

type LocationFacts = {
  driver_id: string;
  zone_ids: string[];
  language: string | null;
  online_status: string;
  online_since: Date | null;
  /** v0.18.110 BQ-V44 (bonusCampaigns.counting.who): only an active account counts toward a campaign. */
  account_status: string;
  has_open_entry: boolean;
  /** v0.18.93 (contract.json#autoArrive): + the trip's kept distances and whether its waiting clock stands still. */
  /** v0.18.108 (contract.json#autoArrive.stops): + the trip's stops and stop visits (the geofence job at middle stops). */
  active: (NonNullable<Awaited<ReturnType<typeof activeTripOf>>> & { arrive_m: number | null; leave_m: number | null; away: boolean | null; next_scan_at: string | null; stops: unknown; stop_visits: unknown }) | undefined;
};

/**
 * `lockLimitMs`: only POST /driver/location passes it (supervisor SF-1). Going online (setAvailability) reads the same
 * facts for its own fix with no limit, so it waits for a row lock as it always did. With it, the statement also takes the
 * per-driver GPS lock (Q114 SF1, below).
 */
async function locationFacts(trx: Trx, driverId: string, lockLimitMs?: number): Promise<LocationFacts | undefined> {
  const row = await trx
    .selectFrom("drivers as d")
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom("trips")
          .select(["trip_id", "status", "version", "driver_silent_alert", "pickup", "dropoff", "eta", "stops", "stop_visits"])
          // v0.18.93 (contract.json#autoArrive): the kept distances and the stopped clock, read in the same statement.
          .select([
            sql<number | null>`(trips.booking_rules->>'autoArriveMeters')::numeric`.as("arrive_m"),
            sql<number | null>`(trips.booking_rules->>'leaveMeters')::numeric`.as("leave_m"),
            sql<boolean | null>`(trips.waiting->'away') IS NOT NULL`.as("away"),
            // v0.18.100 (BQ-V37): the earliest time of the next ride-check scan (rideCheckServer.ts NEXT_SCAN_KEY).
            sql<string | null>`trips.ride_check_log->>'nextScanAt'`.as("next_scan_at"),
          ])
          .whereRef("trips.driver_id", "=", "d.driver_id")
          .where("trips.status", "in", [...DRIVER_ASSIGNED])
          .where(NOT_HELD)
          .limit(1)
          .as("t"),
      (join) => join.onTrue(),
    )
    .select(["d.driver_id", "d.zone_ids", "d.language", "d.online_status", "d.online_since", "d.account_status", "t.trip_id", "t.status", "t.version", "t.driver_silent_alert", "t.pickup", "t.dropoff", "t.eta", "t.arrive_m", "t.leave_m", "t.away", "t.next_scan_at", "t.stops", "t.stop_visits"])
    .select(sql<boolean>`EXISTS (SELECT 1 FROM airport_queue_entries e WHERE e.driver_id = d.driver_id AND e.left_at IS NULL)`.as("has_open_entry"))
    // S7 B3.1 (Q112): SET LOCAL lock_timeout for this transaction (is_local = true), set by this first statement so the
    // GPS path keeps its statement budget (test/drivers/location_statements.test.ts). This read takes no lock; every
    // write of the batch comes after it. No driver row = no value set, and nothing is written then.
    // S7 W2 Q114 supervisor SF1: with the Idempotency-Key no longer stored, two identical sends at the same moment both
    // read the old position in the upsert's `prev` (its statement snapshot) and both wrote a location event. So the GPS
    // write is one at a time per driver: a transaction-scoped advisory lock, taken in this same first statement AFTER the
    // lock limit (CASE evaluates its condition first), so the wait for it is under the same 2 s limit (503 server_busy).
    // The upsert of the second send then starts after the first one committed and sees its fix (not new). Only GPS
    // posts take this lock, and they take it before any row lock, so it adds no lock cycle with trip commands.
    .$if(lockLimitMs !== undefined, (qb) =>
      qb.select(sql<null>`CASE WHEN set_config('lock_timeout', ${`${lockLimitMs}ms`}, true) IS NOT NULL THEN pg_advisory_xact_lock(hashtext(${`gps:${driverId}`})) END`.as("lock_limit")),
    )
    .where("d.driver_id", "=", driverId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const active = row.trip_id === null ? undefined : { trip_id: row.trip_id, status: row.status!, version: row.version!, driver_silent_alert: row.driver_silent_alert!, pickup: row.pickup!, dropoff: row.dropoff!, eta: row.eta!, arrive_m: num(row.arrive_m), leave_m: num(row.leave_m), away: row.away ?? null, next_scan_at: row.next_scan_at ?? null, stops: row.stops ?? [], stop_visits: row.stop_visits ?? [] };
  return { driver_id: row.driver_id, zone_ids: row.zone_ids, language: row.language, online_status: row.online_status, online_since: row.online_since, account_status: row.account_status, has_open_entry: row.has_open_entry, active: active as LocationFacts["active"] };
}

async function storeFixes(trx: Trx, driverId: string, fixes: Fix[], _tripId: string | undefined, now: Date, facts: LocationFacts): Promise<{ accepted: number; position?: { lat: number; lng: number } }> {
  const fresh = fixes
    .map((fix) => ({ fix, at: new Date(fix.measuredAt) }))
    .filter(({ at }) => !Number.isNaN(at.getTime()) && now.getTime() - at.getTime() <= MAX_FIX_AGE_MS && at.getTime() - now.getTime() <= MAX_FIX_AHEAD_MS)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (fresh.length === 0) return { accepted: 0 };
  // S4 B1.23: the first fix stored after an outage marks it (before it is written).
  await noteFixAfterOutage(trx, now);
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
  // Live 5+5 2026-11-08 (problem 4): the position it replaces comes back in the same statement (a WITH reads the row
  // as it was), so the ETA check below sees where the driver was; no row back = an older fix, nothing replaced.
  const replaced = await trx
    .with("prev", (db) => db.selectFrom("driver_locations").select(["lat", "lng", "measured_at"]).where("driver_id", "=", driverId))
    .insertInto("driver_locations")
    .values(values)
    .onConflict((c) => c.column("driver_id").doUpdateSet(values).where("driver_locations.measured_at", "<=", latest.at))
    .returning([sql<number | null>`(SELECT lat FROM prev)`.as("prev_lat"), sql<number | null>`(SELECT lng FROM prev)`.as("prev_lng"), sql<Date | null>`(SELECT measured_at FROM prev)`.as("prev_at")])
    .executeTakeFirst();
  // S7 B3.2 (owner W2 Q113 "Yes, skip repeats", 2026-11-15): a new fix = measured after the stored one (or the first).
  // The same fix sent again still replaced the row above (received_at, G5) but is not new.
  const isNew = replaced !== undefined && (replaced.prev_at === null || replaced.prev_at.getTime() < latest.at.getTime());

  // v0.18.36 §60 (fix job 9, contract.json#airportQueue): join, stay in or leave an airport queue.
  await onDriverPosition(trx, driverId, latest.fix, now, { driver: facts, hasOpenEntry: facts.has_open_entry });
  // v0.18.110 BQ-V44 (contract.json#bonusCampaigns.counting.onlineHours, MF3): the batch's fixes count toward his
  // online_hours campaigns (one guarded write per campaign at most; a savepoint, so it never fails this post). Before the
  // trip row is written below (lock order: bonus_progress, then trip; a trip end never locks an online_hours row).
  await countFixes(trx, facts, fresh.map(({ fix, at }) => ({ at, lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy })), now);

  // On a trip, the trip is the one the server knows, whatever tripId the app sent.
  const active = facts.active;
  if (active) {
    // Live 5+5 2026-11-08 (problem 4): at the pickup / drop-off (or after a jump) the ETA tick runs now, not up to 30 s
    // later; run 2: also each 50 m inside the arrive radius (at most one per 5 s). Before the trip row is written below
    // (lock order, trips/etaNow.ts etaOnPosition); the trip's earlier fixes are in trip_locations (written below).
    if (replaced) {
      const previous = replaced.prev_lat !== null && replaced.prev_lng !== null ? { lat: Number(replaced.prev_lat), lng: Number(replaced.prev_lng) } : null;
      await etaOnPosition(trx, active, previous, latest.fix, now);
    }
    await trx
      .insertInto("trip_locations")
      .values(fresh.map(({ fix, at }) => ({ trip_id: active.trip_id, driver_id: driverId, measured_at: at, lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, heading: fix.heading ?? null, speed_mps: fix.speedMps ?? null, moving: fix.moving ?? false })))
      .onConflict((c) => c.columns(["trip_id", "measured_at", "driver_id"]).doNothing())
      .execute();
    // E4 (audit S03 B2): a batch older than the stored fix (out of order on a bad connection) only fills the trace above;
    // no location event, NOTIFY, near-drop-off or silence check runs on a position that is not current.
    // S7 B3.2 safety (v1 R18): the ride-check scan is booked all the same. Long stop is read from the fix times in the
    // trace this batch just filled, so the standing fixes that arrive late must be looked at too (a timer row only).
    if (!replaced) {
      await scheduleRideCheckScan(trx, active, now);
      return { accepted: fresh.length };
    }
    await maybeNearDropoff(trx, active, latest.fix, now);
    // v0.18.93 (contract.json#autoArrive): the automatic arrival / the waiting clock, as a job right after (a timer row only).
    await maybePickupGeofence(trx, active, latest.fix, now);
    // v0.18.9 (contract.json#onTrip.rideCheck): the server's ride check looks at the new fixes in a job right after.
    await scheduleRideCheckScan(trx, active, now);
    // Car lost (contract v0.7.0 §15): the position is back, so the silence check runs now and takes the alarm down.
    if (active.driver_silent_alert) await scheduleTimer(trx, { kind: DRIVER_SILENCE, refId: active.trip_id, dueAt: now });
    // S5 (sup1 P11, G34 proof 2026-11-13): the trip row is written LAST (timer rows first, as etaOnPosition already does),
    // so the row lock that every trip command waits for is held for the fewest Node turns before the commit. No command
    // that holds the trip lock writes the near-drop-off or ride-check-scan timer, and board books the silence timer only
    // while driver_silent_alert is off (then this step skips it), so this order adds no lock cycle
    // (test/e2e/50_gps_vs_trip_command.test.ts races GPS posts against Finish + Collect cash).
    // One location event per batch, with the newest fix; it never changes the projection version (§4).
    // S7 B3.2 (Q113): none for the same fix sent again (a phone standing still): no event, no NOTIFY, no rider reads,
    // and no trip row write at all. Everything above (trace, checks, timers) still ran for it.
    if (isNew) await appendTripEvent(trx, { tripId: active.trip_id, kind: "location", version: active.version, occurredAt: now, location: { ...latest.fix, measuredAt: latest.at.toISOString() } });
  }
  // A row back = this batch's newest fix is now the stored position; none = an older fix, the stored one is read later.
  return { accepted: fresh.length, ...(replaced ? { position: { lat: latest.fix.lat, lng: latest.fix.lng } } : {}) };
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
  // v0.18.161 (adminListFilters.carZones.carZone): the car's zone, its fleet's, else its driver's first zone, else null.
  let zoneId: string | null = null;
  if (v.fleet_id) {
    const fleet = await ex.selectFrom("fleets").select(["country", "zone_id"]).where("fleet_id", "=", v.fleet_id).executeTakeFirst();
    country = fleet?.country ?? null;
    zoneId = fleet?.zone_id ?? null;
    if (v.driver_id) {
      const picker = await ex.selectFrom("drivers").select(["online_status", "vehicle_id"]).where("driver_id", "=", v.driver_id).executeTakeFirst();
      inUse = picker?.vehicle_id === v.vehicle_id && picker.online_status !== "offline";
    }
  } else if (v.driver_id) {
    const owner = await ex.selectFrom("drivers").select(["country", "zone_ids"]).where("driver_id", "=", v.driver_id).executeTakeFirst();
    country = owner?.country ?? null;
    zoneId = owner?.zone_ids[0] ?? null;
  }
  const pick = viewer ? await pickability(ex, v, viewer.driverId, inUse) : undefined;
  // v0.18.3 (R2): the rules the car breaks now, for the admin's red warning and the fleet owner.
  const ruleProblems = !viewer || viewer.owner ? await rulesBrokenBy(ex, v, country) : [];
  // v0.18.5 (G2-D5.3, vehicleRules.fitCategories): the categories the admin may give this car.
  const fit = !viewer || viewer.owner ? await fitCategories(ex, v, country) : undefined;
  return {
    ...vehicleView(v),
    // v0.18.161 (adminListFilters.carZones.fields): Vehicle.zoneId / Vehicle.country on the admin's reads (no viewer).
    ...(viewer ? {} : { zoneId, country }),
    ...(v.fleet_id ? { inUse } : {}),
    ...(ruleProblems.length > 0 ? { ruleProblems } : {}),
    ...(fit ? { fitCategories: fit } : {}),
    ...(viewer && !viewer.owner ? {} : { documents: await documentSummaries(ex, "vehicle", v.vehicle_id), requiredDocuments: await liveRequiredDocuments(ex, country, "vehicle") }),
    ...(pick ? { pickable: pick.reason === null, ...(pick.reason ? { notPickableReason: pick.reason } : {}) } : {}),
  };
}

/**
 * SUP3 P7 (audits/fix-plan-2026-11-13/sup3-admin.md): vehicleFullView of a page of cars for an admin (no viewer), each
 * fact read once per page: fleets, drivers, the countries' onboarding settings, documents + renewals (5 queries for any
 * page size; one car at a time it was ~6.4 per car, 322 for 50). The same view, field for field (test/admin/
 * vehicles_list_batched.test.ts).
 */
export async function vehicleFullViews(ex: Executor, rows: VehicleRow[]): Promise<Array<Awaited<ReturnType<typeof vehicleFullView>>>> {
  if (rows.length === 0) return [];
  const fleetIds = [...new Set(rows.map((v) => v.fleet_id).filter((id): id is string => id !== null))];
  const driverIds = [...new Set(rows.map((v) => v.driver_id).filter((id): id is string => id !== null))];
  // One after the other on purpose: a page never holds more than one pool connection (the pool is what runs out at load).
  const fleets = fleetIds.length ? await ex.selectFrom("fleets").select(["fleet_id", "country", "zone_id"]).where("fleet_id", "in", fleetIds).execute() : [];
  const people = driverIds.length ? await ex.selectFrom("drivers").select(["driver_id", "online_status", "vehicle_id", "country", "zone_ids"]).where("driver_id", "in", driverIds).execute() : [];
  const documents = await documentSummariesOf(ex, "vehicle", rows.map((v) => v.vehicle_id));
  const fleetOf = new Map(fleets.map((f) => [f.fleet_id, f]));
  const personOf = new Map(people.map((d) => [d.driver_id, d]));
  const countryOf = (v: VehicleRow): string | null => (v.fleet_id ? fleetOf.get(v.fleet_id)?.country ?? null : v.driver_id ? personOf.get(v.driver_id)?.country ?? null : null);
  const zoneOf = (v: VehicleRow): string | null => (v.fleet_id ? fleetOf.get(v.fleet_id)?.zone_id ?? null : v.driver_id ? personOf.get(v.driver_id)?.zone_ids[0] ?? null : null);
  const settings = await onboardingSettingsOf(ex, rows.map(countryOf).filter((c): c is string => Boolean(c)));
  return rows.map((v) => {
    const country = countryOf(v);
    const picker = v.fleet_id && v.driver_id ? personOf.get(v.driver_id) : undefined;
    const inUse = picker !== undefined && picker.vehicle_id === v.vehicle_id && picker.online_status !== "offline";
    const rules = country ? settings.get(country) : undefined;
    const car = { year: v.year, seats: v.seats, fuel: v.fuel ?? null };
    const ruleProblems = rules ? carRuleProblems(car, rules, v.category_ids) : [];
    const fit = rules ? [...new Set([...rules.vehicles.categories.filter((r) => r.on).map((r) => r.category), ...EXTRA_CATEGORIES])].filter((c) => categoryProblem(car, rules, c) === null) : undefined;
    return {
      ...vehicleView(v),
      zoneId: zoneOf(v),
      country,
      ...(v.fleet_id ? { inUse } : {}),
      ...(ruleProblems.length > 0 ? { ruleProblems } : {}),
      ...(fit ? { fitCategories: fit } : {}),
      documents: documents.get(v.vehicle_id) ?? [],
      requiredDocuments: rules ? requiredOf(rules, "vehicle") : [],
    };
  });
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
  // Deep fix 2026-11-02 (live sweep H-2 "wrong car"): the car the server drives him with (drivers.vehicle_id) is always
  // in his list, first, so the Vehicles page, the rider and the server show the same car.
  if (me.vehicle_id !== null && !rows.some((r) => r.vehicle_id === me.vehicle_id)) {
    const active = await ex.selectFrom("vehicles").selectAll().where("vehicle_id", "=", me.vehicle_id).executeTakeFirst();
    if (active) rows.unshift(active);
  }
  const items = [];
  const owner = me.account_type === "fleet" || me.fleet_id === null;
  for (const r of rows) items.push({ ...(await vehicleFullView(ex, r as unknown as VehicleRow, { driverId, owner })), active: r.vehicle_id === me.vehicle_id });
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
  // v0.18.162 (contract.json#driverCountryFirst.required): no car is saved for a driver with no country (the hole where
  // a car was saved while account type and country were still null).
  const fleetCountry = fleetId !== null ? (await trx.selectFrom("fleets").select("country").where("fleet_id", "=", fleetId).executeTakeFirst())?.country ?? null : null;
  if (me.country === null || (fleetId !== null && fleetCountry === null)) throw new ApiError("invalid_transition", "Choose the country you work in first.", { reason: "country_required" });
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
  // v0.18.161: Vehicle.zoneId / Vehicle.country are on the admin's reads only, not on the driver app's answer.
  const { zoneId: _zoneId, country: _country, ...view } = await vehicleFullView(trx, row as unknown as VehicleRow);
  return view;
}

/* ---------------------------------------------------------------- admin views */

/** Job 1 (stress M4): the admin map's visible box (all four, degrees); with it only the drivers inside are read. */
export type MapBox = { minLat: number; minLng: number; maxLat: number; maxLng: number };

/** v0.18.34 §65 (A8/A10, rule 33): one page of live drivers, keyset by driverId (stateless, safe with several copies). */
export type LivePage = { limit: number; cursor?: string };

/** The zone a live driver counts in: the zone of his latest fix, else his first zone (contract §12 / §29). */
const LIVE_ZONE = sql<string | null>`coalesce(driver_locations.zone_id, drivers.zone_ids[1])`;

export async function liveDrivers(ex: Executor, zoneId: string | undefined, zones: string[], now: Date, box?: MapBox, page?: LivePage) {
  // Every driver not offline, inside the admin's zones (exact rule in SQL, so a page and the count agree), in the box.
  const scoped = () => {
    let query = ex
      .selectFrom("drivers")
      .leftJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
      .where("drivers.online_status", "!=", "offline");
    if (zoneId) query = query.where("driver_locations.zone_id", "=", zoneId);
    if (box) query = query.where("driver_locations.lat", ">=", box.minLat).where("driver_locations.lat", "<=", box.maxLat).where("driver_locations.lng", ">=", box.minLng).where("driver_locations.lng", "<=", box.maxLng);
    if (!zones.includes("*")) query = query.where(sql<boolean>`${LIVE_ZONE} = any(${sql.val(zones.length ? zones : ["-"])}::text[])`);
    return query;
  };
  let rowsQuery = scoped()
    .leftJoin("vehicles", "vehicles.vehicle_id", "drivers.vehicle_id")
    .select([
      "drivers.driver_id", "drivers.first_name", "drivers.online_status", "drivers.vehicle_id", "drivers.zone_ids", "drivers.offline_after_trip", "drivers.next_trips_off",
      "driver_locations.lat", "driver_locations.lng", "driver_locations.accuracy", "driver_locations.heading", "driver_locations.speed_mps", "driver_locations.moving", "driver_locations.measured_at", "driver_locations.received_at", "driver_locations.zone_id",
      "vehicles.plate",
    ])
    .orderBy("drivers.driver_id");
  if (page?.cursor) rowsQuery = rowsQuery.where("drivers.driver_id", ">", page.cursor);
  if (page) rowsQuery = rowsQuery.limit(page.limit + 1);
  const read = await rowsQuery.execute();
  const more = page !== undefined && read.length > page.limit;
  const shown = more ? read.slice(0, page.limit) : read;
  const activeRows = shown.length ? await ex.selectFrom("trips").select(["driver_id", "trip_id", "status"]).where("driver_id", "in", shown.map((r) => r.driver_id)).where("status", "in", [...DRIVER_ASSIGNED]).where(NOT_HELD).execute() : [];
  const activeOf = new Map(activeRows.map((t) => [t.driver_id as string, t]));
  const items = [];
  for (const r of shown) {
    const where = r.zone_id ?? r.zone_ids[0] ?? null;
    const active = activeOf.get(r.driver_id);
    const hasFix = r.lat !== null && r.measured_at !== null && r.received_at !== null;
    items.push({
      driverId: r.driver_id,
      firstName: r.first_name,
      onlineStatus: r.online_status,
      ...(r.offline_after_trip ? { offlineAfterTrip: true } : {}),
      ...(r.next_trips_off ? { nextTripsOff: true } : {}),
      ...(r.moving !== null ? { moving: r.moving } : {}),
      ...(hasFix ? { location: fixView({ lat: r.lat!, lng: r.lng!, accuracy: r.accuracy!, heading: r.heading, speed_mps: r.speed_mps, moving: r.moving ?? false, measured_at: r.measured_at! }), lastFixAt: r.received_at!.toISOString() } : {}),
      stale: !hasFix || now.getTime() - r.received_at!.getTime() > STALE_AFTER_SECONDS * 1000,
      ...(active ? { activeTripId: active.trip_id, tripStatus: active.status } : {}),
      ...(r.vehicle_id ? { vehicleId: r.vehicle_id } : {}),
      ...(r.plate ? { plate: r.plate } : {}),
      ...(where ? { zoneId: where } : {}),
    });
  }
  const paging = { nextCursor: more ? shown[shown.length - 1]!.driver_id : null };
  // v0.18.34 §65: counts per zone over EVERY matching driver (not only this page), one grouped query.
  const perZone = await scoped()
    .select((eb) => [
      LIVE_ZONE.as("zone"),
      eb.fn.countAll<string>().as("online"),
      sql<string>`count(*) filter (where drivers.online_status = 'online' and not exists (select 1 from trips where trips.driver_id = drivers.driver_id and trips.status = any(${sql.val([...DRIVER_ASSIGNED])}::text[]) and ${NOT_HELD}))`.as("free"),
    ])
    .groupBy(LIVE_ZONE)
    .execute();
  const total = perZone.reduce((sum, row) => sum + Number(row.online), 0);
  // Job 1 (stress M4): a map-box read is for the map only: the zone counts below need every driver, so they are left out.
  if (box) return { items, total, ...paging, staleAfterSeconds: STALE_AFTER_SECONDS, serverTime: now.toISOString() };
  // v0.18.4 (G3-R4): real riders online per zone, for the Dashboard.
  const ridersOnline = await ridersOnlineByZone(ex, zones, now);
  // v0.18.4 (G3-D5): supply and demand per zone, one rule for the Dashboard's rows and its shortage alert.
  const counted = perZone.flatMap((row) => (row.zone ? [{ zoneId: row.zone, online: Number(row.online), free: Number(row.free) }] : []));
  const zoneSupply = await zoneSupplyOf(ex, counted, [...ridersOnline.map((r) => r.zoneId), ...counted.map((row) => row.zoneId)], zones);
  return { items, total, ...paging, staleAfterSeconds: STALE_AFTER_SECONDS, serverTime: now.toISOString(), ridersOnline, ridersOnlineWindowSeconds: RIDERS_ONLINE_WINDOW_SECONDS, zoneSupply };
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
    // G30 (contract.json#emailVerified.neverActive): every path to active records the first time.
    .set({ first_name: input.firstName, account_status: "active", first_activated_at: sql`coalesce(first_activated_at, ${now})`, vehicle_id: vehicleId, category_ids: input.categoryIds, zone_ids: input.zoneIds, version: (existing?.version ?? 1) + 1, updated_at: now })
    .where("driver_id", "=", driverId)
    .execute();
  return { driverId, vehicleId };
}

/**
 * Contract v0.18.4 §29 (contract.json#driverHome.zoneSupply, owner G3-D5 "Fix it"): every driver online or on_trip
 * counts in his LiveDriver.zoneId, stale or not; free = online with no active trip; waiting = live requests with no
 * driver yet; short when waiting > free.
 */
async function zoneSupplyOf(ex: Executor, counted: Array<{ zoneId: string; online: number; free: number }>, shown: string[], zones: string[]) {
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
    const here = counted.find((row) => row.zoneId === zoneId) ?? { online: 0, free: 0 };
    const free = here.free;
    const waiting = Number(waitingRows.find((r) => r.zone_id === zoneId)?.n ?? 0);
    const level = waiting === 0 ? "ok" : waiting <= free ? "tight" : "short";
    return { zoneId, online: here.online, free, busy: here.online - free, waiting, level, shortage: level === "short" };
  });
}
