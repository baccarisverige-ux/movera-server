import type { Executor } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { liveTrafficSettings, type LiveTrafficSettings } from "../maps/liveTraffic.js";
import { alongRoute, decodePolyline } from "../maps/polyline.js";
import type { LatLng, Router } from "../maps/routing.js";

/**
 * v0.18.163 (contract.json#liveTraffic.calls; owner 2026-11-25 "the cheapest method, about 2 Google calls per trip"):
 * the live ETA follows a stored Google route instead of asking a router every tick.
 *  - To the pickup: one Google call after accept (the first tick), driver position → pickup; its polyline is kept.
 *  - To the drop-off: the trip's quote polyline (trips.route_polyline), from boarding, with no call.
 *  - Each tick: the remaining metres along the route from the driver's position × the route's average speed.
 *  - A new call only when the driver is off the route (> offRouteMeters for > offRouteSeconds) or the arrival is
 *    more than behindMinutes later than the route planned.
 * Runs in the ETA timer's `prepare` (no transaction, no lock); the handler stores what it returns.
 */
export type EtaRoute = {
  target: "pickup" | "dropoff";
  polyline: string;
  meters: number;
  seconds: number;
  /** When the route was taken (its planned arrival = at + seconds). */
  at: string;
  /** First tick seen off the route, null while on it. */
  offSince: string | null;
  /** Google calls this trip's ETA made (for the logs / the cost check). */
  calls: number;
};

/** Closer than this to the end of the route: no new Google call (review #328 F3). */
export const NEAR_END_METERS = 50;

export type EtaRoutePrepared = { kind: "eta_route"; target: "pickup" | "dropoff"; basis: string; route: EtaRoute | null; leg: { distanceMeters: number; durationSeconds: number; source: "google" | "estimate" } };

const asRoute = (value: unknown): EtaRoute | null => {
  const r = value as Partial<EtaRoute> | null;
  return r && typeof r.polyline === "string" && typeof r.meters === "number" && typeof r.seconds === "number" && typeof r.at === "string" && (r.target === "pickup" || r.target === "dropoff") ? (r as EtaRoute) : null;
};

/** What this tick shows from `route` at `fix`, and whether Google must be asked again. */
export function followRoute(route: EtaRoute, fix: LatLng, now: Date, s: Pick<LiveTrafficSettings, "offRouteMeters" | "offRouteSeconds" | "behindMinutes">): { route: EtaRoute; remainingMeters: number; remainingSeconds: number; recall: boolean } {
  const points = decodePolyline(route.polyline);
  const { offMeters, remainingMeters } = alongRoute(points, fix);
  const speed = route.meters > 0 && route.seconds > 0 ? route.meters / route.seconds : 0;
  const remainingSeconds = speed > 0 ? remainingMeters / speed : 0;
  const off = offMeters > s.offRouteMeters;
  const offSince = off ? (route.offSince ?? now.toISOString()) : null;
  const offTooLong = offSince !== null && now.getTime() - Date.parse(offSince) > s.offRouteSeconds * 1000;
  const planned = Date.parse(route.at) + route.seconds * 1000;
  const behind = now.getTime() + remainingSeconds * 1000 - planned > s.behindMinutes * 60_000;
  // Review #328 F3: almost there (or a 0 m route) never asks Google again.
  const near = remainingMeters < NEAR_END_METERS;
  return { route: { ...route, offSince }, remainingMeters: Math.round(remainingMeters), remainingSeconds: Math.round(remainingSeconds), recall: !near && (offTooLong || behind || speed === 0) };
}

/**
 * The prepared ETA of one tick, or null when live traffic is off for the zone or the server has no Google router
 * (then the tick uses the estimate as before). `traffic` falls back to the estimate itself when Google fails.
 */
export async function prepareEtaRoute(ex: Executor, trip: TripRow, target: "pickup" | "dropoff", fix: LatLng, to: LatLng, now: Date, traffic: Router | undefined, via: LatLng[] = []): Promise<EtaRoutePrepared | null> {
  if (traffic === undefined) return null;
  const basis = etaRouteBasis(trip);
  const settings = await liveTrafficSettings(ex, trip.zone_id);
  if (!settings.on) return null;
  let route = asRoute(trip.eta_route);
  if (route !== null && route.target !== target) route = null;
  if (route === null && target === "dropoff" && trip.route_polyline) {
    // From boarding, the booked route of the quote: no call.
    route = { target, polyline: trip.route_polyline, meters: trip.distance_meters ?? 0, seconds: trip.duration_seconds ?? 0, at: now.toISOString(), offSince: null, calls: asRoute(trip.eta_route)?.calls ?? 0 };
  }
  if (route !== null) {
    const followed = followRoute(route, fix, now, settings);
    if (!followed.recall) return { kind: "eta_route", target, basis, route: followed.route, leg: { distanceMeters: followed.remainingMeters, durationSeconds: followed.remainingSeconds, source: "google" } };
  }
  const calls = (route?.calls ?? asRoute(trip.eta_route)?.calls ?? 0) + 1;
  // Review #328 F4: to the drop-off through the stops still ahead, so a trip with stops is not "off the route" at once.
  const leg = await traffic.route([fix, ...via, to], { shape: false });
  if (leg.source === "google" && leg.polyline) {
    return { kind: "eta_route", target, basis, route: { target, polyline: leg.polyline, meters: leg.distanceMeters, seconds: leg.durationSeconds, at: now.toISOString(), offSince: null, calls }, leg: { distanceMeters: leg.distanceMeters, durationSeconds: leg.durationSeconds, source: "google" } };
  }
  // Google did not answer: the estimate for this tick; the next tick tries again (the breaker keeps that cheap).
  return { kind: "eta_route", target, basis, route: null, leg: { distanceMeters: leg.distanceMeters, durationSeconds: leg.durationSeconds, source: "estimate" } };
}

/** What the prepared tick was worked out from; the handler uses it only if the trip still holds the same (review #328 F6). */
export const etaRouteBasis = (trip: Pick<TripRow, "eta_route" | "route_polyline">): string => `${JSON.stringify(trip.eta_route ?? null)}|${trip.route_polyline ?? ""}`;

export const isEtaRoutePrepared = (value: unknown): value is EtaRoutePrepared => (value as { kind?: unknown } | null)?.kind === "eta_route";
