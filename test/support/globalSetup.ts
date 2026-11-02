import pg from "pg";
import { migrate } from "../../src/db/migrate.js";

/**
 * Builds the template database once per test run: every migration applied to movera_test_template. Each test
 * file then clones it (test/support/db.ts), which takes milliseconds and keeps files from seeing each other.
 */
<<<<<<< HEAD
/** Several test runs on one server (parallel worktrees) each set their own TEST_TEMPLATE_DB. */
export const TEMPLATE_DB = process.env.TEST_TEMPLATE_DB ?? "movera_test_template";

=======
>>>>>>> 8f82eeb (A2: rider moderation — Warn → Pause → Ban with reasons (G16 Q16-1/Q16-2), contract 0.18.16)
export function adminUrl(): string {
  return process.env.TEST_DATABASE_URL ?? "postgres://movera:movera@127.0.0.1:5432/movera";
}

/**
 * Test databases are named after TEST_DATABASE_URL's database ("movera" → movera_test_template / movera_t_*, as
 * before). Another name (e.g. movera_a2) gets its own template and clones, so runs that share one Postgres never
 * drop each other's databases.
 */
const base = decodeURIComponent(new URL(adminUrl()).pathname.slice(1)) || "movera";
export const TEST_DB_PREFIX = /^[a-z0-9_]+$/.test(base) ? base : "movera";
export const TEMPLATE_DB = `${TEST_DB_PREFIX}_test_template`;

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
      const left = await cleanup.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE $1", [`${TEST_DB_PREFIX.replace(/_/g, "\\_")}\\_t\\_%`]);
      for (const row of left.rows) await cleanup.query(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`);
      await cleanup.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
  };
}
