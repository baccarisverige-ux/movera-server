import type { Trx } from "../db/db.js";
import { appendTripEvent, type TripRow } from "../db/tripLog.js";
import { lockTripNow } from "../dispatch/runtime.js";
import { scheduleTimer, type Timer, type TimerHandler } from "../jobs/timers.js";
import { haversineKm, prepareLegs, preparedRouter, type LatLng, type Router } from "../maps/routing.js";
import { isTripStatus, TERMINAL } from "../rules/transitions.js";
import { tripProjection } from "../trips/projection.js";
import { rideCheckSettings, type RideCheckSettings } from "../trips/onTripSettings.js";
import { queueRideCheckPush } from "./rideCheckPush.js";
// v0.18.98 (job C9b): the shared stop visit (arrivedBy / away / pausedSeconds / pauseCount on top of arrivedAt / leftAt).
import type { StopVisit } from "../trips/ride/stopClock.js";

/**
 * v0.18.9 (contract.json#onTrip.rideCheck, owner G7 decisions 1 + 2): the server starts ride checks itself from the
 * driver's GPS and asks BOTH the rider and the driver "Is everything OK?". Every number is the zone's live
 * DriverAppConfig.rideCheck. The answers come through the §22 endpoint (safety/rideCheck.ts), whose no-answer timer
 * alerts the safety team.
 *
 * This module imports nothing from trips/ride.ts (ride.ts calls askUnexpectedEnd), and uses imported values only
 * inside functions, so it is safe in the existing ride ↔ projection import cycle.
 */

export const RIDE_CHECK_SCAN = "ride_check_scan";
/** The §22 no-answer timer kind (safety/rideCheck.ts), repeated here as a plain string to keep the module order free. */
const NO_ANSWER_KIND = "ride_check_no_answer";
const ONBOARD = new Set(["rider_onboard", "in_trip", "approaching_dropoff"]);
const STILL_METERS = 50;
const NEAR_DROPOFF_KM = 0.3;
const MAX_ACCURACY_M = 50;

type Side = "rider" | "driver";
export type ServerRideCheck = { checkId: string; trigger: string; askedAt: string; answerBy: string; answers: Partial<Record<Side, "ok" | "need_help">>; alertedAt?: string };
type Fix = LatLng & { measured_at: Date };

const pointOf = (p: unknown): LatLng => ({ lat: Number((p as LatLng).lat), lng: Number((p as LatLng).lng) });

/** Is the trip's current server check still waiting for an answer from someone? */
export function openServerCheck(trip: Pick<TripRow, "ride_check">, now: Date): ServerRideCheck | null {
  const check = trip.ride_check as ServerRideCheck | null;
  if (!check) return null;
  if (check.answers.rider && check.answers.driver) return null;
  return Date.parse(check.answerBy) > now.getTime() ? check : null;
}

/**
 * v0.18.100 (BQ-V37, contract.json#onTrip.rideCheck.detection.cadence): the earliest time of the trip's next scan, kept in
 * trips.ride_check_log under this key by each scan (scan time + the zone's scanEverySeconds). Not a trigger name.
 */
export const NEXT_SCAN_KEY = "nextScanAt";

/**
 * Called for each position batch of a driver on a trip: the check runs in a job right after (never inside the request).
 * v0.18.100 (BQ-V37, owner W1 Q66 = Q-B6): at most one scan per trip every scanEverySeconds: a batch that comes sooner
 * books the scan for `nextScanAt` (read with the trip in the same statement) instead of now. The first scan is not delayed.
 */
export async function scheduleRideCheckScan(trx: Trx, trip: Pick<TripRow, "trip_id" | "status"> & { next_scan_at?: string | null }, now: Date): Promise<void> {
  if (!ONBOARD.has(trip.status)) return;
  const next = trip.next_scan_at ? Date.parse(trip.next_scan_at) : Number.NaN;
  const dueAt = Number.isFinite(next) && next > now.getTime() ? new Date(next) : now;
  // E6: a pending scan keeps its due time and attempts (a GPS backlog cannot push it back or un-park a failing one).
  await scheduleTimer(trx, { kind: RIDE_CHECK_SCAN, refId: trip.trip_id, dueAt }, { keepDue: true });
}

/** v0.18.100 (BQ-V37): the scan keeps when the next one may run (the trip row is already locked by the scan). */
async function keepNextScan(trx: Trx, trip: TripRow, settings: RideCheckSettings, now: Date): Promise<void> {
  const log = { ...((trip.ride_check_log as Record<string, string> | null) ?? {}), [NEXT_SCAN_KEY]: new Date(now.getTime() + settings.scanEverySeconds * 1000).toISOString() };
  // askRideCheck below spreads trip.ride_check_log, so it keeps this key.
  (trip as { ride_check_log: unknown }).ride_check_log = log;
  await trx.updateTable("trips").set({ ride_check_log: JSON.stringify(log) }).where("trip_id", "=", trip.trip_id).execute();
}

/** Distance (km) from a point to a line through the points (flat earth around the point: fine for a few km). */
export function kmFromRoute(at: LatLng, route: readonly LatLng[]): number {
  if (route.length === 0) return Infinity;
  if (route.length === 1) return haversineKm(at, route[0]!);
  const kx = 111.32 * Math.cos((at.lat * Math.PI) / 180);
  const ky = 110.574;
  const xy = (p: LatLng) => ({ x: (p.lng - at.lng) * kx, y: (p.lat - at.lat) * ky });
  let best = Infinity;
  for (let i = 1; i < route.length; i++) {
    const a = xy(route[i - 1]!);
    const b = xy(route[i]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len));
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return best;
}

/** How long (minutes) the car has stood within 50 m of the newest fix, from the fixes given. */
export function stoppedMinutes(fixes: readonly Fix[]): number {
  const newest = fixes[fixes.length - 1];
  if (!newest) return 0;
  let since = newest.measured_at.getTime();
  for (let i = fixes.length - 1; i >= 0 && haversineKm(fixes[i]!, newest) * 1000 <= STILL_METERS; i--) since = fixes[i]!.measured_at.getTime();
  return (newest.measured_at.getTime() - since) / 60_000;
}

/** Long stop: the fixes cover the last stopMinutes and all stay within 50 m of the newest one. */
export function isLongStop(fixes: readonly Fix[], stopMinutes: number): boolean {
  if (fixes.length < 2) return false;
  const newest = fixes[fixes.length - 1]!;
  const windowStart = newest.measured_at.getTime() - stopMinutes * 60_000;
  let from = -1;
  for (let i = 0; i < fixes.length; i++) if (fixes[i]!.measured_at.getTime() <= windowStart) from = i;
  if (from < 0) return false;
  return fixes.slice(from).every((f) => haversineKm(f, newest) * 1000 <= STILL_METERS);
}

/** The trip's route for the off-route check: the road route (kept on the trip), else straight lines through its points. */
async function routeOf(trx: Trx, trip: TripRow, router: Router | undefined): Promise<LatLng[]> {
  const kept = trip.planned_route as LatLng[] | null;
  if (Array.isArray(kept) && kept.length >= 2) return kept;
  const points = [trip.pickup, ...((trip.stops as unknown[]) ?? []), trip.dropoff].map(pointOf);
  if (router) {
    try {
      const leg = await router.route(points);
      // E13 (audit S02 A2): only a real road route (OSRM) is kept; the estimate's points are the straight lines below,
      // and keeping them would stop the trip from ever getting its road route once OSRM answers.
      if (leg.source === "osrm" && leg.points && leg.points.length >= 2) {
        const shape = leg.points.map(pointOf);
        await trx.updateTable("trips").set({ planned_route: JSON.stringify(shape) }).where("trip_id", "=", trip.trip_id).execute();
        return shape;
      }
    } catch {
      // No road route now: the straight lines below.
    }
  }
  return points;
}

/**
 * Ask both sides: one ride_checks row per side (origin server, counted as shown now), the §22 no-answer timer per side,
 * TripProjection.rideCheck, and one event without a version change (trip_projection; payment_updated once the trip
 * ended, so the apps' after-terminal gate lets it through).
 */
export async function askRideCheck(trx: Trx, trip: TripRow, trigger: string, settings: RideCheckSettings, now: Date, position?: LatLng, measured?: number): Promise<ServerRideCheck> {
  const checkId = `srv_${trigger}_${now.getTime().toString(36)}`;
  const answerBy = new Date(now.getTime() + settings.noAnswerSeconds * 1000);
  const sides: Array<[Side, string | null]> = [["rider", trip.rider_id], ["driver", trip.driver_id]];
  for (const [side, subject] of sides) {
    if (!subject) continue;
    await trx
      .insertInto("ride_checks")
      .values({ trip_id: trip.trip_id, side, check_id: checkId, trigger, subject_id: subject, shown_at: now, origin: "server", position: position ? JSON.stringify({ ...position, at: now.toISOString(), ...measuredFields(trigger, measured), answerSeconds: settings.noAnswerSeconds }) : null, created_at: now })
      .onConflict((c) => c.doNothing())
      .execute();
    await scheduleTimer(trx, { kind: NO_ANSWER_KIND, refId: `${trip.trip_id}|${side}|${checkId}`, dueAt: answerBy });
    // Owner rule 16 (G7 open question 3): always a push too, so a locked phone still asks.
    await queueRideCheckPush(trx, trip, side, subject, { checkId, trigger, answerBy: answerBy.toISOString() }, now);
  }
  const check: ServerRideCheck = { checkId, trigger, askedAt: now.toISOString(), answerBy: answerBy.toISOString(), answers: {} };
  const log = { ...((trip.ride_check_log as Record<string, string> | null) ?? {}), [trigger]: now.toISOString() };
  await trx.updateTable("trips").set({ ride_check: JSON.stringify(check), ride_check_log: JSON.stringify(log) }).where("trip_id", "=", trip.trip_id).execute();
  await sendRideCheckEvent(trx, trip.trip_id, now);
  return check;
}

/**
 * G7 live fix (contract.json#onTrip.rideCheck.adminList): what the trigger measured, kept with the position so the admin
 * shows the real numbers: long_stop minutes stopped, off_route km from the route, dropped_far metres from the drop-off.
 */
export function measuredFields(trigger: string, measured: number | undefined): { measured?: { value: number; unit: "min" | "km" | "m" } } {
  if (measured === undefined || !Number.isFinite(measured)) return {};
  if (trigger === "long_stop") return { measured: { value: Math.max(1, Math.round(measured)), unit: "min" } };
  if (trigger === "off_route") return { measured: { value: Math.round(measured * 10) / 10, unit: "km" } };
  if (trigger === "dropped_far") return { measured: { value: Math.round(measured), unit: "m" } };
  return {};
}

/** One event with the trip as it is now, without a version change. */
export async function sendRideCheckEvent(trx: Trx, tripId: string, now: Date): Promise<void> {
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  const ended = isTripStatus(updated.status) && TERMINAL.has(updated.status);
  await appendTripEvent(trx, { tripId, kind: ended ? "payment_updated" : "trip_projection", version: updated.version, occurredAt: now, projection: tripProjection(updated, "admin", { sequence: Number(updated.sequence) + 1, now }) });
}

const recentlyAsked = (trip: TripRow, trigger: string, settings: RideCheckSettings, now: Date) => {
  const at = (trip.ride_check_log as Record<string, string> | null)?.[trigger];
  return at !== undefined && now.getTime() - Date.parse(at) < settings.repeatMinutes * 60_000;
};

/** What the latest fixes say: long_stop, off_route or nothing. Exported for the tests. */
export async function detect(trx: Trx, trip: TripRow, settings: RideCheckSettings, now: Date, router?: Router): Promise<{ trigger: string; at: LatLng; measured: number } | null> {
  const since = new Date(now.getTime() - (settings.stopMinutes * 60 + 120) * 1000);
  const fixes = (await trx
    .selectFrom("trip_locations")
    .select(["lat", "lng", "measured_at"])
    .where("trip_id", "=", trip.trip_id)
    .where("measured_at", ">=", since)
    .where("accuracy", "<=", MAX_ACCURACY_M)
    .orderBy("measured_at")
    .execute()) as Fix[];
  const newest = fixes[fixes.length - 1];
  if (!newest) return null;
  const boardedLongEnough = trip.boarded_at !== null && now.getTime() - trip.boarded_at.getTime() >= settings.stopMinutes * 60_000;
  // v0.18.98 supervisor M2 (job C9b): an open stop counts as "at the stop" only while the driver is not away from it
  // (stops[i].away), so a stop arrived (also automatically) and never left does not switch long_stop off for the trip.
  const atStop = ((trip.stop_visits as StopVisit[] | null) ?? []).some((v) => !v.leftAt && !v.away);
  const nearDropoff = haversineKm(newest, pointOf(trip.dropoff)) <= NEAR_DROPOFF_KM;
  if (boardedLongEnough && !atStop && !nearDropoff && isLongStop(fixes, settings.stopMinutes)) return { trigger: "long_stop", at: newest, measured: Math.max(settings.stopMinutes, stoppedMinutes(fixes)) };
  const route = await routeOf(trx, trip, router);
  const offKm = kmFromRoute(newest, route);
  if (offKm > settings.offRouteKm) return { trigger: "off_route", at: newest, measured: offKm };
  return null;
}

/** The scan job: one open server check per trip; each trigger again only after repeatMinutes. */
export const rideCheckScanHandler = (router?: Router): TimerHandler => {
  const handler: TimerHandler = async (trx, timer) => scan(trx, timer, router ? preparedRouter(timer.prepared) : undefined);
  // Job 1 (fix plan R1 b): the trip's road route (asked once, then kept on the trip) is fetched before the transaction.
  handler.prepare = async (db, timer) => {
    if (!router) return null;
    const trip = await db.selectFrom("trips").selectAll().where("trip_id", "=", timer.refId).executeTakeFirst();
    if (!trip || !ONBOARD.has(trip.status)) return null;
    const kept = trip.planned_route as LatLng[] | null;
    if (Array.isArray(kept) && kept.length >= 2) return null;
    return prepareLegs(router, [[trip.pickup, ...((trip.stops as unknown[]) ?? []), trip.dropoff].map(pointOf)]);
  };
  return handler;
};

async function scan(trx: Trx, timer: Timer, router: Router | undefined): Promise<void> {
  const trip = await lockTripNow(trx, timer.refId);
  if (!trip || !ONBOARD.has(trip.status) || !trip.driver_id) return;
  const now = timer.firedAt;
  const settings = await rideCheckSettings(trx, trip.zone_id);
  await keepNextScan(trx, trip, settings, now);
  if (openServerCheck(trip, now)) return;
  if (!settings.on) return;
  const found = await detect(trx, trip, settings, now, router);
  if (!found || recentlyAsked(trip, found.trigger, settings, now)) return;
  await askRideCheck(trx, trip, found.trigger, settings, now, found.at, found.measured);
}

/**
 * Unexpected end (trigger dropped_far): the driver completed or cancelled with the rider on board farther than
 * endFarMeters from the drop-off (his latest fix). Called by trips/ride.ts right after the trip ended.
 */
export async function askUnexpectedEnd(trx: Trx, ended: TripRow, now: Date): Promise<void> {
  if (!ended.driver_id) return;
  const settings = await rideCheckSettings(trx, ended.zone_id);
  if (!settings.on || recentlyAsked(ended, "dropped_far", settings, now)) return;
  const fix = await trx.selectFrom("driver_locations").select(["lat", "lng"]).where("driver_id", "=", ended.driver_id).executeTakeFirst();
  if (!fix) return;
  const farMeters = haversineKm(fix, pointOf(ended.dropoff)) * 1000;
  if (farMeters <= settings.endFarMeters) return;
  await askRideCheck(trx, ended, "dropped_far", settings, now, { lat: fix.lat, lng: fix.lng }, farMeters);
}
