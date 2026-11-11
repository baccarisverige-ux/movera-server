import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { splitSql } from "./splitSql.js";

/** migrations/NNNN_name.sql at the repository root (also copied into the container image). */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

const LOCK_KEY = 73_310_001;

/**
 * Owner rule 46 (global-plan step 58): a migration may not lock a table while the app runs. A file whose FIRST
 * line is exactly this marker runs outside BEGIN/COMMIT, one statement at a time, so CREATE INDEX CONCURRENTLY
 * and ADD CONSTRAINT ... NOT VALID / VALIDATE CONSTRAINT work. Such a file is not atomic: on failure, what ran
 * stays, the row in schema_migrations is not written, and the next start runs the whole file again, so write
 * every statement to be re-runnable (IF NOT EXISTS, IF EXISTS).
 */
/** How long a starting server sleeps between two tries of the migration lock. */
export const LOCK_RETRY_MS = 200;
export const NO_TRANSACTION_MARKER = "-- movera: no-transaction";

/**
 * B1.4 follow-up (owner W1 Q68, 2026-11-11: the database time limit "never on database changes"). The app pool has
 * DATABASE_STATEMENT_TIMEOUT_MS on every connection, and the server migrates at start on that pool. The migration
 * connection therefore turns the statement limit off (an index build or VALIDATE may take long) and sets lock_timeout
 * instead: a migration that waits for a busy table fails after this long (the next start tries again) rather than
 * queueing every app query behind its lock wait. 0 = no lock limit. Env: DATABASE_MIGRATION_LOCK_TIMEOUT_MS.
 */
export const MIGRATION_LOCK_TIMEOUT_MS = 5000;
export type MigrateOptions = { lockTimeoutMs?: number };

function wantsNoTransaction(sql: string): boolean {
  const eol = sql.indexOf("\n");
  return (eol === -1 ? sql : sql.slice(0, eol)).trimEnd() === NO_TRANSACTION_MARKER;
}

/** Names of indexes Postgres marked INVALID: a CREATE INDEX CONCURRENTLY that failed or was cut off. */
async function invalidIndexes(client: pg.PoolClient): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    "SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE NOT i.indisvalid ORDER BY 1",
  );
  return result.rows.map((row) => row.name);
}

function invalidIndexHint(names: string[]): string {
  return `INVALID index left behind: ${names.join(", ")}. Drop it (DROP INDEX CONCURRENTLY) and start again.`;
}

/** Runs a `-- movera: no-transaction` file statement by statement; never leaves an INVALID index unreported. */
/**
 * CREATE / DROP INDEX CONCURRENTLY and VALIDATE CONSTRAINT never block app reads or writes, but they wait for older
 * open transactions, and that wait counts as a lock wait: with the lock limit a busy deploy would fail them (leaving an
 * INVALID index), so they alone wait without it. Every other statement in the file (e.g. ADD CONSTRAINT … NOT VALID,
 * which takes a lock app queries queue behind) keeps the lock limit (supervisor #189 F1).
 */
const WAITS_WITHOUT_LIMIT = /\bCONCURRENTLY\b|\bVALIDATE\s+CONSTRAINT\b/i;

/**
 * True when the statement itself (not a comment, string literal, quoted identifier or dollar-quoted body) is a
 * CONCURRENTLY / VALIDATE CONSTRAINT statement. One left-to-right pass, so whichever starts first wins — an apostrophe in
 * a comment ("driver's") never opens a string that swallows the code (supervisor #189 F1b, F1c; same rule as splitSql).
 */
export function waitsWithoutLimit(statement: string): boolean {
  const code = statement.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\/\*[\s\S]*?\*\/|--[^\n]*|\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, " ");
  return WAITS_WITHOUT_LIMIT.test(code);
}

async function runWithoutTransaction(client: pg.PoolClient, name: string, sql: string, lockTimeoutMs: number): Promise<void> {
  try {
    for (const statement of splitSql(sql)) {
      if (!waitsWithoutLimit(statement)) {
        await client.query(statement);
        continue;
      }
      await client.query("SET lock_timeout = 0");
      try {
        await client.query(statement);
      } finally {
        // A dead connection must not hide the real error (and the INVALID-index hint); it is destroyed anyway.
        await client.query(`SET lock_timeout = ${lockTimeoutMs}`).catch(() => undefined);
      }
    }
  } catch (error) {
    const invalid = await invalidIndexes(client).catch(() => []);
    const tail = invalid.length ? ` ${invalidIndexHint(invalid)}` : "";
    throw new Error(`Migration ${name} failed: ${(error as Error).message}.${tail}`);
  }
  const invalid = await invalidIndexes(client);
  if (invalid.length) throw new Error(`Migration ${name} ran, but not recorded: ${invalidIndexHint(invalid)}`);
}

/**
 * Applies every migration not applied yet, in name order, each in its own transaction (except files that start
 * with NO_TRANSACTION_MARKER), under an advisory lock so two instances starting together never race. A migration that was applied and later edited stops the
 * server: migrations are append-only; change the schema with a new file.
 */
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR, options: MigrateOptions = {}): Promise<string[]> {
  const lockTimeoutMs = Math.max(0, Math.round(options.lockTimeoutMs ?? MIGRATION_LOCK_TIMEOUT_MS));
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // B1.4: session settings of this connection only; it is closed (never handed back to the app pool) at the end.
    await client.query("SET statement_timeout = 0");
    await client.query(`SET lock_timeout = ${lockTimeoutMs}`);
    // Stress T-A follow-up (0091, the first no-transaction file): a server WAITING in pg_advisory_lock is a running
    // statement, and CREATE INDEX CONCURRENTLY of the server holding the lock waits for every running statement to
    // end, so two servers starting together deadlocked. Ask with pg_try_advisory_lock and sleep between tries instead.
    while (!(await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY])).rows[0]!.ok) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Map<string, string>(
      (await client.query<{ name: string; sha256: string }>("SELECT name, sha256 FROM schema_migrations")).rows.map((row) => [row.name, row.sha256]),
    );
    const files = readdirSync(dir).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
    for (const name of files) {
      const sql = readFileSync(`${dir}/${name}`, "utf8");
      const sha = createHash("sha256").update(sql).digest("hex");
      const known = done.get(name);
      if (known !== undefined) {
        if (known !== sha) throw new Error(`Migration ${name} changed after it was applied. Add a new migration instead.`);
        continue;
      }
      if (wantsNoTransaction(sql)) {
        await runWithoutTransaction(client, name, sql, lockTimeoutMs);
        await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [name, sha]);
      } else {
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [name, sha]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw new Error(`Migration ${name} failed: ${(error as Error).message}`);
        }
      }
      applied.push(name);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    // B1.4: close the connection so its migration settings (no statement limit) never serve an app query.
    client.release(true);
  }
}
