import type { Trx } from "../db/db.js";
import { appendTripEvent, type TripRow } from "../db/tripLog.js";
import { lockTripNow } from "../dispatch/runtime.js";
import { scheduleTimer, type TimerHandler } from "../jobs/timers.js";
import { haversineKm, type LatLng, type Router } from "../maps/routing.js";
import { isTripStatus, TERMINAL } from "../rules/transitions.js";
import { tripProjection } from "../trips/projection.js";
import { rideCheckSettings, type RideCheckSettings } from "../trips/onTripSettings.js";
import { queueRideCheckPush } from "./rideCheckPush.js";

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
type StopVisit = { stopIndex: number; arrivedAt: string; leftAt?: string };

const pointOf = (p: unknown): LatLng => ({ lat: Number((p as LatLng).lat), lng: Number((p as LatLng).lng) });

/** Is the trip's current server check still waiting for an answer from someone? */
export function openServerCheck(trip: Pick<TripRow, "ride_check">, now: Date): ServerRideCheck | null {
  const check = trip.ride_check as ServerRideCheck | null;
  if (!check) return null;
  if (check.answers.rider && check.answers.driver) return null;
  return Date.parse(check.answerBy) > now.getTime() ? check : null;
}

/** Called for each position batch of a driver on a trip: the check runs in a job right after (never inside the request). */
export async function scheduleRideCheckScan(trx: Trx, trip: Pick<TripRow, "trip_id" | "status">, now: Date): Promise<void> {
  if (!ONBOARD.has(trip.status)) return;
  await scheduleTimer(trx, { kind: RIDE_CHECK_SCAN, refId: trip.trip_id, dueAt: now });
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
      if (leg.points && leg.points.length >= 2) {
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
export async function askRideCheck(trx: Trx, trip: TripRow, trigger: string, settings: RideCheckSettings, now: Date, position?: LatLng): Promise<ServerRideCheck> {
  const checkId = `srv_${trigger}_${now.getTime().toString(36)}`;
  const answerBy = new Date(now.getTime() + settings.noAnswerSeconds * 1000);
  const sides: Array<[Side, string | null]> = [["rider", trip.rider_id], ["driver", trip.driver_id]];
  for (const [side, subject] of sides) {
    if (!subject) continue;
    await trx
      .insertInto("ride_checks")
      .values({ trip_id: trip.trip_id, side, check_id: checkId, trigger, subject_id: subject, shown_at: now, origin: "server", position: position ? JSON.stringify({ ...position, at: now.toISOString() }) : null, created_at: now })
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
export async function detect(trx: Trx, trip: TripRow, settings: RideCheckSettings, now: Date, router?: Router): Promise<{ trigger: string; at: LatLng } | null> {
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
  const atStop = ((trip.stop_visits as StopVisit[] | null) ?? []).some((v) => !v.leftAt);
  const nearDropoff = haversineKm(newest, pointOf(trip.dropoff)) <= NEAR_DROPOFF_KM;
  if (boardedLongEnough && !atStop && !nearDropoff && isLongStop(fixes, settings.stopMinutes)) return { trigger: "long_stop", at: newest };
  const route = await routeOf(trx, trip, router);
  if (kmFromRoute(newest, route) > settings.offRouteKm) return { trigger: "off_route", at: newest };
  return null;
}

/** The scan job: one open server check per trip; each trigger again only after repeatMinutes. */
export const rideCheckScanHandler = (router?: Router): TimerHandler => async (trx, timer) => {
  const trip = await lockTripNow(trx, timer.refId);
  if (!trip || !ONBOARD.has(trip.status) || !trip.driver_id) return;
  const now = timer.firedAt;
  if (openServerCheck(trip, now)) return;
  const settings = await rideCheckSettings(trx, trip.zone_id);
  if (!settings.on) return;
  const found = await detect(trx, trip, settings, now, router);
  if (!found || recentlyAsked(trip, found.trigger, settings, now)) return;
  await askRideCheck(trx, trip, found.trigger, settings, now, found.at);
};

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
  if (haversineKm(fix, pointOf(ended.dropoff)) * 1000 <= settings.endFarMeters) return;
  await askRideCheck(trx, ended, "dropped_far", settings, now, { lat: fix.lat, lng: fix.lng });
}
