import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEMPLATE_DB, adminUrl, urlFor } from "../support/globalSetup.js";
import { DISTRIBUTION, MAX_SCALE, planCounts, type PlanCounts } from "../../tools/datagen/plan.mjs";

/**
 * Global plan step 61 (T2): the data generator fills a freshly migrated test database with a real-size spread. Small
 * scale here (0.01 = 100 riders + 100 drivers, 10k finished trips); the counts and the spread must match the plan.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const TOOL = join(ROOT, "tools", "datagen", "datagen.mjs");
const suffix = randomBytes(4).toString("hex");
const DB = `movera_loadtest_t61_${suffix}`;
const DB2 = `movera_loadtest_t61b_${suffix}`;
const DB3 = `movera_loadtest_t61c_${suffix}`;

type Result = { plan: PlanCounts & { activeTripsWritten: number }; rows: Record<string, number>; orphans: Record<string, number>; fkChecked: number; range: { start: string; end: string } };

function run(args: string[], env: Record<string, string | undefined> = { DATAGEN_ADMIN_URL: adminUrl() }) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
function generate(db: string, extra: string[]): Result {
  const out = join(tmpdir(), `${db}.json`);
  const r = run(["--db", db, "--create", "--template", TEMPLATE_DB, "--i-know-this-drops", db, "--out", out, ...extra]);
  expect(r.code, r.out).toBe(0);
  return JSON.parse(readFileSync(out, "utf8")) as Result;
}
async function adminQuery(sql: string) {
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

let result: Result;
let pool: pg.Pool;
const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await pool.query<T>(sql, params)).rows;

beforeAll(() => {
  result = generate(DB, ["--scale", "0.01", "--seed", "7"]);
  pool = new pg.Pool({ connectionString: urlFor(DB), max: 2 });
}, 120_000);
afterAll(async () => {
  await pool?.end();
  for (const db of [DB, DB2, DB3]) await adminQuery(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});

describe("data generator: row counts match the requested scale", () => {
  it("people and trips are exactly the plan", async () => {
    const plan = planCounts({ scale: 0.01 });
    expect(plan).toMatchObject({ riders: 100, drivers: 100, historicTrips: 10_000 });
    const [row] = await q<Record<string, string>>(`SELECT (SELECT count(*) FROM riders) AS riders, (SELECT count(*) FROM drivers) AS drivers,
      (SELECT count(*) FROM vehicles) AS vehicles, (SELECT count(*) FROM fleets) AS fleets, (SELECT count(*) FROM admins) AS admins,
      (SELECT count(*) FROM trips) AS trips, (SELECT count(*) FROM rider_wallets) AS wallets`);
    expect(Number(row!.riders)).toBe(plan.riders);
    expect(Number(row!.drivers)).toBe(plan.drivers);
    expect(Number(row!.vehicles)).toBe(plan.vehicles);
    expect(Number(row!.fleets)).toBe(plan.fleets);
    expect(Number(row!.admins)).toBe(plan.admins);
    expect(Number(row!.wallets)).toBe(plan.riders);
    expect(Number(row!.trips)).toBe(plan.historicTrips + plan.bookedRides + result.plan.activeTripsWritten);
    expect(result.plan.activeTripsWritten).toBeGreaterThanOrEqual(1);
  });

  it("rows that hang off trips are within tolerance of the configured rates", async () => {
    const [row] = await q<Record<string, string>>(`SELECT (SELECT count(*) FROM trips) AS trips, (SELECT count(*) FROM trip_events) AS events,
      (SELECT count(*) FROM trip_messages) AS messages, (SELECT count(*) FROM earnings_entries WHERE kind = 'trip') AS earnings,
      (SELECT count(*) FROM trips WHERE status = 'completed') AS completed, (SELECT count(*) FROM support_tickets) AS tickets,
      (SELECT count(*) FROM ticket_messages) AS ticket_messages, (SELECT count(*) FROM admin_audit) AS audit,
      (SELECT count(*) FROM wallet_entries WHERE kind = 'charge') AS charges, (SELECT count(*) FROM trips WHERE status = 'completed' AND payment_method = 'wallet') AS wallet_trips`);
    const n = (k: string) => Number(row![k]);
    const near = (got: number, want: number, tol: number) => expect(Math.abs(got - want) / want, `${got} vs ${want}`).toBeLessThanOrEqual(tol);
    expect(n("events") / n("trips")).toBeGreaterThan(8);
    expect(n("events") / n("trips")).toBeLessThan(16);
    near(n("tickets"), n("trips") * DISTRIBUTION.ticketsPerTrip, 0.35);
    near(n("audit"), n("trips") * DISTRIBUTION.auditPerTrip, 0.25);
    expect(n("ticket_messages")).toBeGreaterThanOrEqual(2 * n("tickets"));
    expect(n("earnings")).toBe(n("completed")); // every completed trip has a driver and one earnings row
    expect(n("charges")).toBe(n("wallet_trips"));
    // chat: share of trips with a driver × 1..5 messages (mean 3)
    near(n("messages"), n("trips") * 0.85 * DISTRIBUTION.chatTripShare * 3, 0.3);
    for (const [table, count] of Object.entries(result.rows)) expect(count, table).toBeGreaterThan(0);
  });

  it("every foreign key holds (the tool re-checks all of them)", async () => {
    expect(result.fkChecked).toBeGreaterThan(50);
    expect(result.orphans).toEqual({});
    const [row] = await q<{ n: string }>("SELECT count(*) AS n FROM trip_events e LEFT JOIN trips t USING (trip_id) WHERE t.trip_id IS NULL");
    expect(Number(row!.n)).toBe(0);
  });
});

describe("data generator: the spread matches the configured distribution", () => {
  it("finished-trip status mix", async () => {
    const rows = await q<{ status: string; share: number }>(`SELECT status, count(*)::float / sum(count(*)) OVER () AS share FROM trips
      WHERE kind = 'live' AND trip_id < $1 GROUP BY status`, [`trp_dg_${String(10_000).padStart(8, "0")}`]);
    const got = Object.fromEntries(rows.map((r) => [r.status, r.share]));
    for (const [status, share] of Object.entries(DISTRIBUTION.tripStatus)) expect(Math.abs((got[status] ?? 0) - share), status).toBeLessThan(0.02);
    expect(Object.keys(got).sort()).toEqual(Object.keys(DISTRIBUTION.tripStatus).sort());
  });

  it("zones and currencies: Z001 SEK, FR-PC EUR, TN-TC TND with 3 decimals in 50-millime steps", async () => {
    const rows = await q<{ zone_id: string; currency: string; share: number; bad_step: string }>(`SELECT zone_id, currency, count(*)::float / sum(count(*)) OVER () AS share,
      count(*) FILTER (WHERE fare_minor % 50 <> 0) AS bad_step FROM trips GROUP BY zone_id, currency`);
    expect(rows).toHaveLength(3);
    for (const z of DISTRIBUTION.zones) {
      const r = rows.find((x) => x.zone_id === z.zoneId);
      expect(r?.currency, z.zoneId).toBe(z.currency);
      expect(Math.abs(r!.share - z.share), z.zoneId).toBeLessThan(0.03);
    }
    expect(Number(rows.find((r) => r.currency === "TND")!.bad_step)).toBe(0);
    const [tnd] = await q<{ n: string; whole: string }>("SELECT count(*) AS n, count(*) FILTER (WHERE amount_minor % 1000 = 0) AS whole FROM earnings_entries WHERE currency = 'TND'");
    expect(Number(tnd!.n)).toBeGreaterThan(0);
    expect(Number(tnd!.whole)).toBeLessThan(Number(tnd!.n)); // real millimes, not whole dinars
    const people = await q<{ country: string; n: string }>("SELECT country, count(*) AS n FROM drivers GROUP BY country");
    expect(people.map((p) => p.country).sort()).toEqual(["FR", "SE", "TN"]);
  });

  it("time range: six months up to --end, every month used, busy hours busier than night", async () => {
    const [r] = await q<{ min: Date; max: Date }>("SELECT min(created_at) AS min, max(created_at) AS max FROM trips WHERE kind = 'live' AND status NOT IN ('searching','accepted','driver_to_pickup','arrived','in_trip')");
    expect(r!.min.getTime()).toBeGreaterThanOrEqual(Date.parse(result.range.start));
    expect(r!.max.getTime()).toBeLessThanOrEqual(Date.parse(result.range.end));
    const months = await q<{ m: string; n: string }>("SELECT to_char(created_at, 'YYYY-MM') AS m, count(*) AS n FROM trips WHERE kind = 'live' GROUP BY 1 ORDER BY 1");
    const full = months.filter((m) => m.m >= result.range.start.slice(0, 7) && m.m < result.range.end.slice(0, 7));
    expect(full).toHaveLength(6);
    for (const m of full) expect(Number(m.n), m.m).toBeGreaterThan(10_000 / 6 / 2);
    const [h] = await q<{ peak: string; night: string }>(`SELECT count(*) FILTER (WHERE extract(hour FROM created_at AT TIME ZONE 'Europe/Paris') BETWEEN 17 AND 18) AS peak,
      count(*) FILTER (WHERE extract(hour FROM created_at AT TIME ZONE 'Europe/Paris') BETWEEN 3 AND 4) AS night FROM trips`);
    expect(Number(h!.peak)).toBeGreaterThan(5 * Number(h!.night));
  });

  it("live trips now respect one active trip per driver and per rider; booked rides are in the future", async () => {
    const [r] = await q<{ booked: string; future: string }>(`SELECT count(*) AS booked, count(*) FILTER (WHERE scheduled_at > $1) AS future FROM trips WHERE kind = 'scheduled'`, [result.range.end]);
    expect(Number(r!.booked)).toBe(result.plan.bookedRides);
    expect(Number(r!.future)).toBe(result.plan.bookedRides);
  });
});

describe("data generator: deterministic, and the load tool guards", () => {
  it("same seed → the same rows, with triggers on or off and any worker count", () => {
    const a = generate(DB2, ["--scale", "0.002", "--seed", "11", "--workers", "1"]);
    const b = generate(DB3, ["--scale", "0.002", "--seed", "11", "--workers", "4", "--with-triggers"]);
    expect(a.rows).toEqual(b.rows);
    const digest = (db: string) => {
      const r = spawnSync("psql", [urlFor(db), "-Atc", "SELECT md5(string_agg(t::text, '|' ORDER BY trip_id)) FROM trips t"], { encoding: "utf8" });
      const e = spawnSync("psql", [urlFor(db), "-Atc", "SELECT md5(string_agg(e::text, '|' ORDER BY event_id)) FROM trip_events e"], { encoding: "utf8" });
      return `${r.stdout.trim()}/${e.stdout.trim()}`;
    };
    expect(digest(DB2)).toBe(digest(DB3));
    expect(digest(DB2)).toMatch(/^[0-9a-f]{32}\/[0-9a-f]{32}$/);
  }, 120_000);

  it("refuses a non-test database name, a remote host, an existing database without the drop flag, and a too-big scale", () => {
    const bad = run(["--db", "movera", "--scale", "0.01"]);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("LOADTEST GUARD");
    const remote = run(["--db", "movera_loadtest_x", "--scale", "0.01"], { DATAGEN_ADMIN_URL: "postgres://movera:secretpw@db.prod.example.com/movera" });
    expect(remote.code).toBe(2);
    expect(remote.out).not.toContain("secretpw");
    const existing = run(["--db", DB, "--scale", "0.01", "--create", "--template", TEMPLATE_DB]);
    expect(existing.code).toBe(2);
    expect(existing.out).toContain(`--i-know-this-drops ${DB}`);
    const notEmpty = run(["--db", DB, "--scale", "0.01"]);
    expect(notEmpty.code).toBe(2);
    expect(notEmpty.out).toContain("already has riders");
    const big = run(["--db", "movera_loadtest_x", "--scale", String(MAX_SCALE + 1)]);
    expect(big.code).toBe(2);
    expect(big.out).toContain("--unsafe-max");
  });
});
