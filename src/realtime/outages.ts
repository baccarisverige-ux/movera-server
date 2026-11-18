import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { Executor } from "../db/db.js";

/**
 * S4 B1.16 Q-B13 (owner W1 Q78 "An Exclusive offer that expired while the server's live link was down: count it toward
 * auto-offline? — Do not count it", 2026-11-11; contract v0.18.120 contract.json#autoOffline.outage).
 *
 * Each server copy writes the windows in which its LISTEN link was down into `realtime_outages` (migration 0116), so
 * every copy can read every copy's windows (Rule 33: a driver's offer feed may be on any copy, so the safe reading is
 * "any copy's window"). dispatch/autoOffline.ts skips an Exclusive or hand-sent offer that EXPIRED inside one.
 *
 * - down: `down_at` = the hub's last proof that the link worked (connect, a ping that answered, a notification), so an
 *   offer sent while the dead socket was not noticed yet (at most one ping interval + its timeout) is inside it too.
 * - still down: `seen_at` moves on at each failed reconnect attempt (at most every 5 s + the 5 s connect limit today).
 *   A window with no `up_at` ends at `seen_at + OUTAGE_OPEN_GRACE_MS` for the readers, so a copy that died while down
 *   (no up row ever) cannot stop the count for good.
 * - up: `up_at` = the reconnect; rows older than OUTAGE_KEEP_DAYS are pruned then.
 *
 * Writes go through the app pool and never block the hub: they are queued one after the other, and one that fails (the
 * database itself is down) is written at the next call that works, at the latest with the reconnect. One warning per
 * outage at most. NOT CHECKED: a socket that dies silently is noticed after up to 15 s; an offer that expires and is
 * counted in that gap, before the "down" row exists, still counts (the row is written as soon as the hub notices).
 */

/** An open window (copy still down, no reconnect yet) lasts until its last "still down" + this, for the readers. */
export const OUTAGE_OPEN_GRACE_MS = 60_000;
/** Windows are kept this long (a driver may stay online for days; offers older than his online time never count). */
export const OUTAGE_KEEP_DAYS = 7;

/** This process's name in realtime_outages: host (the Render instance), process id and a random part. */
export function outageCopyId(): string {
  return `${process.env.RENDER_INSTANCE_ID ?? hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
}

export type LinkWatcher = { down: (lastProvenAt: Date) => void; stillDown: () => void; up: (at: Date) => void };

type Window = { downAt: Date; seenAt: Date; upAt: Date | null; id: string | null };

export class OutageRecorder implements LinkWatcher {
  private window: Window | undefined;
  private queue: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(
    private readonly db: Executor,
    private readonly copyId: string,
    private readonly log: { warn: (data: object, message: string) => void },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  down(lastProvenAt: Date): void {
    const now = this.clock();
    this.window = { downAt: lastProvenAt <= now ? lastProvenAt : now, seenAt: now, upAt: null, id: null };
    this.warned = false;
    this.flush(this.window);
  }

  stillDown(): void {
    if (this.window === undefined || this.window.upAt !== null) return;
    this.window.seenAt = this.clock();
    this.flush(this.window);
  }

  up(at: Date): void {
    const window = this.window;
    if (window === undefined || window.upAt !== null) return;
    window.upAt = at < window.downAt ? window.downAt : at;
    window.seenAt = window.upAt;
    this.flush(window, true);
  }

  /** For tests: resolves once every queued write was tried. */
  settled(): Promise<void> {
    return this.queue;
  }

  private flush(window: Window, prune = false): void {
    this.queue = this.queue.then(() => this.write(window, prune));
  }

  private async write(window: Window, prune: boolean): Promise<void> {
    try {
      if (window.id === null) {
        const row = await this.db
          .insertInto("realtime_outages")
          .values({ copy_id: this.copyId, down_at: window.downAt, seen_at: window.seenAt, up_at: window.upAt })
          .returning("outage_id")
          .executeTakeFirstOrThrow();
        window.id = String(row.outage_id);
      } else {
        await this.db.updateTable("realtime_outages").set({ seen_at: window.seenAt, up_at: window.upAt }).where("outage_id", "=", window.id).execute();
      }
      if (prune) await this.db.deleteFrom("realtime_outages").where(sql<boolean>`coalesce(up_at, seen_at) < ${new Date(this.clock().getTime() - OUTAGE_KEEP_DAYS * 86_400_000)}`).execute();
    } catch (error) {
      if (!this.warned) this.log.warn({ err: error }, "realtime outage window not written yet; tried again at the next change");
      this.warned = true;
    }
  }
}
