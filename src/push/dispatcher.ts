import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "../db/db.js";
import { riderPushAlwaysSent } from "../notifications/tripPush.js";
import type { PushSender, SendResult } from "./fcm.js";

/**
 * Sends every bell notice as a push (contract v0.18.3 auth.devices.sending, owner decision R7). notify() only writes
 * the row inside its command's transaction and kicks this dispatcher; the dispatcher claims rows with pushed_at NULL
 * (FOR UPDATE SKIP LOCKED, so several instances never send one twice), which only exist once the command committed,
 * and sends outside any transaction. A rolled-back notice is never seen. A periodic sweep catches a kick that came
 * before the commit. One retry per device; tokens FCM calls dead are removed. Notices older than MAX_AGE_MS (push was
 * off, the server was down) are marked and not sent.
 */

/** A short one-way hash of a driver/rider id for logs (follow-up 2026-11-26). */
export const subjectHash = (audience: string, subjectId: string): string => createHash("sha256").update(`movera-push-subject:${audience}:${subjectId}`).digest("hex").slice(0, 16);

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

type PushRow = {
  notification_id: string;
  audience: "rider" | "driver";
  subject_id: string;
  kind: string;
  title: string;
  body: string;
  deep_link: string | null;
  created_at: Date;
  bell: boolean;
  push_until: Date | null;
  data: Record<string, unknown> | null;
};

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
    const rows = await sql<PushRow>`
      UPDATE notifications SET pushed_at = ${now}
      WHERE notification_id IN (
        SELECT notification_id FROM notifications WHERE pushed_at IS NULL ORDER BY created_at LIMIT ${this.options.batch ?? 50} FOR UPDATE SKIP LOCKED
      )
      RETURNING notification_id, audience, subject_id, kind, title, body, deep_link, created_at, bell, push_until, data`.execute(this.db);
    const maxAge = this.options.maxAgeMs ?? 60 * 60 * 1000;
    // v0.18.6 (G4 decision 1): a push with push_until (a new offer) is dropped once the offer has run out.
    const due = (row: PushRow) => now.getTime() - new Date(row.created_at).getTime() <= maxAge && (row.push_until === null || new Date(row.push_until).getTime() > now.getTime());
    await Promise.all(rows.rows.filter(due).map((row) => this.pushOne(row, now)));
    return rows.rows.length;
  }

  private async pushOne(row: PushRow, now: Date): Promise<void> {
    // v0.18.9 owner rule 16: the ride-check push is safety and always goes, whatever the ride-updates choice.
    // v0.18.53 §75 (owner Q36-Q39, contract.json#riderTripPush.consent): rideUpdates false stops only the optional
    // trip moments (driver_found, driver_arriving) and kinds outside the always-sent set (riderPushAlwaysSent); arrived,
    // a new driver, cancelled, no driver found, failed, the booked-ride no-driver kinds (to the rider) and a support answer always go.
    if (row.audience === "rider" && !riderPushAlwaysSent(row.kind, row.data)) {
      const rider = await this.db.selectFrom("riders").select("consents").where("rider_id", "=", row.subject_id).executeTakeFirst();
      if ((rider?.consents as { rideUpdates?: unknown } | null | undefined)?.rideUpdates === false) return;
    }
    // Checker LOW 9 (G4 decision 1): a new-offer push goes only while its offer is still open (not withdrawn, taken,
    // declined or expired), not only before push_until.
    const offerId = row.bell === false ? row.data?.["offerId"] : undefined;
    if (typeof offerId === "string") {
      const offer = await this.db.selectFrom("offers").select(["status", "expires_at"]).where("offer_id", "=", offerId).executeTakeFirst();
      if (offer === undefined || offer.status !== "open" || offer.expires_at.getTime() <= now.getTime()) return;
    }
    // v0.18.56 §78 (inAppCalls.push): an incoming-call push goes only while that call still rings.
    const callId = row.kind === "call_ringing" ? row.data?.["callId"] : undefined;
    if (typeof callId === "string") {
      const ringing = await this.db.selectFrom("trip_calls").select("state").where("call_id", "=", callId).executeTakeFirst();
      if (ringing?.state !== "ringing") return;
    }
    const devices = await this.db.selectFrom("push_devices").select(["token", "platform"]).where("actor", "=", row.audience).where("subject_id", "=", row.subject_id).where("provider", "=", "fcm").execute();
    // v0.18.6 (contract.json#driverOffers.push.data): a push-only row (the new-offer push) carries its own data too,
    // as strings, and the sound rule; bell notices keep the v0.18.3 data.
    const extra = row.bell === false ? Object.fromEntries(Object.entries(row.data ?? {}).map(([k, v]) => [k, String(v)])) : {};
    const data = { ...extra, notificationId: row.notification_id, kind: row.kind, deepLink: row.deep_link ?? "" };
    const sound = extra["sound"] === "offer" || extra["sound"] === "none" ? (extra["sound"] as "offer" | "none") : undefined;
    const ttlSeconds = row.push_until === null ? undefined : Math.max(1, Math.ceil((new Date(row.push_until).getTime() - now.getTime()) / 1000));
    await Promise.all(
      devices.map(async (device) => {
        const message = { token: device.token, platform: device.platform, title: row.title, body: row.body, data, ...(sound ? { sound } : {}), ...(ttlSeconds ? { ttlSeconds } : {}) };
        let result: SendResult = await this.sender.send(message);
        if (result === "retry" && !this.stopped) {
          await this.sleep(this.options.retryDelayMs ?? 2000);
          result = await this.sender.send(message);
        }
        if (result === "dead_token") {
          await this.db.deleteFrom("push_devices").where("token", "=", device.token).where("actor", "=", row.audience).execute();
        } else if (result !== "sent") {
          // Follow-up 2026-11-26: which app and a hash of whose id (never the token or the raw id).
          this.options.logger?.warn({ notificationId: row.notification_id, kind: row.kind, app: row.audience, subjectHash: subjectHash(row.audience, row.subject_id), platform: device.platform, result }, "push not delivered to one device");
        }
      }),
    );
  }
}
