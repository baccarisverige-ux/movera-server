import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contract } from "../../src/contract/contract.js";
import { migrate } from "../../src/db/migrate.js";
import { splitSql } from "../../src/db/splitSql.js";
import { TRIP_EVENT_KINDS, appendTripEvent, assertTripEventKind, type TripEventKind } from "../../src/db/tripLog.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertRider, insertTrip } from "../support/seed.js";

/**
 * S7 W2 Q135 (Q-B10; owner 2026-11-15 "A) yes", Rules decisions/session-2026-11-06.md "Sitting W2"): trip event kinds
 * are checked in code, not by a CHECK on trip_events (the biggest table). Migration 0115 drops trip_events_kind_check;
 * TRIP_EVENT_KINDS in src/db/tripLog.ts is the one list and appendTripEvent (the only insert path) refuses any other
 * kind before it writes. The list must stay equal to the contract's realtime.kinds and to the last CHECK (0085), which
 * is also what 0115's undo puts back.
 */

const NAME = "0115_trip_events_kind_in_code.sql";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));
const FILE = `${MIGRATIONS}${NAME}`;

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database?.drop();
});

const rows = async <T>(q: string, args: unknown[] = []) => (await database.pool.query(q, args)).rows as T[];
const newTrip = async () => insertTrip(database.db, await insertRider(database.db));
const quoted = (text: string) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
/** The kind list of the CHECK a migration text adds (the text after `ADD CONSTRAINT trip_events_kind_check`, to its `;`). */
function checkKinds(text: string): string[] {
  const at = text.lastIndexOf("ADD CONSTRAINT trip_events_kind_check");
  if (at === -1) throw new Error("no ADD CONSTRAINT trip_events_kind_check in the text");
  return quoted(text.slice(at, text.indexOf(";", at)));
}
const undoOf = (text: string) => text.slice(text.indexOf("-- undo:") + "-- undo:".length).split("\n").map((l) => l.replace(/^--\s?/, "")).join("\n");
const kindChecks = () =>
  rows<{ conname: string; convalidated: boolean; def: string }>(
    `SELECT conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'trip_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~ '\\mkind\\M'`);
const rawInsert = (tripId: string, sequence: number, kind: string) =>
  database.pool.query("INSERT INTO trip_events (trip_id, sequence, event_id, kind, version, occurred_at) VALUES ($1, $2, $3, $4, 1, now())", [tripId, sequence, `evt_q135_${tripId}_${sequence}`, kind]);

describe("Q135 the one list of trip event kinds (src/db/tripLog.ts TRIP_EVENT_KINDS)", () => {
  it("is the contract's realtime.kinds, in the same order", () => {
    expect([...TRIP_EVENT_KINDS]).toEqual((contract as unknown as { realtime: { kinds: string[] } }).realtime.kinds);
  });

  it("is the list of the last CHECK a migration set (so nothing the database allowed before 0115 is refused now)", () => {
    const setters = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f !== NAME).sort()
      .filter((f) => /^\s*ALTER TABLE trip_events ADD CONSTRAINT trip_events_kind_check/m.test(readFileSync(`${MIGRATIONS}${f}`, "utf8")));
    expect(setters).toEqual(["0041_pickup_waiting.sql", "0085_trip_calls.sql"]);
    expect(checkKinds(readFileSync(`${MIGRATIONS}${setters.at(-1)!}`, "utf8"))).toEqual([...TRIP_EVENT_KINDS]);
  });

  it("is the list 0115's undo puts back", () => {
    expect(checkKinds(undoOf(readFileSync(FILE, "utf8")))).toEqual([...TRIP_EVENT_KINDS]);
  });

  it("has no kind twice", () => {
    expect(new Set(TRIP_EVENT_KINDS).size).toBe(TRIP_EVENT_KINDS.length);
  });

  it("only src/db/tripLog.ts inserts into trip_events (the guard cannot be walked around)", () => {
    const grep = spawnSync("grep", ["-rlE", "insertInto\\(\\s*[\"'`]trip_events|INSERT INTO trip_events", "src"], { cwd: ROOT, encoding: "utf8" });
    expect(grep.stdout.trim().split("\n")).toEqual(["src/db/tripLog.ts"]);
    expect(readFileSync(`${ROOT}src/db/tripLog.ts`, "utf8").match(/insertInto\("trip_events"\)/g)).toHaveLength(1);
  });
});

describe("Q135 the code guard", () => {
  it("assertTripEventKind refuses an unknown kind and takes every current one", () => {
    for (const bad of ["trip_shared", "", "LOCATION", "location ", "toString", "constructor"]) {
      expect(() => assertTripEventKind(bad), bad).toThrow(/Unknown trip event kind/);
    }
    for (const kind of TRIP_EVENT_KINDS) expect(() => assertTripEventKind(kind), kind).not.toThrow();
  });

  it("appendTripEvent refuses an unknown kind BEFORE it writes: no event row, the trip's sequence is not taken", async () => {
    const tripId = await newTrip();
    const before = await rows<{ sequence: string }>("SELECT sequence FROM trips WHERE trip_id = $1", [tripId]);
    await expect(
      database.db.transaction().execute((trx) => appendTripEvent(trx, { tripId, kind: "trip_shared" as TripEventKind, version: 1 })),
    ).rejects.toThrow(/Unknown trip event kind "trip_shared"/);
    // Also outside a rolled-back transaction nothing was sent: the guard runs before the first statement.
    const statements: string[] = [];
    const spy = { updateTable: () => { statements.push("update"); throw new Error("reached the database"); } } as never;
    await expect(appendTripEvent(spy, { tripId, kind: "nope" as TripEventKind, version: 1 })).rejects.toThrow(/Unknown trip event kind "nope"/);
    expect(statements).toEqual([]);
    expect(await rows("SELECT sequence FROM trips WHERE trip_id = $1", [tripId])).toEqual(before);
    expect(await rows("SELECT 1 FROM trip_events WHERE trip_id = $1", [tripId])).toEqual([]);
  });

  it("appendTripEvent takes every current kind", async () => {
    const tripId = await newTrip();
    await database.db.transaction().execute(async (trx) => {
      for (const kind of TRIP_EVENT_KINDS) await appendTripEvent(trx, { tripId, kind, version: 1 });
    });
    const written = await rows<{ kind: string }>("SELECT kind FROM trip_events WHERE trip_id = $1 ORDER BY sequence", [tripId]);
    expect(written.map((r) => r.kind)).toEqual([...TRIP_EVENT_KINDS]);
  });
});

describe(`Q135 migration ${NAME}`, () => {
  it("passes tools/check_migrations.py (R1-R4: an undo is written, no table lock held while it scans)", () => {
    const run = spawnSync("python3", ["tools/check_migrations.py", `migrations/${NAME}`], { cwd: ROOT, encoding: "utf8" });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain("0 finding(s)");
  });

  it("no CHECK on trip_events.kind remains; the column is still NOT NULL text; the other checks stay", async () => {
    expect(await kindChecks()).toEqual([]);
    expect(await rows("SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'trip_events' AND column_name = 'kind'")).toEqual([{ data_type: "text", is_nullable: "NO" }]);
    const left = await rows<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conrelid = 'trip_events'::regclass AND contype = 'c' ORDER BY conname");
    expect(left.map((r) => r.conname)).toEqual(["trip_events_sequence_check", "trip_events_version_check"]);
  });

  it("the database alone no longer refuses a kind (so the code guard is the only gate)", async () => {
    const tripId = await newTrip();
    await rawInsert(tripId, 1, "kind_of_a_later_release");
    await database.pool.query("DELETE FROM trip_events WHERE trip_id = $1", [tripId]);
  });

  it("the written undo puts the CHECK back, validated, with today's list; the file then runs again and drops it", async () => {
    const tripId = await newTrip();
    for (const statement of splitSql(undoOf(readFileSync(FILE, "utf8")))) await database.pool.query(statement);
    const back = await kindChecks();
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ conname: "trip_events_kind_check", convalidated: true });
    expect(quoted(back[0]!.def)).toEqual([...TRIP_EVENT_KINDS]);
    await expect(rawInsert(tripId, 1, "kind_of_a_later_release")).rejects.toMatchObject({ code: "23514", constraint: "trip_events_kind_check" });
    await rawInsert(tripId, 1, "location");
    // The undo is safe to run twice.
    for (const statement of splitSql(undoOf(readFileSync(FILE, "utf8")))) await database.pool.query(statement);
    expect(await kindChecks()).toHaveLength(1);

    await database.pool.query("DELETE FROM schema_migrations WHERE name = $1", [NAME]);
    expect(await migrate(database.pool)).toEqual([NAME]);
    expect(await kindChecks()).toEqual([]);
    await rawInsert(tripId, 2, "kind_of_a_later_release");
  });

  it("the undo after a newer kind was written: the CHECK goes on for new rows, VALIDATE names the old rows", async () => {
    // State left by the test above: one row with a kind outside the list.
    const [add, validate] = splitSql(undoOf(readFileSync(FILE, "utf8"))).filter((s) => /trip_events_kind_check/.test(s) && !/^\s*ALTER TABLE trip_events DROP/i.test(s));
    const statements = splitSql(undoOf(readFileSync(FILE, "utf8")));
    expect(statements.at(-1)).toMatch(/VALIDATE CONSTRAINT trip_events_kind_check/);
    for (const statement of statements.slice(0, -1)) await database.pool.query(statement);
    await expect(database.pool.query(statements.at(-1)!)).rejects.toMatchObject({ code: "23514" });
    expect(await kindChecks()).toMatchObject([{ conname: "trip_events_kind_check", convalidated: false }]);
    expect(add).toMatch(/NOT VALID/);
    expect(validate).toMatch(/VALIDATE/);
    await database.pool.query("ALTER TABLE trip_events DROP CONSTRAINT IF EXISTS trip_events_kind_check");
  });
});
