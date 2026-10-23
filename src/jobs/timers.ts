import { sql } from "kysely";
import type { Db, Executor, Trx } from "../db/db.js";

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
};

export type TimerHandler = (trx: Trx, timer: Timer) => Promise<void>;

export type TimerLogger = {
  warn: (data: object, message: string) => void;
  error: (data: object, message: string) => void;
};

export const MAX_ATTEMPTS = 8;

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

export type TimerWorkerOptions = {
  handlers: Record<string, TimerHandler>;
  logger: TimerLogger;
  clock?: () => Date;
  pollMs?: number;
};

export class TimerWorker {
  private readonly clock: () => Date;
  private readonly pollMs: number;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly db: Db,
    private readonly options: TimerWorkerOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.pollMs = options.pollMs ?? 500;
  }

  /** Takes and runs one due timer. Returns false when none is due (or every due one is taken by another worker). */
  async runOne(): Promise<boolean> {
    const now = this.clock();
    let taken: Timer | undefined;
    try {
      const ran = await this.db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom("timers")
          .selectAll()
          .where("due_at", "<=", now)
          .orderBy("due_at")
          .orderBy("timer_id")
          .limit(1)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (row === undefined) return false;
        taken = {
          timerId: row.timer_id,
          kind: row.kind,
          refId: row.ref_id,
          dueAt: row.due_at,
          payload: row.payload,
          attempts: row.attempts,
        };
        await trx.deleteFrom("timers").where("timer_id", "=", row.timer_id).execute();
        const handler = this.options.handlers[row.kind];
        if (handler === undefined) throw new Error(`No handler for timer kind ${row.kind}`);
        await handler(trx, taken);
        return true;
      });
      return ran;
    } catch (error) {
      if (taken === undefined) throw error;
      await this.recordFailure(taken, error as Error, now);
      return true;
    }
  }

  /** Runs due timers until none is left. Returns how many were taken. */
  async runDue(limit = 1000): Promise<number> {
    let count = 0;
    while (count < limit && (await this.runOne())) count++;
    return count;
  }

  start(): void {
    if (this.loop !== undefined) return;
    this.stopping = false;
    this.loop = (async () => {
      while (!this.stopping) {
        try {
          await this.runDue(100);
        } catch (error) {
          this.options.logger.error({ err: error }, "timer worker: database error");
        }
        if (this.stopping) break;
        await new Promise<void>((resolve) => {
          const handle = setTimeout(resolve, this.pollMs);
          this.wake = () => {
            clearTimeout(handle);
            resolve();
          };
        });
        this.wake = undefined;
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
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
    if (parked) this.options.logger.error(data, "timer parked after repeated failures");
    else this.options.logger.warn(data, "timer failed; will retry");
  }
}
