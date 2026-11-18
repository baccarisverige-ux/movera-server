import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OUTAGE_KEEP_DAYS, OutageRecorder } from "../../src/realtime/outages.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * S4 B1.16 Q-B13: the outage recorder writes one row per outage of this copy: down_at = the hub's last proof the
 * link worked, seen_at moved on each "still down", up_at at the reconnect. A write that fails (the database itself is
 * down) is done later: the row is written at the next call that works, at the latest with the reconnect. Rows older
 * than OUTAGE_KEEP_DAYS are pruned at each reconnect.
 */
let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});
beforeEach(async () => {
  await sql`DELETE FROM realtime_outages`.execute(database.db);
});

const T0 = new Date("2026-11-16T10:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
type Row = { copy_id: string; down_at: Date; seen_at: Date; up_at: Date | null };
const rows = async () => (await sql<Row>`SELECT copy_id, down_at, seen_at, up_at FROM realtime_outages ORDER BY outage_id`.execute(database.db)).rows;

describe("Q-B13 outage recorder", () => {
  it("down, still down, up: one row with the window", async () => {
    const clock = { now: at(10) };
    const rec = new OutageRecorder(database.db, "copy-1", { warn: () => undefined }, () => clock.now);
    rec.down(at(3));
    await rec.settled();
    expect(await rows()).toEqual([{ copy_id: "copy-1", down_at: at(3), seen_at: at(10), up_at: null }]);
    clock.now = at(40);
    rec.stillDown();
    await rec.settled();
    expect((await rows())[0]!.seen_at).toEqual(at(40));
    clock.now = at(55);
    rec.up(at(55));
    await rec.settled();
    expect(await rows()).toEqual([{ copy_id: "copy-1", down_at: at(3), seen_at: at(55), up_at: at(55) }]);
  });

  it("a write that fails while the database is down is written at the next call that works", async () => {
    const clock = { now: at(10) };
    let broken = true;
    const real = database.db;
    const bound = (t: object, p: string | symbol) => {
      const v = Reflect.get(t, p) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    };
    const flaky = new Proxy(real, { get: (t, p) => (broken && (p === "insertInto" || p === "updateTable") ? () => { throw new Error("db down"); } : bound(t, p)) });
    const warns: string[] = [];
    const rec = new OutageRecorder(flaky as never, "copy-2", { warn: (_d, m) => void warns.push(m) }, () => clock.now);
    rec.down(at(3));
    rec.stillDown();
    await rec.settled();
    expect(await rows()).toEqual([]);
    expect(warns).toHaveLength(1);
    broken = false;
    clock.now = at(70);
    rec.up(at(70));
    await rec.settled();
    expect(await rows()).toEqual([{ copy_id: "copy-2", down_at: at(3), seen_at: at(70), up_at: at(70) }]);
  });

  it("at a reconnect, rows older than the keep time are pruned", async () => {
    await sql`INSERT INTO realtime_outages (copy_id, down_at, seen_at, up_at) VALUES ('old', ${at(-OUTAGE_KEEP_DAYS * 86400 - 100)}, ${at(-OUTAGE_KEEP_DAYS * 86400 - 90)}, ${at(-OUTAGE_KEEP_DAYS * 86400 - 90)})`.execute(database.db);
    const clock = { now: at(10) };
    const rec = new OutageRecorder(database.db, "copy-3", { warn: () => undefined }, () => clock.now);
    rec.down(at(1));
    rec.up(at(10));
    await rec.settled();
    expect((await rows()).map((r) => r.copy_id)).toEqual(["copy-3"]);
  });
});
