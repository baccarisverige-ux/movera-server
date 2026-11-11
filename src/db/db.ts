import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";
import { recordQuery } from "../telemetry/load.js";

export type Db = Kysely<Database>;
export type Trx = Transaction<Database>;
/** A connection or an open transaction: functions that write take this so callers choose the transaction. */
export type Executor = Db | Trx;

/**
 * bigint columns come back as strings (pg's default); code converts them where it reads them.
 * An idle connection that the database drops (restart, failover) is reported, not fatal: the pool opens a new
 * one on the next query, and /readyz shows whether the database is reachable.
 */
export type PoolOptions = { max?: number; idleMs?: number; connectTimeoutMs?: number; statementTimeoutMs?: number };

let current: pg.Pool | undefined;
let currentMax = 0;

export function createPool(url: string, options: number | PoolOptions = {}, onIdleError: (error: Error) => void = () => undefined): pg.Pool {
  const { max = 10, idleMs = 30_000, connectTimeoutMs = 0, statementTimeoutMs = 0 } = typeof options === "number" ? { max: options } : options;
  // S05 D1: statement_timeout is a connection setting of the pool itself, so EVERY connection has it from its first
  // statement (also the one waitForDatabase/migrate open before anything else); 0 = no limit.
  const pool = new pg.Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: idleMs,
    connectionTimeoutMillis: connectTimeoutMs,
    application_name: "movera-server",
    ...(statementTimeoutMs > 0 ? { statement_timeout: Math.round(statementTimeoutMs) } : {}),
  });
  pool.on("error", onIdleError);
  current = pool;
  currentMax = max;
  return pool;
}

/** B12: the pool settings from the environment. */
export function poolOptionsFrom(env: { DATABASE_POOL_MAX: number; DATABASE_POOL_IDLE_MS: number; DATABASE_POOL_CONNECT_TIMEOUT_MS: number }): PoolOptions {
  return { max: env.DATABASE_POOL_MAX, idleMs: env.DATABASE_POOL_IDLE_MS, connectTimeoutMs: env.DATABASE_POOL_CONNECT_TIMEOUT_MS };
}

export type PoolStats = { max: number; total: number; idle: number; waiting: number };

/** B12: counts only (no address, user or password), for /healthz. */
export function poolStats(pool: pg.Pool | undefined = current): PoolStats | null {
  if (pool === undefined) return null;
  return { max: pool === current ? currentMax : pool.options.max ?? 0, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

export function createDb(pool: pg.Pool): Db {
  // Step 63 (T6): each statement's time goes to the request it ran for (Server-Timing `db`); nothing is logged.
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }), log: (event) => recordQuery(event.queryDurationMillis) });
}

/**
 * Job 1 (fix plan R22, audits/stress-test-2026-11-04.md H3): every connection the pool opens from now on stops a single
 * statement after `ms` (0: no limit), so one slow query can never hold a connection for ever under a spike.
 * S05 D1: the server now passes `statementTimeoutMs` to createPool instead (this hook missed connections opened
 * before it was added); kept for callers that build a pool themselves.
 */
export function limitStatements(pool: pg.Pool, ms: number): void {
  if (ms <= 0) return;
  pool.on("connect", (client) => {
    client.query(`SET statement_timeout = ${Math.round(ms)}`).catch(() => undefined);
  });
}

/**
 * Job 1 (fix plan R22): errors that mean "the database is overloaded right now", not a bug: no free pooled connection in
 * time (pg-pool), a statement stopped by statement_timeout (57014), a lock wait stopped by lock_timeout (55P03), and (E5) a transaction Postgres rolled back as a deadlock
 * victim (40P01) or for a serialization failure (40001): trying again in a moment succeeds.
 * The API answers them 503 unavailable, reason server_busy, retryable, with Retry-After.
 */
const BUSY_CODES = new Set(["57014", "55P03", "40P01", "40001"]);
export function isDatabaseBusy(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | undefined;
  if (e === undefined || e === null) return false;
  if (e.code !== undefined && BUSY_CODES.has(e.code)) return true;
  return typeof e.message === "string" && /timeout exceeded when trying to connect/i.test(e.message);
}
