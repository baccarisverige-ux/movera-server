import { Kysely, PostgresDialect, type CompiledQuery } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/schema.js";
import type { Db, Trx } from "../../src/db/db.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { tripEventsAfter } from "../../src/db/tripLog.js";
import type { Principal } from "../../src/auth/guard.js";
import { candidatesFor } from "../../src/dispatch/runtime/candidates.js";
import { zoneDriverFacts } from "../../src/dispatch/driverFacts.js";
import { countedSeconds, driversAtDrivingLimit } from "../../src/drivers/drivingTime.js";
import { driversWithCurrentTrip } from "../../src/reservations/service.js";
import { nearbyVehicles } from "../../src/riders/nearby.js";
import { maybePushArriving } from "../../src/notifications/tripPush.js";
import { listNotifications } from "../../src/notifications/service.js";
import { purgeOfferPushes } from "../../src/dispatch/offerPush.js";
import { listMessages } from "../../src/trips/messages.js";
import { driverEarnings } from "../../src/trips/ride/earnings.js";
import { driverPayouts, listPayouts } from "../../src/admin/payouts.js";
import { listTrips } from "../../src/admin/lists.js";
import { countDay } from "../../src/admin/kpis.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { buildWorkerConfig } from "../../src/jobs/workerConfig.js";
import { EstimateRouter } from "../../src/maps/routing.js";
import { ROUND, WITHDRAW } from "../../src/dispatch/runtime/shared.js";
import { TRIP_ETA } from "../../src/trips/etaNow.js";
import { RIDE_CHECK_SCAN } from "../../src/safety/rideCheckServer.js";
import { listIncidents } from "../../src/safety/incidents.js";
import { LIST_COUNT } from "../../src/admin/listTotal.js";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPool } from "../../src/db/db.js";
import { TEMPLATE_DB, adminUrl, urlFor } from "../support/globalSetup.js";

/**
 * Global plan step 64 (T4, audits/global-plan-2026-11-08/GLOBAL-SAFE-PLAN.md "T4 row"): plan tests of the SQL the
 * server REALLY runs on its hot paths, on backlog-size tables. Each case calls the real server function on a Kysely
 * whose `log` hook records every compiled statement (SQL text + parameters, exactly as node-pg gets them); each
 * recorded statement is then run again under EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) inside a rolled-back transaction.
 * A statement passes when no big table is read with a Seq Scan, no plan node throws away more than MAX_REMOVED rows
 * (Rows Removed by Filter / Join Filter / Index Recheck, times loops) and it touches at most MAX_BUFFERS (1,000) shared
 * blocks (both limits grow by a few per looked-up key: PER_KEY_*). Plans run with no parallel workers and no JIT, on
 * statistics taken with default_statistics_target = 1000, so they do not flip with load or sampling. Cases marked `it.fails` are the known slow queries of today (the Rule 36 proof for the later index / query
 * fixes B1.10–B1.21, B3.8, IN-G10.3); the fix PR turns its case into a plain `it`. No index is added here (Rule 46).
 *
 * Data (generated here, fixed shape, no randomness): 3,000 drivers (2,000 in Z001), 20,000 riders, 300,000 finished
 * trips over 180 days + 200 live trips, 600,000 trip events, 300,000 offers, 400,000 notifications, 300,000 earnings
 * rows, 30,000 payouts, 150,000 chat messages, 20,000 overdue trip-lane timers, 100,000 closed incidents over 180 days + 40 open ones (B1.26). Foreign keys and triggers are skipped
 * while loading (session_replication_role = replica), then every table is ANALYZEd.
 */

const BIG = new Set(["trips", "trip_events", "offers", "notifications", "timers", "earnings_entries", "payouts", "trip_messages", "driver_cancels", "incidents"]);
const MAX_REMOVED = 5_000;
// The passing statements touch at most ~300 blocks on this data (deterministic); a walk of a whole index or heap is thousands.
const MAX_BUFFERS = 1_000;
const PER_KEY_BUFFERS = 4;
const PER_KEY_REMOVED = 10;

type Captured = { sql: string; parameters: readonly unknown[] };
type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Join Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
};
type Explained = { "Plan": PlanNode; "Execution Time": number };

type PlanDatabase = { name: string; pool: pg.Pool };
let database: PlanDatabase;

/**
 * Its own clone of the template, named movera_qp_* (not movera_t_*): kept apart from the per-file clones that the
 * shared test teardown drops (only this run's, by RUN_DB_PREFIX).
 */
async function adminQuery(text: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}
let captured: Captured[] = [];
let traced: Db;
let now: Date;
let liveTrip: TripRow;
const searchTrip = {} as { row: TripRow };

/** L78-S: the admin lists' first-page count (listTotal.ts), checked by its own case below. */
const notTotal = (sql: string) => !sql.includes('count(*) as "total"');

const nodes = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodes)];

async function explain(q: Captured): Promise<{ problems: string[]; ms: number; plan: string }> {
  // Its own client per statement, released (destroyed on error) in finally: a broken connection never reaches the next case.
  const client = await database.pool.connect();
  let broken: Error | undefined;
  try {
    // A plan that does not depend on how many parallel workers are free right now, nor on JIT.
    await client.query("SET max_parallel_workers_per_gather = 0");
    await client.query("SET jit = off");
    await client.query("BEGIN");
    const r = await client.query<{ "QUERY PLAN": Explained[] }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`, q.parameters as unknown[]);
    await client.query("ROLLBACK");
    const root = r.rows[0]!["QUERY PLAN"][0]!;
    // A lookup of N keys (an IN list or array of driver ids) may cost a few blocks and rows per key: that grows with
    // the round, not with the table.
    const keys = q.parameters.reduce<number>((n, p) => n + (Array.isArray(p) ? p.length : 1), 0);
    const maxRemoved = MAX_REMOVED + PER_KEY_REMOVED * keys;
    const maxBuffers = MAX_BUFFERS + PER_KEY_BUFFERS * keys;
    const problems: string[] = [];
    for (const n of nodes(root.Plan)) {
      if (n["Node Type"] === "Seq Scan" && n["Relation Name"] && BIG.has(n["Relation Name"])) problems.push(`Seq Scan on ${n["Relation Name"]}`);
      const removed = ((n["Rows Removed by Filter"] ?? 0) + (n["Rows Removed by Join Filter"] ?? 0) + (n["Rows Removed by Index Recheck"] ?? 0)) * (n["Actual Loops"] ?? 1);
      if (removed > maxRemoved) problems.push(`${n["Node Type"]}${n["Relation Name"] ? ` on ${n["Relation Name"]}` : ""} removed ${removed} rows (max ${maxRemoved})`);
    }
    const buffers = (root.Plan["Shared Hit Blocks"] ?? 0) + (root.Plan["Shared Read Blocks"] ?? 0);
    if (buffers > maxBuffers) problems.push(`${buffers} shared buffers (max ${maxBuffers})`);
    const plan = nodes(root.Plan).map((n) => `${n["Node Type"]}${n["Relation Name"] ? ` ${n["Relation Name"]}` : ""}${n["Index Name"] ? ` using ${n["Index Name"]}` : ""}`).join(" > ");
    return { problems, ms: root["Execution Time"], plan };
  } catch (error) {
    broken = error as Error;
    throw error;
  } finally {
    client.release(broken);
  }
}

/** Runs the real function, then checks every statement it sent (or those `only` keeps). */
async function check(run: () => Promise<unknown>, only?: (sql: string) => boolean): Promise<{ count: number; problems: string[] }> {
  captured = [];
  await run();
  const statements = captured.filter((q) => /^\s*(select|with|update|delete|insert)/i.test(q.sql) && (only === undefined || only(q.sql)));
  expect(statements.length, `${statements.length} matching statements of ${captured.length} captured`).toBeGreaterThan(0);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const q of statements) {
    if (seen.has(q.sql)) continue;
    seen.add(q.sql);
    const r = await explain(q);
    if (r.problems.length) problems.push(`${r.problems.join(", ")} (${r.ms.toFixed(1)} ms) [${r.plan}] :: ${q.sql.slice(0, 160)}`);
  }
  return { count: captured.length, problems };
}

/** The work of a rolled-back transaction (functions that take a Trx). */
async function inTrx(run: (trx: Trx) => Promise<unknown>): Promise<void> {
  await traced
    .transaction()
    .execute(async (trx) => {
      await run(trx);
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
}
class Rollback extends Error {}

const SUPER: Principal = { actor: "admin", subjectId: "adm_qp", sessionId: "s_qp", zones: ["*"], role: "super", perms: ["support.reply"] };

// L78-S: these cases count the statements a list sends, the first page's total included; wait for the count so it is
// always there (the production wait of 25 ms is tested in test/admin/list_total.test.ts).
const WAIT_BEFORE = LIST_COUNT.waitAfterPageMs;
beforeAll(async () => {
  LIST_COUNT.waitAfterPageMs = 5000;
  const name = `movera_qp_${randomBytes(6).toString("hex")}`;
  await adminQuery(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  database = { name, pool: createPool(urlFor(name), 10) };
  traced = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: database.pool }),
    log: (event) => {
      if (event.level === "query") captured.push({ sql: event.query.sql, parameters: (event.query as CompiledQuery).parameters });
    },
  });
  const c = await database.pool.connect();
  try {
    await c.query("SET session_replication_role = replica");
    await c.query("SET synchronous_commit = off");
    now = (await c.query<{ n: Date }>("SELECT date_trunc('second', now()) AS n")).rows[0]!.n;
    const at = `'${now.toISOString()}'::timestamptz`;
    await c.query(`INSERT INTO riders (rider_id, phone) SELECT 'r' || g, '+4670' || lpad(g::text, 7, '0') FROM generate_series(0, 19999) g`);
    // Drivers 0–199 on a trip, 200–1499 online (Z001), 2000–2019 online (Z002), the rest offline; 0–1999 in Z001, 2000–2999 in Z002.
    await c.query(`INSERT INTO drivers (driver_id, phone, account_status, online_status, zone_ids, category_ids, country, rating_sum, rating_count, driving_since)
      SELECT 'd' || g, '+4673' || lpad(g::text, 7, '0'), 'active', CASE WHEN g < 200 THEN 'on_trip' WHEN g < 1500 OR g BETWEEN 2000 AND 2019 THEN 'online' ELSE 'offline' END,
             CASE WHEN g < 2000 THEN '{Z001}'::text[] ELSE '{Z002}'::text[] END, '{economy}', 'SE', 4.8 * 20, 20, ${at} - interval '6 hours'
        FROM generate_series(0, 2999) g`);
    await c.query(`INSERT INTO driver_locations (driver_id, lat, lng, accuracy, measured_at, received_at, zone_id)
      SELECT 'd' || g, 59.334 + ((g % 50) - 25) * 0.002, 18.063 + ((g / 50) - 20) * 0.003, 5, ${at} - interval '3 seconds', ${at} - interval '2 seconds', CASE WHEN g < 2000 THEN 'Z001' ELSE 'Z002' END
        FROM generate_series(0, 2999) g`);
    const place = `jsonb_build_object('lat', 59.334, 'lng', 18.063, 'address', 'A')`;
    // 300,000 finished trips, 100 per driver, over 180 days.
    await c.query(`INSERT INTO trips (trip_id, rider_id, driver_id, zone_id, kind, category_id, status, pickup, dropoff, currency, fare_minor, booked_fare_minor, payment_method,
                                      created_at, updated_at, accepted_at, arrived_at, boarded_at, ended_at)
      SELECT 't' || g, 'r' || (g % 20000), 'd' || (g % 3000), CASE WHEN g % 3000 < 2000 THEN 'Z001' ELSE 'Z002' END, 'live', 'economy', 'completed', ${place}, ${place}, 'SEK', 10000, 10000, 'card',
             ${at} - (g * interval '51 seconds') - interval '1 hour', ${at} - (g * interval '51 seconds') - interval '30 minutes',
             ${at} - (g * interval '51 seconds') - interval '58 minutes', ${at} - (g * interval '51 seconds') - interval '50 minutes',
             ${at} - (g * interval '51 seconds') - interval '48 minutes', ${at} - (g * interval '51 seconds') - interval '30 minutes'
        FROM generate_series(1, 300000) g`);
    // 200 live trips: driver dN with rider rN on board; 50 searching trips without a driver.
    await c.query(`INSERT INTO trips (trip_id, rider_id, driver_id, zone_id, kind, category_id, status, pickup, dropoff, currency, fare_minor, booked_fare_minor, payment_method,
                                      created_at, updated_at, accepted_at, arrived_at, boarded_at, sequence)
      SELECT 'tl' || g, 'r' || g, 'd' || g, 'Z001', 'live', 'economy', 'in_trip', ${place}, ${place}, 'SEK', 10000, 10000, 'card',
             ${at} - interval '20 minutes', ${at} - interval '5 minutes', ${at} - interval '19 minutes', ${at} - interval '12 minutes', ${at} - interval '10 minutes', 300
        FROM generate_series(0, 199) g`);
    await c.query(`INSERT INTO trips (trip_id, rider_id, zone_id, kind, category_id, status, pickup, dropoff, currency, fare_minor, booked_fare_minor, payment_method, created_at, updated_at, search_started_at)
      SELECT 'ts' || g, 'r' || (10000 + g), 'Z001', 'live', 'economy', 'searching', ${place}, ${place}, 'SEK', 10000, 10000, 'card', ${at} - interval '1 minute', ${at}, ${at} - interval '1 minute'
        FROM generate_series(0, 49) g`);
    await c.query(`INSERT INTO trip_events (trip_id, sequence, event_id, kind, version, occurred_at)
      SELECT 't' || (g / 2 + 1), g % 2 + 1, 'e' || g, 'trip_projection', 1, ${at} - (g * interval '25 seconds') FROM generate_series(0, 599999) g`);
    await c.query(`INSERT INTO trip_events (trip_id, sequence, event_id, kind, version, occurred_at)
      SELECT 'tl0', g, 'el' || g, 'location', 1, ${at} - interval '20 minutes' + g * interval '4 seconds' FROM generate_series(1, 300) g`);
    await c.query(`INSERT INTO offers (offer_id, trip_id, driver_id, kind, status, round, sent_at, expires_at, pickup_eta_seconds, pickup_meters, fare_minor, driver_earnings_minor, currency)
      SELECT 'o' || g, 't' || (g + 1), 'd' || (g % 3000), CASE WHEN g % 4 = 0 THEN 'radar' ELSE 'exclusive' END, CASE WHEN g % 3 = 0 THEN 'declined' ELSE 'claimed' END, 1,
             ${at} - (g * interval '51 seconds') - interval '1 hour', ${at} - (g * interval '51 seconds') - interval '59 minutes', 300, 2000, 10000, 8000, 'SEK'
        FROM generate_series(0, 299999) g`);
    await c.query(`INSERT INTO driver_cancels (trip_id, driver_id, reason_code, from_status, at)
      SELECT 't' || (g * 15 + 1), 'd' || (g % 3000), 'other', 'accepted', ${at} - g * interval '12 minutes' FROM generate_series(0, 19999) g`);
    // Notifications: 2 per finished trip for the rider (one "almost there"), plus driver rows.
    await c.query(`INSERT INTO notifications (notification_id, audience, subject_id, kind, title, body, trip_id, data, created_at, bell)
      SELECT 'n' || g, CASE WHEN g % 4 = 3 THEN 'driver' ELSE 'rider' END, CASE WHEN g % 4 = 3 THEN 'd' || (g % 3000) ELSE 'r' || (g % 20000) END, 'trip_moment', 'T', 'B',
             't' || (g / 2 + 1), CASE WHEN g % 2 = 0 THEN '{"moment":"driver_arriving"}'::jsonb ELSE '{"moment":"driver_arrived"}'::jsonb END, ${at} - g * interval '38 seconds', true
        FROM generate_series(0, 399999) g`);
    await c.query(`INSERT INTO earnings_entries (entry_id, driver_id, trip_id, kind, currency, amount_minor, gross_minor, commission_minor, cash_minor, at)
      SELECT 'ee' || g, 'd' || (g % 3000), 't' || (g + 1), 'trip', 'SEK', 7500, 10000, 2500, 0, ${at} - (g * interval '51 seconds') - interval '30 minutes' FROM generate_series(0, 299999) g`);
    await c.query(`INSERT INTO payouts (payout_id, driver_id, currency, amount_minor, lines, trip_count, source, status, period_start, period_end, created_at)
      SELECT 'p' || g, 'd' || (g % 3000), 'SEK', 75000, '[]', 10, 'weekly', CASE WHEN g < 3000 THEN 'pending' ELSE 'paid' END,
             ${at} - ((g / 3000) + 1) * interval '7 days', ${at} - (g / 3000) * interval '7 days', ${at} - (g / 3000) * interval '7 days' + (g % 3000) * interval '1 second'
        FROM generate_series(0, 29999) g`);
    await c.query(`INSERT INTO trip_messages (message_id, trip_id, sequence, sender, sender_id, text, created_at)
      SELECT 'm' || g, 't' || (g / 3 + 1), g % 3 + 1, 'rider', 'r1', 'Hi', ${at} - g * interval '1 minute' FROM generate_series(0, 149999) g`);
    await c.query(`INSERT INTO trip_messages (message_id, trip_id, sequence, sender, sender_id, text, created_at)
      SELECT 'ml' || g, 'tl0', g, 'rider', 'r0', 'Hi', ${at} - interval '15 minutes' + g * interval '1 second' FROM generate_series(1, 30) g`);
    // B1.26: a big closed SOS history (100,000 resolved / dismissed over 180 days, half in Z001) and 40 open cases in Z001
    // (drivers d0-d39), one every 4 days back to 156 days (cases left open), so "open cases, newest first" cannot hide
    // behind the newest rows.
    await c.query(`INSERT INTO incidents (incident_id, trip_id, kind, severity, status, raised_by, zone_id, driver_id, opened_at, updated_at, resolved_at)
      SELECT 'ic' || g, 't' || (g + 1), 'sos', 'high', CASE WHEN g % 2 = 0 THEN 'resolved' ELSE 'dismissed' END, 'rider', CASE WHEN g % 2 = 0 THEN 'Z001' ELSE 'Z002' END,
             'd' || (g % 3000), ${at} - interval '1 hour' - g * interval '155 seconds', ${at} - interval '1 hour' - g * interval '155 seconds', ${at} - interval '1 hour' - g * interval '155 seconds'
        FROM generate_series(0, 99999) g`);
    await c.query(`INSERT INTO incidents (incident_id, trip_id, kind, severity, status, raised_by, zone_id, driver_id, opened_at, updated_at)
      SELECT 'io' || g, 'tl' || g, 'sos', 'critical', CASE WHEN g % 4 = 1 THEN 'investigating' ELSE 'open' END, 'rider', 'Z001', 'd' || g,
             ${at} - interval '10 minutes' - g * interval '4 days', ${at} - interval '10 minutes'
        FROM generate_series(0, 39) g`);
    // A trip-lane backlog: 20,000 overdue ETA timers, and 20 dispatch rounds due behind them.
    await c.query(`INSERT INTO timers (kind, ref_id, due_at) SELECT '${TRIP_ETA}', 'tl' || g, ${at} - interval '10 minutes' + g * interval '10 ms' FROM generate_series(0, 19999) g`);
    await c.query(`INSERT INTO timers (kind, ref_id, due_at) SELECT '${ROUND}', 'ts' || g, ${at} - interval '1 second' FROM generate_series(0, 19) g`);
    await c.query("SET session_replication_role = origin");
    // A fixed, high statistics target so the plans cannot flip with ANALYZE's random sample.
    await c.query("SET default_statistics_target = 1000");
    await c.query("ANALYZE");
    liveTrip = (await c.query<TripRow>("SELECT * FROM trips WHERE trip_id = 'tl0'")).rows[0]!;
    searchTrip.row = (await c.query<TripRow>("SELECT * FROM trips WHERE trip_id = 'ts0'")).rows[0]!;
  } finally {
    c.release();
  }
}, 300_000);

afterAll(async () => {
  LIST_COUNT.waitAfterPageMs = WAIT_BEFORE;
  await traced?.destroy().catch(() => undefined);
  if (database === undefined) return;
  if (!database.pool.ended) await database.pool.end();
  await adminQuery(`DROP DATABASE IF EXISTS ${database.name} WITH (FORCE)`);
});

const noProblems = async (run: () => Promise<unknown>, only?: (sql: string) => boolean) => {
  const { problems } = await check(run, only);
  expect(problems, problems.join("\n")).toEqual([]);
};

describe("hot queries at backlog size (global plan step 64, T4)", () => {
  // ---- dispatch round ----
  it("dispatch candidate search: drivers in the zone with a fresh position (dispatch/runtime/candidates.ts:133-154)", async () => {
    await noProblems(() => inTrx((trx) => candidatesFor(trx, searchTrip.row, null, now)), (s) => s.includes('inner join "driver_locations"'));
  });
  it("dispatch candidate search: open offers of the round's drivers (dispatch/runtime/candidates.ts:218)", async () => {
    await noProblems(() => inTrx((trx) => candidatesFor(trx, searchTrip.row, null, now)), (s) => /from "offers" where "driver_id" in .* and "status" = \$\d+ group by/.test(s));
  });
  it("dispatch: drivers with a current trip (reservations/service.ts:133)", async () => {
    await noProblems(() => driversWithCurrentTrip(traced, Array.from({ length: 300 }, (_, i) => `d${i + 200}`)));
  });
  it("B1.11 fixed (0091 trips_driver_last/_open): driving-time limit of the round's drivers reads only trips in the window (drivers/drivingTime.ts)", async () => {
    const drivers = Array.from({ length: 300 }, (_, i) => ({ driver_id: `d${i + 200}`, zone_ids: ["Z001"], driving_since: new Date(now.getTime() - 6 * 3600_000) }));
    await noProblems(() => driversAtDrivingLimit(traced, drivers, now), (s) => s.includes("WITH d AS"));
  });
  // B1.12 is NOT proven at this size: ~17 offers per driver in 30 days is an index lookup per driver here.
  it("score aggregate of the round's drivers over 30 days of offers (dispatch/runtime/candidates.ts:245)", async () => {
    await noProblems(() => inTrx((trx) => candidatesFor(trx, searchTrip.row, null, now)), (s) => s.includes("count(*) FILTER (WHERE status = 'claimed')"));
  });
  it("B1.11 fixed (0091): one driver's counted driving seconds (drivers/drivingTime.ts)", async () => {
    await noProblems(() => countedSeconds(traced, "d300", new Date(now.getTime() - 24 * 3600_000), now));
  });

  // ---- timers ----
  it("dispatch lane takes its timer past a trip-lane backlog (jobs/timers.ts:141-147)", async () => {
    const worker = new TimerWorker(traced, { handlers: { [ROUND]: async () => undefined, [WITHDRAW]: async () => undefined }, logger: { warn: () => undefined, error: () => undefined } });
    await noProblems(() => worker.runOne({ kinds: [ROUND, WITHDRAW] }), (s) => s.includes('from "timers"') && s.includes("skip locked"));
  });
  it("B1.13 fixed (0091 timers_due_general): general lane (all kinds but the trip lane's) skips the trip-lane backlog (jobs/timers.ts)", async () => {
    const worker = new TimerWorker(traced, { handlers: { [ROUND]: async () => undefined }, logger: { warn: () => undefined, error: () => undefined } });
    await noProblems(() => worker.runOne({ exclude: [TRIP_ETA, RIDE_CHECK_SCAN, "near_dropoff"] }), (s) => s.includes('from "timers"') && s.includes("skip locked"));
  });
  it("B1.7: the real general lane (trip and housekeeping kinds excluded) and the housekeeping lane skip the trip-lane backlog (jobs/workerConfig.ts)", async () => {
    const { lanes } = buildWorkerConfig(new EstimateRouter(), { timerLanes: 4, dispatchLanes: 1 });
    const general = lanes.find((lane) => lane.exclude !== undefined)!;
    const housekeeping = lanes.find((lane) => lane.name === "housekeeping")!;
    const worker = new TimerWorker(traced, { handlers: { [ROUND]: async () => undefined }, logger: { warn: () => undefined, error: () => undefined } });
    await noProblems(() => worker.runOne(general), (s) => s.includes('from "timers"') && s.includes("skip locked"));
    await noProblems(() => worker.runOne(housekeeping), (s) => s.includes('from "timers"') && s.includes("skip locked"));
  });
  it("trip lane takes the oldest due timer (jobs/timers.ts:141-147)", async () => {
    const worker = new TimerWorker(traced, { handlers: { [TRIP_ETA]: async () => undefined }, logger: { warn: () => undefined, error: () => undefined } });
    await noProblems(() => worker.runOne({ kinds: [TRIP_ETA, RIDE_CHECK_SCAN, "near_dropoff"] }), (s) => s.includes('from "timers"') && s.includes("skip locked"));
  });

  // ---- active trip ----
  it("trip events since a sequence (db/tripLog.ts:148-156)", async () => {
    await noProblems(() => tripEventsAfter(traced, "tl0", 100));
  });
  it("trip chat page (trips/messages.ts:77-83)", async () => {
    await noProblems(() => listMessages(traced, { actor: "rider", subjectId: "r0" }, "tl0", { limit: 50 }), (s) => s.includes('from "trip_messages"'));
  });
  it("B3.8 fixed (0091 notifications_trip): \"almost there\" sent-check reads notifications by trip on an index (notifications/tripPush.ts)", async () => {
    await noProblems(() => inTrx((trx) => maybePushArriving(trx, { ...liveTrip, status: "driver_to_pickup" }, 30, now)), (s) => s.includes('from "notifications"'));
  });
  it("S05 A10 fixed (0094 notifications_offer_push_purge): hourly offer-push purge reads only old offer-push rows on an index (dispatch/offerPush.ts)", async () => {
    await noProblems(() => inTrx((trx) => purgeOfferPushes(trx, now)), (s) => s.includes('from "notifications"'));
  });
  it("rider's notification list (notifications/service.ts:111-118)", async () => {
    await noProblems(() => listNotifications(traced, { audience: "rider", subjectId: "r5" }, { limit: 20 }), (s) => s.includes('from "notifications"'));
  });

  // ---- rider app ----
  // B1.21 (no zone filter) is NOT proven here: driver_locations has one row per driver (3,000), not a big table.
  it("nearby cars around a point (riders/nearby.ts:53-72)", async () => {
    await noProblems(() => nearbyVehicles(traced, { lat: 59.334, lng: 18.063 }, "secret", now));
  });

  // ---- admin ----
  it("fixed (0093 trips_created): admin trip list with no filter reads one page on an index (admin/lists.ts)", async () => {
    await noProblems(() => listTrips(traced, SUPER, { limit: 50 }, now), (s) => s.includes('from "trips"') && notTotal(s));
  });
  it("S05 A5 fixed (0095 trips_zone_ended/_created): nightly KPI day count reads one zone-day of trips on an index, new riders without a walk of every trip (admin/kpis.ts)", async () => {
    // The day is taken from the data, never from the clock. Trips are in Z002 only in runs of 1,000 (g % 3000 >= 2000,
    // ~14.2 h), then ~28.3 h of Z001, so "176 days back" by the clock held no Z002 trip at all on runs between 06:29 and
    // 10:50 UTC (07:29-11:50 when that day is in Stockholm winter time; fail 2026-11-12 07:13 UTC). t299500 is mid-run (g 299000-299999, riders r19000-r19999, each rider's oldest
    // trip: g > 280000): its Stockholm day holds ~500+ Z002 trips that are all first trips, whatever the time of the run.
    const zone = { zone_id: "Z002", time_zone: "Europe/Stockholm", currency: "SEK" };
    const pick = await database.pool.query<{ day: string }>(
      `SELECT to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') AS day FROM trips WHERE trip_id = 't299500'`, [zone.time_zone]);
    const day = pick.rows[0]!.day;
    let figures: Awaited<ReturnType<typeof countDay>> | undefined;
    const { problems } = await check(async () => (figures = await countDay(traced, zone, day)), (s) => s.includes("FROM trips"));
    // The work grows with the zone-day (500-1,000 trips here: a few blocks per trip for the first-trip probe), never with the
    // table: no Seq Scan of a big table, no mass of filtered rows, and at most 15 blocks per trip of the day.
    expect(problems.filter((p) => !/^\d+ shared buffers/.test(p)), problems.join("\n")).toEqual([]);
    const c = await database.pool.connect();
    try {
      const bounds = await c.query<{ n: string; old: string }>(
        `WITH b AS (SELECT ($1::date::timestamp AT TIME ZONE $2) AS lo, (($1::date + 1)::timestamp AT TIME ZONE $2) AS hi)
         SELECT (SELECT count(*) FROM trips, b WHERE zone_id = $3 AND created_at >= lo AND created_at < hi) AS n,
                (SELECT count(*) FROM (SELECT DISTINCT ON (rider_id) rider_id, zone_id, created_at FROM trips ORDER BY rider_id, created_at, trip_id) f, b
                  WHERE zone_id = $3 AND created_at >= lo AND created_at < hi) AS old`, [day, zone.time_zone, zone.zone_id]);
      const { n, old } = bounds.rows[0]!;
      // Same answer as the old DISTINCT ON over every trip.
      expect(figures!.newRiders).toBe(Number(old));
      expect(Number(n), "Z002 trips in the picked day").toBeGreaterThanOrEqual(500);
      expect(figures!.newRiders).toBeGreaterThanOrEqual(500);
      for (const p of problems) expect(Number(/^(\d+) shared buffers/.exec(p)![1]), p).toBeLessThanOrEqual(15 * Number(n) + MAX_BUFFERS);
    } finally {
      c.release();
    }
  });
  it("B1.19 fixed: Dispatch page driver facts reads missed-in-a-row and driving time in one query each (dispatch/driverFacts.ts)", async () => {
    const { count } = await check(() => zoneDriverFacts(traced, "Z002", now));
    expect(count, `${count} queries for one call (max 10)`).toBeLessThanOrEqual(10);
  });
  it("B1.11 fixed (0091): driver facts' batched driving-time reads only trips in the window (dispatch/driverFacts.ts → drivers/drivingTime.ts)", async () => {
    await noProblems(() => zoneDriverFacts(traced, "Z002", now), (s) => s.includes("legs AS ("));
  });
  // No new index: the open-case read already runs on incidents_one_open_per_trip (0021, partial on open | investigating;
  // it holds every open case, also those without a trip) and sorts only the open cases; the history (no status) pages on
  // incidents_newest. What was slow is the N+1: one driver_locations read per row (a page of 51 = 52 statements).
  it("B1.26: admin SOS list of open cases and of all cases, newest first, one batched position read per page (safety/incidents.ts)", async () => {
    const ZONE: Principal = { ...SUPER, zones: ["Z001"] };
    let items = 0;
    const { count, problems } = await check(async () => {
      items = (await listIncidents(traced, SUPER, { limit: 51, status: ["open", "investigating"] })).items.length;
      await listIncidents(traced, ZONE, { limit: 51, status: ["open", "investigating"] });
      await listIncidents(traced, ZONE, { limit: 51 });
    }, notTotal);
    expect(items).toBe(40);
    expect(problems, problems.join("\n")).toEqual([]);
    // Three calls, each: the page, then the positions of its drivers in one read; L78-S: + each first page's total
    // (begin, two SET LOCAL, count, commit; checked by its own case below).
    expect(count).toBe(3 * 2 + 3 * 5);
  });
  it("admin payout list (admin/payouts.ts:272-284)", async () => {
    await noProblems(() => listPayouts(traced, SUPER, { limit: 50 }), notTotal);
  });

  // L78-S (contract v0.18.78 adminListFilters.total, Rule 33): the first-page count reads every matching row by design,
  // so it is not held to the page rules above; it runs in its own statement under LIST_COUNT.timeoutMs instead. On these
  // backlog tables it is exact within the budget, and a count that runs past the budget is left out while the page is
  // the same.
  it("L78-S: the list totals at backlog size are exact, or left out with the same page when past the budget", async () => {
    const before = LIST_COUNT.timeoutMs;
    const exact = async (text: string) => Number((await database.pool.query<{ n: string }>(text)).rows[0]!.n);
    try {
      // Exactness here, not speed: a loaded CI runner must not turn this into a timing test (the time is measured apart).
      LIST_COUNT.timeoutMs = 10_000;
      const all = await listTrips(traced, SUPER, { limit: 50 }, now);
      expect(all.total).toBe(await exact("SELECT count(*) AS n FROM trips"));
      expect((await listIncidents(traced, { ...SUPER, zones: ["Z001"] }, { limit: 51 })).total).toBe(await exact("SELECT count(*) AS n FROM incidents WHERE zone_id = 'Z001'"));
      expect((await listPayouts(traced, SUPER, { limit: 50 })).total).toBe(await exact("SELECT count(*) AS n FROM payouts"));
      LIST_COUNT.timeoutMs = 1;
      const cut = await listTrips(traced, SUPER, { limit: 50 }, now);
      expect(cut).not.toHaveProperty("total");
      expect(cut.items).toEqual(all.items);
      expect(cut.nextCursor).toBe(all.nextCursor);
    } finally {
      LIST_COUNT.timeoutMs = before;
    }
  });

  // ---- money (driver app) ----
  it("IN-G10.3 fixed (0093 payouts_driver_created): driver's own payouts page reads one page on an index (admin/payouts.ts)", async () => {
    await noProblems(() => driverPayouts(traced, "d7", { limit: 20 }));
  });
  it("driver earnings report, this month (trips/ride/earnings.ts:18-31)", async () => {
    await noProblems(() => driverEarnings(traced, "d7", { period: "month", timeZone: "Europe/Stockholm", currency: "SEK" }, now), (s) => s.includes("earnings_entries"));
  });
});
