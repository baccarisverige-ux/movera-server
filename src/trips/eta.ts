import type { Trx } from "../db/db.js";
import { appendTripEvent, type TripRow } from "../db/tripLog.js";
import { ETA_FIX_MAX_AGE_SECONDS, fixView, STALE_AFTER_SECONDS } from "../drivers/service.js";
import { contract } from "../contract/contract.js";
import { scheduleTimer, cancelTimer, type TimerHandler } from "../jobs/timers.js";
import { lockTripNow } from "../dispatch/runtime.js";
import { haversineKm } from "../maps/routing.js";
import type { Router } from "../maps/routing.js";
import { DISPATCH } from "../dispatch/engine.js";
import { tripProjection } from "./projection.js";
import { TERMINAL, type TripStatus } from "../rules/transitions.js";

/**
 * v0.18.7 (contract.json#pickupWaiting.eta, owner status item 2 and Q4 "same road-route ETA for both apps"): ONE ETA,
 * computed by the server every EVERY_SECONDS from the driver's latest position with the server's router (Movera's
 * OSRM, else the straight-line estimate), to the pickup from accept until the rider boards and to the drop-off from
 * boarding until the end. It is kept on the trip (trips.eta, TripProjection.eta on every read) and sent as a
 * kind=location event with etaSeconds + eta, so the rider, the driver and the admin all show the same number without
 * computing anything themselves. One durable timer per trip (kind TRIP_ETA), booked at accept, re-booked by each tick,
 * gone when the trip has no driver or is over.
 */

type Place = { lat: number; lng: number };
export type TripEta = { etaSeconds: number; distanceMeters: number; target: "pickup" | "dropoff"; at: string; source: "osrm" | "estimate" | "stale" };

const PW = (contract as unknown as { pickupWaiting: { eta: { everySeconds: number; staleAfterSeconds: number } } }).pickupWaiting.eta;
export const TRIP_ETA = "trip_eta";
export const ETA_EVERY_MS = PW.everySeconds * 1000;
export const ETA_STALE_MS = PW.staleAfterSeconds * 1000;
/** Nobody is told "0 minutes": the ETA floor (as the old haversine ETA had). */
export const ETA_MIN_SECONDS = 60;

const TO_PICKUP = new Set(["accepted", "driver_to_pickup"]);
const ON_BOARD = new Set(["rider_onboard", "in_trip", "approaching_dropoff"]);

/** Where the car is going now, or null while it waits at the pickup or the trip is over / has no driver. */
export function etaTarget(trip: Pick<TripRow, "status" | "driver_id">): "pickup" | "dropoff" | null {
  if (!trip.driver_id || TERMINAL.has(trip.status as TripStatus)) return null;
  if (TO_PICKUP.has(trip.status)) return "pickup";
  if (ON_BOARD.has(trip.status)) return "dropoff";
  return null;
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
export function etaHandler(router: Router): TimerHandler {
  return async (trx, timer) => {
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
    if (!fix) return;
    const previous = trip.eta as TripEta | null;
    let eta: TripEta;
    if (isStaleFix(fix, now)) {
      // No fresh position: nothing new to route; the apps keep the last number and see it is old (source stale).
      if (!previous || previous.target !== target) return;
      eta = staleOf(previous, target, now);
    } else {
      const to = (target === "pickup" ? trip.pickup : trip.dropoff) as Place;
      const leg = await router.route([{ lat: fix.lat, lng: fix.lng }, to]);
      eta = { etaSeconds: Math.max(ETA_MIN_SECONDS, leg.durationSeconds), distanceMeters: leg.distanceMeters, target, at: now.toISOString(), source: leg.source };
    }
    await trx.updateTable("trips").set({ eta: JSON.stringify(eta) }).where("trip_id", "=", trip.trip_id).execute();
    // A location event (no version change) with the ETA: the apps' gate never replaces the projection with it (§4).
    await appendTripEvent(trx, { tripId: trip.trip_id, kind: "location", version: trip.version, occurredAt: now, location: fixView(fix), etaSeconds: eta.etaSeconds, eta });
  };
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
