import type { Executor } from "../db/db.js";
import type { TimerHandler } from "./timers.js";

/** Housekeeping that runs on the timer worker, so only one instance does it at a time. */

const HOUR_MS = 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_TTL_MS = 24 * HOUR_MS;

export const SWEEP_IDEMPOTENCY_KEYS = "sweep_idempotency_keys";

/** Every hour: forget Idempotency-Keys older than a day and unused quotes, then book the next sweep. */
export const sweepIdempotencyKeysHandler: TimerHandler = async (trx) => {
  const now = new Date();
  await trx.deleteFrom("idempotency_keys").where("created_at", "<", new Date(now.getTime() - IDEMPOTENCY_KEY_TTL_MS)).execute();
  // Trip GPS traces 30 days after the fix (owner decision 11); the driver's latest position stays.
  await trx.deleteFrom("trip_locations").where("measured_at", "<", new Date(now.getTime() - 30 * 24 * HOUR_MS)).execute();
  // Quotes nobody booked, a day after they expired.
  await trx.deleteFrom("quotes").where("expires_at", "<", new Date(now.getTime() - 24 * HOUR_MS)).where("used_at", "is", null).execute();
  await trx
    .insertInto("timers")
    .values({ kind: SWEEP_IDEMPOTENCY_KEYS, ref_id: "all", due_at: new Date(now.getTime() + HOUR_MS) })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
};

/** Books the recurring jobs if they are not booked yet (every instance calls this at start; one row wins). */
export async function ensureMaintenanceTimers(ex: Executor, now: Date = new Date()): Promise<void> {
  await ex
    .insertInto("timers")
    .values({ kind: SWEEP_IDEMPOTENCY_KEYS, ref_id: "all", due_at: now })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
}

export const maintenanceHandlers: Record<string, TimerHandler> = {
  [SWEEP_IDEMPOTENCY_KEYS]: sweepIdempotencyKeysHandler,
};
