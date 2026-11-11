import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { LIVE, pruneAdminLiveEvents } from "../../src/realtime/adminEvents.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

describe("S05 A2: admin live events pruning", () => {
  it("prunes 200,000 old events without a RangeError, keeps the fresh ones and remembers the highest pruned sequence", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (LIVE.retentionHours + 1) * 3_600_000);
    await sql`INSERT INTO admin_live_events (type, entity_id, zone_id, occurred_at)
      SELECT 'trip.changed', 'e' || g, 'Z001', ${old}::timestamptz FROM generate_series(1, 200000) g`.execute(database.db);
    const top = await sql<{ top: string }>`SELECT max(sequence)::text AS top FROM admin_live_events`.execute(database.db);
    await database.db.insertInto("admin_live_events").values({ type: "trip.changed", entity_id: "fresh", zone_id: "Z001" }).execute();
    await pruneAdminLiveEvents(database.db, now);
    const left = await database.db.selectFrom("admin_live_events").select("entity_id").execute();
    expect(left.map((row) => row.entity_id)).toEqual(["fresh"]);
    const pruned = await database.db.selectFrom("admin_live_pruned").select("up_to").where("id", "=", 1).executeTakeFirstOrThrow();
    expect(String(pruned.up_to)).toBe(top.rows[0]!.top);
  }, 60_000);

  it("small batches give the same result", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (LIVE.retentionHours + 1) * 3_600_000);
    await sql`INSERT INTO admin_live_events (type, entity_id, zone_id, occurred_at)
      SELECT 'trip.changed', 'b' || g, 'Z001', ${old}::timestamptz FROM generate_series(1, 25) g`.execute(database.db);
    const top = await sql<{ top: string }>`SELECT max(sequence)::text AS top FROM admin_live_events WHERE entity_id LIKE 'b%'`.execute(database.db);
    await pruneAdminLiveEvents(database.db, now, 10);
    const left = await database.db.selectFrom("admin_live_events").select("entity_id").execute();
    expect(left.map((row) => row.entity_id)).toEqual(["fresh"]);
    const pruned = await database.db.selectFrom("admin_live_pruned").select("up_to").where("id", "=", 1).executeTakeFirstOrThrow();
    expect(String(pruned.up_to)).toBe(top.rows[0]!.top);
  });
});
