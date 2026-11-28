/** v0.18.172 (contract.json#preferredAreas, migrations/0141_driver_preferred_areas.sql): the areas a driver may prefer. */
import type { ColumnType, Generated } from "kysely";

export type AreaKind = "kommun" | "stadsdelsomrade" | "city" | "arrondissement" | "commune" | "departement";
/** [polygon = [outer ring, hole, ...], ...]; ring = [[lat, lng], ...], not closed (src/zones/geometry.ts format). */
export type AreaPolygons = Array<Array<Array<[number, number]>>>;
export type AreaBbox = { south: number; west: number; north: number; east: number };

export interface AreasTable {
  area_id: string;
  zone_id: string;
  country: string;
  kind: AreaKind;
  parent_area_id: string | null;
  name: string;
  name_override: ColumnType<string | null, string | null | undefined, string | null>;
  parent_name: string | null;
  search_key: string;
  polygons: ColumnType<AreaPolygons, string, string>;
  bbox: ColumnType<AreaBbox, string, string>;
  derived: Generated<boolean>;
  source: string;
  licence: string;
  source_year: number;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AreaSeedRunsTable {
  manifest_sha: string;
  rows: number;
  seeded_at: Generated<Date>;
}
