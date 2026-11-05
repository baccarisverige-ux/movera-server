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
export type PoolOptions = { max?: number; idleMs?: number; connectTimeoutMs?: number };

let current: pg.Pool | undefined;
let currentMax = 0;

export function createPool(url: string, options: number | PoolOptions = {}, onIdleError: (error: Error) => void = () => undefined): pg.Pool {
  const { max = 10, idleMs = 30_000, connectTimeoutMs = 0 } = typeof options === "number" ? { max: options } : options;
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: idleMs, connectionTimeoutMillis: connectTimeoutMs, application_name: "movera-server" });
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
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
