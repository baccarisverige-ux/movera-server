import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { AdminLiveFeed, ADMIN_EVENTS_CHANNEL } from "../../src/realtime/adminEvents.js";
import { SettledCursor } from "../../src/realtime/settled.js";
import { dispatchEventsAfter } from "../../src/dispatch/feed.js";
import type { NotificationHub } from "../../src/realtime/hub.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * S04 A1 (B6): a bigserial sequence is taken at insert, not at commit. T1 takes the lower sequence but commits after
 * T2; both events must reach the stream, each exactly once.
 */

let database: TestDatabase;
let t1: pg.Client;
let t2: pg.Client;
beforeAll(async () => {
  database = await freshDatabase();
  t1 = new pg.Client({ connectionString: database.url });
  t2 = new pg.Client({ connectionString: database.url });
  await t1.connect();
  await t2.connect();
});
afterAll(async () => {
  await t1.end();
  await t2.end();
  await database.drop();
});

const owner = { actor: "admin" as const, subjectId: "a", sessionId: "s", zones: ["*"], perms: ["overview.read", "trips.read"] };
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("S04 A1: events committed out of order", () => {
  it("admin live feed: T1 inserts first, T2 commits first; both are delivered once", async () => {
    const listeners: (() => void)[] = [];
    const hub = { subscribe: (_c: string, fn: () => void) => (listeners.push(fn), () => undefined) } as unknown as NotificationHub;
    const feed = new AdminLiveFeed(database.db, hub, { warn: () => undefined });
    const sent: number[] = [];
    await feed.join({ who: owner, last: 0, catchingUp: true, send: (row) => sent.push(Number(row.sequence)), cursor: () => undefined, close: () => undefined });
    expect(ADMIN_EVENTS_CHANNEL).toBeTruthy();
    const notify = async () => {
      const before = feed.reads;
      for (const fn of listeners) fn();
      await until(() => feed.reads > before);
      await new Promise((r) => setTimeout(r, 30));
    };

    await t1.query("BEGIN");
    const a = await t1.query("INSERT INTO admin_live_events (type, entity_id, zone_id) VALUES ('trip.changed', 'first', 'Z001') RETURNING sequence");
    await t2.query("BEGIN");
    const b = await t2.query("INSERT INTO admin_live_events (type, entity_id, zone_id) VALUES ('trip.changed', 'second', 'Z001') RETURNING sequence");
    await t2.query("COMMIT");
    await notify();
    await t1.query("COMMIT");
    await notify();
    await notify();

    const low = Number(a.rows[0].sequence);
    const high = Number(b.rows[0].sequence);
    expect(low).toBeLessThan(high);
    expect(sent.sort((x, y) => x - y)).toEqual([low, high]);
  });

  it("dispatch stream cursor: same order, both once", async () => {
    await t1.query("INSERT INTO dispatch_events (kind, trip_id, occurred_at) VALUES ('offer_sent', 'seed', now())");
    const start = Number((await t1.query("SELECT max(sequence) AS m FROM dispatch_events")).rows[0].m);
    const cursor = new SettledCursor(start, "dispatch_events_sequence_seq");
    const got: number[] = [];
    const read = async () => {
      const { rows } = await cursor.next(database.db, 200, (from, limit) => dispatchEventsAfter(database.db, from, limit));
      got.push(...rows.map((r) => Number(r.sequence)));
    };
    await t1.query("BEGIN");
    await t1.query("INSERT INTO dispatch_events (kind, trip_id, occurred_at) VALUES ('offer_sent', 't1', now())");
    await t2.query("BEGIN");
    await t2.query("INSERT INTO dispatch_events (kind, trip_id, occurred_at) VALUES ('offer_sent', 't2', now())");
    await t2.query("COMMIT");
    await read();
    await t1.query("COMMIT");
    await read();
    await read();
    expect(got.sort((x, y) => x - y)).toEqual([start + 1, start + 2]);
  });
});
