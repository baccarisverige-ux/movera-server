import type { Executor } from "../../db/db.js";
import { haversineKm, legKey, type Router } from "../../maps/routing.js";
import { PAID_KM_RULES, traceGaps, type GapRoads, type TraceGap } from "./paidKm.js";
import { ONBOARD } from "./shared.js";

/**
 * Road snapping of GPS gaps (owner decision 2026-11-10): a tunnel or signal loss leaves kept fixes far apart, and the
 * straight line between them under-pays. After a location batch is stored (outside its transaction, no row locked),
 * the driver's on-board trip's gaps are routed once each and cached per trip; kmOnBoard (settings.ts) reads only this
 * cache, never the network. Only a real road answer (source "osrm") is kept: routing off or down = straight line, and
 * the trip never fails. At most MAX_ROUTED_GAPS router calls per trip, none for gaps under MIN_ROUTED_GAP_M.
 */
export const MAX_ROUTED_GAPS = 8;
/** A shorter gap is not worth a router call (the straight line is close to the road). */
export const MIN_ROUTED_GAP_M = 200;
const MAX_TRIPS = 5000;

/** trip id -> gap key -> road metres (null: asked, no road answer). */
const cache = new Map<string, Map<string, number | null>>();

const keyOf = (gap: TraceGap) => legKey([gap.from, gap.to]);

/** The cached road metres for a trip's gaps (for paidKm). */
export function gapRoadsOf(tripId: string): GapRoads {
  const roads = cache.get(tripId);
  return (gap) => roads?.get(keyOf(gap)) ?? undefined;
}

export function forgetGapRoads(tripId?: string): void {
  if (tripId === undefined) cache.clear();
  else cache.delete(tripId);
}

/** Route the not-yet-asked gaps of one trip's on-board trace (bounded); errors leave the straight line. */
export async function snapTripGaps(ex: Executor, router: Router, tripId: string, since: Date): Promise<void> {
  const fixes = await ex.selectFrom("trip_locations").select(["lat", "lng", "accuracy", "measured_at", "speed_mps"]).where("trip_id", "=", tripId).where("measured_at", ">=", since).where("accuracy", "<=", PAID_KM_RULES.maxAccuracyM).orderBy("measured_at").execute();
  let roads = cache.get(tripId);
  if (!roads) {
    if (cache.size >= MAX_TRIPS) cache.delete(cache.keys().next().value!);
    roads = new Map();
    cache.set(tripId, roads);
  }
  for (const gap of traceGaps(fixes)) {
    const key = keyOf(gap);
    if (roads.has(key) || haversineKm(gap.from, gap.to) * 1000 < MIN_ROUTED_GAP_M) continue;
    if (roads.size >= MAX_ROUTED_GAPS) break;
    roads.set(key, null);
    try {
      const leg = await router.route([gap.from, gap.to]);
      if (leg.source === "osrm" && Number.isFinite(leg.distanceMeters)) roads.set(key, leg.distanceMeters);
    } catch {
      // Routing down: the straight line stays.
    }
  }
}

/** After POST /driver/location: snap the gaps of the driver's on-board trip, if any. Never throws. */
export async function snapDriverGaps(ex: Executor, router: Router, driverId: string): Promise<void> {
  try {
    const trip = await ex.selectFrom("trips").select(["trip_id", "boarded_at"]).where("driver_id", "=", driverId).where("status", "in", ONBOARD).executeTakeFirst();
    if (trip?.boarded_at) await snapTripGaps(ex, router, trip.trip_id, trip.boarded_at);
  } catch {
    // Never fail the location batch over road snapping.
  }
}
