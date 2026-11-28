import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import type { Db } from "../db/db.js";
import type { AreaKind, AreaPolygons } from "../db/schema/areas.js";
import { bboxOf } from "./geometry.js";

/**
 * v0.18.172 (contract.json#preferredAreas.seed; plan §2.2): the area rows ship in the image (data/areas, Dockerfile) and
 * are upserted at boot right after migrate (main.ts, same MIGRATE_ON_START gate). One transaction under an advisory lock
 * (several copies may start at once); skipped when the manifest's hash is already in area_seed_runs. Upsert by area_id
 * of the data columns only: never active or name_override (the admin's). Rows are never deleted (Rule 21).
 * At boot only the manifest's sha256 of each file and the row count per country are checked (GM edit 3); the district
 * gap/overlap geometry check runs in tools/areas/build_areas.py and in CI (test/areas/stockholm_districts_geometry).
 * Any failure throws: the transaction rolls back and the server does not start.
 */

export const AREAS_DIR = new URL("../../data/areas/", import.meta.url);
const LOCK_KEY = 172_0141;

type Feature = {
  properties: { areaId: string; zoneId: string; country: string; kind: AreaKind; name: string; parentAreaId: string | null; parentName: string | null; searchKey: string; derived: boolean; source: string; licence: string; sourceYear: number };
  polygons: AreaPolygons;
};
type Manifest = { files: Record<string, string>; rows: Record<string, number> };
export type SeedResult = { skipped: boolean; rows: number; manifestSha: string };

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** Reads and checks the data set (checksums, counts, source + licence, no OSM). Throws on any problem. */
export function loadAreaData(dir: URL = AREAS_DIR): { manifestSha: string; features: Feature[] } {
  const manifestText = readFileSync(new URL("manifest.json", dir), "utf8");
  const manifest = JSON.parse(manifestText) as Manifest;
  const features: Feature[] = [];
  for (const [file, expected] of Object.entries(manifest.files)) {
    const body = readFileSync(new URL(file, dir));
    if (sha(body) !== expected) throw new Error(`areas seed: ${file} checksum does not match manifest.json`);
    features.push(...(JSON.parse(body.toString("utf8")) as { features: Feature[] }).features);
  }
  const counts: Record<string, number> = {};
  for (const f of features) {
    const p = f.properties;
    if (!p.source || !p.licence) throw new Error(`areas seed: ${p.areaId} has no source or licence`);
    if (/\bosm\b|openstreetmap/i.test(`${p.source} ${p.licence}`)) throw new Error(`areas seed: ${p.areaId} has an OSM source (owner 2026-11-25: no OSM)`);
    counts[p.country] = (counts[p.country] ?? 0) + 1;
  }
  for (const country of new Set([...Object.keys(counts), ...Object.keys(manifest.rows)])) {
    if (counts[country] !== manifest.rows[country]) throw new Error(`areas seed: ${country} has ${counts[country] ?? 0} rows, manifest.json says ${manifest.rows[country] ?? 0}`);
  }
  return { manifestSha: sha(manifestText), features };
}

export async function seedAreas(db: Db, dir: URL = AREAS_DIR): Promise<SeedResult> {
  const { manifestSha, features } = loadAreaData(dir);
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`.execute(trx);
    const done = await trx.selectFrom("area_seed_runs").select("manifest_sha").where("manifest_sha", "=", manifestSha).executeTakeFirst();
    if (done) return { skipped: true, rows: features.length, manifestSha };
    const now = new Date();
    for (let k = 0; k < features.length; k += 100) {
      const rows = features.slice(k, k + 100).map(({ properties: p, polygons }) => ({
        area_id: p.areaId, zone_id: p.zoneId, country: p.country, kind: p.kind, parent_area_id: p.parentAreaId, name: p.name, parent_name: p.parentName,
        search_key: p.searchKey, polygons: JSON.stringify(polygons), bbox: JSON.stringify(bboxOf(polygons)), derived: p.derived, source: p.source,
        licence: p.licence, source_year: p.sourceYear, updated_at: now,
      }));
      await trx.insertInto("areas").values(rows).onConflict((oc) => oc.column("area_id").doUpdateSet((eb) => ({
        zone_id: eb.ref("excluded.zone_id"), country: eb.ref("excluded.country"), kind: eb.ref("excluded.kind"), parent_area_id: eb.ref("excluded.parent_area_id"),
        name: eb.ref("excluded.name"), parent_name: eb.ref("excluded.parent_name"), search_key: eb.ref("excluded.search_key"), polygons: eb.ref("excluded.polygons"),
        bbox: eb.ref("excluded.bbox"), derived: eb.ref("excluded.derived"), source: eb.ref("excluded.source"), licence: eb.ref("excluded.licence"),
        source_year: eb.ref("excluded.source_year"), updated_at: eb.ref("excluded.updated_at"),
      }))).execute();
    }
    await trx.insertInto("area_seed_runs").values({ manifest_sha: manifestSha, rows: features.length }).execute();
    return { skipped: false, rows: features.length, manifestSha };
  });
}
