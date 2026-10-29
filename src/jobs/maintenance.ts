import type { Executor } from "../db/db.js";
import { bookSilenceChecks } from "../trips/ride.js";
import { closeWeeks } from "../admin/payouts.js";
import { summarize } from "../admin/kpis.js";
import { purgeOldMessages } from "../trips/messages.js";
import { purgeOldErrorGroups } from "../telemetry/errors.js";
import { sweepDocumentExpiry, sweepSignUpReminders } from "../drivers/reminders.js";
import type { TimerHandler } from "./timers.js";

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
  await closeWeeks(trx, now);
  // contract v0.13.0 §22: trip chat after 90 days, except trips with a safety case.
  await purgeOldMessages(trx, now);
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
  await trx.deleteFrom("idempotency_keys").where("created_at", "<", new Date(now.getTime() - IDEMPOTENCY_KEY_TTL_MS)).execute();
  // Trip GPS traces 30 days after the fix (owner decision 11); the driver's latest position stays.
  await trx.deleteFrom("trip_locations").where("measured_at", "<", new Date(now.getTime() - 30 * 24 * HOUR_MS)).execute();
  // App telemetry after 30 days (contract §11).
  await trx.deleteFrom("telemetry").where("at", "<", new Date(now.getTime() - 30 * 24 * HOUR_MS)).execute();
  // contract v0.16.0: an error group not seen for 30 days goes too (its devices with it).
  await purgeOldErrorGroups(trx, new Date(now.getTime() - 30 * 24 * HOUR_MS));
  // Quotes nobody booked, a day after they expired.
  await trx.deleteFrom("quotes").where("expires_at", "<", new Date(now.getTime() - 24 * HOUR_MS)).where("used_at", "is", null).execute();
  // Every trip with the rider on board has a driver-silence check (owner decision 2026-10-26), also one boarded
  // before the check existed.
  await bookSilenceChecks(trx, now);
  // contract v0.17.0 §25 (owner items 1 and 3, note check): documents expire at their date, with the 30 / 7 / 1
  // day warnings, and accounts that wait on themselves get 'Finish your sign-up' every few days.
  await sweepDocumentExpiry(trx, now);
  await sweepSignUpReminders(trx, now);
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
    .values([
      { kind: SWEEP_IDEMPOTENCY_KEYS, ref_id: "all", due_at: now },
      { kind: NIGHTLY, ref_id: "all", due_at: nextNightly(now) },
    ])
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
}

export const maintenanceHandlers: Record<string, TimerHandler> = {
  [SWEEP_IDEMPOTENCY_KEYS]: sweepIdempotencyKeysHandler,
  [NIGHTLY]: nightlyHandler,
};
