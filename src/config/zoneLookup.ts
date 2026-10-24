import type { Executor } from "../db/db.js";
import type { LatLng } from "../maps/routing.js";

/** The zone a point is in: an airport first (it sits inside a city zone), then the smallest city zone. */
export async function zoneAt(ex: Executor, point: LatLng): Promise<{ zoneId: string; open: boolean } | null> {
  const rows = await ex
    .selectFrom("zones")
    .select(["zone_id", "open", "kind", "south", "west", "north", "east"])
    .where("south", "<=", point.lat)
    .where("north", ">=", point.lat)
    .where("west", "<=", point.lng)
    .where("east", ">=", point.lng)
    .execute();
  if (rows.length === 0) return null;
  rows.sort((a, b) => (a.kind === "airport" ? 0 : 1) - (b.kind === "airport" ? 0 : 1) || (a.north - a.south) * (a.east - a.west) - (b.north - b.south) * (b.east - b.west));
  return { zoneId: rows[0]!.zone_id, open: rows[0]!.open };
}
