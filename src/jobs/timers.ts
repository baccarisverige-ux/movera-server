import { sql } from "kysely";
import type { Db, Executor, Trx } from "../db/db.js";
import { isDatabaseConnectionError } from "../db/ready.js";
import { laneName, recordTimerLag, recordTimerParked } from "../telemetry/load.js";

/**
 * Durable timers: offer expiry, the next dispatch step, search expiry, no-show windows, … A timer is written in
 * the same transaction as the change that needs it, so a crash or restart never loses one. Any number of server
 * instances can run a worker: each due timer is taken by exactly one (FOR UPDATE SKIP LOCKED), removed, and
 * its handler runs in that same transaction. If the handler fails, everything it did is undone and the timer
 * comes back later with a growing delay; after MAX_ATTEMPTS it is parked and logged for a person to look at.
 */

export type Timer = {
  timerId: string;
  kind: string;
  refId: string;
  dueAt: Date;
  payload: unknown;
  attempts: number;
  /** The worker's clock when it took the timer (handlers use this, not their own clock). */
  firedAt: Date;
  /** Job 1 (fast dispatch): what the handler's `prepare` found outside the transaction (slow network calls). */
  prepared?: unknown;
};

/**
 * A handler runs inside the timer's transaction. Job 1 (fix plan R1, audits/stress-test-2026-11-04.md H2): a handler
 * that needs a slow network call (road routing) gives `prepare`, which runs first with NO transaction and NO lock;
 * its result reaches the handler as `timer.prepared`. So no row lock is ever held while waiting on the network.
 */
export type TimerHandler = ((trx: Trx, timer: Timer) => Promise<void>) & { prepare?: (db: Db, timer: Timer) => Promise<unknown> };

export type TimerLogger = {
  warn: (data: object, message: string) => void;
  error: (data: object, message: string) => void;
};

export const MAX_ATTEMPTS = 8;

/**
 * A handler that cannot take the lock it needs right now throws this. The timer is rolled back and comes back
 * shortly, without counting as a failure. Handlers lock what they need with NOWAIT and throw this instead of
 * waiting, so a worker holding a timer never waits on a row a command holds while that command waits on the timer.
 */
export class TimerBusy extends Error {}
export const BUSY_RETRY_MS = 250;
/** Job 1: a busy timer is tried again after 250 ms, 500 ms, 1 s, then every 2 s at most (bounded backoff). */
export const BUSY_RETRY_MAX_MS = 2000;
export function busyRetryMs(tries: number): number {
  return Math.min(BUSY_RETRY_MS * 2 ** Math.max(0, tries - 1), BUSY_RETRY_MAX_MS);
}
/**
 * Job 1: a timer transaction never waits long for a row lock (lock_timeout), so one stuck command cannot freeze the
 * worker; a lock wait that runs out counts as busy (TimerBusy), not as a failure.
 */
export const TIMER_LOCK_TIMEOUT_MS = 2000;
/**
 * 55P03 lock_not_available / lock timeout, and (stress T-A part 4) 40P01 deadlock_detected: Postgres rolled the timer's
 * transaction back because two timers (e.g. two dispatch rounds) locked the same driver rows in turn. Like a busy row,
 * it is tried again shortly with its due time kept, and it does not count as a failed attempt.
 */
const isLockTimeout = (error: unknown) => ["55P03", "40P01"].includes((error as { code?: string } | undefined)?.code ?? "");

/**
 * At most one pending timer per (kind, refId): scheduling again moves it (and starts its attempts again).
 * E6 (audit S02 A1/A4): `keepDue` is for a timer asked again and again (the ride-check scan, once per GPS batch): a
 * pending one keeps its due time (never moved later; nor earlier, which would skip a failing one's back-off or wake a
 * parked one at 'infinity'), its attempts and its last error; only its payload is refreshed.
 */
export async function scheduleTimer(ex: Executor, timer: { kind: string; refId: string; dueAt: Date; payload?: unknown }, options: { keepDue?: boolean } = {}): Promise<void> {
  const payload = JSON.stringify(timer.payload ?? {});
  await ex
    .insertInto("timers")
    .values({ kind: timer.kind, ref_id: timer.refId, due_at: timer.dueAt, payload })
    .onConflict((conflict) =>
      conflict
        .columns(["kind", "ref_id"])
        .doUpdateSet(options.keepDue ? { payload } : { due_at: timer.dueAt, payload, attempts: 0, last_error: null }),
    )
    .execute();
}

export async function cancelTimer(ex: Executor, kind: string, refId: string): Promise<boolean> {
  const result = await ex.deleteFrom("timers").where("kind", "=", kind).where("ref_id", "=", refId).executeTakeFirst();
  return result.numDeletedRows > 0n;
}

/** Delay before the next try: 1 s, 2 s, 4 s, … capped at 5 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempts - 1), 5 * 60 * 1000);
}

/**
 * Job 1: a lane is one loop of the worker; `kinds` = only these kinds (e.g. a dispatch lane), missing = any kind.
 * `name` (B1.7): the lane's name in the load numbers (telemetry/load.ts laneName) instead of its kinds joined.
 */
export type TimerLane = { kinds?: string[]; exclude?: string[]; name?: string };
/** Rule 28: while the database cannot be reached the loop waits 1 s, 2 s, 4 s, … at most 30 s between tries. */
export const DB_DOWN_MAX_MS = 30_000;
/**
 * The worker's loops: `dispatchLanes` loops for dispatch rounds and withdrawals only (stress T-A part 4: rounds of
 * different trips run side by side), one for trip GPS work (stress H1), and TIMER_LANES − 2 (at least 1) general loops
 * for every other kind (dispatch too, when it is busy).
 * B1.7 (owner W1 Q71): `housekeepingKinds` (clean-ups, hourly sweep, nightly run) run only on their own
 * `housekeepingLanes` loops (HOUSEKEEPING_LANES, at least 1), never on the general lanes, so a long clean-up never holds
 * the lane an SOS escalation, the alert sweep or a booked ride needs. The general lanes' query stays on the partial
 * index timers_due_general (0091): its NOT IN list is a superset of the index's, which Postgres proves implies it.
 */
export function timerLanes(o: { dispatchKinds: string[]; tripKinds: string[]; timerLanes: number; dispatchLanes: number; housekeepingKinds?: string[]; housekeepingLanes?: number; tripLanes?: number }): TimerLane[] {
  const housekeeping = o.housekeepingKinds ?? [];
  return [
    ...Array.from({ length: Math.max(1, o.dispatchLanes) }, () => ({ kinds: o.dispatchKinds })),
    // G34 S3: TRIP_LANES loops (default 1) for the per-trip GPS timers; each takes its own timer with SKIP LOCKED.
    ...Array.from({ length: Math.max(1, o.tripLanes ?? 1) }, () => ({ kinds: o.tripKinds })),
    ...Array.from({ length: Math.max(1, o.timerLanes - 2) }, () => ({ exclude: [...o.tripKinds, ...housekeeping] })),
    ...(housekeeping.length > 0 ? Array.from({ length: Math.max(1, o.housekeepingLanes ?? 1) }, () => ({ kinds: housekeeping, name: "housekeeping" })) : []),
  ];
}

export function dbDownDelayMs(failures: number, pollMs: number): number {
  return Math.min(Math.max(pollMs, 1000) * 2 ** Math.max(0, failures - 1), DB_DOWN_MAX_MS);
}

export type TimerWorkerOptions = {
  handlers: Record<string, TimerHandler>;
  logger: TimerLogger;
  clock?: () => Date;
  pollMs?: number;
  /**
   * Job 1 (fix plan R1): the loops this worker runs at the same time. Each takes due timers with FOR UPDATE SKIP LOCKED,
   * so they never take the same one. Default: one lane for any kind (as before).
   */
  lanes?: TimerLane[];
  /**
   * B1.6b (owner W1 Q70): kinds whose timer, on its first parking, runs once more RESTART_ONCE_AFTER_MS later instead
   * (attempts stays MAX_ATTEMPTS; failing again parks it for good at MAX_ATTEMPTS + 1). Only kinds whose handler
   * re-checks the trip or case first (test/jobs/restart_rechecks.test.ts).
   */
  restartOnce?: readonly string[];
  /** B1.6b: runs after a timer was parked (or put on its one restart), e.g. to raise the alert without the alert sweep. */
  onParked?: (db: Db, timer: Timer, now: Date) => Promise<void>;
};

/** B1.6b: a parked trip or safety timer runs once more after this long. */
export const RESTART_ONCE_AFTER_MS = 60_000;

export class TimerWorker {
  private readonly clock: () => Date;
  private readonly pollMs: number;
  private readonly lanes: TimerLane[];
  private loops: Promise<void>[] = [];
  private stopping = false;
  private readonly wakers = new Set<() => void>();
  /**
   * Job 1 (fix plan R1 a): a timer whose handler found its rows busy KEEPS its due_at (so it is not pushed behind a
   * backlog of later timers); this worker only skips it until `until`, with a bounded backoff (busyRetryMs).
   */
  private readonly busy = new Map<string, { tries: number; until: number }>();
  /** Rule 28: database connection errors in a row (the loop backs off while the database is down). */
  private dbFailures = 0;

  constructor(
    private readonly db: Db,
    private readonly options: TimerWorkerOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.pollMs = options.pollMs ?? 500;
    this.lanes = options.lanes && options.lanes.length > 0 ? options.lanes : [{}];
  }

  /** Timers this worker skips for now (busy, waiting for their retry time). */
  private skipped(now: Date): string[] {
    const ids: string[] = [];
    for (const [id, entry] of this.busy) {
      if (entry.until > now.getTime()) ids.push(id);
      else if (entry.until < now.getTime() - 60_000) this.busy.delete(id);
    }
    return ids;
  }

  /** Takes and runs one due timer. Returns false when none is due (or every due one is taken by another worker). */
  async runOne(lane: TimerLane = {}): Promise<boolean> {
    const now = this.clock();
    const skip = this.skipped(now);
    let taken: Timer | undefined;
    let prepareFor: Timer | undefined;
    let failed: { error: Error; parked: boolean; restart: boolean } | undefined;
    const take = async (trx: Trx, timerId?: string) => {
      let query = trx.selectFrom("timers").selectAll().where("due_at", "<=", now);
      if (timerId !== undefined) query = query.where("timer_id", "=", timerId);
      if (lane.kinds !== undefined) query = query.where("kind", "in", lane.kinds);
      // Stress T-A follow-up (B1.13): the kinds as literals, so the general lanes' query matches the partial index
      // timers_due_general (migration 0091) and never walks the trip lane's backlog. Kinds are code constants.
      if (lane.exclude !== undefined && lane.exclude.length > 0) query = query.where(sql<boolean>`kind NOT IN (${sql.join(lane.exclude.map((kind) => sql.lit(kind)))})`);
      if (skip.length > 0) query = query.where("timer_id", "not in", skip);
      return query.orderBy("due_at").orderBy("timer_id").limit(1).forUpdate().skipLocked().executeTakeFirst();
    };
    const run = async (timerId?: string, prepared?: unknown) =>
      this.db.transaction().execute(async (trx) => {
        await sql`SET LOCAL lock_timeout = ${sql.lit(`${TIMER_LOCK_TIMEOUT_MS}ms`)}`.execute(trx);
        const row = await take(trx, timerId);
        if (row === undefined) return timerId === undefined ? false : true;
        const timer: Timer = { timerId: row.timer_id, kind: row.kind, refId: row.ref_id, dueAt: row.due_at, payload: row.payload, attempts: row.attempts, firedAt: now };
        const handler = this.options.handlers[row.kind];
        if (handler?.prepare !== undefined && timerId === undefined) {
          // Slow work first, outside this transaction (it ends here having changed nothing).
          prepareFor = timer;
          return true;
        }
        taken = prepared === undefined ? timer : { ...timer, prepared };
        recordTimerLag(laneName(lane), now.getTime() - row.due_at.getTime());
        // B1.6b (Rule 33): a failure is undone to here and recorded in this same transaction, while this worker still
        // holds the row, so no other copy can take the timer again between the failure and its record.
        await sql`SAVEPOINT timer_handler`.execute(trx);
        try {
          await trx.deleteFrom("timers").where("timer_id", "=", row.timer_id).execute();
          if (handler === undefined) throw new Error(`No handler for timer kind ${row.kind}`);
          await handler(trx, taken);
        } catch (error) {
          if (error instanceof TimerBusy || isLockTimeout(error)) throw error;
          await sql`ROLLBACK TO SAVEPOINT timer_handler`.execute(trx);
          failed = { error: error as Error, ...(await this.recordFailure(trx, taken, error as Error, now)) };
        }
        return true;
      });
    try {
      const ran = await run();
      if (prepareFor !== undefined) {
        const target: Timer = prepareFor;
        let prepared: unknown = null;
        try {
          prepared = (await this.options.handlers[target.kind]!.prepare!(this.db, target)) ?? null;
        } catch {
          // Nothing prepared: the handler does its cheap fallback.
        }
        await run(target.timerId, prepared);
      }
      if (taken !== undefined) this.busy.delete(taken.timerId);
      if (taken !== undefined && failed !== undefined) await this.afterFailure(taken, failed, now);
      return ran;
    } catch (error) {
      if (taken === undefined) throw error;
      if (error instanceof TimerBusy || isLockTimeout(error)) {
        const tries = (this.busy.get(taken.timerId)?.tries ?? 0) + 1;
        this.busy.set(taken.timerId, { tries, until: now.getTime() + busyRetryMs(tries) });
        return true;
      }
      this.busy.delete(taken.timerId);
      // The transaction itself failed (e.g. the commit, or the savepoint after a lost connection): recorded on its own.
      await this.afterFailure(taken, { error: error as Error, ...(await this.recordFailure(this.db, taken, error as Error, now)) }, now);
      return true;
    }
  }

  /** Runs due timers until none is left. Returns how many were taken. */
  async runDue(limit = 1000, lane: TimerLane = {}): Promise<number> {
    let count = 0;
    while (count < limit && (await this.runOne(lane))) count++;
    return count;
  }

  start(): void {
    if (this.loops.length > 0) return;
    this.stopping = false;
    this.loops = this.lanes.map((lane) =>
      (async () => {
        while (!this.stopping) {
          // Rule 28 (#92): one round that never throws; backs off while the database is down.
          const delay = await this.tick(() => this.runDue(100, lane));
          if (this.stopping) break;
          await new Promise<void>((resolve) => {
            const wake = () => {
              clearTimeout(handle);
              this.wakers.delete(wake);
              resolve();
            };
            const handle = setTimeout(wake, delay);
            this.wakers.add(wake);
          });
        }
      })(),
    );
  }

  /** Job 1: a timer due now was just written (e.g. a new search): look at once instead of after the poll. */
  kick(): void {
    for (const wake of [...this.wakers]) wake();
  }

  /**
   * One round of the loop. Never throws (rule 28): a database that is restarting (57P03, ECONNREFUSED, connection
   * terminated) is logged and the loop waits longer each time; any other error is logged and the loop goes on.
   * Returns how long to wait before the next round.
   */
  async tick(round: () => Promise<unknown>): Promise<number> {
    try {
      await round();
      if (this.dbFailures > 0) this.options.logger.warn({ failures: this.dbFailures }, "timer worker: database is back");
      this.dbFailures = 0;
      return this.pollMs;
    } catch (error) {
      try {
        if (isDatabaseConnectionError(error)) {
          this.dbFailures += 1;
          const delay = dbDownDelayMs(this.dbFailures, this.pollMs);
          this.options.logger.warn({ err: error, failures: this.dbFailures, retryInMs: delay }, "timer worker: database unavailable; retrying");
          return delay;
        }
        this.options.logger.error({ err: error }, "timer worker: database error");
      } catch {
        // A logger that throws must not stop the loop either.
      }
      return this.pollMs;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.kick();
    await Promise.all(this.loops);
    this.loops = [];
  }

  /** Writes the failure on the row this worker failed on (if another worker already took it again, leaves it alone). */
  private async recordFailure(ex: Executor, timer: Timer, error: Error, now: Date): Promise<{ parked: boolean; restart: boolean }> {
    const attempts = timer.attempts + 1;
    const parked = attempts >= MAX_ATTEMPTS;
    // B1.6b: the first parking of a restart-once kind runs it once more later; attempts > MAX_ATTEMPTS = restarted already.
    const restart = attempts === MAX_ATTEMPTS && (this.options.restartOnce ?? []).includes(timer.kind);
    const dueAt = restart ? new Date(now.getTime() + RESTART_ONCE_AFTER_MS) : parked ? sql<Date>`'infinity'::timestamptz` : new Date(now.getTime() + backoffMs(attempts));
    await ex
      .updateTable("timers")
      .set({ attempts, last_error: error.message.slice(0, 2000), due_at: dueAt })
      .where("timer_id", "=", timer.timerId)
      .where("attempts", "=", timer.attempts)
      .execute();
    return { parked, restart };
  }

  /** After the failure is committed: the log line, the parked count and (B1.6b) the onParked hook, which never throws. */
  private async afterFailure(timer: Timer, failure: { error: Error; parked: boolean; restart: boolean }, now: Date): Promise<void> {
    const data = { kind: timer.kind, refId: timer.refId, attempts: timer.attempts + 1, err: failure.error.message.slice(0, 2000) };
    if (!failure.parked) {
      this.options.logger.warn(data, "timer failed; will retry");
      return;
    }
    recordTimerParked(timer.kind);
    if (failure.restart) this.options.logger.error({ ...data, restartInMs: RESTART_ONCE_AFTER_MS }, "timer parked after repeated failures; it runs once more");
    else this.options.logger.error(data, "timer parked after repeated failures");
    try {
      await this.options.onParked?.(this.db, timer, now);
    } catch (hookError) {
      this.options.logger.error({ kind: timer.kind, err: hookError }, "timer parked: the alert could not be raised");
    }
  }
}

/**
 * S05 A1: a RECURRING job (one row per kind, booked again by its own handler) that failed MAX_ATTEMPTS times is
 * parked at 'infinity', and the start-up booking (insert … do nothing) never touches it again. At start every
 * parked timer of these kinds runs again now with a fresh attempt count, with one warning each. One-off timers
 * (offers, trips, …) stay parked.
 */
export async function rearmParkedRecurringTimers(
  ex: Executor,
  kinds: readonly string[],
  logger: { warn: (data: object, message: string) => void },
  now: Date = new Date(),
): Promise<number> {
  if (kinds.length === 0) return 0;
  const rows = await ex
    .updateTable("timers")
    .set({ due_at: now, attempts: 0 })
    .where("kind", "in", [...kinds])
    .where("due_at", "=", sql<Date>`'infinity'::timestamptz`)
    .returning(["kind", "ref_id", "last_error"])
    .execute();
  for (const row of rows) logger.warn({ kind: row.kind, refId: row.ref_id, lastError: row.last_error }, "parked recurring timer re-armed at start");
  return rows.length;
}

/**
 * B1.6b (owner W1 Q70): at start, a trip or safety timer parked before restart-once existed (attempts MAX_ATTEMPTS,
 * due 'infinity') runs once more now, with one warning each. One statement, so several copies starting together
 * restart it once in all; it keeps attempts MAX_ATTEMPTS, so failing again parks it for good (MAX_ATTEMPTS + 1).
 */
export async function restartParkedOnce(
  ex: Executor,
  kinds: readonly string[],
  logger: { warn: (data: object, message: string) => void },
  now: Date = new Date(),
): Promise<number> {
  if (kinds.length === 0) return 0;
  const rows = await ex
    .updateTable("timers")
    .set({ due_at: now })
    .where("kind", "in", [...kinds])
    .where("attempts", "=", MAX_ATTEMPTS)
    .where("due_at", "=", sql<Date>`'infinity'::timestamptz`)
    .returning(["kind", "ref_id", "last_error"])
    .execute();
  for (const row of rows) logger.warn({ kind: row.kind, refId: row.ref_id, lastError: row.last_error }, "parked trip or safety timer runs once more at start");
  return rows.length;
}
