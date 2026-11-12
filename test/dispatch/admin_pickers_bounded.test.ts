import { Kysely, PostgresDialect, type CompiledQuery } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nearbyDrivers } from "../../src/admin/trips.js";
import type { Principal } from "../../src/auth/guard.js";
import type { Database } from "../../src/db/schema.js";
import { dispatchKm } from "../../src/dispatch/engine.js";
import { boxAround } from "../../src/dispatch/nearArea.js";
import { freeDriversFor, radarZoneFree } from "../../src/dispatch/tools.js";
import { boundsOf, inPolygon, type Bounds, type Polygon } from "../../src/zones/geometry.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * S4 B1.20 (owner yes, W1 Q81b; S01 A10): the admin's driver pickers (nearby drivers for an assign or a radar group, the
 * send to a radar zone, its repeat and the "free now" count) read only the drivers around the trip or the radar zone,
 * not every online driver of every country. Online drivers in Stockholm, Paris and Tunis, 50,000 offline drivers' old
 * positions; a Tunis trip and a radar zone in Tunis. The lists stay the same (A check): only Tunis drivers, nearest to
 * the pickup first, a driver with no zone on his fix included. Before this change every online driver in all three
 * countries was read and came back from the database, and the area or radius was applied in Node (fails on main on the
 * rows read; the lists already matched).
 */

const NOW = new Date("2026-11-12T10:00:00Z");
// Rule 33: a realistic busy hour, 3,000 online drivers in each of the three countries.
const PER_COUNTRY = 3000;
const OFFLINE = 50_000;
// Each country's drivers on a 60 x 50 grid over its city centre; zone_id as the fix write stores it (zoneAt).
const CITIES = [
  { key: "se", zone: "Z001", lat: 59.3, lng: 18.0, dLat: 0.06, dLng: 0.1 },
  { key: "fr", zone: "FR-PC", lat: 48.83, lng: 2.3, dLat: 0.05, dLng: 0.1 },
  { key: "tn", zone: "TN-TC", lat: 36.7, lng: 10.05, dLat: 0.2, dLng: 0.25 },
] as const;
// A small area in central Tunis.
const AREA: Polygon = [[36.79, 10.15], [36.82, 10.15], [36.82, 10.19], [36.79, 10.19]];
const PICKUP = { lat: 36.8, lng: 10.17 };
const ADMIN: Principal = { actor: "admin", subjectId: "adm_b120", sessionId: "s_b120", zones: ["*"] };

let database: TestDatabase;
let traced: Kysely<Database>;
let captured: CompiledQuery[] = [];
const positions: Array<{ id: string; lat: number; lng: number; zone: string | null }> = [];

beforeAll(async () => {
  database = await freshDatabase();
  traced = new Kysely<Database>({ dialect: new PostgresDialect({ pool: database.pool }), log: (event) => void captured.push(event.query) });
  // Rows straight in with generate_series (foreign keys and triggers off) so the plan is the one production gets.
  const client = await database.pool.connect();
  try {
    await client.query("SET session_replication_role = replica");
    for (const [c, city] of CITIES.entries()) {
      await client.query(`INSERT INTO drivers (driver_id, phone, account_status, online_status, category_ids, zone_ids)
        SELECT 'drv_${city.key}_' || g, '+${c + 1}0' || lpad(g::text, 8, '0'), 'active', 'online', '{economy}', '{${city.zone}}' FROM generate_series(0, ${PER_COUNTRY - 1}) g`);
      await client.query(`INSERT INTO driver_locations (driver_id, lat, lng, accuracy, measured_at, received_at, zone_id)
        SELECT 'drv_${city.key}_' || g, ${city.lat} + (g % 60) / 60.0 * ${city.dLat}, ${city.lng} + (g / 60) / 50.0 * ${city.dLng}, 5, $1, $1, '${city.zone}' FROM generate_series(0, ${PER_COUNTRY - 1}) g`, [NOW]);
    }
    // Inside the area but outside every zone's outline (zoneAt gave no zone): still in the list, as before.
    await client.query(`INSERT INTO drivers (driver_id, phone, account_status, online_status, category_ids) VALUES ('drv_tn_nozone', '+90000000001', 'active', 'online', '{economy}')`);
    await client.query(`INSERT INTO driver_locations (driver_id, lat, lng, accuracy, measured_at, received_at, zone_id) VALUES ('drv_tn_nozone', 36.805, 10.165, 5, $1, $1, NULL)`, [NOW]);
    // Every driver ever signed up has his last position in driver_locations (one row per driver): 50,000 offline.
    await client.query(`INSERT INTO drivers (driver_id, phone, account_status, online_status, category_ids, zone_ids)
      SELECT 'drv_tn_old_' || g, '+80' || lpad(g::text, 9, '0'), 'active', 'offline', '{economy}', '{TN-TC}' FROM generate_series(0, ${OFFLINE - 1}) g`);
    await client.query(`INSERT INTO driver_locations (driver_id, lat, lng, accuracy, measured_at, received_at, zone_id)
      SELECT 'drv_tn_old_' || g, 36.8, 10.17, 5, $1, $1, 'TN-TC' FROM generate_series(0, ${OFFLINE - 1}) g`, [new Date(NOW.getTime() - 7 * 86_400_000)]);
    await client.query("SET session_replication_role = origin");
  } finally {
    client.release();
  }
  const online = await database.db.selectFrom("driver_locations").innerJoin("drivers", "drivers.driver_id", "driver_locations.driver_id").select(["drivers.driver_id as id", "lat", "lng", "zone_id as zone"]).where("online_status", "=", "online").execute();
  positions.push(...online);
  await database.db.insertInto("radar_zones").values({ radar_zone_id: "rzn_b120", country: "TN", zone_id: "TN-TC", name: "Tunis centre", polygon: JSON.stringify(AREA), version: 1, created_at: NOW, updated_at: NOW } as never).execute();
  await database.pool.query("ANALYZE drivers; ANALYZE driver_locations");
});
afterAll(async () => {
  await database.drop();
});

/** Rows the database reads from drivers and driver_locations for one statement (EXPLAIN ANALYZE of the real SQL). */
async function rowsRead(query: CompiledQuery): Promise<number> {
  type Node = { "Relation Name"?: string; "Actual Rows"?: number; "Actual Loops"?: number; "Rows Removed by Filter"?: number; "Rows Removed by Index Recheck"?: number; "Node Type": string; Plans?: Node[] };
  const plan = (await database.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`, query.parameters as unknown[])).rows[0]["QUERY PLAN"][0].Plan as Node;
  let read = 0;
  const walk = (n: Node) => {
    const scansTable = n["Relation Name"] === "drivers" || n["Relation Name"] === "driver_locations";
    if (scansTable || (n["Node Type"].includes("Index") && n["Node Type"] !== "Bitmap Heap Scan")) {
      // Index-only or bitmap index nodes have no Relation Name; count their entries too.
      if (scansTable || n["Node Type"] === "Bitmap Index Scan") read += ((n["Actual Rows"] ?? 0) + (n["Rows Removed by Filter"] ?? 0) + (n["Rows Removed by Index Recheck"] ?? 0)) * (n["Actual Loops"] ?? 1);
    }
    n.Plans?.forEach(walk);
  };
  walk(plan);
  return read;
}

/** Every statement the picker sent that reads drivers or positions, summed. */
async function pickerRowsRead(): Promise<number> {
  const reads = captured.filter((c) => /from "(drivers|driver_locations)"/.test(c.sql));
  if (reads.length === 0) throw new Error(`no drivers query in ${captured.map((c) => c.sql).join("\n")}`);
  let total = 0;
  for (const q of reads) total += await rowsRead(q);
  return total;
}

/**
 * The most a bounded picker may read: the fresh positions of the zones around the box (Tunis only here: 3,001 index
 * entries and 3,001 rows) and then, for each driver in the box, his driver row and his position by key.
 */
const bound = (box: Bounds) => 2 * (PER_COUNTRY + 1) + 2 * positions.filter((p) => p.lat >= box.south && p.lat <= box.north && p.lng >= box.west && p.lng <= box.east).length;

describe("B1.20: the admin's radar-zone pickers read only the drivers around the area", () => {
  it("send to a radar zone (and its repeat): only the Tunis drivers inside, nearest first; the database reads the area's drivers, not 9,000", async () => {
    captured = [];
    const ids = await freeDriversFor(traced, { trip_id: "trp_b120", pickup: PICKUP, category_id: "economy" }, { polygon: AREA, limit: 1000, now: NOW });
    const expected = positions.filter((p) => inPolygon(p.lat, p.lng, AREA))
      .map((p) => ({ id: p.id, km: dispatchKm(p, PICKUP) }))
      .sort((a, b) => a.km - b.km || (a.id < b.id ? -1 : 1))
      .map((p) => p.id);
    expect(expected.length).toBeGreaterThan(10);
    expect(expected).toContain("drv_tn_nozone");
    expect(ids).toEqual(expected);
    expect(ids.every((id) => id.startsWith("drv_tn_"))).toBe(true);
    const read = await pickerRowsRead();
    // Before: every online driver of SE, FR and TN was read (the drivers_online list, the drivers and their positions:
    // 36,004 rows) and all 9,001 came back to Node. Now the positions of the zones near the area and then the drivers
    // inside by key (6,184 rows, 91 back to Node).
    expect(read).toBeLessThanOrEqual(bound(boundsOf(AREA)));
  });

  it("free-now count of a radar zone: the same count, from the area's drivers only", async () => {
    captured = [];
    const free = await radarZoneFree(traced, ADMIN, "rzn_b120", "economy", NOW);
    expect(free).toMatchObject({ radarZoneId: "rzn_b120", free: positions.filter((p) => inPolygon(p.lat, p.lng, AREA)).length });
    expect(await pickerRowsRead()).toBeLessThanOrEqual(bound(boundsOf(AREA)));
  });

  it("nearby drivers of a Tunis trip (assign / radar group picker): radius and zone give the same drivers, read from Tunis only", async () => {
    const trip = { trip_id: "trp_b120", zone_id: "TN-TC", pickup: PICKUP } as never;
    const byKm = (keep: (p: (typeof positions)[number], km: number) => boolean) => positions
      .map((p) => ({ p, km: dispatchKm(p, PICKUP) }))
      .filter(({ p, km }) => keep(p, km))
      .sort((a, b) => a.km - b.km || (a.p.id < b.p.id ? -1 : 1))
      .slice(0, 100)
      .map(({ p }) => p.id);
    for (const radiusKm of [5, 10]) {
      captured = [];
      const near = await nearbyDrivers(traced, trip, { scope: "radius", radiusKm }, NOW);
      expect(near.items.map((d) => d.driverId)).toEqual(byKm((_, km) => km <= radiusKm));
      expect(near.items.every((d) => d.driverId.startsWith("drv_tn_"))).toBe(true);
      expect(await pickerRowsRead()).toBeLessThanOrEqual(bound(boxAround(PICKUP, radiusKm)));
    }
    captured = [];
    const zone = await nearbyDrivers(traced, trip, { scope: "zone" }, NOW);
    expect(zone.items.map((d) => d.driverId)).toEqual(byKm((p) => p.zone === "TN-TC"));
    // The zone's fresh positions (3,000 index entries and rows), then each of those drivers and his position by key.
    expect(await pickerRowsRead()).toBeLessThanOrEqual(4 * PER_COUNTRY);
  });

  it("a zone-scoped admin of another country still cannot count a Tunis radar zone", async () => {
    await expect(radarZoneFree(traced, { ...ADMIN, zones: ["Z001"] }, "rzn_b120", "economy", NOW)).rejects.toMatchObject({ code: "forbidden" });
  });
});
