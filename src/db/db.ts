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
