import type { Executor } from "../db/db.js";
import { sweepIdempotencyKeys } from "../http/idempotency.js";
import { bookSilenceChecks } from "../trips/ride.js";
import { purgeOldErrorGroups } from "../telemetry/errors.js";
import { purgeOfferPushes } from "../dispatch/offerPush.js";
import { pruneAdminLiveEvents } from "../realtime/adminEvents.js";
import { sweepDocumentExpiry, sweepSignUpReminders } from "../drivers/reminders.js";
import { liftEndedPauses } from "../riders/moderation.js";
import { purgeOldShares } from "../safety/shareCleanup.js";
import { ACCOUNT_ERASE, eraseDueAccounts } from "../accounts/deletion.js";
import type { TimerHandler } from "./timers.js";

/**
 * S4 0.14b (stage S4 wave B1; owner W1 Q69 "… cleaning in batches" = Yes, 2026-11-11). The hourly clean-ups that ran in
 * the one hourly sweep (one handler, one transaction: one failing clean-up undid every other one and the payout pass)
 * each have their own recurring timer. A clean-up deletes at most HOUSEKEEPING_BATCH rows per firing; while rows are
 * left it comes back in HOUSEKEEPING_AGAIN_MS, else in an hour. Every kind is re-armed at start (main.ts).
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Idempotency-Keys are kept for a day (long enough for any app retry). */
export const IDEMPOTENCY_KEY_TTL_MS = DAY_MS;
/** At most this many rows deleted by one firing of a clean-up (one statement each). */
export const HOUSEKEEPING_BATCH = 5_000;
/** A clean-up with rows left comes back this soon (a 150k-row backlog is gone in ~2.5 min, never in one statement). */
export const HOUSEKEEPING_AGAIN_MS = 5_000;

export const CLEANUP_IDEMPOTENCY_KEYS = "cleanup_idempotency_keys";
export const CLEANUP_TRIP_LOCATIONS = "cleanup_trip_locations";
export const CLEANUP_TRIP_GAP_ROADS = "cleanup_trip_gap_roads";
export const CLEANUP_TELEMETRY = "cleanup_telemetry";
export const CLEANUP_ERROR_GROUPS = "cleanup_error_groups";
export const CLEANUP_OFFER_PUSHES = "cleanup_offer_pushes";
export const CLEANUP_ADMIN_EVENTS = "cleanup_admin_events";
export const CLEANUP_QUOTES = "cleanup_quotes";
export const CLEANUP_TRIP_SHARES = "cleanup_trip_shares";
export const BOOK_SILENCE_CHECKS = "book_silence_checks";
export const DOCUMENT_EXPIRY = "document_expiry";
export const SIGN_UP_REMINDERS = "sign_up_reminders";
export const LIFT_ENDED_PAUSES = "lift_ended_pauses";

/** A delete clean-up: removes at most `limit` rows, returns how many it removed. */
type Cleanup = (ex: Executor, now: Date, limit: number) => Promise<number>;
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

const CLEANUPS: Record<string, Cleanup> = {
  [CLEANUP_IDEMPOTENCY_KEYS]: (ex, now, limit) => sweepIdempotencyKeys(ex, ago(now, IDEMPOTENCY_KEY_TTL_MS), limit),
  // Trip GPS traces 30 days after the fix (owner decision 11); the driver's latest position stays.
  [CLEANUP_TRIP_LOCATIONS]: async (ex, now, limit) => {
    const cut = ago(now, 30 * DAY_MS);
    const old = ex.selectFrom("trip_locations").select(["trip_id", "measured_at", "driver_id"]).where("measured_at", "<", cut).limit(limit);
    const gone = await ex.deleteFrom("trip_locations").where("measured_at", "<", cut).where((eb) => eb(eb.refTuple("trip_id", "measured_at", "driver_id"), "in", old.$asTuple("trip_id", "measured_at", "driver_id"))).executeTakeFirst();
    return Number(gone.numDeletedRows);
  },
  // Road-snapped gaps (0092) go with the trace they were routed from.
  [CLEANUP_TRIP_GAP_ROADS]: async (ex, now, limit) => {
    const cut = ago(now, 30 * DAY_MS);
    const old = ex.selectFrom("trip_gap_roads").select(["trip_id", "from_ts", "to_ts"]).where("created_at", "<", cut).limit(limit);
    const gone = await ex.deleteFrom("trip_gap_roads").where("created_at", "<", cut).where((eb) => eb(eb.refTuple("trip_id", "from_ts", "to_ts"), "in", old.$asTuple("trip_id", "from_ts", "to_ts"))).executeTakeFirst();
    return Number(gone.numDeletedRows);
  },
  // App telemetry after 30 days (contract §11).
  [CLEANUP_TELEMETRY]: async (ex, now, limit) => {
    const cut = ago(now, 30 * DAY_MS);
    const old = ex.selectFrom("telemetry").select("telemetry_id").where("at", "<", cut).limit(limit);
    const gone = await ex.deleteFrom("telemetry").where("at", "<", cut).where("telemetry_id", "in", old).executeTakeFirst();
    return Number(gone.numDeletedRows);
  },
  // contract v0.16.0: an error group not seen for 30 days goes too (its devices with it).
  [CLEANUP_ERROR_GROUPS]: (ex, now, limit) => purgeOldErrorGroups(ex, ago(now, 30 * DAY_MS), limit),
  // v0.18.6 (checker LOW 10): new-offer push rows (never bell notices) a day after their offer ran out.
  [CLEANUP_OFFER_PUSHES]: (ex, now, limit) => purgeOfferPushes(ex, now, limit),
  // v0.18.22: admin live events after contract.json#adminLiveEvents.retentionHours (an older cursor gets resync).
  [CLEANUP_ADMIN_EVENTS]: (ex, now, limit) => pruneAdminLiveEvents(ex, now, limit, 1),
  // Quotes nobody booked, a day after they expired.
  [CLEANUP_QUOTES]: async (ex, now, limit) => {
    const cut = ago(now, DAY_MS);
    const old = ex.selectFrom("quotes").select("quote_id").where("expires_at", "<", cut).where("used_at", "is", null).limit(limit);
    const gone = await ex.deleteFrom("quotes").where("expires_at", "<", cut).where("used_at", "is", null).where("quote_id", "in", old).executeTakeFirst();
    return Number(gone.numDeletedRows);
  },
  // v0.18.116 §94 (owner S10 Q7): share-my-trip rows 30 days after they were made (contract.json#shareTrip.retentionDays).
  [CLEANUP_TRIP_SHARES]: purgeOldShares,
};

/** The hourly jobs that delete nothing (they book timers, send notices or lift pauses), each on its own timer too. */
const JOBS: Record<string, (ex: Executor, now: Date) => Promise<unknown>> = {
  // Every trip with the rider on board has a driver-silence check (owner decision 2026-10-26), also one boarded
  // before the check existed.
  [BOOK_SILENCE_CHECKS]: bookSilenceChecks,
  // contract v0.18.0 §27 (owner items 1 and 3, note check): documents expire at their date, with the 30 / 7 / 1
  // day warnings, and accounts that wait on themselves get 'Finish your sign-up' every few days.
  [DOCUMENT_EXPIRY]: sweepDocumentExpiry,
  [SIGN_UP_REMINDERS]: sweepSignUpReminders,
  // v0.18.39 A2 (G16 Q16-2): a rider pause that ended lifts by itself.
  [LIFT_ENDED_PAUSES]: liftEndedPauses,
  // v0.18.134 (contract.json#accountDeletion.job): erase accounts 30 days after the request (dry-run while the switch is off).
  [ACCOUNT_ERASE]: eraseDueAccounts,
};

/** Every housekeeping kind (recurring: re-armed at start, booked at start). Not trip or safety: not in the loud list. */
export const HOUSEKEEPING_KINDS: readonly string[] = [...Object.keys(CLEANUPS), ...Object.keys(JOBS)];

async function bookNext(ex: Executor, kind: string, dueAt: Date): Promise<void> {
  await ex
    .insertInto("timers")
    .values({ kind, ref_id: "all", due_at: dueAt })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
}

function cleanupHandler(kind: string, cleanup: Cleanup): TimerHandler {
  return async (trx, timer) => {
    // The worker's clock, like every handler.
    const now = timer.firedAt;
    const gone = await cleanup(trx, now, HOUSEKEEPING_BATCH);
    await bookNext(trx, kind, new Date(now.getTime() + (gone >= HOUSEKEEPING_BATCH ? HOUSEKEEPING_AGAIN_MS : HOUR_MS)));
  };
}

function jobHandler(kind: string, job: (ex: Executor, now: Date) => Promise<unknown>): TimerHandler {
  return async (trx, timer) => {
    await job(trx, timer.firedAt);
    await bookNext(trx, kind, new Date(timer.firedAt.getTime() + HOUR_MS));
  };
}

export const housekeepingHandlers: Record<string, TimerHandler> = Object.fromEntries([
  ...Object.entries(CLEANUPS).map(([kind, cleanup]) => [kind, cleanupHandler(kind, cleanup)] as const),
  ...Object.entries(JOBS).map(([kind, job]) => [kind, jobHandler(kind, job)] as const),
]);

/** Books every housekeeping job (due now) that is not booked yet; every instance calls this at start, one row wins. */
export async function ensureHousekeepingTimers(ex: Executor, now: Date = new Date()): Promise<void> {
  await ex
    .insertInto("timers")
    .values(HOUSEKEEPING_KINDS.map((kind) => ({ kind, ref_id: "all", due_at: now })))
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
}
