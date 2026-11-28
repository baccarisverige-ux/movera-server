import { inPolygon } from "../zones/geometry.js";
import type { AreaBbox, AreaPolygons } from "../db/schema/areas.js";

/** v0.18.172 (contract.json#preferredAreas.order): the bounding box over every polygon (outer rings). */
export function bboxOf(polygons: AreaPolygons): AreaBbox {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const polygon of polygons) {
    for (const [lat, lng] of polygon[0] ?? []) {
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
    }
  }
  return { south, west, north, east };
}

export const inBbox = (b: AreaBbox, lat: number, lng: number) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;

/**
 * Point in a MULTIPOLYGON: inside the outer ring of one polygon (inPolygon, zones/geometry.ts) and in none of that
 * polygon's holes. Islands are separate polygons (Värmdö, Lidingö); enclaves are holes.
 */
export function areaContains(area: { bbox: AreaBbox; polygons: AreaPolygons }, lat: number, lng: number): boolean {
  if (!inBbox(area.bbox, lat, lng)) return false;
  for (const [outer, ...holes] of area.polygons) {
    if (!outer || !inPolygon(lat, lng, outer)) continue;
    if (holes.some((hole) => inPolygon(lat, lng, hole))) continue;
    return true;
  }
  return false;
}

/** The same key as tools/areas/build_areas.py key(): lower case, accents removed, every other sign a space. */
export function searchKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
