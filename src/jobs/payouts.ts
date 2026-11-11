import { sql } from "kysely";
import type { Executor } from "../db/db.js";
import { closeDriverPeriods, newPayoutScheduleCache, payoutDrivers, payoutDue, PAYOUT_BATCH_DRIVERS } from "../admin/payouts.js";
import type { TimerHandler } from "./timers.js";

/**
 * S4 0.14a (owner W1 Q69 "Payouts on their own timer, one driver per step, one payout job (hourly kept)", 2026-11-11):
 * the ONE payout job. It used to run inside the nightly summary and again inside the hourly clean-up sweep, with
 * 200 drivers in one transaction (one failing driver rolled back the batch, the clean-ups with it, and no alert named
 * him). Now:
 *   - PAYOUT_CLOSE (one row, every hour, re-armed at start like the other recurring kinds) only reads: it takes the
 *     next batch of drivers with unpaid entries and books a PAYOUT_DRIVER step (due now) for each one whose period
 *     ended; while drivers are left it comes back in PAYOUT_BATCH_GAP_MS with the next batch.
 *   - PAYOUT_DRIVER (one row per driver, ref_id = driver id) pays that driver in its own transaction. A failure undoes
 *     only his step; the timer worker retries it with its back-off, logs each failure with his id (refId) and parks
 *     it after MAX_ATTEMPTS, and the system_health alert then lists his id (alerts/detector.ts).
 * Safe to run again and on several server copies (Rule 33): each step is taken by one worker (SKIP LOCKED), entries
 * are locked and paid once, and payouts_weekly_once (migrations 0025, 0048) keeps one weekly payout per period, driver and
 * currency; a pending or parked step is never booked twice (insert … do nothing).
 */

export const PAYOUT_CLOSE = "payout_close";
export const PAYOUT_DRIVER = "payout_driver";
const HOUR_MS = 60 * 60 * 1000;
/** Stress T-A follow-up: the pause between two payout batches while a backlog is listed. */
export const PAYOUT_BATCH_GAP_MS = 5_000;

export const payoutCloseHandler: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  const after = (timer.payload as { after?: unknown } | null)?.after;
  const rows = await payoutDrivers(trx, { after: typeof after === "string" ? after : null, maxDrivers: PAYOUT_BATCH_DRIVERS });
  const cache = newPayoutScheduleCache();
  // Normal path: one savepoint for the whole batch. If one driver's check throws (a bad time zone, …), the batch is
  // checked again one driver at a time and a driver whose check throws gets his step anyway: it fails there, in his
  // own transaction, where it is retried, logged and alerted by his id (never holding back the others).
  let due: string[] = [];
  await sql`SAVEPOINT payout_batch`.execute(trx);
  try {
    for (const row of rows) if (await payoutDue(trx, row, now, cache)) due.push(row.driver_id);
    await sql`RELEASE SAVEPOINT payout_batch`.execute(trx);
  } catch {
    await sql`ROLLBACK TO SAVEPOINT payout_batch`.execute(trx);
    due = [];
    for (const row of rows) {
      await sql`SAVEPOINT payout_one`.execute(trx);
      try {
        if (await payoutDue(trx, row, now, newPayoutScheduleCache())) due.push(row.driver_id);
        await sql`RELEASE SAVEPOINT payout_one`.execute(trx);
      } catch {
        await sql`ROLLBACK TO SAVEPOINT payout_one`.execute(trx);
        due.push(row.driver_id);
      }
    }
  }
  if (due.length > 0) {
    await trx
      .insertInto("timers")
      .values(due.map((driverId) => ({ kind: PAYOUT_DRIVER, ref_id: driverId, due_at: now, payload: "{}" })))
      .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
      .execute();
  }
  const next = rows.length >= PAYOUT_BATCH_DRIVERS ? rows.at(-1)!.driver_id : null;
  await trx
    .insertInto("timers")
    .values({
      kind: PAYOUT_CLOSE,
      ref_id: "all",
      due_at: new Date(now.getTime() + (next !== null ? PAYOUT_BATCH_GAP_MS : HOUR_MS)),
      payload: JSON.stringify(next !== null ? { after: next } : {}),
    })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
};

/** One driver's payouts in this step's own transaction (the driver id is the timer's refId). */
export const payoutDriverHandler: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  // Read again here: since the step was booked he may have been paid by hand, put on hold or have nothing left.
  for (const row of await payoutDrivers(trx, { driverId: timer.refId })) await closeDriverPeriods(trx, row, now);
};

/** Books the payout timer if it is not booked yet (every copy calls this at start; one row wins). */
export async function ensurePayoutTimer(ex: Executor, now: Date = new Date()): Promise<void> {
  await ex
    .insertInto("timers")
    .values({ kind: PAYOUT_CLOSE, ref_id: "all", due_at: now })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
}

export const payoutHandlers: Record<string, TimerHandler> = {
  [PAYOUT_CLOSE]: payoutCloseHandler,
  [PAYOUT_DRIVER]: payoutDriverHandler,
};
