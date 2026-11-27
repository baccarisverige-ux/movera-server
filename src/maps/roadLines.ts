import type { Db } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { STALE_AFTER_SECONDS } from "../drivers/service.js";
import { TERMINAL, type TripStatus } from "../rules/transitions.js";
import { etaTarget } from "../trips/eta.js";
import { asRoute, storeCountedRoute, tooSoon, zoneCountry, type EtaRoute } from "../trips/etaRoute.js";
import { nextStopIndex, visitsOf } from "../trips/ride/stopClock.js";
import { googleBudgetOpen, type GoogleCallBudget } from "./googleBudget.js";
import { liveTrafficSettings } from "./liveTraffic.js";
import { cutFrom, decodePolyline } from "./polyline.js";
import { EstimateRouter, haversineKm, type LatLng, type Router } from "./routing.js";

/**
 * v0.18.171 (contract.json#googleRoadLines.navigation / trust / offRouteRule / calls / spacing / atCap; owner 2026-11-27
 * "Google on key screens"): the driver's road line for GET /routes/driving.
 *  - Only the caller's OWN active trip leg is routed and written; the origin is the asked first point only within 150 m
 *    of his stored position (at most 120 s old), else that stored position. No leg or no position: the straight line.
 *  - On the stored Google route (within a fixed 50 m): that route, cut at the car, no call (source stored).
 *  - Off it (or none): one Google call, under the trip cap (the quote included), the 60 s rule (eta_route.at, in the DB)
 *    and the daily road-line budget; stored as trips.eta_route with the counter in ONE update (source google).
 *  - Otherwise: the stored route cut (stored), else the straight line (estimate). Always code Ok, status 200.
 */
export const OFF_ROUTE_METERS = 50;
export const TRUST_METERS = 150;
export const CACHE_TTL_MS = 120_000;

export type RoadLine = { source: "google" | "stored" | "estimate"; points: LatLng[]; distanceMeters: number; durationSeconds: number };

type CacheEntry = { at: number; line: RoadLine };

/** Best effort, per server copy: trip + target + origin rounded to about 100 m, 120 s. The DB rules above are the real guards. */
export class RoadLineCache {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(private readonly ttlMs = CACHE_TTL_MS) {}
  static key(tripId: string, target: string, origin: LatLng): string {
    return `${tripId}|${target}|${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}`;
  }
  get(key: string, now: number): RoadLine | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (now - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.line;
  }
  put(key: string, line: RoadLine, now: number): void {
    if (this.entries.size > 2000) for (const [k, v] of this.entries) if (now - v.at > this.ttlMs) this.entries.delete(k);
    this.entries.set(key, { at: now, line });
  }
}

const straight = async (points: LatLng[]): Promise<RoadLine> => {
  const leg = await new EstimateRouter().route(points);
  return { source: "estimate", points, distanceMeters: leg.distanceMeters, durationSeconds: leg.durationSeconds };
};

/** The caller's own active trip with a leg to drive (to the pickup, or to the drop-off), or null. */
async function ownActiveLeg(db: Db, driverId: string): Promise<{ trip: TripRow; target: "pickup" | "dropoff" } | null> {
  const trips = await db.selectFrom("trips").selectAll().where("driver_id", "=", driverId).where("status", "not in", [...TERMINAL] as TripStatus[]).orderBy("created_at", "desc").limit(3).execute();
  for (const trip of trips) {
    const target = etaTarget(trip);
    if (target !== null) return { trip, target };
  }
  return null;
}

/** The stored Google route of this leg: trips.eta_route of the same target, else (to the drop-off) the booked quote route. */
function storedLeg(trip: TripRow, target: "pickup" | "dropoff"): { points: LatLng[]; meters: number; seconds: number } | null {
  const r = asRoute(trip.eta_route);
  if (r !== null && r.target === target) {
    const points = decodePolyline(r.polyline);
    if (points.length >= 2) return { points, meters: r.meters, seconds: r.seconds };
  }
  if (target === "dropoff" && trip.route_polyline) {
    const points = decodePolyline(trip.route_polyline);
    if (points.length >= 2) return { points, meters: trip.distance_meters ?? 0, seconds: trip.duration_seconds ?? 0 };
  }
  return null;
}

function cut(stored: { points: LatLng[]; meters: number; seconds: number }, origin: LatLng): RoadLine & { offMeters: number } {
  const c = cutFrom(stored.points, origin);
  const speed = stored.meters > 0 && stored.seconds > 0 ? stored.meters / stored.seconds : 0;
  return { source: "stored", points: c.points, distanceMeters: Math.round(c.remainingMeters), durationSeconds: speed > 0 ? Math.round(c.remainingMeters / speed) : 0, offMeters: c.offMeters };
}

export async function driverRoadLine(db: Db, driverId: string, asked: LatLng[], now: Date, traffic: Router | undefined, cache: RoadLineCache): Promise<RoadLine> {
  const active = await ownActiveLeg(db, driverId);
  if (active === null) return straight(asked);
  const { trip, target } = active;
  const fix = await db.selectFrom("driver_locations").select(["lat", "lng", "received_at"]).where("driver_id", "=", driverId).executeTakeFirst();
  if (!fix || now.getTime() - fix.received_at.getTime() > STALE_AFTER_SECONDS * 1000) return straight(asked);
  const at = { lat: fix.lat, lng: fix.lng };
  const first = asked[0]!;
  const origin = haversineKm(first, at) * 1000 <= TRUST_METERS ? first : at;

  const stored = storedLeg(trip, target);
  const onLine = stored !== null ? cut(stored, origin) : null;
  if (onLine !== null && onLine.offMeters <= OFF_ROUTE_METERS) return strip(onLine);
  const fallback = async () => (onLine !== null ? strip(onLine) : straight([origin, ...asked.slice(1)]));

  const key = RoadLineCache.key(trip.trip_id, target, origin);
  const hit = cache.get(key, now.getTime());
  if (hit !== undefined) return { ...hit, source: "stored" };

  if (traffic === undefined) return fallback();
  const settings = await liveTrafficSettings(db, trip.zone_id);
  if (!settings.roadLines.on) return fallback();
  const cap = settings.roadLines.maxCallsPerTrip;
  if ((trip.google_route_calls ?? 0) >= cap || tooSoon(trip.eta_route, target, now)) return fallback();
  const ask: GoogleCallBudget = { kind: "road_line", stage: target === "pickup" && asRoute(trip.eta_route)?.target !== "pickup" ? "pickup" : "reroute" };
  const country = await zoneCountry(db, trip.zone_id);
  if (country !== undefined) ask.country = country;
  if (!(await googleBudgetOpen(db, ask, now))) return fallback();

  // The leg's target, through the stops still ahead (as the ETA tick asks).
  const to = (target === "pickup" ? trip.pickup : trip.dropoff) as LatLng;
  const stops = (Array.isArray(trip.stops) ? (trip.stops as LatLng[]) : []).map((p) => ({ lat: p.lat, lng: p.lng }));
  const next = target === "dropoff" ? nextStopIndex(stops.length, visitsOf({ stop_visits: trip.stop_visits })) : null;
  const via = next === null ? [] : stops.slice(next);
  const leg = await traffic.route([origin, ...via, { lat: to.lat, lng: to.lng }], { budget: ask });
  if (leg.source !== "google" || !leg.polyline) return fallback();
  const previous = asRoute(trip.eta_route);
  const route: EtaRoute = { target, polyline: leg.polyline, meters: leg.distanceMeters, seconds: leg.durationSeconds, at: now.toISOString(), offSince: null, calls: (previous?.calls ?? 0) + 1 };
  // ONE update: the route and the trip counter, only if the trip still holds what this was worked out from.
  await storeCountedRoute(db, trip, route, cap);
  const points = leg.points && leg.points.length >= 2 ? leg.points : decodePolyline(leg.polyline);
  const line: RoadLine = { source: "google", points, distanceMeters: leg.distanceMeters, durationSeconds: leg.durationSeconds };
  cache.put(key, line, now.getTime());
  return line;
}

const strip = (line: RoadLine & { offMeters?: number }): RoadLine => ({ source: line.source, points: line.points, distanceMeters: line.distanceMeters, durationSeconds: line.durationSeconds });
