import { sql, type SelectQueryBuilder } from "kysely";
import { poolStats, type Db, type Executor } from "../db/db.js";

/**
 * L78-S (contract v0.18.78, contract.json#adminListFilters.total): the exact number of rows a list query matches,
 * counted without cursor and limit, for the first page of the 10 admin lists. Rule 33, "the count never fails or slows
 * the list":
 * - the count asks for its connection only after the page has asked for its own (one macrotask later), and only when
 *   the pool is not under pressure: nothing waiting, and an idle connection or room to open one (poolStats);
 * - it runs in its own short transaction under SET LOCAL statement_timeout = timeoutMs (an abandoned count stops soon)
 *   and without parallel workers (it never takes CPU workers from the page beside it);
 * - once the page is built the list waits for the count at most waitAfterPageMs more; a later, failed, timed-out or
 *   skipped count gives `undefined`, total is left out and the page is served unchanged. A count abandoned before it got
 *   its connection runs no statement on it.
 * Never cached: every admin and every server copy counts its own query.
 */
// timeoutMs 50, not 150 (fix round F1): the count is only sent when it ends within 25 ms of the page, and a count
// still running beside a heavy page slowed that page by 40-70 ms at 10k (riders / refunds of one zone); at 50 ms it is
// within the 25 ms (audits/impact/server-l78s.md "Fix round").
export const LIST_COUNT = { timeoutMs: 50, waitAfterPageMs: 25 };

// The query builder's row type does not matter here: only its FROM / JOIN / WHERE are counted.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = SelectQueryBuilder<any, any, any>;

export type PendingTotal = { result: Promise<number | undefined>; abandon: () => void };

/** True when a count must not take a connection now: someone is waiting, or none is free and none can be opened. */
export function poolUnderPressure(): boolean {
  const stats = poolStats();
  if (stats === null) return false;
  return stats.waiting > 0 || (stats.idle === 0 && stats.total >= stats.max);
}

/**
 * `query` is the list's query with every filter but no cursor, order or limit. Call it right before the page query is
 * sent; finish with `totalAfterPage`. Inside an open transaction (no list route reads in one) total is not counted:
 * SET LOCAL there would change the caller's transaction.
 */
export function countTotal(ex: Executor, query: AnyQuery): PendingTotal | undefined {
  if (ex.isTransaction) return undefined;
  const compiled = query
    .clearSelect()
    .clearOrderBy()
    .select((eb) => eb.fn.countAll<string>().as("total"))
    .compile();
  const budget = Math.max(1, Math.round(LIST_COUNT.timeoutMs));
  let abandoned = false;
  const result = new Promise<void>((resolve) => setImmediate(resolve))
    .then(async () => {
      // The page's connection request went first; skip when the pool has nothing to spare.
      if (abandoned || poolUnderPressure()) return undefined;
      return (ex as Db).connection().execute(async (conn) => {
        // Abandoned while waiting for the connection: no statement at all, the connection goes straight back.
        if (abandoned) return undefined;
        await sql`BEGIN`.execute(conn);
        try {
          await sql`SET LOCAL statement_timeout = ${sql.lit(budget)}`.execute(conn);
          // One core only: a count must not take parallel workers from the page it runs beside (measured at 10k).
          await sql`SET LOCAL max_parallel_workers_per_gather = 0`.execute(conn);
          const rows = await conn.executeQuery<{ total: string | number }>(compiled);
          await sql`COMMIT`.execute(conn);
          const total = Number(rows.rows[0]?.total);
          return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
        } catch (error) {
          // A timed-out count aborted the transaction: end it before the connection goes back to the pool.
          await sql`ROLLBACK`.execute(conn).catch(() => undefined);
          throw error;
        }
      });
    })
    .catch(() => undefined);
  return { result, abandon: () => void (abandoned = true) };
}

/** Called once the page is built: the count if it is ready within waitAfterPageMs, else undefined (and it is abandoned). */
export async function totalAfterPage(pending: PendingTotal | undefined): Promise<number | undefined> {
  if (pending === undefined) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, LIST_COUNT.waitAfterPageMs));
    timer.unref();
  });
  try {
    const total = await Promise.race([pending.result, late]);
    if (total === undefined) pending.abandon();
    return total;
  } finally {
    clearTimeout(timer);
  }
}

/** The page answer with total when it was counted. */
export function withTotal<T extends { items: unknown[]; nextCursor: string | null }>(page: T, total: number | undefined): T & { total?: number } {
  return total === undefined ? page : { ...page, total };
}
