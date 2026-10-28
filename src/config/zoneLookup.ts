import type { Executor } from "../db/db.js";
import type { LatLng } from "../maps/routing.js";
import { inPolygon, type Polygon } from "../zones/geometry.js";

/**
 * The zone a point is in (contract v0.11.0 §20, contract.json#zones.lookup): the rectangle (bounds) is the quick
 * prefilter, the outline (polygon) decides; then an open zone before a closed one (the closed district boxes of the
 * first test days sit inside the county-wide Z001, migration 0014), a city zone before an airport (v0.11.0: an open
 * airport such as CDG inside FR-PC only adds the airport fees, src/pricing/airport.ts; the ride stays the city's), the smallest.
 */
export async function zoneAt(ex: Executor, point: LatLng, options: { kind?: "airport" } = {}): Promise<{ zoneId: string; open: boolean } | null> {
  let query = ex
    .selectFrom("zones")
    .select(["zone_id", "open", "kind", "south", "west", "north", "east", "polygon"])
    .where("south", "<=", point.lat)
    .where("north", ">=", point.lat)
    .where("west", "<=", point.lng)
    .where("east", ">=", point.lng);
  if (options.kind) query = query.where("kind", "=", options.kind);
  const rows = (await query.execute()).filter((r) => inPolygon(point.lat, point.lng, r.polygon as Polygon));
  if (rows.length === 0) return null;
  rows.sort((a, b) => Number(b.open) - Number(a.open) || (a.kind === "airport" ? 1 : 0) - (b.kind === "airport" ? 1 : 0) || (a.north - a.south) * (a.east - a.west) - (b.north - b.south) * (b.east - b.west));
  return { zoneId: rows[0]!.zone_id, open: rows[0]!.open };
}
