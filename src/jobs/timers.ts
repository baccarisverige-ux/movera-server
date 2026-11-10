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

/** At most one pending timer per (kind, refId): scheduling again moves it. */
export async function scheduleTimer(ex: Executor, timer: { kind: string; refId: string; dueAt: Date; payload?: unknown }): Promise<void> {
  const payload = JSON.stringify(timer.payload ?? {});
  await ex
    .insertInto("timers")
    .values({ kind: timer.kind, ref_id: timer.refId, due_at: timer.dueAt, payload })
    .onConflict((conflict) =>
      conflict.columns(["kind", "ref_id"]).doUpdateSet({ due_at: timer.dueAt, payload, attempts: 0, last_error: null }),
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

/** Job 1: a lane is one loop of the worker; `kinds` = only these kinds (e.g. a dispatch lane), missing = any kind. */
export type TimerLane = { kinds?: string[]; exclude?: string[] };
/** Rule 28: while the database cannot be reached the loop waits 1 s, 2 s, 4 s, … at most 30 s between tries. */
export const DB_DOWN_MAX_MS = 30_000;
/**
 * The worker's loops: `dispatchLanes` loops for dispatch rounds and withdrawals only (stress T-A part 4: rounds of
 * different trips run side by side), one for trip GPS work (stress H1), and TIMER_LANES − 2 (at least 1) general loops
 * for every other kind (dispatch too, when it is busy).
 */
export function timerLanes(o: { dispatchKinds: string[]; tripKinds: string[]; timerLanes: number; dispatchLanes: number }): TimerLane[] {
  return [
    ...Array.from({ length: Math.max(1, o.dispatchLanes) }, () => ({ kinds: o.dispatchKinds })),
    { kinds: o.tripKinds },
    ...Array.from({ length: Math.max(1, o.timerLanes - 2) }, () => ({ exclude: o.tripKinds })),
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
};

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
        await trx.deleteFrom("timers").where("timer_id", "=", row.timer_id).execute();
        if (handler === undefined) throw new Error(`No handler for timer kind ${row.kind}`);
        await handler(trx, taken);
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
      return ran;
    } catch (error) {
      if (taken === undefined) throw error;
      if (error instanceof TimerBusy || isLockTimeout(error)) {
        const tries = (this.busy.get(taken.timerId)?.tries ?? 0) + 1;
        this.busy.set(taken.timerId, { tries, until: now.getTime() + busyRetryMs(tries) });
        return true;
      }
      this.busy.delete(taken.timerId);
      await this.recordFailure(taken, error as Error, now);
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

  private async recordFailure(timer: Timer, error: Error, now: Date): Promise<void> {
    const attempts = timer.attempts + 1;
    const parked = attempts >= MAX_ATTEMPTS;
    const message = error.message.slice(0, 2000);
    // Only touch the row this worker failed on; if another worker already took it again, leave it alone.
    await this.db
      .updateTable("timers")
      .set({
        attempts,
        last_error: message,
        due_at: parked ? sql<Date>`'infinity'::timestamptz` : new Date(now.getTime() + backoffMs(attempts)),
      })
      .where("timer_id", "=", timer.timerId)
      .where("attempts", "=", timer.attempts)
      .execute();
    const data = { kind: timer.kind, refId: timer.refId, attempts, err: message };
    if (parked) recordTimerParked(timer.kind);
    if (parked) this.options.logger.error(data, "timer parked after repeated failures");
    else this.options.logger.warn(data, "timer failed; will retry");
  }
}
