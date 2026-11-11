import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import { LIVE } from "../../src/realtime/adminEvents.js";
import { SWEEP_IDEMPOTENCY_KEYS, ensureMaintenanceTimers, maintenanceHandlers } from "../../src/jobs/maintenance.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * S4 0.14b (owner W1 Q69 "… cleaning in batches" = Yes, 2026-11-11): every hourly clean-up is its own timer, so one
 * failing clean-up no longer rolls back the others (or the payout pass); and each firing deletes at most 5,000 rows,
 * booking itself again soon while rows are left.
 */

const T0 = new Date("2026-11-11T12:00:00Z");
const OLD = new Date("2026-09-01T12:00:00Z");
const MAX_ROWS = 5_000;

let database: TestDatabase;
beforeEach(async () => {
  database = await freshDatabase();
});
afterEach(async () => {
  await database.drop();
});

const quiet = { warn: () => undefined, error: () => undefined };
function worker(clock: { now: Date }) {
  return new TimerWorker(database.db, { handlers: maintenanceHandlers, logger: quiet, clock: () => clock.now });
}
const count = async (table: string) => Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(table)}`.execute(database.db)).rows[0]!.n);

async function seedOld(n: number) {
  await sql`INSERT INTO idempotency_keys (actor, subject_id, key, method, route, body_sha256, status_code, response, created_at)
    SELECT 'rider', 'rdr_hk', 'old-key-0123456789-' || g, 'POST', '/api/v1/x', repeat('0', 64), 200, NULL, ${OLD}::timestamptz FROM generate_series(1, ${n}) g`.execute(database.db);
  await sql`INSERT INTO telemetry (kind, body, at) SELECT 'log', '{}'::jsonb, ${OLD}::timestamptz FROM generate_series(1, ${n}) g`.execute(database.db);
  const oldEvent = new Date(T0.getTime() - (LIVE.retentionHours + 1) * 3_600_000);
  await sql`INSERT INTO admin_live_events (type, entity_id, zone_id, occurred_at)
    SELECT 'trip.changed', 'e' || g, 'Z001', ${oldEvent}::timestamptz FROM generate_series(1, ${n}) g`.execute(database.db);
}

describe("S4 0.14b: one timer per housekeeping job", () => {
  it("one failing clean-up does not roll back the other clean-ups, nor the payout sweep", async () => {
    await seedOld(1);
    // The telemetry clean-up fails (a broken table, a bug): every delete there throws.
    await sql`CREATE FUNCTION hk_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'telemetry is broken'; END $$`.execute(database.db);
    await sql`CREATE TRIGGER hk_fail BEFORE DELETE ON telemetry FOR EACH ROW EXECUTE FUNCTION hk_fail()`.execute(database.db);
    const clock = { now: T0 };
    await ensureMaintenanceTimers(database.db, T0);
    await worker(clock).runDue();
    // The other clean-ups did their work.
    expect(await count("idempotency_keys")).toBe(0);
    expect(await count("admin_live_events")).toBe(0);
    // Only the telemetry clean-up failed and waits for its retry; the payout sweep is not among the failures.
    expect(await count("telemetry")).toBe(1);
    const failed = await database.db.selectFrom("timers").select(["kind", "last_error"]).where("attempts", ">", 0).execute();
    expect(failed.map((t) => t.kind)).not.toContain(SWEEP_IDEMPOTENCY_KEYS);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.last_error).toContain("telemetry is broken");
  });

  it("a backlog of 12,000 rows is deleted in statements of at most 5,000 rows, at most 5,000 per firing, and is soon gone", async () => {
    await seedOld(12_000);
    // Each DELETE statement on the three tables writes how many rows it removed.
    await sql`CREATE TABLE hk_deletes (tbl text NOT NULL, n integer NOT NULL)`.execute(database.db);
    await sql`CREATE FUNCTION hk_log() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO hk_deletes (tbl, n) SELECT TG_TABLE_NAME, count(*) FROM gone; RETURN NULL; END $$`.execute(database.db);
    for (const table of ["idempotency_keys", "telemetry", "admin_live_events"]) {
      await sql`CREATE TRIGGER ${sql.raw(`hk_log_${table}`)} AFTER DELETE ON ${sql.table(table)} REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION hk_log()`.execute(database.db);
    }
    const clock = { now: T0 };
    await ensureMaintenanceTimers(database.db, T0);
    const w = worker(clock);
    await w.runDue();
    // No DELETE statement removed more than 5,000 rows.
    const firstRun = await sql<{ tbl: string; n: number }>`SELECT tbl, max(n) AS n FROM hk_deletes GROUP BY tbl ORDER BY tbl`.execute(database.db);
    expect(Object.fromEntries(firstRun.rows.map((r) => [r.tbl, r.n <= MAX_ROWS]))).toEqual({ admin_live_events: true, idempotency_keys: true, telemetry: true });
    // One firing of each clean-up removed at most 5,000 rows.
    for (const table of ["idempotency_keys", "telemetry", "admin_live_events"]) expect(await count(table)).toBeGreaterThanOrEqual(12_000 - MAX_ROWS);
    // The clean-ups come back soon (not in an hour) while rows are left: within a minute the backlog is gone.
    for (let second = 1; second <= 60; second++) {
      clock.now = new Date(T0.getTime() + second * 1000);
      await w.runDue();
    }
    for (const table of ["idempotency_keys", "telemetry", "admin_live_events"]) expect(await count(table)).toBe(0);
    const biggest = await sql<{ tbl: string; n: number }>`SELECT tbl, max(n) AS n FROM hk_deletes GROUP BY tbl ORDER BY tbl`.execute(database.db);
    expect(biggest.rows.map((r) => r.tbl)).toEqual(["admin_live_events", "idempotency_keys", "telemetry"]);
    for (const row of biggest.rows) expect(row.n).toBeLessThanOrEqual(MAX_ROWS);
    // Once the backlog is gone, each clean-up waits an hour again.
    const next = await database.db.selectFrom("timers").select(["kind", "due_at"]).where("kind", "like", "cleanup_%").execute();
    expect(next.length).toBeGreaterThan(0);
    for (const t of next) expect(t.due_at.getTime()).toBeGreaterThanOrEqual(T0.getTime() + 60 * 60_000);
  }, 120_000);

  it("traces, road gaps, error groups and unbooked quotes go 5,000 at a time too (fresh rows stay)", async () => {
    // Seeded with foreign keys off (no trips, riders or zones needed to prove the batching).
    const client = await database.pool.connect();
    try {
      await client.query("SET session_replication_role = replica");
      await client.query(`INSERT INTO trip_locations (trip_id, driver_id, measured_at, lat, lng, accuracy)
        SELECT 'trp_hk', 'drv_hk', $1::timestamptz + g * interval '1 ms', 59.3, 18.0, 5 FROM generate_series(1, 6000) g`, [OLD]);
      await client.query(`INSERT INTO trip_locations (trip_id, driver_id, measured_at, lat, lng, accuracy) VALUES ('trp_hk', 'drv_hk', $1, 59.3, 18.0, 5)`, [T0]);
      await client.query(`INSERT INTO trip_gap_roads (trip_id, from_ts, to_ts, road_m, created_at)
        SELECT 'trp_hk', $1::timestamptz + g * interval '1 ms', $1::timestamptz + g * interval '1 ms' + interval '1 s', 10, $1 FROM generate_series(1, 6000) g`, [OLD]);
      await client.query(`INSERT INTO error_groups (error_id, fingerprint, app, platform, kind, message, first_seen, last_seen)
        SELECT 'err_hk_' || g, 'fp_hk_' || g, 'driver', 'android', 'error', 'boom', $1, $1 FROM generate_series(1, 6000) g`, [OLD]);
      await client.query(`INSERT INTO quotes (quote_id, rider_id, zone_id, category_id, kind, pickup, dropoff, distance_meters, duration_seconds, route_source, currency, total_minor, fare_lines, driver_earnings_minor, pricing_version, expires_at)
        SELECT 'qte_hk_' || g, 'rdr_hk', 'Z001', 'standard', 'live', '{}', '{}', 1, 1, 'estimate', 'SEK', 1, '[]', 1, 1, $1 FROM generate_series(1, 6000) g`, [OLD]);
    } finally {
      await client.query("SET session_replication_role = DEFAULT");
      client.release();
    }
    const clock = { now: T0 };
    await ensureMaintenanceTimers(database.db, T0);
    const w = worker(clock);
    await w.runDue();
    expect([await count("trip_locations"), await count("trip_gap_roads"), await count("error_groups"), await count("quotes")]).toEqual([1001, 1000, 1000, 1000]);
    clock.now = new Date(T0.getTime() + 10_000);
    await w.runDue();
    expect([await count("trip_locations"), await count("trip_gap_roads"), await count("error_groups"), await count("quotes")]).toEqual([1, 0, 0, 0]);
  });

  it("every housekeeping kind is re-armed at start like the other recurring jobs (main.ts)", async () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    const rearm = main.slice(main.indexOf("rearmParkedRecurringTimers(db"));
    expect(rearm.slice(0, rearm.indexOf(");"))).toContain("...HOUSEKEEPING_KINDS");
  });
});
