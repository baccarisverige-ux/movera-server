import type { Executor } from "../db/db.js";
import { closePeriodsBatch, PAYOUT_BATCH_DRIVERS } from "../admin/payouts.js";
import { summarize } from "../admin/kpis.js";
import { purgeOldMessages } from "../trips/messages.js";
import { NO_FIX_OFFLINE, NO_FIX_SWEEP, ensureNoFixTimer, noFixOfflineHandler, noFixSweepHandler } from "../drivers/presence.js";
import type { TimerHandler } from "./timers.js";
import { ensureHousekeepingTimers, housekeepingHandlers } from "./housekeeping.js";

/** Housekeeping that runs on the timer worker, so only one instance does it at a time. */

const HOUR_MS = 60 * 60 * 1000;
export { IDEMPOTENCY_KEY_TTL_MS } from "./housekeeping.js";

export const SWEEP_IDEMPOTENCY_KEYS = "sweep_idempotency_keys";
/** contract v0.9.0 §16: the nightly summary (KPIs of the days that ended) and the weekly payouts. */
export const NIGHTLY = "nightly_summary";
/** The nightly run starts at 01:00 UTC (02:00 or 03:00 in Stockholm and Paris), after every zone's day has ended. */
export const NIGHTLY_HOUR_UTC = 1;

export function nextNightly(now: Date): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NIGHTLY_HOUR_UTC));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Each night: summarize every zone-day that ended (a re-run rewrites the same rows) and pay every week that ended. */
export const nightlyHandler: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  await summarize(trx, now);
  // Stress T-A follow-up: one batch here too; the hourly sweep pays whatever is left, a batch at a time.
  await closePeriodsBatch(trx, now, { maxDrivers: PAYOUT_BATCH_DRIVERS });
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
 * Every hour: the payout pass, then book the next sweep. S4 0.14b: the clean-ups this sweep ran (Idempotency-Keys,
 * traces, telemetry, quotes, …) each have their own timer (jobs/housekeeping.ts); the kind keeps its name so the
 * booked row and the re-arm list stay valid (the payouts get their own timer in 0.14a).
 */
export const sweepIdempotencyKeysHandler: TimerHandler = async (trx, timer) => {
  // The worker's clock, like every handler (a test clock ahead of the wall clock would otherwise rerun it at once).
  const now = timer.firedAt;
  const after = (timer.payload as { payoutAfter?: unknown } | null)?.payoutAfter;
  // v0.18.13 (owner G10-2): payouts at the country's day and time (default Monday 08:00 local), within the hour.
  // Stress T-A follow-up: one batch of drivers per run; while more are left the sweep comes back in PAYOUT_BATCH_GAP_MS
  // with the next batch (payload.payoutAfter), so no run holds its transaction (and a pool connection) for minutes.
  const batch = await closePeriodsBatch(trx, now, { after: typeof after === "string" ? after : null, maxDrivers: PAYOUT_BATCH_DRIVERS });
  await trx
    .insertInto("timers")
    .values({
      kind: SWEEP_IDEMPOTENCY_KEYS,
      ref_id: "all",
      due_at: new Date(now.getTime() + (batch.next !== null ? PAYOUT_BATCH_GAP_MS : HOUR_MS)),
      payload: JSON.stringify(batch.next !== null ? { payoutAfter: batch.next } : {}),
    })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
};

/** Stress T-A follow-up: the pause between two payout batches of the hourly sweep while a backlog is paid. */
export const PAYOUT_BATCH_GAP_MS = 5_000;

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
  // contract v0.18.4 §29 (G3-R1): online drivers with no position for noFixMinutes go offline (every 30 s).
  await ensureNoFixTimer(ex, now);
}

export const maintenanceHandlers: Record<string, TimerHandler> = {
  [SWEEP_IDEMPOTENCY_KEYS]: sweepIdempotencyKeysHandler,
  [NIGHTLY]: nightlyHandler,
  [NO_FIX_OFFLINE]: noFixOfflineHandler,
  [NO_FIX_SWEEP]: noFixSweepHandler,
  ...housekeepingHandlers,
};
