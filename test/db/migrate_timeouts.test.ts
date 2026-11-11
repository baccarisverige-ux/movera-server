import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, NO_TRANSACTION_MARKER, migrate } from "../../src/db/migrate.js";
import { createPool } from "../../src/db/db.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

// B1.4 follow-up (owner W1 Q68, 2026-11-11: "Database time limit set safely, also on the first connection, never on
// database changes"). The server migrates at start on its app pool, which has DATABASE_STATEMENT_TIMEOUT_MS on every
// connection. A migration must never run under that limit (a long index build or VALIDATE would fail the deploy), but
// it must stop waiting for a busy table after DATABASE_MIGRATION_LOCK_TIMEOUT_MS instead of queueing every query
// behind it. App connections keep their statement limit.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function migratedDb(): Promise<TestDatabase> {
  const database = await freshDatabase();
  cleanups.push(database.drop);
  return database;
}

/** The real migrations (already applied in the template) plus the given extra files. */
function migrationsWith(extra: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "movera-migrations-"));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  for (const [name, sql] of Object.entries(extra)) writeFileSync(join(dir, name), sql);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The app pool as main.ts builds it, with a 1 s statement limit (scaled down from the 30 s default). */
function appPool(database: TestDatabase): pg.Pool {
  const pool = createPool(database.url, { max: 3, statementTimeoutMs: 1000 });
  cleanups.push(() => pool.end());
  return pool;
}

async function recorded(database: TestDatabase, name: string): Promise<boolean> {
  return (await database.pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name])).rowCount === 1;
}

const SLOW = "SELECT pg_sleep(2);\nCREATE TABLE b14_slow (id int);\n";
const SLOW_NO_TX = `${NO_TRANSACTION_MARKER}\nSELECT pg_sleep(2);\nCREATE TABLE IF NOT EXISTS b14_slow_no_tx (id int);\n`;

describe("B1.4: migrations run without the app statement limit, with a lock limit", () => {
  it("a start-up migration longer than the app statement limit still applies (both kinds)", async () => {
    const database = await migratedDb();
    const pool = appPool(database);
    const dir = migrationsWith({ "9998_b14_slow.sql": SLOW, "9999_b14_slow_no_tx.sql": SLOW_NO_TX });
    expect(await migrate(pool, dir)).toEqual(["9998_b14_slow.sql", "9999_b14_slow_no_tx.sql"]);
    expect(await recorded(database, "9998_b14_slow.sql")).toBe(true);
    expect(await recorded(database, "9999_b14_slow_no_tx.sql")).toBe(true);
  }, 20_000);

  it("app connections keep the statement limit after migrating (the migration settings never leak into the pool)", async () => {
    const database = await migratedDb();
    const pool = appPool(database);
    await migrate(pool, migrationsWith({ "9998_b14_slow.sql": SLOW }));
    const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    try {
      for (const client of clients) {
        const row = (await client.query<{ s: string; l: string }>("SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l")).rows[0]!;
        expect(row).toEqual({ s: "1s", l: "0" });
      }
      await expect(clients[0]!.query("SELECT pg_sleep(2)")).rejects.toMatchObject({ code: "57014" });
    } finally {
      for (const client of clients) client.release();
    }
  }, 20_000);

  it("a migration waiting on a table another session holds fails within the lock limit instead of hanging", async () => {
    const database = await migratedDb();
    const pool = appPool(database);
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE riders IN ACCESS SHARE MODE");
    const dir = migrationsWith({ "9999_b14_alter.sql": "ALTER TABLE riders ADD COLUMN b14_x int;\n" });
    const started = Date.now();
    await expect(migrate(pool, dir, { lockTimeoutMs: 500 })).rejects.toThrow(/9999_b14_alter\.sql failed: .*lock timeout/);
    expect(Date.now() - started).toBeLessThan(3000);
    await holder.query("ROLLBACK");
    expect(await recorded(database, "9999_b14_alter.sql")).toBe(false);
    // Once the table is free, the next start applies it.
    expect(await migrate(pool, dir, { lockTimeoutMs: 500 })).toEqual(["9999_b14_alter.sql"]);
  }, 10_000);

  it("the lock limit defaults to 5 s (env and migrate) and statement_timeout is off inside a migration", async () => {
    expect(readEnv({ MOVERA_ENV: "development" }).DATABASE_MIGRATION_LOCK_TIMEOUT_MS).toBe(5000);
    expect(readEnv({ MOVERA_ENV: "development", DATABASE_MIGRATION_LOCK_TIMEOUT_MS: "0" }).DATABASE_MIGRATION_LOCK_TIMEOUT_MS).toBe(0);
    const database = await migratedDb();
    const check = (want: string) =>
      `DO $$ BEGIN IF current_setting('statement_timeout') <> '0' OR current_setting('lock_timeout') <> '${want}' THEN ` +
      `RAISE EXCEPTION 'statement_timeout=% lock_timeout=%', current_setting('statement_timeout'), current_setting('lock_timeout'); END IF; END $$;\n`;
    expect(await migrate(appPool(database), migrationsWith({ "9998_b14_check.sql": check("5s") }))).toEqual(["9998_b14_check.sql"]);
    expect(await migrate(appPool(database), migrationsWith({ "9998_b14_check.sql": check("5s"), "9999_b14_check.sql": `${NO_TRANSACTION_MARKER}\n${check("1500ms")}` }), { lockTimeoutMs: 1500 })).toEqual(["9999_b14_check.sql"]);
  }, 20_000);

  it("a no-transaction CREATE INDEX CONCURRENTLY waits for an older open transaction instead of failing on the lock limit (it never blocks the app)", async () => {
    const database = await migratedDb();
    const pool = appPool(database);
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE riders IN ROW EXCLUSIVE MODE"); // an open write transaction, as during a deploy
    const release = setTimeout(() => void holder.query("COMMIT"), 1500);
    cleanups.push(() => clearTimeout(release));
    const dir = migrationsWith({ "9999_b14_cic.sql": `${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS b14_cic_idx ON riders (created_at);\n` });
    expect(await migrate(pool, dir, { lockTimeoutMs: 500 })).toEqual(["9999_b14_cic.sql"]);
    expect(await recorded(database, "9999_b14_cic.sql")).toBe(true);
  }, 20_000);

  it("in a no-transaction file only CONCURRENTLY / VALIDATE wait without the limit: an ADD CONSTRAINT … NOT VALID on a held table fails within the lock limit (supervisor #189 F1)", async () => {
    const database = await migratedDb();
    const pool = appPool(database);
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE riders IN ACCESS SHARE MODE");
    const dir = migrationsWith({ "9999_b14_nv.sql": `${NO_TRANSACTION_MARKER}\nALTER TABLE riders ADD CONSTRAINT b14_nv_chk CHECK (true) NOT VALID;\n` });
    const started = Date.now();
    await expect(migrate(pool, dir, { lockTimeoutMs: 500 })).rejects.toThrow(/9999_b14_nv\.sql failed: .*lock timeout/);
    expect(Date.now() - started).toBeLessThan(3000);
    await holder.query("ROLLBACK");
  }, 20_000);

  it("a transactional file after a no-transaction file gets the lock limit back (supervisor #189 F2)", async () => {
    const database = await migratedDb();
    const check = (want: string) =>
      `DO $$ BEGIN IF current_setting('lock_timeout') <> '${want}' THEN RAISE EXCEPTION 'lock_timeout=%', current_setting('lock_timeout'); END IF; END $$;\n`;
    const dir = migrationsWith({
      "9998_b14_cic2.sql": `${NO_TRANSACTION_MARKER}\nCREATE INDEX CONCURRENTLY IF NOT EXISTS b14_cic2_idx ON riders (created_at);\n`,
      "9999_b14_after.sql": check("5s"),
    });
    expect(await migrate(appPool(database), dir)).toEqual(["9998_b14_cic2.sql", "9999_b14_after.sql"]);
  }, 20_000);

  it("two copies starting at once with the statement limit: the slow migration is applied once (Rule 33)", async () => {
    const database = await migratedDb();
    const dir = migrationsWith({ "9998_b14_slow.sql": SLOW, "9999_b14_slow_no_tx.sql": SLOW_NO_TX });
    const [a, b] = await Promise.all([migrate(appPool(database), dir), migrate(appPool(database), dir)]);
    expect([...a, ...b].sort()).toEqual(["9998_b14_slow.sql", "9999_b14_slow_no_tx.sql"]);
  }, 20_000);
});
