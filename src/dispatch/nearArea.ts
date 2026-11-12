import { sql, type ExpressionBuilder } from "kysely";
import { GEOMETRY_TTL_MS } from "../config/geometryCache.js";
import type { Executor } from "../db/db.js";
import type { Database } from "../db/schema.js";
import { DISPATCH_FIX_MAX_AGE_SECONDS, STALE_AFTER_SECONDS } from "../drivers/service.js";
import type { Bounds } from "../zones/geometry.js";

/**
 * S4 B1.20 (owner yes, W1 Q81b; S01 A10): the admin's driver pickers (nearby drivers for an assign or a radar group,
 * the radar-zone send, its repeat and the "free now" count) read only the positions around the trip or the area, not
 * every online driver of every country. `driversNear` is the one entry: it reads the fresh positions around, then the
 * drivers there (by key when few, one plain join with the same conditions when many).
 */

/** A box that holds every point within `km` of `center` as dispatchKm measures it (road factor >= 1, to 0.1 km). */
export function boxAround(center: { lat: number; lng: number }, km: number): Bounds {
  const dLat = (km + 0.1) / 111.32;
  const south = Math.max(-90, center.lat - dLat);
  const north = Math.min(90, center.lat + dLat);
  // dispatchKm takes the cosine at the middle latitude; the box's widest point uses the smallest cosine in it.
  const cos = Math.cos((Math.max(Math.abs(south), Math.abs(north)) * Math.PI) / 180);
  const dLng = cos < 0.01 ? 360 : dLat / cos;
  return { south, north, west: center.lng - dLng, east: center.lng + dLng };
}

/**
 * How long a stored fix zone can lag behind a zone edit (PUT /admin/zones/{id} rewrites the zone's box): the fix is at
 * most STALE_AFTER_SECONDS old, it may have been placed with geometry up to GEOMETRY_TTL_MS old, and the zone save's
 * updated_at is taken before its commit (60 s margin). A zone edited within this window is always searched.
 */
export const ZONE_EDIT_LAG_MS = STALE_AFTER_SECONDS * 1000 + GEOMETRY_TTL_MS + 60_000;

/**
 * Up to this many drivers they are read one by one by key; above it one plain join (the planner's choice) is faster.
 * Measured 2026-11-12 (10,000 / 3,000 and 50,000 / 10,000 drivers / online, one city): by key wins up to about 1,000
 * ids and loses from about 2,000 (F2 of the supervisor's check). More than this many positions around the area is dense
 * at once (the positions read stops there).
 */
export const BY_KEY_MAX = 1000;

export type Near = { zoneId: string } | { box: Bounds };

/**
 * The condition for the fresh positions (received in the last 120 s, measured in the last DISPATCH_FIX_MAX_AGE_SECONDS)
 * of one zone or inside a box, on the driver_locations_zone index. For a box the fix's zone must be one whose box meets it, one
 * edited in the last ZONE_EDIT_LAG_MS (its fixes may still carry it under the old box), or none (a fix outside every
 * zone's outline, as zoneAt stores it). zoneAt only gives a zone whose box held the point when the fix came, so this
 * keeps every position inside the box: the same drivers as reading them all.
 */
function nearCondition(ex: Executor, where: Near, now: Date) {
  const freshAfter = new Date(now.getTime() - STALE_AFTER_SECONDS * 1000);
  const measuredAfter = new Date(now.getTime() - DISPATCH_FIX_MAX_AGE_SECONDS * 1000);
  if ("zoneId" in where) {
    const zoneId = where.zoneId;
    return (eb: ExpressionBuilder<Database, "driver_locations">) => eb.and([eb("driver_locations.zone_id", "=", zoneId), eb("driver_locations.received_at", ">", freshAfter), eb("driver_locations.measured_at", ">", measuredAfter)]);
  }
  const box = where.box;
  // One statement: the zones list is an InitPlan, evaluated once, then the index reads only these zones.
  const zones = ex
    .selectFrom("zones")
    .select("zones.zone_id")
    .where((eb) => eb.or([
      eb.and([eb("zones.south", "<=", box.north), eb("zones.north", ">=", box.south), eb("zones.west", "<=", box.east), eb("zones.east", ">=", box.west)]),
      eb("zones.updated_at", ">", new Date(now.getTime() - ZONE_EDIT_LAG_MS)),
    ]));
  // Each arm carries the freshness so the index reads only fresh entries (positions of drivers long offline stay).
  return (eb: ExpressionBuilder<Database, "driver_locations">) => eb.and([
    eb.or([
      eb.and([eb(sql.ref("driver_locations.zone_id"), "=", sql<string>`ANY(ARRAY(${zones}))`), eb("driver_locations.received_at", ">", freshAfter)]),
      eb.and([eb("driver_locations.zone_id", "is", null), eb("driver_locations.received_at", ">", freshAfter)]),
    ]),
    eb("driver_locations.measured_at", ">", measuredAfter),
    eb("driver_locations.lat", ">=", box.south), eb("driver_locations.lat", "<=", box.north),
    eb("driver_locations.lng", ">=", box.west), eb("driver_locations.lng", "<=", box.east),
  ]);
}

/**
 * `selectFrom("drivers")` joined with "driver_locations" for the drivers whose fresh position is `where` (and passes
 * `keep`, e.g. inside the polygon), or null when there are none. Few (at most BY_KEY_MAX): each read by its primary
 * key (a fenced LATERAL per id: OFFSET 0 keeps the planner from turning the list into a scan of every driver ever
 * signed up). Many: one plain join with the same position conditions (no id list), the planner's choice, which is never
 * more than the whole join of before; the caller's own filter in Node (polygon, radius, zone) then decides as before.
 * Either way the rows carry the drivers and driver_locations columns under those names.
 */
export async function driversNear(ex: Executor, where: Near, now: Date, keep: (p: { lat: number; lng: number }) => boolean = () => true) {
  const condition = nearCondition(ex, where, now);
  const found = await ex.selectFrom("driver_locations").select(["driver_locations.driver_id", "driver_locations.lat", "driver_locations.lng"]).where(condition).limit(BY_KEY_MAX + 1).execute();
  // More than BY_KEY_MAX positions around: dense, the plain join at once (the positions read stops there).
  const ids = found.length > BY_KEY_MAX ? null : found.filter(keep).map((p) => p.driver_id);
  if (ids !== null && ids.length === 0) return null;
  if (ids === null || ids.length > BY_KEY_MAX) {
    return ex.selectFrom("drivers").innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id").where(condition);
  }
  return ex
    .selectFrom(sql<{ wanted: string }>`unnest(${sql.val(ids)}::text[])`.as("wanted"))
    .innerJoinLateral((eb) => eb.selectFrom("drivers").selectAll().where("drivers.driver_id", "=", sql.ref<string>("wanted.wanted")).offset(0).as("drivers"), (join) => join.onTrue())
    .innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id");
}
