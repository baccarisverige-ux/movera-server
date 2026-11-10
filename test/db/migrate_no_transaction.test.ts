import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../../src/db/migrate.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

// Global-plan step 58 / owner rule 46: a migration may not lock a table while the app runs. CREATE INDEX
// CONCURRENTLY is the tool for that, and Postgres refuses it inside a transaction block, so a file whose first
// line is exactly `-- movera: no-transaction` runs outside BEGIN/COMMIT, statement by statement.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function emptyDb(): Promise<TestDatabase> {
  const database = await freshDatabase({ migrated: false });
  cleanups.push(database.drop);
  return database;
}

function copyOfMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "movera-migrations-"));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CONCURRENT_INDEX = "CREATE INDEX CONCURRENTLY IF NOT EXISTS trips_step58_test_idx ON trips (rider_id, created_at);\n";

async function indexExists(database: TestDatabase, name: string): Promise<boolean> {
  const result = await database.pool.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1", [name]);
  return result.rowCount === 1;
}

describe("migrate: -- movera: no-transaction", () => {
  it("without the marker, CREATE INDEX CONCURRENTLY still fails inside the transaction (unchanged behaviour)", async () => {
    const database = await emptyDb();
    const dir = copyOfMigrations();
    writeFileSync(join(dir, "0099_concurrent_index.sql"), `-- a comment, but not the marker\n${CONCURRENT_INDEX}-- undo: DROP INDEX CONCURRENTLY IF EXISTS trips_step58_test_idx;\n`);
    await expect(migrate(database.pool, dir)).rejects.toThrow(/0099_concurrent_index\.sql failed: .*cannot run inside a transaction block/);
    expect(await indexExists(database, "trips_step58_test_idx")).toBe(false);
  });

  it("with the marker on line 1, CREATE INDEX CONCURRENTLY runs and the migration is recorded once", async () => {
    const database = await emptyDb();
    const dir = copyOfMigrations();
    writeFileSync(
      join(dir, "0099_concurrent_index.sql"),
      `-- movera: no-transaction\n-- Step 58 test: an index the app can get while it runs.\n${CONCURRENT_INDEX}` +
        "ALTER TABLE trips ADD CONSTRAINT trips_step58_test_chk CHECK (char_length(trip_id) > 0) NOT VALID;\n" +
        "ALTER TABLE trips VALIDATE CONSTRAINT trips_step58_test_chk;\n" +
        "-- undo:\n-- DROP INDEX CONCURRENTLY IF EXISTS trips_step58_test_idx;\n-- ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_step58_test_chk;\n",
    );
    const applied = await migrate(database.pool, dir);
    expect(applied[applied.length - 1]).toBe("0099_concurrent_index.sql");
    expect(await indexExists(database, "trips_step58_test_idx")).toBe(true);
    const valid = await database.pool.query("SELECT convalidated FROM pg_constraint WHERE conname = 'trips_step58_test_chk'");
    expect(valid.rows).toEqual([{ convalidated: true }]);
    const recorded = await database.pool.query("SELECT name FROM schema_migrations WHERE name = '0099_concurrent_index.sql'");
    expect(recorded.rowCount).toBe(1);
    expect(await migrate(database.pool, dir)).toEqual([]);
  });

  it("the marker only counts on the first line", async () => {
    const database = await emptyDb();
    const dir = copyOfMigrations();
    writeFileSync(join(dir, "0099_concurrent_index.sql"), `-- Step 58\n-- movera: no-transaction\n${CONCURRENT_INDEX}`);
    await expect(migrate(database.pool, dir)).rejects.toThrow(/cannot run inside a transaction block/);
  });

  it("a failing no-transaction migration is not recorded and names the half-built index it left behind", async () => {
    const database = await emptyDb();
    const dir = copyOfMigrations();
    await migrate(database.pool, dir);
    await database.pool.query("CREATE TABLE step58_nums (n int)");
    await database.pool.query("INSERT INTO step58_nums VALUES (1), (0)");
    // 1/0 fails while the index is being built: Postgres keeps the index, marked INVALID (pg_index.indisvalid = false).
    writeFileSync(join(dir, "0099_half_built.sql"), "-- movera: no-transaction\nCREATE INDEX CONCURRENTLY step58_half_built_idx ON step58_nums ((1 / n));\n");
    await expect(migrate(database.pool, dir)).rejects.toThrow(/0099_half_built\.sql failed: .*division by zero.*step58_half_built_idx/s);
    const recorded = await database.pool.query("SELECT name FROM schema_migrations WHERE name = '0099_half_built.sql'");
    expect(recorded.rowCount).toBe(0);
  });

  it("an INVALID index present after a no-transaction migration stops the runner, naming the index", async () => {
    const database = await emptyDb();
    const dir = copyOfMigrations();
    await migrate(database.pool, dir);
    await database.pool.query("CREATE TABLE step58_nums (n int)");
    await database.pool.query("INSERT INTO step58_nums VALUES (1), (0)");
    // Simulate an index left half-built by an earlier crash or a killed CONCURRENTLY run.
    await expect(database.pool.query("CREATE INDEX CONCURRENTLY step58_stale_idx ON step58_nums ((1 / n))")).rejects.toThrow(/division by zero/);
    const stale = await database.pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid = 'step58_stale_idx'::regclass");
    expect(stale.rows).toEqual([{ indisvalid: false }]);
    writeFileSync(join(dir, "0099_fine.sql"), `-- movera: no-transaction\n${CONCURRENT_INDEX}`);
    await expect(migrate(database.pool, dir)).rejects.toThrow(/0099_fine\.sql.*INVALID index.*step58_stale_idx/s);
    // Not recorded: the next start retries after someone drops the invalid index.
    const recorded = await database.pool.query("SELECT name FROM schema_migrations WHERE name = '0099_fine.sql'");
    expect(recorded.rowCount).toBe(0);
  });
});
