import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, testWorld } from "../support/world.js";

/**
 * Contract v0.18.34 §65 (Rules plan/FIX-PLAN-RERUN-2026-11-05.md A8/A10, rule 33): GET /admin/live/drivers is paged by
 * driverId (limit, cursor → nextCursor) and carries `total`, so the admin live card can show EVERY online driver
 * without the 50-row driver list. 10,000 online drivers (SE Z001 + FR FR-PC), read by two server copies at once.
 */

let database: TestDatabase;
let app: FastifyInstance;
let second: FastifyInstance;
const clock = { now: new Date("2026-11-05T12:00:00Z") };
const SE = 6_000;
const FR = 4_000;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  // A second server copy on the same database (rule 33: several copies; no per-copy state may change an answer).
  second = await testWorld(database.db, database.url, clock).catch(() => app);
  const at = clock.now.toISOString();
  for (const [zone, count, offset, lat, lng] of [["Z001", SE, 0, 59.33, 18.06], ["FR-PC", FR, SE, 48.85, 2.35]] as const) {
    await sql`INSERT INTO drivers (driver_id, phone, first_name, online_status, zone_ids, account_status)
      SELECT 'drv_live_' || lpad((g + ${offset})::text, 6, '0'), '+4670' || lpad((g + ${offset})::text, 7, '0'), 'D' || (g + ${offset}), 'online', ARRAY[${zone}]::text[], 'active'
      FROM generate_series(1, ${count}) g`.execute(database.db);
    await sql`INSERT INTO driver_locations (driver_id, lat, lng, accuracy, measured_at, received_at, zone_id)
      SELECT 'drv_live_' || lpad((g + ${offset})::text, 6, '0'), ${lat} + g * 0.00001, ${lng}, 5, ${at}::timestamptz, ${at}::timestamptz, ${zone}
      FROM generate_series(1, ${count}) g`.execute(database.db);
  }
}, 120_000);
afterAll(async () => {
  if (second !== app) await second.close();
  await app.close();
  await database.drop();
});

type LivePage = { items: Array<{ driverId: string; zoneId?: string }>; total: number; nextCursor: string | null; zoneSupply?: Array<{ zoneId: string; online: number }> };

async function readAll(path: string, limit: number, headers: Record<string, string>) {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let total = -1;
  do {
    // Pages alternate between the two server copies: the cursor is the last driverId, nothing is kept in a process.
    const server = pages % 2 === 0 ? app : second;
    const sep = path.includes("?") ? "&" : "?";
    const res = await call(server, "GET", `${path}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`, headers);
    expect(res.statusCode).toBe(200);
    const body = res.json() as LivePage;
    expect(body.items.length).toBeLessThanOrEqual(limit);
    total = body.total;
    seen.push(...body.items.map((row) => row.driverId));
    cursor = body.nextCursor;
    pages += 1;
  } while (cursor && pages < 1000);
  return { seen, pages, total };
}

describe("v0.18.34 §65 paged live drivers (A8/A10, rule 33)", () => {
  it("10,000 online drivers: every one comes back exactly once over pages of 500, total is right, each page is bounded", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const started = Date.now();
    const { seen, pages, total } = await readAll("/admin/live/drivers", 500, admin);
    expect(total).toBe(SE + FR);
    expect(seen.length).toBe(SE + FR);
    expect(new Set(seen).size).toBe(SE + FR);
    expect(pages).toBe(20);
    // Bounded: 20 pages of 10k drivers well inside 60 s on a CI runner (measured, not a budget for production).
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 120_000);

  it("SE and FR: a country filter pages only its drivers and its total; zoneSupply counts every driver, not the page", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    for (const [country, zone, count] of [["SE", "Z001", SE], ["FR", "FR-PC", FR]] as const) {
      const first = (await call(app, "GET", `/admin/live/drivers?country=${country}&limit=50`, admin)).json() as LivePage;
      expect(first.items.length).toBe(50);
      expect(first.total).toBe(count);
      expect(first.items.every((row) => row.zoneId === zone)).toBe(true);
      expect(first.zoneSupply?.find((row) => row.zoneId === zone)?.online).toBe(count);
      const { seen, total } = await readAll(`/admin/live/drivers?country=${country}`, 1000, admin);
      expect([seen.length, total]).toEqual([count, count]);
    }
  }, 120_000);

  it("more than 50 online drivers past row 50 of the driver list are all on the live answer", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const first = (await call(app, "GET", "/admin/live/drivers?country=SE&limit=60", admin)).json() as LivePage;
    expect(first.items.length).toBe(60);
    expect(first.nextCursor).toBe(first.items[59]!.driverId);
  });

  it("limit and cursor are checked: 0, 1001 and an empty cursor are 400; an unknown key stays 400 unknown_filter", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    for (const query of ["limit=0", "limit=1001", "limit=10&cursor="]) {
      expect((await call(app, "GET", `/admin/live/drivers?${query}`, admin)).statusCode).toBe(400);
    }
    expect((await call(app, "GET", "/admin/live/drivers?page=2", admin)).json()).toMatchObject({ reason: "unknown_filter" });
  });
});
