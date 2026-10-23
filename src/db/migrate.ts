import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/** migrations/NNNN_name.sql at the repository root (also copied into the container image). */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

const LOCK_KEY = 73_310_001;

/**
 * Applies every migration not applied yet, in name order, each in its own transaction, under an advisory lock
 * so two instances starting together never race. A migration that was applied and later edited stops the
 * server: migrations are append-only; change the schema with a new file.
 */
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
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
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [name, sha]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${name} failed: ${(error as Error).message}`);
      }
      applied.push(name);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
