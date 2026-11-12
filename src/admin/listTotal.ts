import { sql, type SelectQueryBuilder } from "kysely";
import type { Db, Executor } from "../db/db.js";

/**
 * L78-S (contract v0.18.78, contract.json#adminListFilters.total): the exact number of rows a list query matches,
 * counted without cursor and limit, for the first page of the 10 admin lists. Rule 33: the count runs in its own
 * short transaction under SET LOCAL statement_timeout (the list's time budget) next to the page read; a count that
 * does not finish in time (a very large unfiltered table, a busy database) or fails for any other reason gives
 * `undefined`, so the list leaves total out and is served as before: the count never fails or slows the list.
 * Never cached: every admin and every server copy counts its own query.
 */
export const LIST_COUNT = { timeoutMs: 300 };

/** How much longer than the statement budget the page may wait for the count (a pool connection that is slow to come). */
const WAIT_SLACK_MS = 200;

// The query builder's row type does not matter here: only its FROM / JOIN / WHERE are counted.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = SelectQueryBuilder<any, any, any>;

/**
 * `query` is the list's query with every filter but no cursor, order or limit. Inside an open transaction (no list
 * route reads in one) total is not counted: SET LOCAL there would change the caller's transaction.
 */
export async function countTotal(ex: Executor, query: AnyQuery): Promise<number | undefined> {
  if (ex.isTransaction) return undefined;
  const compiled = query
    .clearSelect()
    .clearOrderBy()
    .select((eb) => eb.fn.countAll<string>().as("total"))
    .compile();
  const budget = Math.max(1, Math.round(LIST_COUNT.timeoutMs));
  const count = (ex as Db)
    .transaction()
    .execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = ${sql.lit(budget)}`.execute(trx);
      const result = await trx.executeQuery<{ total: string | number }>(compiled);
      const total = Number(result.rows[0]?.total);
      return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
    })
    .catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budget + WAIT_SLACK_MS);
    timer.unref();
  });
  try {
    return await Promise.race([count, giveUp]);
  } finally {
    clearTimeout(timer);
  }
}

/** The page answer with total when it was counted. */
export function withTotal<T extends { items: unknown[]; nextCursor: string | null }>(page: T, total: number | undefined): T & { total?: number } {
  return total === undefined ? page : { ...page, total };
}
