import type { Trx } from "../db/db.js";
import { appendTripEvent, type TripRow } from "../db/tripLog.js";
import { ETA_FIX_MAX_AGE_SECONDS, fixView, STALE_AFTER_SECONDS } from "../drivers/service.js";
import { contract } from "../contract/contract.js";
import { scheduleTimer, cancelTimer, type TimerHandler } from "../jobs/timers.js";
import { lockTripNow } from "../dispatch/runtime.js";
import { haversineKm } from "../maps/routing.js";
import { prepareLegs, preparedRouter, type Router } from "../maps/routing.js";
import { DISPATCH } from "../dispatch/engine.js";
import { tripProjection } from "./projection.js";
import { TERMINAL, type TripStatus } from "../rules/transitions.js";
import { headingTick } from "./headingCheck.js";
import { takeBackLateBooked } from "./ride.js";
import { statusTarget, TRIP_ETA } from "./etaNow.js";
import { maybePushArriving } from "../notifications/tripPush.js";
import { etaRouteBasis, isEtaRoutePrepared, prepareEtaRoute } from "./etaRoute.js";
import { nextStopIndex, visitsOf } from "./ride/stopClock.js";

/**
 * v0.18.7 (contract.json#pickupWaiting.eta, owner status item 2 and Q4 "same road-route ETA for both apps"): ONE ETA,
 * computed by the server every EVERY_SECONDS from the driver's latest position: v0.18.163 along the stored Google route
 * where live traffic is on (trips/etaRoute.ts), else the straight-line estimate (no OSRM since v0.18.163), to the pickup from accept until the rider boards and to the drop-off from
 * boarding until the end. It is kept on the trip (trips.eta, TripProjection.eta on every read) and sent as a
 * kind=location event with etaSeconds + eta, so the rider, the driver and the admin all show the same number without
 * computing anything themselves. One durable timer per trip (kind TRIP_ETA), booked at accept, re-booked by each tick,
 * gone when the trip has no driver or is over.
 */

type Place = { lat: number; lng: number };
export type TripEta = { etaSeconds: number; distanceMeters: number; target: "pickup" | "dropoff"; at: string; source: "google" | "osrm" | "estimate" | "stale" };

const PW = (contract as unknown as { pickupWaiting: { eta: { everySeconds: number; staleAfterSeconds: number } } }).pickupWaiting.eta;
export { TRIP_ETA };
export const ETA_EVERY_MS = PW.everySeconds * 1000;
export const ETA_STALE_MS = PW.staleAfterSeconds * 1000;
/** Nobody is told "0 minutes": the ETA floor (as the old haversine ETA had). */
export const ETA_MIN_SECONDS = 60;

/** Where the car is going now, or null while it waits at the pickup or the trip is over / has no driver. */
export function etaTarget(trip: Pick<TripRow, "status" | "driver_id">): "pickup" | "dropoff" | null {
  if (!trip.driver_id || TERMINAL.has(trip.status as TripStatus)) return null;
  return statusTarget(trip.status);
}

/** The straight-line estimate at dispatch's pickup speed (what reads use when no fresh ETA is stored). */
export function estimateEta(from: Place, to: Place, target: "pickup" | "dropoff", now: Date): TripEta {
  const meters = Math.round(haversineKm(from, to) * DISPATCH.score.roadFactor * 1000);
  return { etaSeconds: Math.max(ETA_MIN_SECONDS, Math.round((meters / 1000 / DISPATCH.score.pickupKmh) * 3600)), distanceMeters: meters, target, at: now.toISOString(), source: "estimate" };
}

export const isFreshEta = (eta: TripEta | null | undefined, now: Date): eta is TripEta => !!eta && now.getTime() - Date.parse(eta.at) <= ETA_STALE_MS;
/** Checker L5: a position older than dispatch's "gone" age (STALE_AFTER_SECONDS) is not routed; the previous ETA is kept as source stale. */
/** No fix received for 120 s, or (G5 live re-test) the fix itself measured longer ago than ETA_FIX_MAX_AGE_SECONDS. */
export const isStaleFix = (fix: { received_at: Date; measured_at?: Date }, now: Date): boolean =>
  now.getTime() - fix.received_at.getTime() > STALE_AFTER_SECONDS * 1000 ||
  (fix.measured_at !== undefined && now.getTime() - fix.measured_at.getTime() > ETA_FIX_MAX_AGE_SECONDS * 1000);
const staleOf = (previous: TripEta, target: "pickup" | "dropoff", now: Date): TripEta => ({ ...previous, target, at: now.toISOString(), source: "stale" });

/** Books the first tick (at accept, and for a trip that has none yet). */
export async function startEta(trx: Trx, tripId: string, now: Date): Promise<void> {
  await scheduleTimer(trx, { kind: TRIP_ETA, refId: tripId, dueAt: now, payload: {} });
}

export async function stopEta(trx: Trx, tripId: string): Promise<void> {
  await cancelTimer(trx, TRIP_ETA, tripId);
}

/** One tick: route the driver's latest fix to the target, keep it on the trip, send it, book the next tick. */
export function etaHandler(router: Router, traffic?: Router): TimerHandler {
  const handler: TimerHandler = async (trx, timer) => {
    // Job 1 (fix plan R1 b): the road route was asked before this transaction (prepare below); nothing here waits on OSRM.
    const routerNow = preparedRouter(timer.prepared);
    const now = timer.firedAt;
    const trip = await lockTripNow(trx, timer.refId);
    if (!trip) return;
    const target = etaTarget(trip);
    if (target === null) {
      // Waiting at the pickup: nothing to show, look again when the rider boards (the next step books nothing, so poll slowly).
      if (trip.status === "arrived") await scheduleTimer(trx, { kind: TRIP_ETA, refId: trip.trip_id, dueAt: new Date(now.getTime() + ETA_EVERY_MS), payload: {} });
      return;
    }
    const fix = await trx.selectFrom("driver_locations").selectAll().where("driver_id", "=", trip.driver_id!).executeTakeFirst();
    await scheduleTimer(trx, { kind: TRIP_ETA, refId: trip.trip_id, dueAt: new Date(now.getTime() + ETA_EVERY_MS), payload: {} });
    if (!fix) {
      // v0.18.13 (G5-8): no position at all is no proof the driver is coming.
      if (target === "pickup") await headingTick(trx, trip, { fix: null, leg: null, now }, takeBackLateBooked);
      return;
    }
    const previous = trip.eta as TripEta | null;
    let eta: TripEta;
    let leg: { distanceMeters: number; durationSeconds: number } | null = null;
    if (isStaleFix(fix, now)) {
      if (target === "pickup" && (await headingTick(trx, trip, { fix: null, leg: null, now }, takeBackLateBooked))) return;
      // No fresh position: nothing new to route; the apps keep the last number and see it is old (source stale).
      if (!previous || previous.target !== target) return;
      eta = staleOf(previous, target, now);
    } else {
      const to = (target === "pickup" ? trip.pickup : trip.dropoff) as Place;
      // v0.18.163 (contract.json#liveTraffic.calls): with live traffic the tick follows the stored Google route
      // (trips/etaRoute.ts, prepared outside the lock); else the router (the straight-line estimate) as before.
      // Review #328 F6: only for the same target (the rider may have boarded meanwhile), and a route change that
      // cleared the stored route in between is not written back over.
      const followed = isEtaRoutePrepared(timer.prepared) && timer.prepared.target === target && timer.prepared.basis === etaRouteBasis(trip) ? timer.prepared : null;
      const routed = followed !== null ? followed.leg : await routerNow.route([{ lat: fix.lat, lng: fix.lng }, to]);
      leg = routed;
      eta = { etaSeconds: Math.max(ETA_MIN_SECONDS, routed.durationSeconds), distanceMeters: routed.distanceMeters, target, at: now.toISOString(), source: routed.source };
      if (followed !== null && followed.route !== null) await trx.updateTable("trips").set({ eta_route: JSON.stringify(followed.route) }).where("trip_id", "=", trip.trip_id).execute();
      // v0.18.13 (G5-8): the heading-to-pickup check runs with every tick to the pickup. v0.18.35 (owner Q-A, job 4): a
      // live trip is never taken back; only a late booked ride may be (then it is back in dispatch: no ETA to send).
      if (target === "pickup" && (await headingTick(trx, trip, { fix, leg, now }, takeBackLateBooked))) return;
    }
    await trx.updateTable("trips").set({ eta: JSON.stringify(eta) }).where("trip_id", "=", trip.trip_id).execute();
    // A location event (no version change) with the ETA: the apps' gate never replaces the projection with it (§4).
    await appendTripEvent(trx, { tripId: trip.trip_id, kind: "location", version: trip.version, occurredAt: now, location: fixView(fix), etaSeconds: eta.etaSeconds, eta });
    // v0.18.13 (contract.json#riderTripPush): "your driver is almost there", once per driver.
    if (target === "pickup" && leg !== null) await maybePushArriving(trx, trip, eta.etaSeconds, now);
  };
  // Outside the transaction, no lock: the same trip and fix read plainly, the route asked from the real router.
  handler.prepare = async (db, timer) => {
    const trip = await db.selectFrom("trips").selectAll().where("trip_id", "=", timer.refId).executeTakeFirst();
    if (!trip) return null;
    const target = etaTarget(trip);
    if (target === null) return null;
    const fix = await db.selectFrom("driver_locations").selectAll().where("driver_id", "=", trip.driver_id!).executeTakeFirst();
    if (!fix || isStaleFix(fix, timer.firedAt)) return null;
    const to = (target === "pickup" ? trip.pickup : trip.dropoff) as Place;
    // v0.18.163: live traffic on → the stored Google route (a call only after accept, off the route or far behind).
    const stops = (Array.isArray(trip.stops) ? (trip.stops as Place[]) : []).map((p) => ({ lat: p.lat, lng: p.lng }));
    const next = target === "dropoff" ? nextStopIndex(stops.length, visitsOf({ stop_visits: trip.stop_visits })) : null;
    const viaRoute = await prepareEtaRoute(db, trip, target, { lat: fix.lat, lng: fix.lng }, to, timer.firedAt, traffic, next === null ? [] : stops.slice(next));
    if (viaRoute !== null) return viaRoute;
    // S7 0.17: an ETA tick needs the time and the distance only, never the road's shape.
    return prepareLegs(router, [[{ lat: fix.lat, lng: fix.lng }, to]], { shape: false });
  };
  return handler;
}

/** The ETA for a read of the trip: the stored one while fresh, else the estimate from the driver's latest fix. */
export function etaForRead(trip: TripRow, fix: Place & { received_at?: Date; measured_at?: Date }, now: Date): TripEta | null {
  const target = etaTarget(trip);
  if (target === null) return null;
  const stored = trip.eta as TripEta | null;
  if (isFreshEta(stored, now) && stored.target === target) return stored;
  // An old position gives no new estimate: the last ETA, marked stale (none when there never was one).
  if (fix.received_at !== undefined && isStaleFix({ received_at: fix.received_at, measured_at: fix.measured_at }, now)) return stored && stored.target === target ? staleOf(stored, target, now) : null;
  return estimateEta(fix, (target === "pickup" ? trip.pickup : trip.dropoff) as Place, target, now);
}

/** The admin projection of a trip with its live ETA (for lists). */
export function withEta(trip: TripRow, fix: (Place & { received_at?: Date; measured_at?: Date }) | undefined, now: Date, viewer: "rider" | "driver" | "admin"): Record<string, unknown> {
  const projection = tripProjection(trip, viewer, { now });
  if (!fix) return projection;
  const eta = etaForRead(trip, fix, now);
  return eta ? { ...projection, eta, etaSeconds: eta.etaSeconds } : projection;
}
