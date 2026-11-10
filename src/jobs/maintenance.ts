import type { Executor } from "../db/db.js";
import { bookSilenceChecks } from "../trips/ride.js";
import { closePeriodsBatch, PAYOUT_BATCH_DRIVERS } from "../admin/payouts.js";
import { summarize } from "../admin/kpis.js";
import { purgeOldMessages } from "../trips/messages.js";
import { purgeOldErrorGroups } from "../telemetry/errors.js";
import { purgeOfferPushes } from "../dispatch/offerPush.js";
import { pruneAdminLiveEvents } from "../realtime/adminEvents.js";
import { sweepDocumentExpiry, sweepSignUpReminders } from "../drivers/reminders.js";
import { NO_FIX_OFFLINE, ensureNoFixTimer, noFixOfflineHandler } from "../drivers/presence.js";
import type { TimerHandler } from "./timers.js";
import { liftEndedPauses } from "../riders/moderation.js";

/** Housekeeping that runs on the timer worker, so only one instance does it at a time. */

const HOUR_MS = 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_TTL_MS = 24 * HOUR_MS;

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

/** Every hour: forget Idempotency-Keys older than a day and unused quotes, then book the next sweep. */
export const sweepIdempotencyKeysHandler: TimerHandler = async (trx, timer) => {
  // The worker's clock, like every handler (a test clock ahead of the wall clock would otherwise rerun it at once).
  const now = timer.firedAt;
  const after = (timer.payload as { payoutAfter?: unknown } | null)?.payoutAfter;
  // A follow-up run of a payout backlog (below) only pays the next batch; the clean-ups ran in the first run.
  if (typeof after !== "string") await hourlyCleanups(trx, now);
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

/** The hourly clean-ups of the sweep (everything but the payouts). */
async function hourlyCleanups(trx: Parameters<TimerHandler>[0], now: Date): Promise<void> {
  await trx.deleteFrom("idempotency_keys").where("created_at", "<", new Date(now.getTime() - IDEMPOTENCY_KEY_TTL_MS)).execute();
  // Trip GPS traces 30 days after the fix (owner decision 11); the driver's latest position stays.
  await trx.deleteFrom("trip_locations").where("measured_at", "<", new Date(now.getTime() - 30 * 24 * HOUR_MS)).execute();
  // Road-snapped gaps (0092) go with the trace they were routed from.
  await trx.deleteFrom("trip_gap_roads").where("created_at", "<", new Date(now.getTime() - 30 * 24 * HOUR_MS)).execute();
  // App telemetry after 30 days (contract §11).
  await trx.deleteFrom("telemetry").where("at", "<", new Date(now.getTime() - 30 * 24 * HOUR_MS)).execute();
  // contract v0.16.0: an error group not seen for 30 days goes too (its devices with it).
  await purgeOldErrorGroups(trx, new Date(now.getTime() - 30 * 24 * HOUR_MS));
  // v0.18.6 (checker LOW 10): new-offer push rows (never bell notices) a day after their offer ran out.
  await purgeOfferPushes(trx, now);
  // v0.18.22: admin live events after contract.json#adminLiveEvents.retentionHours (an older cursor gets resync).
  await pruneAdminLiveEvents(trx, now);
  // Quotes nobody booked, a day after they expired.
  await trx.deleteFrom("quotes").where("expires_at", "<", new Date(now.getTime() - 24 * HOUR_MS)).where("used_at", "is", null).execute();
  // Every trip with the rider on board has a driver-silence check (owner decision 2026-10-26), also one boarded
  // before the check existed.
  await bookSilenceChecks(trx, now);
  // contract v0.18.0 §27 (owner items 1 and 3, note check): documents expire at their date, with the 30 / 7 / 1
  // day warnings, and accounts that wait on themselves get 'Finish your sign-up' every few days.
  await sweepDocumentExpiry(trx, now);
  await sweepSignUpReminders(trx, now);
  // v0.18.39 A2 (G16 Q16-2): a rider pause that ended lifts by itself.
  await liftEndedPauses(trx, now);
}

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
  // contract v0.18.4 §29 (G3-R1): online drivers with no position for noFixMinutes go offline (every 30 s).
  await ensureNoFixTimer(ex, now);
}

export const maintenanceHandlers: Record<string, TimerHandler> = {
  [SWEEP_IDEMPOTENCY_KEYS]: sweepIdempotencyKeysHandler,
  [NIGHTLY]: nightlyHandler,
  [NO_FIX_OFFLINE]: noFixOfflineHandler,
};
