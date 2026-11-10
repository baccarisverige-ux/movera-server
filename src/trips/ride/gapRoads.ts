import { sql } from "kysely";
import type { Executor } from "../../db/db.js";
import { haversineKm, type Router } from "../../maps/routing.js";
import { PAID_KM_RULES, traceGaps, type GapRoads, type TraceGap } from "./paidKm.js";
import { ONBOARD } from "./shared.js";

/**
 * Road snapping of GPS gaps (owner decision 2026-11-10): a tunnel or signal loss leaves kept fixes far apart, and the
 * straight line between them under-pays. After a location batch is stored (outside its transaction, no row locked),
 * the driver's on-board trip's gaps are routed once each and stored in Postgres (trip_gap_roads, migration 0092), so
 * every server copy and every restart pays the same km; kmOnBoard (settings.ts) reads only that table, never the
 * network. Only a real road answer (source "osrm") is kept: routing off or down = straight line (road_m null), and
 * the trip never fails. At most MAX_ROUTED_GAPS rows (= router calls) per trip, none for gaps under MIN_ROUTED_GAP_M.
 */
export const MAX_ROUTED_GAPS = 8;
/** A shorter gap is not worth a router call (the straight line is close to the road). */
export const MIN_ROUTED_GAP_M = 200;

const keyOf = (fromAt: Date, toAt: Date) => `${fromAt.getTime()}|${toAt.getTime()}`;

/** The stored road metres of a trip's gaps (for paidKm). */
export async function gapRoadsOf(ex: Executor, tripId: string): Promise<GapRoads> {
  const rows = await ex.selectFrom("trip_gap_roads").select(["from_ts", "to_ts", "road_m"]).where("trip_id", "=", tripId).execute();
  const roads = new Map(rows.map((r) => [keyOf(new Date(r.from_ts), new Date(r.to_ts)), r.road_m]));
  return (gap: TraceGap) => roads.get(keyOf(gap.fromAt, gap.toAt)) ?? undefined;
}

/** Route the not-yet-asked gaps of one trip's on-board trace (bounded by the table); errors leave the straight line. */
export async function snapTripGaps(ex: Executor, router: Router, tripId: string, since: Date): Promise<void> {
  const fixes = await ex.selectFrom("trip_locations").select(["lat", "lng", "accuracy", "measured_at", "speed_mps"]).where("trip_id", "=", tripId).where("measured_at", ">=", since).where("accuracy", "<=", PAID_KM_RULES.maxAccuracyM).orderBy("measured_at").execute();
  const asked = await ex.selectFrom("trip_gap_roads").select(["from_ts", "to_ts"]).where("trip_id", "=", tripId).execute();
  const done = new Set(asked.map((r) => keyOf(new Date(r.from_ts), new Date(r.to_ts))));
  let count = done.size;
  for (const gap of traceGaps(fixes)) {
    if (count >= MAX_ROUTED_GAPS) break;
    const key = keyOf(gap.fromAt, gap.toAt);
    if (done.has(key) || haversineKm(gap.from, gap.to) * 1000 < MIN_ROUTED_GAP_M) continue;
    done.add(key);
    let roadM: number | null = null;
    try {
      const leg = await router.route([gap.from, gap.to]);
      if (leg.source === "osrm" && Number.isFinite(leg.distanceMeters)) roadM = Math.round(leg.distanceMeters);
    } catch {
      // Routing down: the straight line stays.
    }
    // Two copies may route the same gap at once: the first row stands. The cap is re-checked in the insert.
    const inserted = await ex
      .insertInto("trip_gap_roads")
      .columns(["trip_id", "from_ts", "to_ts", "road_m"])
      .expression(
        ex.selectNoFrom([sql.lit(tripId).as("trip_id"), sql<Date>`${gap.fromAt.toISOString()}::timestamptz`.as("from_ts"), sql<Date>`${gap.toAt.toISOString()}::timestamptz`.as("to_ts"), sql<number | null>`${roadM}::integer`.as("road_m")])
          .where(sql<boolean>`(SELECT count(*) FROM trip_gap_roads WHERE trip_id = ${tripId}) < ${MAX_ROUTED_GAPS}`),
      )
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0) count++;
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
