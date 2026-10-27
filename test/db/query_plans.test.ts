import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Audit Phase 7: every hot query has an index to use. The list is the most-called statements of the e2e harness
 * run (pg_stat_statements, docs/audit/phase-7.md) plus the admin bonus sum that read the whole earnings table.
 * With sequential scans disabled the planner still picks one only when no index fits, so a "Seq Scan" here means
 * the query reads the whole table once it grows; so does an index scan
 * without a condition on the index's first column. Values are literals, like node-pg's unnamed (custom-plan)
 * statements, so partial indexes count.
 */
const HOT_QUERIES: Array<[string, string]> = [
  ["timers due", `select * from timers where due_at <= now() order by due_at, timer_id limit 20 for update skip locked`],
  ["session check", `select revoked_at, expires_at from auth_sessions where session_id = 's1'`],
  ["driver's live trip", `select trip_id, status, version from trips where driver_id = 'd1' and status in ('accepted', 'arriving', 'arrived', 'in_progress')`],
  ["trip by id", `select * from trips where trip_id = 't1'`],
  ["driver position", `select * from driver_locations where driver_id = 'd1'`],
  ["trip's open offers", `select * from offers where trip_id = 't1' and status = 'open'`],
  ["trip events since", `select * from trip_events where trip_id = 't1' and sequence > 3 order by sequence limit 100`],
  ["driver's offers", `select * from offers where driver_id = 'd1' and status = 'open' order by sent_at desc limit 20`],
  ["driver acceptance", `select count(*) from offers where driver_id = 'd1' and kind in ('radar', 'exclusive') and sent_at > now() - interval '7 days'`],
  ["zone load", `select count(*) from trips where zone_id = 'Z001' and status in ('searching', 'offered', 'accepted')`],
  ["rider's live trip", `select * from trips where rider_id = 'r1' and kind = 'now' and status not in ('completed', 'cancelled') order by created_at desc`],
  ["rider history", `select * from trips where rider_id = 'r1' order by created_at desc limit 20`],
  ["admin trip list", `select * from trips where status = 'searching' order by updated_at desc limit 50`],
  ["quote", `select * from quotes where quote_id = 'q1' for update`],
  ["refresh token", `select * from refresh_tokens where token_sha256 = 'x'`],
  ["idempotency", `select * from idempotency_keys where actor = 'rider' and subject_id = 'r1' and key = 'k'`],
  ["notifications", `select * from notifications where audience = 'driver' and subject_id = 'd1' order by created_at desc, notification_id desc limit 20`],
  ["owed fees", `select trip_id, amount_minor from rider_fees where rider_id = 'r1' and status = 'owed' order by created_at, trip_id`],
  ["trip messages", `select * from trip_messages where trip_id = 't1' order by created_at`],
  ["trip trace", `select lat, lng from trip_locations where trip_id = 't1' and measured_at >= now() - interval '1 hour' order by measured_at`],
  ["driver earnings", `select sum(amount_minor) from earnings_entries where driver_id = 'd1' and at >= now() - interval '7 days'`],
  ["trip bonus paid (P7-S1)", `select coalesce(sum(amount_minor), 0) from earnings_entries where trip_id = 't1' and kind = 'trip'`],
];

let database: TestDatabase;
let client: pg.PoolClient;
beforeAll(async () => {
  database = await freshDatabase();
  client = await database.pool.connect();
  // On empty tables every index costs the same and the planner may pick any; give the earnings table a realistic
  // spread (300 drivers, three entries per trip) so the plan is the one production gets. Foreign keys are skipped.
  await client.query("SET session_replication_role = replica");
  await client.query(`INSERT INTO earnings_entries (entry_id, driver_id, trip_id, kind, currency, amount_minor, at)
    SELECT 'e' || g, 'd' || (g % 300), 't' || (g / 3), (ARRAY['trip', 'pickup_pay', 'fee_share'])[g % 3 + 1], 'SEK', 100, now() - g * interval '1 minute'
      FROM generate_series(1, 20000) g`);
  await client.query("SET session_replication_role = origin");
  await client.query("ANALYZE earnings_entries");
  await client.query("SET enable_seqscan = off");
});
afterAll(async () => {
  client.release();
  await database.drop();
});

type PlanNode = { "Node Type": string; "Index Name"?: string; "Index Cond"?: string; Plans?: PlanNode[] };

function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

async function leadingColumn(index: string): Promise<string> {
  const r = await client.query<{ attname: string }>(
    `SELECT a.attname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE c.relname = $1`,
    [index],
  );
  return r.rows[0]?.attname ?? "";
}

describe("hot queries use an index (audit Phase 7)", () => {
  it.each(HOT_QUERIES)("%s", async (_name, query) => {
    const [{ "QUERY PLAN": [root] }] = (await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(`EXPLAIN (FORMAT JSON) ${query}`)).rows as [{ "QUERY PLAN": [{ Plan: PlanNode }] }];
    const all = nodes(root.Plan);
    expect(all.map((n) => n["Node Type"])).not.toContain("Seq Scan");
    const scans = all.filter((n) => n["Index Name"]);
    expect(scans.length).toBeGreaterThan(0);
    // The condition must be on the index's first column: a condition on a later column walks the whole index,
    // which is a whole-table read too (earnings_entries by trip_id did that through (driver_id, trip_id, kind)).
    for (const scan of scans) {
      expect(scan["Index Cond"] ?? "", `${scan["Index Name"]}`).toContain(`(${await leadingColumn(scan["Index Name"]!)} `);
    }
  });
});
