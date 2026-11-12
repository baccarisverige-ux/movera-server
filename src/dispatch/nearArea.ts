import { sql } from "kysely";
import type { Executor } from "../db/db.js";
import { DISPATCH_FIX_MAX_AGE_SECONDS, STALE_AFTER_SECONDS } from "../drivers/service.js";
import type { Bounds } from "../zones/geometry.js";

/**
 * S4 B1.20 (owner yes, W1 Q81b; S01 A10): the admin's driver pickers (nearby drivers for an assign or a radar group,
 * the radar-zone send, its repeat and the "free now" count) read only the positions around the trip or the area, not
 * every online driver of every country. The callers then read just these drivers by id (primary key).
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

type Fresh = { driver_id: string; lat: number; lng: number };

/**
 * The fresh positions (received in the last 120 s, measured in the last DISPATCH_FIX_MAX_AGE_SECONDS) of one zone or
 * inside a box, from the driver_locations_zone index. For a box the fix's zone must be one whose box meets it, or none
 * (a fix outside every zone's outline, as zoneAt stores it): zoneAt only gives a zone whose box holds the point, so
 * this keeps every position inside the box, the same drivers as reading them all.
 */
export async function freshPositions(ex: Executor, where: { zoneId: string } | { box: Bounds }, now: Date): Promise<Fresh[]> {
  const freshAfter = new Date(now.getTime() - STALE_AFTER_SECONDS * 1000);
  const q = ex
    .selectFrom("driver_locations")
    .select(["driver_id", "lat", "lng"])
    .where("measured_at", ">", new Date(now.getTime() - DISPATCH_FIX_MAX_AGE_SECONDS * 1000));
  if ("zoneId" in where) return q.where("zone_id", "=", where.zoneId).where("received_at", ">", freshAfter).execute();
  const box = where.box;
  const zones = (await ex.selectFrom("zones").select("zone_id").where("south", "<=", box.north).where("north", ">=", box.south).where("west", "<=", box.east).where("east", ">=", box.west).execute()).map((z) => z.zone_id);
  // Each arm carries the freshness so the index reads only fresh entries (positions of drivers long offline stay).
  return q
    .where((eb) => eb.or([
      eb.and([eb(sql.ref("zone_id"), "=", sql<string>`ANY(${sql.val(zones)}::text[])`), eb("received_at", ">", freshAfter)]),
      eb.and([eb("zone_id", "is", null), eb("received_at", ">", freshAfter)]),
    ]))
    .where("lat", ">=", box.south).where("lat", "<=", box.north).where("lng", ">=", box.west).where("lng", "<=", box.east)
    .execute();
}

/**
 * `selectFrom("drivers")` for these ids only, each read by its primary key (a fenced LATERAL per id: OFFSET 0 keeps the
 * planner from turning a long id list into a scan of every driver ever signed up). The rows are the drivers table's
 * columns, under the name "drivers", so a caller's joins and conditions stay as they were.
 */
export function driversById(ex: Executor, ids: string[]) {
  return ex
    .selectFrom(sql<{ wanted: string }>`unnest(${sql.val(ids)}::text[])`.as("wanted"))
    .innerJoinLateral((eb) => eb.selectFrom("drivers").selectAll().where("drivers.driver_id", "=", sql.ref<string>("wanted.wanted")).offset(0).as("drivers"), (join) => join.onTrue());
}
