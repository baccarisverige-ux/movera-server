import type { Executor } from "../db/db.js";

/**
 * Stress T-A part 3 (owner 2026-11-10, audits/stress-ta-2026-11-10/RESULT-3.md): every GPS update looked up its zone,
 * the driver's own zones and the airport queue areas in the database, inside the request's transaction. Zones and areas
 * are read-only geometry that changes only when an admin saves one, so they are kept in memory. Money and trip state
 * stay in Postgres (rule: the database is the one truth for anything that is paid or dispatched).
 *
 * Off until `cacheGeometry` turns it on (main.ts, with the realtime hub), as the live-document cache is: then the copy
 * lives at most `ttlMs`, every config_published notification (any instance; zone saves send doc "zones") drops it, and
 * a zone or area save on this instance drops it at once (before its commit and again after it).
 */
export type ZoneGeometry = { zone_id: string; open: boolean; kind: string; south: number; west: number; north: number; east: number; polygon: unknown; name: string; names: unknown };
export type AreaGeometry = Record<string, unknown> & { area_id: string; is_on: boolean; south: number; west: number; north: number; east: number; polygon: unknown };
export type Geometry = { zones: ZoneGeometry[]; byId: Map<string, ZoneGeometry>; areas: AreaGeometry[] };

const cache = { ttlMs: 0, generation: 0, value: null as Geometry | null, until: 0, loading: null as Promise<Geometry> | null };

export function cacheGeometry(ttlMs: number): void {
  cache.ttlMs = Math.max(0, ttlMs);
  forgetGeometry();
}

export function forgetGeometry(): void {
  cache.generation += 1;
  cache.value = null;
  cache.loading = null;
}

export const geometryCached = (): boolean => cache.ttlMs > 0;

async function load(ex: Executor): Promise<Geometry> {
  const zones = (await ex.selectFrom("zones").select(["zone_id", "open", "kind", "south", "west", "north", "east", "polygon", "name", "names"]).execute()) as ZoneGeometry[];
  const areas = (await ex.selectFrom("airport_queue_areas").selectAll().execute()) as unknown as AreaGeometry[];
  return { zones, byId: new Map(zones.map((z) => [z.zone_id, z])), areas };
}

/** The cached geometry, or null when the cache is off (callers then read the tables as before). */
export async function geometry(ex: Executor): Promise<Geometry | null> {
  if (cache.ttlMs <= 0) return null;
  const now = Date.now();
  if (cache.value !== null && cache.until > now) return cache.value;
  if (cache.loading === null) {
    const generation = cache.generation;
    const loading = load(ex).then(
      (value) => {
        // A save that happened while this read ran must not be hidden by the older value it read.
        if (generation === cache.generation) {
          cache.value = value;
          cache.until = Date.now() + cache.ttlMs;
        }
        if (cache.loading === loading) cache.loading = null;
        return value;
      },
      (error: unknown) => {
        if (cache.loading === loading) cache.loading = null;
        throw error;
      },
    );
    cache.loading = loading;
  }
  return cache.loading;
}
