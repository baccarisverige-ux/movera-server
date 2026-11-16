import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db, Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "./errors.js";

/**
 * Idempotency-Key (contract §1 Headers): every mutation sends one, 16–128 visible characters. The key is bound
 * to who sent it, the method, the concrete path and the body. The same key with the same request replays the
 * first answer; the same key with anything else is 409 conflict.
 *
 * The key row is written first, inside the command's own transaction. A second request with the same key
 * waits on that row until the first one finishes: if the first committed, the second replays its answer; if
 * it failed (any error rolls the whole transaction back, key row included), the second runs as new. Only
 * 2xx answers are kept, so a client can always retry after an error.
 *
 * Exception: POST /driver/location (S7 W2 Q114, owner "Yes, stop storing (Rec.)", contract v0.18.117
 * driverHome.locationSend.idempotencyKey). The key is checked with readIdempotencyKey (missing or not 16–128 characters:
 * 400) but never stored: a repeat runs again, is never replayed and never 409, also with another body. A resent batch is
 * safe on its own (drivers/service.ts: a fix that is not new writes no event; one GPS write per driver at a time).
 * Read-only POSTs take no key at all (contract §1).
 */

export type Actor = "rider" | "driver" | "admin" | "system";

export type IdempotencyRequest = {
  actor: Actor;
  /** The signed-in rider/driver/admin id. */
  subjectId: string;
  /** The Idempotency-Key header as sent (undefined when missing). */
  key: string | undefined;
  method: string;
  /** The concrete path without the query string, e.g. /api/v1/trips/trp_…/cancel. */
  route: string;
  body: unknown;
};

export type CommandResult<T> = { status: number; body: T };

const KEY = /^[\x21-\x7e]{16,128}$/;

export function readIdempotencyKey(header: string | string[] | undefined): string {
  if (header === undefined) throw badRequest("Send an Idempotency-Key header with every change.", "idempotency_key_missing");
  if (typeof header !== "string" || !KEY.test(header)) {
    throw badRequest("The Idempotency-Key must be 16 to 128 visible characters.", "idempotency_key_invalid");
  }
  return header;
}

/** JSON with object keys sorted at every level, so { a, b } and { b, a } hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`).join(",")}}`;
}

export function bodyHash(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/**
 * Runs `work` once per key. `work` gets the open transaction and must do all its writes through it.
 * Returns `replayed: true` when the answer is the stored one from an earlier request.
 */
export async function runIdempotent<T>(
  db: Db,
  request: IdempotencyRequest,
  work: (trx: Trx) => Promise<CommandResult<T>>,
): Promise<CommandResult<T> & { replayed: boolean }> {
  const key = readIdempotencyKey(request.key);
  const method = request.method.toUpperCase();
  const hash = bodyHash(request.body);

  return db.transaction().execute(async (trx) => {
    // status_code 0 marks "in progress"; the row only survives a commit with the real answer written in.
    const claimed = await trx
      .insertInto("idempotency_keys")
      .values({ actor: request.actor, subject_id: request.subjectId, key, method, route: request.route, body_sha256: hash, status_code: 0, response: null })
      .onConflict((conflict) => conflict.columns(["actor", "subject_id", "key"]).doNothing())
      .returning("key")
      .executeTakeFirst();

    if (claimed === undefined) {
      const stored = await trx
        .selectFrom("idempotency_keys")
        .selectAll()
        .where("actor", "=", request.actor)
        .where("subject_id", "=", request.subjectId)
        .where("key", "=", key)
        .executeTakeFirstOrThrow();
      if (stored.method !== method || stored.route !== request.route || stored.body_sha256 !== hash) {
        throw new ApiError("conflict", "This Idempotency-Key was already used for a different request.", { reason: "idempotency_key_reused" });
      }
      return { status: stored.status_code, body: stored.response as T, replayed: true };
    }

    const result = await work(trx);
    if (result.status < 200 || result.status > 299) {
      throw new Error(`An idempotent command must answer 2xx or throw an ApiError; it answered ${result.status}.`);
    }
    await trx
      .updateTable("idempotency_keys")
      .set({ status_code: result.status, response: result.body === undefined ? null : JSON.stringify(result.body) })
      .where("actor", "=", request.actor)
      .where("subject_id", "=", request.subjectId)
      .where("key", "=", key)
      .execute();
    return { ...result, replayed: false };
  });
}

/**
 * Keys are kept for a day (long enough for any app retry), then swept by a timer. S4 0.14b: `limit` = at most that many
 * keys in one statement (the housekeeping timer comes back soon while more are left).
 */
export async function sweepIdempotencyKeys(ex: Executor, olderThan: Date, limit?: number): Promise<number> {
  let query = ex.deleteFrom("idempotency_keys").where("created_at", "<", olderThan);
  if (limit !== undefined) {
    query = query.where((eb) =>
      eb(eb.refTuple("actor", "subject_id", "key"), "in", eb.selectFrom("idempotency_keys").select(["actor", "subject_id", "key"]).where("created_at", "<", olderThan).limit(limit).$asTuple("actor", "subject_id", "key")),
    );
  }
  const result = await query.executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** Used by tests to look inside the store. */
export async function countIdempotencyKeys(db: Db): Promise<number> {
  const row = await sql<{ n: string }>`SELECT count(*) AS n FROM idempotency_keys`.execute(db);
  return Number(row.rows[0]?.n ?? 0);
}
