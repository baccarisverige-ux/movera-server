import { randomBytes } from "node:crypto";
import pg from "pg";
import { createDb, createPool, type Db } from "../../src/db/db.js";
import { RUN_DB_PREFIX, TEMPLATE_DB, adminUrl, urlFor } from "./globalSetup.js";

export type TestDatabase = { name: string; url: string; pool: pg.Pool; db: Db; drop: () => Promise<void> };

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** A new database for one test file. `migrated: false` gives an empty one (for testing migrations themselves). */
export async function freshDatabase({ migrated = true }: { migrated?: boolean } = {}): Promise<TestDatabase> {
  const name = `${RUN_DB_PREFIX}${randomBytes(6).toString("hex")}`;
  await admin((client) => client.query(migrated ? `CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}` : `CREATE DATABASE ${name}`));
  const url = urlFor(name);
  const pool = createPool(url, 10);
  const db = createDb(pool);
  return {
    name,
    url,
    pool,
    db,
    drop: async () => {
      await db.destroy();
      // Kysely only ends a pool it has used; tests that talk to the pool directly need this.
      if (!pool.ended) await pool.end();
      await admin((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
