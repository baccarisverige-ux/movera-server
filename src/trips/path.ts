import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { haversineKm, type LatLng, type Router } from "../maps/routing.js";
import { TERMINAL, type TripStatus } from "../rules/transitions.js";
import { readOwnTrip } from "./commands.js";

/**
 * The route of an ended trip (contract v0.17.0 §25, `contract.json#tripPath`) for the trip's own rider or driver.
 * `driven` is read from the trip's GPS trace (trip_locations, the fixes of POST /driver/location during the trip),
 * so it needs no new storage and goes when the trace goes (30 days, maintenance sweep). Without a usable trace the
 * answer is `planned`: the server's road route from the pickup through the stops to the drop-off.
 */

type TripPathRules = { maxPoints: number };
const RULES = (contract as unknown as { tripPath: TripPathRules }).tripPath;
const TRACE_KEEP_MS = (contract as unknown as { liveDrivers: { traceKeepDays: number } }).liveDrivers.traceKeepDays * 24 * 3600_000;
/** The same filters as the driven distance (trips/ride.ts): a usable fix, parked jitter, a wild fix. */
const MAX_ACCURACY_M = 50;
const MIN_STEP_KM = 0.025;
const MAX_KMH = 150;

const point = (p: unknown): LatLng => ({ lat: Number((p as LatLng).lat), lng: Number((p as LatLng).lng) });

type Fix = LatLng & { measured_at: Date };

/** Drops jitter and wild fixes, keeping the first fix and the last one. */
export function cleanTrace(fixes: readonly Fix[]): Fix[] {
  if (fixes.length === 0) return [];
  const kept: Fix[] = [fixes[0]!];
  for (const next of fixes.slice(1)) {
    const from = kept[kept.length - 1]!;
    const step = haversineKm(from, next);
    if (step < MIN_STEP_KM) continue;
    const hours = Math.max(1, next.measured_at.getTime() - from.measured_at.getTime()) / 3_600_000;
    if (step / hours > MAX_KMH) continue;
    kept.push(next);
  }
  return kept;
}

/** At most `max` points, evenly spread, the first and the last always kept. */
export function thin<T>(points: readonly T[], max: number = RULES.maxPoints): T[] {
  if (points.length <= max) return [...points];
  const out: T[] = [];
  const stride = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * stride)]!);
  return out;
}

export async function tripPath(ex: Executor, router: Router, tripId: string, who: { actor: "rider" | "driver"; subjectId: string }) {
  const trip = await readOwnTrip(ex, tripId, who);
  if (!TERMINAL.has(trip.status as TripStatus)) throw new ApiError("invalid_transition", "The trip has not ended yet.", { reason: "trip_not_ended" });
  const pickup = point(trip.pickup);
  const dropoff = point(trip.dropoff);
  const stops = ((trip.stops as unknown[]) ?? []).map(point);
  const base = { tripId, pickup, dropoff, stops };
  const since = trip.boarded_at ?? trip.started_at;
  if (since !== null) {
    let query = ex
      .selectFrom("trip_locations")
      .select(["lat", "lng", "measured_at"])
      .where("trip_id", "=", tripId)
      .where("measured_at", ">=", since)
      .where("accuracy", "<=", MAX_ACCURACY_M)
      .orderBy("measured_at");
    if (trip.ended_at !== null) query = query.where("measured_at", "<=", trip.ended_at);
    const driven = cleanTrace(await query.execute());
    if (driven.length >= 2) {
      const last = driven[driven.length - 1]!;
      return {
        ...base,
        source: "driven" as const,
        points: thin(driven).map((f) => ({ lat: f.lat, lng: f.lng })),
        keptUntil: new Date(last.measured_at.getTime() + TRACE_KEEP_MS).toISOString(),
      };
    }
  }
  const waypoints = [pickup, ...stops, dropoff];
  const leg = await router.route(waypoints);
  const line = leg.points !== undefined && leg.points.length >= 2 ? leg.points : waypoints;
  return { ...base, source: "planned" as const, points: thin(line.map(point)) };
}
