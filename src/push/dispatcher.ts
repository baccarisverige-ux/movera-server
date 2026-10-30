import { sql } from "kysely";
import type { Db } from "../db/db.js";
import type { PushSender, SendResult } from "./fcm.js";

/**
 * Sends every bell notice as a push (contract v0.18.3 auth.devices.sending, owner decision R7). notify() only writes
 * the row inside its command's transaction and kicks this dispatcher; the dispatcher claims rows with pushed_at NULL
 * (FOR UPDATE SKIP LOCKED, so several instances never send one twice), which only exist once the command committed,
 * and sends outside any transaction. A rolled-back notice is never seen. A periodic sweep catches a kick that came
 * before the commit. One retry per device; tokens FCM calls dead are removed. Notices older than MAX_AGE_MS (push was
 * off, the server was down) are marked and not sent.
 */

export type PushLogger = { warn: (data: object, message: string) => void; info?: (data: object, message: string) => void };

export type DispatcherOptions = {
  clock?: () => Date;
  logger?: PushLogger;
  /** Wait before the one retry of a device. */
  retryDelayMs?: number;
  /** How often the sweep runs without a kick. */
  sweepMs?: number;
  maxAgeMs?: number;
  batch?: number;
  sleep?: (ms: number) => Promise<void>;
};

const KICK_DELAYS_MS = [50, 1500];

export class PushDispatcher {
  private readonly clock: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private timers = new Set<NodeJS.Timeout>();
  private interval: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;
  private again = false;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly sender: PushSender,
    private readonly options: DispatcherOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  start(): void {
    this.stopped = false;
    this.interval = setInterval(() => void this.sweepSafely(), this.options.sweepMs ?? 15_000);
    this.interval.unref();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await this.running?.catch(() => 0);
  }

  /** Called by notify(): never waits, never throws. */
  kick(): void {
    if (this.stopped) return;
    for (const ms of KICK_DELAYS_MS) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        void this.sweepSafely();
      }, ms);
      t.unref();
      this.timers.add(t);
    }
  }

  private async sweepSafely(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      this.options.logger?.warn({ err: { message: (error as Error).message } }, "push sweep failed");
    }
  }

  /** Sends what is waiting; returns how many notices were taken. One sweep at a time per instance. */
  async sweep(): Promise<number> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let total = 0;
      do {
        this.again = false;
        let n: number;
        do {
          n = await this.sweepOnce();
          total += n;
        } while (n > 0 && !this.stopped);
      } while (this.again && !this.stopped);
      return total;
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  private async sweepOnce(): Promise<number> {
    const now = this.clock();
    const rows = await sql<{ notification_id: string; audience: "rider" | "driver"; subject_id: string; kind: string; title: string; body: string; deep_link: string | null; created_at: Date }>`
      UPDATE notifications SET pushed_at = ${now}
      WHERE notification_id IN (
        SELECT notification_id FROM notifications WHERE pushed_at IS NULL ORDER BY created_at LIMIT ${this.options.batch ?? 50} FOR UPDATE SKIP LOCKED
      )
      RETURNING notification_id, audience, subject_id, kind, title, body, deep_link, created_at`.execute(this.db);
    const maxAge = this.options.maxAgeMs ?? 60 * 60 * 1000;
    await Promise.all(rows.rows.filter((row) => now.getTime() - new Date(row.created_at).getTime() <= maxAge).map((row) => this.pushOne(row)));
    return rows.rows.length;
  }

  private async pushOne(row: { notification_id: string; audience: "rider" | "driver"; subject_id: string; kind: string; title: string; body: string; deep_link: string | null }): Promise<void> {
    if (row.audience === "rider") {
      const rider = await this.db.selectFrom("riders").select("consents").where("rider_id", "=", row.subject_id).executeTakeFirst();
      if ((rider?.consents as { rideUpdates?: unknown } | null | undefined)?.rideUpdates === false) return;
    }
    const devices = await this.db.selectFrom("push_devices").select(["token", "platform"]).where("actor", "=", row.audience).where("subject_id", "=", row.subject_id).where("provider", "=", "fcm").execute();
    const data = { notificationId: row.notification_id, kind: row.kind, deepLink: row.deep_link ?? "" };
    await Promise.all(
      devices.map(async (device) => {
        const message = { token: device.token, platform: device.platform, title: row.title, body: row.body, data };
        let result: SendResult = await this.sender.send(message);
        if (result === "retry" && !this.stopped) {
          await this.sleep(this.options.retryDelayMs ?? 2000);
          result = await this.sender.send(message);
        }
        if (result === "dead_token") {
          await this.db.deleteFrom("push_devices").where("token", "=", device.token).where("actor", "=", row.audience).execute();
        } else if (result !== "sent") {
          this.options.logger?.warn({ notificationId: row.notification_id, kind: row.kind, platform: device.platform, result }, "push not delivered to one device");
        }
      }),
    );
  }
}
