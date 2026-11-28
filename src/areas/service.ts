import { sql } from "kysely";
import type { Executor } from "../db/db.js";
import type { AreaBbox, AreaKind, AreaPolygons } from "../db/schema/areas.js";
import { contract } from "../contract/contract.js";
import { ApiError } from "../http/errors.js";
import { areaContains, searchKey } from "./geometry.js";

/** v0.18.172 driver preferred areas (contract.json#preferredAreas). Areas change the ORDER of booked rides, never who sees one. */

type PA = { searchLimit: number; areaRank: Record<AreaKind, number> };
export const PREFERRED = (contract as unknown as { preferredAreas: PA }).preferredAreas;

const KIND_LABEL: Record<"sv" | "fr" | "en", Record<AreaKind, string>> = {
  sv: { kommun: "Kommun", stadsdelsomrade: "Område", city: "Stad", arrondissement: "Arrondissement", commune: "Commune", departement: "Département" },
  fr: { kommun: "Kommun", stadsdelsomrade: "District", city: "Ville", arrondissement: "Arrondissement", commune: "Commune", departement: "Département" },
  en: { kommun: "Municipality", stadsdelsomrade: "District", city: "City", arrondissement: "Arrondissement", commune: "Commune", departement: "Département" },
};
const langOf = (language: string | null | undefined): "sv" | "fr" | "en" => (language === "sv" || language === "fr" ? language : "en");

type AreaRow = { area_id: string; name: string; name_override: string | null; kind: AreaKind; zone_id: string; country: string; parent_name: string | null };
const AREA_COLUMNS = ["area_id", "name", "name_override", "kind", "zone_id", "country", "parent_name"] as const;

/** contract Area: never the polygon. */
export function areaView(row: AreaRow, language: string | null | undefined) {
  return {
    areaId: row.area_id,
    name: row.name_override ?? row.name,
    kind: row.kind,
    kindLabel: KIND_LABEL[langOf(language)][row.kind],
    zoneId: row.zone_id,
    country: row.country,
    ...(row.parent_name ? { parentName: row.parent_name } : {}),
  };
}

/** GET /driver/areas/search: active areas of his zones; name starting with q first, then containing it; areas only. */
export async function searchAreas(ex: Executor, zoneIds: string[], q: string, limit: number, language: string | null) {
  if (zoneIds.length === 0) return { items: [] };
  const key = searchKey(q);
  let query = ex.selectFrom("areas").select(AREA_COLUMNS).where("zone_id", "in", zoneIds).where("active", "=", true);
  if (key) {
    // The key holds letters, digits and single spaces only, so it is safe inside LIKE.
    query = query.where((eb) => eb.or([eb("search_key", "like", `%${key}%`), eb(sql<string>`lower(coalesce(name_override, ''))`, "like", `%${q.toLowerCase().replace(/[%_\\]/g, "")}%`)]));
    query = query.orderBy(sql`CASE WHEN search_key LIKE ${key + "%"} OR search_key LIKE ${"% " + key + "%"} THEN 0 ELSE 1 END`);
  }
  const rows = await query.orderBy(sql`coalesce(name_override, name)`).orderBy("area_id").limit(limit).execute();
  return { items: rows.map((r) => areaView(r, language)) };
}

type Geo = { area_id: string; updated_at: Date; bbox: AreaBbox; polygons: AreaPolygons };
// Areas change only by the seed or an admin; the cache is keyed by updated_at, so a change is never served stale.
const geoCache = new Map<string, Geo>();

async function geometryOf(ex: Executor, heads: { area_id: string; updated_at: Date; bbox: AreaBbox }[]): Promise<Geo[]> {
  const missing = heads.filter((h) => geoCache.get(h.area_id)?.updated_at.getTime() !== h.updated_at.getTime()).map((h) => h.area_id);
  if (missing.length > 0) {
    const rows = await ex.selectFrom("areas").select(["area_id", "updated_at", "bbox", "polygons"]).where("area_id", "in", missing).execute();
    for (const r of rows) geoCache.set(r.area_id, r);
  }
  return heads.map((h) => geoCache.get(h.area_id)).filter((g): g is Geo => g !== undefined);
}

const bboxSize = (b: AreaBbox) => (b.north - b.south) * (b.east - b.west);

/**
 * GET /driver/areas/at: the smallest active area of his zones that holds the point (lowest areaRank, then the smallest
 * bounding box), and every matching area, smallest first. The point is never stored and never logged.
 */
export async function areaAt(ex: Executor, zoneIds: string[], lat: number, lng: number, language: string | null) {
  if (zoneIds.length === 0) return { area: null, containing: [] };
  const heads = await ex.selectFrom("areas").select([...AREA_COLUMNS, "updated_at", "bbox"])
    .where("zone_id", "in", zoneIds).where("active", "=", true)
    .where(sql<boolean>`(bbox->>'south')::float8 <= ${lat} AND (bbox->>'north')::float8 >= ${lat} AND (bbox->>'west')::float8 <= ${lng} AND (bbox->>'east')::float8 >= ${lng}`)
    .execute();
  const geo = new Map((await geometryOf(ex, heads)).map((g) => [g.area_id, g]));
  const hits = heads.filter((h) => { const g = geo.get(h.area_id); return g !== undefined && areaContains(g, lat, lng); });
  hits.sort((a, b) => PREFERRED.areaRank[a.kind] - PREFERRED.areaRank[b.kind] || bboxSize(a.bbox) - bboxSize(b.bbox) || a.area_id.localeCompare(b.area_id));
  const containing = hits.map((h) => areaView(h, language));
  return { area: containing[0] ?? null, containing };
}

/** PUT /driver/preferred-areas: dedupe (order kept), each id active in his zones, at most max. */
export async function checkPreferredIds(ex: Executor, zoneIds: string[], ids: string[], max: number): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length > max) throw new ApiError("invalid_request", `You can choose at most ${max} areas.`, { reason: "too_many_areas", details: [`max:${max}`] });
  if (unique.length === 0) return [];
  const found = zoneIds.length === 0 ? [] : await ex.selectFrom("areas").select("area_id").where("area_id", "in", unique).where("zone_id", "in", zoneIds).where("active", "=", true).execute();
  const ok = new Set(found.map((r) => r.area_id));
  const bad = unique.filter((id) => !ok.has(id));
  if (bad.length > 0) throw new ApiError("invalid_request", "One of these areas does not exist in your zones.", { reason: "area_not_found", details: bad.map((id) => `areaId:${id}`) });
  return unique;
}

/** Driver.preferredAreas: his saved ids that are still areas (an inactive one keeps its id but is still named). */
export async function preferredAreasView(ex: Executor, ids: string[], language: string | null) {
  if (ids.length === 0) return [];
  const rows = await ex.selectFrom("areas").select(AREA_COLUMNS).where("area_id", "in", ids).execute();
  const byId = new Map(rows.map((r) => [r.area_id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is AreaRow => r !== undefined).map((r) => areaView(r, language));
}

/** For the reservation list order: a function telling whether a pickup lies in one of his ACTIVE preferred areas. */
export async function preferredMatcher(ex: Executor, ids: string[]): Promise<(point: { lat: number; lng: number } | null | undefined) => boolean> {
  if (ids.length === 0) return () => false;
  const heads = await ex.selectFrom("areas").select(["area_id", "updated_at", "bbox"]).where("area_id", "in", ids).where("active", "=", true).execute();
  const geo = await geometryOf(ex, heads);
  return (point) => !!point && typeof point.lat === "number" && typeof point.lng === "number" && geo.some((g) => areaContains(g, point.lat, point.lng));
}
