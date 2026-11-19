import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { adminSession } from "../support/admin.js";
import { testWorld } from "../support/world.js";

/**
 * S5 J16/J17 (contract v0.18.134, contract.json#adminListFilters.ids): GET /admin/riders, /admin/drivers and /admin/trips
 * take ids (1-200, comma separated or repeated). The page holds only those rows, inside the admin's zones and every other
 * filter; an id outside the admin's zones, unknown or not matching a filter is left out (never 403 / 404). More than 200,
 * an empty value or a malformed id is 400.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-19T10:00:00Z") };
let superAdmin: Record<string, string>;
let z001Admin: Record<string, string>;
const r: string[] = [];
const d: string[] = [];
const t: string[] = [];

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });
const idsOf = (body: { items: Array<Record<string, string>> }, key: string) => body.items.map((row) => row[key]).sort();

beforeAll(async () => {
  database = await freshDatabase();
  const db = database.db;
  app = await testWorld(db, database.url, clock);
  // r0, r1 ride in Z001; r2 only in Z002. d0, d1 work in Z001; d2 only in Z002. t0, t1 in Z001; t2 in Z002.
  for (let i = 0; i < 3; i += 1) {
    r.push(await insertRider(db));
    d.push(await insertDriver(db));
  }
  await db.updateTable("drivers").set({ zone_ids: ["Z001"] }).where("driver_id", "in", [d[0]!, d[1]!]).execute();
  await db.updateTable("drivers").set({ zone_ids: ["Z002"], account_status: "suspended" }).where("driver_id", "=", d[2]!).execute();
  for (const [i, zone] of ["Z001", "Z001", "Z002"].entries()) {
    const tripId = await insertTrip(db, r[i]!, { status: "completed" });
    await db.updateTable("trips").set({ zone_id: zone }).where("trip_id", "=", tripId).execute();
    t.push(tripId);
  }
  // Extra rows that never match an ids query.
  await insertRider(db);
  await insertDriver(db);
  await insertTrip(db, r[0]!, { status: "completed" });
  superAdmin = (await adminSession(app, db, "super", { now: clock.now })).headers;
  z001Admin = (await adminSession(app, db, "super", { zoneIds: ["Z001"], now: clock.now })).headers;
});

afterAll(async () => {
  await app?.close();
  await database.drop();
});

const LISTS = [
  ["/admin/riders", "riderId", () => r],
  ["/admin/drivers", "driverId", () => d],
  ["/admin/trips", "tripId", () => t],
] as const;

describe("v0.18.134 adminListFilters.ids", () => {
  it.each(LISTS)("%s?ids= gives only those rows (comma separated), with total", async (path, key, rows) => {
    const res = await get(`${path}?ids=${rows()[0]},${rows()[2]}`, superAdmin);
    expect(res.statusCode, res.body).toBe(200);
    expect(idsOf(res.json(), key)).toEqual([rows()[0], rows()[2]].sort());
    expect(res.json().total).toBe(2);
    expect(res.json().nextCursor).toBeNull();
  });

  it.each(LISTS)("%s?ids= repeated keys are joined", async (path, key, rows) => {
    const res = await get(`${path}?ids=${rows()[0]}&ids=${rows()[1]}`, superAdmin);
    expect(res.statusCode, res.body).toBe(200);
    expect(idsOf(res.json(), key)).toEqual([rows()[0], rows()[1]].sort());
  });

  it.each(LISTS)("%s?ids= an id outside the admin's zones is left out, never 403", async (path, key, rows) => {
    const res = await get(`${path}?ids=${rows().join(",")}`, z001Admin);
    expect(res.statusCode, res.body).toBe(200);
    expect(idsOf(res.json(), key)).toEqual([rows()[0], rows()[1]].sort());
    const only = await get(`${path}?ids=${rows()[2]}`, z001Admin);
    expect(only.statusCode, only.body).toBe(200);
    expect(only.json().items).toEqual([]);
  });

  it.each(LISTS)("%s?ids= an unknown id is left out", async (path, key, rows) => {
    const res = await get(`${path}?ids=${rows()[0]},nobody_here`, superAdmin);
    expect(res.statusCode, res.body).toBe(200);
    expect(idsOf(res.json(), key)).toEqual([rows()[0]]);
  });

  it.each(LISTS)("%s?ids= paging still works (limit 1 + cursor)", async (path, key, rows) => {
    const first = await get(`${path}?ids=${rows().join(",")}&limit=2`, superAdmin);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().items).toHaveLength(2);
    const next = await get(`${path}?ids=${rows().join(",")}&limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`, superAdmin);
    expect(next.statusCode, next.body).toBe(200);
    expect([...idsOf(first.json(), key), ...idsOf(next.json(), key)].sort()).toEqual([...rows()].sort());
  });

  it.each(LISTS)("%s?ids= 201 ids, an empty value or a malformed id is 400", async (path) => {
    const many = Array.from({ length: 201 }, (_, i) => `x${i}`).join(",");
    for (const bad of [many, "", "bad%20id"]) {
      const res = await get(`${path}?ids=${bad}`, superAdmin);
      expect(res.statusCode, `${bad.slice(0, 20)}: ${res.body}`).toBe(400);
      expect(res.json().code).toBe("invalid_request");
    }
    const ok = await get(`${path}?ids=${Array.from({ length: 200 }, (_, i) => `x${i}`).join(",")}`, superAdmin);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("ids keeps every other filter: a suspended driver is left out of accountStatus=active", async () => {
    const res = await get(`/admin/drivers?ids=${d.join(",")}&accountStatus=active`, superAdmin);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items.map((x: { driverId: string }) => x.driverId)).not.toContain(d[2]);
  });
});
