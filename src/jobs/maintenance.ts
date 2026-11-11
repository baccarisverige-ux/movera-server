import type { Executor } from "../db/db.js";
import { ensurePayoutTimer, payoutHandlers } from "./payouts.js";
import { summarize } from "../admin/kpis.js";
import { purgeOldMessages } from "../trips/messages.js";
import { NO_FIX_OFFLINE, NO_FIX_SWEEP, ensureNoFixTimer, noFixOfflineHandler, noFixSweepHandler } from "../drivers/presence.js";
import type { TimerHandler } from "./timers.js";
import { ensureHousekeepingTimers, housekeepingHandlers } from "./housekeeping.js";

/** Housekeeping that runs on the timer worker, so only one instance does it at a time. */

const HOUR_MS = 60 * 60 * 1000;
export { IDEMPOTENCY_KEY_TTL_MS } from "./housekeeping.js";

export const SWEEP_IDEMPOTENCY_KEYS = "sweep_idempotency_keys";
/** contract v0.9.0 §16: the nightly summary (KPIs of the days that ended). S4 0.14a: payouts have their own timer (jobs/payouts.ts). */
export const NIGHTLY = "nightly_summary";
/** The nightly run starts at 01:00 UTC (02:00 or 03:00 in Stockholm and Paris), after every zone's day has ended. */
export const NIGHTLY_HOUR_UTC = 1;

export function nextNightly(now: Date): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NIGHTLY_HOUR_UTC));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/**
 * Each night: summarize every zone-day that ended (a re-run rewrites the same rows). S4 0.14a (owner W1 Q69, one payout
 * job, hourly kept): the payouts moved from here and from the hourly sweep to the payout timer (jobs/payouts.ts).
 */
export const nightlyHandler: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  await summarize(trx, now);
  // contract v0.13.0 §22: trip chat after 90 days, except trips with a safety case.
  await purgeOldMessages(trx, now);
  // v0.18.56 §78 (inAppCalls.push): open-stream rows a copy that died never removed.
  await trx.deleteFrom("trip_stream_presence").where("seen_at", "<", new Date(now.getTime() - 60 * 60 * 1000)).execute();
  await trx
    .insertInto("timers")
    .values({ kind: NIGHTLY, ref_id: "all", due_at: nextNightly(now) })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
};

/**
 * Every hour: books the next sweep, nothing else. S4 0.14b moved its clean-ups to their own timers
 * (jobs/housekeeping.ts) and S4 0.14a (owner W1 Q69) its payout pass to the payout timer (jobs/payouts.ts). The kind and
 * its row are kept on purpose: the re-arm list and GET /healthz/jobs stay valid, and the rollback of 0.14a (code revert
 * + docs/undo/0.14a_payout_timers.sql) finds the row the older release pays from. A row booked by an older release may
 * still carry payload.payoutAfter: it is ignored.
 */
export const sweepIdempotencyKeysHandler: TimerHandler = async (trx, timer) => {
  // The worker's clock, like every handler (a test clock ahead of the wall clock would otherwise rerun it at once).
  const now = timer.firedAt;
  await trx
    .insertInto("timers")
    .values({ kind: SWEEP_IDEMPOTENCY_KEYS, ref_id: "all", due_at: new Date(now.getTime() + HOUR_MS), payload: "{}" })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
};

/** Kept name (stress T-A follow-up): the pause between two payout batches, now on the payout timer. */
export { PAYOUT_BATCH_GAP_MS } from "./payouts.js";

/** Books the recurring jobs if they are not booked yet (every instance calls this at start; one row wins). */
export async function ensureMaintenanceTimers(ex: Executor, now: Date = new Date()): Promise<void> {
  await ex
    .insertInto("timers")
    .values([
      { kind: SWEEP_IDEMPOTENCY_KEYS, ref_id: "all", due_at: now },
      { kind: NIGHTLY, ref_id: "all", due_at: nextNightly(now) },
    ])
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
  // S4 0.14b: each hourly clean-up on its own timer.
  await ensureHousekeepingTimers(ex, now);
  // S4 0.14a: the one payout job (hourly).
  await ensurePayoutTimer(ex, now);
  // contract v0.18.4 §29 (G3-R1): online drivers with no position for noFixMinutes go offline (every 30 s).
  await ensureNoFixTimer(ex, now);
}

export const maintenanceHandlers: Record<string, TimerHandler> = {
  [SWEEP_IDEMPOTENCY_KEYS]: sweepIdempotencyKeysHandler,
  [NIGHTLY]: nightlyHandler,
  [NO_FIX_OFFLINE]: noFixOfflineHandler,
  [NO_FIX_SWEEP]: noFixSweepHandler,
  ...housekeepingHandlers,
  ...payoutHandlers,
};
