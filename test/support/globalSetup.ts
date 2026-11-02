import pg from "pg";
import { migrate } from "../../src/db/migrate.js";

/**
 * Builds the template database once per test run: every migration applied to movera_test_template. Each test
 * file then clones it (test/support/db.ts), which takes milliseconds and keeps files from seeing each other.
 */
// TEST_TEMPLATE_DB: a separate template name lets several checkouts share one Postgres without dropping each other's.
export const TEMPLATE_DB = process.env.TEST_TEMPLATE_DB ?? "movera_test_template";

export function adminUrl(): string {
  return process.env.TEST_DATABASE_URL ?? "postgres://movera:movera@127.0.0.1:5432/movera";
}

export function urlFor(database: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

export default async function setup(): Promise<() => Promise<void>> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: urlFor(TEMPLATE_DB), max: 1 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  return async () => {
    const cleanup = new pg.Client({ connectionString: adminUrl() });
    await cleanup.connect();
    try {
      const left = await cleanup.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE 'movera_t\\_%'");
      for (const row of left.rows) await cleanup.query(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`);
      await cleanup.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };
}
