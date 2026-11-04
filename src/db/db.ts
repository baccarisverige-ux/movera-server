import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";

export type Db = Kysely<Database>;
export type Trx = Transaction<Database>;
/** A connection or an open transaction: functions that write take this so callers choose the transaction. */
export type Executor = Db | Trx;

/**
 * bigint columns come back as strings (pg's default); code converts them where it reads them.
 * An idle connection that the database drops (restart, failover) is reported, not fatal: the pool opens a new
 * one on the next query, and /readyz shows whether the database is reachable.
 */
export function createPool(url: string, max = 10, onIdleError: (error: Error) => void = () => undefined): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max, application_name: "movera-server" });
  pool.on("error", onIdleError);
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Job 1 (fix plan R22, audits/stress-test-2026-11-04.md H3): every connection the pool opens from now on stops a single
 * statement after `ms` (0: no limit), so one slow query can never hold a connection for ever under a spike.
 */
export function limitStatements(pool: pg.Pool, ms: number): void {
  if (ms <= 0) return;
  pool.on("connect", (client) => {
    client.query(`SET statement_timeout = ${Math.round(ms)}`).catch(() => undefined);
  });
}

/**
 * Job 1 (fix plan R22): errors that mean "the database is overloaded right now", not a bug: no free pooled connection in
 * time (pg-pool), a statement stopped by statement_timeout (57014), a lock wait stopped by lock_timeout (55P03).
 * The API answers them 503 unavailable, reason server_busy, retryable, with Retry-After.
 */
export function isDatabaseBusy(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | undefined;
  if (e === undefined || e === null) return false;
  if (e.code === "57014" || e.code === "55P03") return true;
  return typeof e.message === "string" && /timeout exceeded when trying to connect/i.test(e.message);
}
