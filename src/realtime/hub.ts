import pg from "pg";
import { recordNotify } from "../telemetry/load.js";

/**
 * One LISTEN connection per server instance for every stream (contract §4 transport). PostgreSQL delivers a
 * NOTIFY only after its transaction commits, so a stream never sees a change that was rolled back. Notifications
 * only say "something new for X"; streams read the events themselves, so a lost or reordered notification is
 * harmless. After a reconnect every subscriber is told to catch up.
 */

export type Listener = (payload: Record<string, unknown> | null) => void;

/**
 * S04 A4 / S03 C1: the LISTEN connection is pinged this often; a ping that fails or hangs reconnects it.
 * B1.16 (owner W1 Q77): every 10 s, shorter than the 14 s Exclusive offer window, so a dead socket is found while
 * the offer is still open.
 */
export const HEALTH_CHECK_MS = 10_000;
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * B1.16: a lost LISTEN connection is retried after 1, 2, 4, … s, capped at 30 s, each delay drawn at random between
 * half and all of it (jitter), so the copies of a server that lost the database together (a database restart) do not
 * all come back in the same instant. A connect that works resets the back-off.
 */
export const RECONNECT_BACKOFF = { baseMs: 1_000, maxMs: 30_000 };

/**
 * B1.16 (staggered catch-up): after a reconnect, the catch-up signal (null) is handed to the streams this many at a
 * time, one batch every `everyMs`, so 10,000 streams start their catch-up read over ~5 s, not in one instant.
 */
export const CATCH_UP_BATCH = { size: 200, everyMs: 100 };

export type HubTuning = { everyMs: number; timeoutMs: number; reconnectBaseMs: number; reconnectMaxMs: number; catchUpBatch: number; catchUpEveryMs: number };
const HUB_TUNING: HubTuning = {
  everyMs: HEALTH_CHECK_MS,
  timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
  reconnectBaseMs: RECONNECT_BACKOFF.baseMs,
  reconnectMaxMs: RECONNECT_BACKOFF.maxMs,
  catchUpBatch: CATCH_UP_BATCH.size,
  catchUpEveryMs: CATCH_UP_BATCH.everyMs,
};

/** The wait before reconnect attempt `attempt` (0 = the first): half to all of min(max, base · 2^attempt). */
export function reconnectDelayMs(attempt: number, tuning: Pick<HubTuning, "reconnectBaseMs" | "reconnectMaxMs"> = HUB_TUNING): number {
  const ceiling = Math.min(tuning.reconnectMaxMs, tuning.reconnectBaseMs * 2 ** Math.min(attempt, 30));
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

export type HubHealth = { status: "ok" | "down"; reconnects: number; subscribers: number; secondsSinceNotification: number | null };

export class NotificationHub {
  private client: pg.Client | undefined;
  private readonly listeners = new Map<string, Set<Listener>>();
  private closed = false;
  private retry: NodeJS.Timeout | undefined;
  private ready: Promise<void> | undefined;
  private ping: NodeJS.Timeout | undefined;
  private reconnects = 0;
  private attempt = 0;
  private catchUp: NodeJS.Timeout | undefined;
  private lastNotification: number | undefined;
  private readonly health: HubTuning;

  constructor(
    private readonly url: string,
    private readonly channels: readonly string[],
    private readonly log: { warn: (data: object, message: string) => void } = { warn: () => undefined },
    tuning: Partial<HubTuning> = {},
  ) {
    this.health = { ...HUB_TUNING, ...tuning };
  }

  start(): Promise<void> {
    this.ready ??= this.connect();
    return this.ready;
  }

  private async connect(): Promise<void> {
    // keepAlive: a socket that died without a close is noticed by TCP too (pg's default is off).
    const client = new pg.Client({ connectionString: this.url, application_name: "movera-server-listen", keepAlive: true });
    client.on("notification", (message) => {
      recordNotify();
      this.lastNotification = Date.now();
      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(message.payload ?? "null") as Record<string, unknown>;
      } catch {
        payload = null;
      }
      for (const listener of this.listeners.get(message.channel) ?? []) listener(payload);
    });
    client.on("error", (error) => {
      this.log.warn({ err: error }, "realtime listen connection lost");
      this.reconnectSoon(client);
    });
    client.on("end", () => this.reconnectSoon(client));
    try {
      await client.connect();
      for (const channel of this.channels) await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    if (this.closed) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.startPing(client);
  }

  /** A `SELECT 1` on the LISTEN connection every 10 s; failure or no answer in time reconnects (with the catch-up signal). */
  private startPing(client: pg.Client): void {
    clearInterval(this.ping);
    this.ping = setInterval(() => {
      if (this.client !== client) return;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("realtime listen health check timed out")), this.health.timeoutMs);
      });
      Promise.race([client.query("SELECT 1"), timeout])
        .catch((error: unknown) => {
          if (this.client !== client) return;
          this.log.warn({ err: error }, "realtime listen health check failed");
          this.reconnectSoon(client);
        })
        .finally(() => clearTimeout(timer));
    }, this.health.everyMs);
    this.ping.unref();
  }

  private reconnectSoon(from?: pg.Client): void {
    if (this.closed || this.retry) return;
    // An old connection's late error/end must not tear down its replacement.
    if (from !== undefined && this.client !== undefined && this.client !== from) return;
    clearInterval(this.ping);
    this.ping = undefined;
    const dead = this.client;
    this.client = undefined;
    // Drop the dead socket so its own end/error cannot fire later and it does not leak.
    if (dead !== undefined) void dead.end().catch(() => undefined);
    // A catch-up still being handed out is for the connection that just died; the next one starts afresh.
    clearTimeout(this.catchUp);
    this.catchUp = undefined;
    const delay = reconnectDelayMs(this.attempt, this.health);
    this.attempt += 1;
    this.retry = setTimeout(async () => {
      this.retry = undefined;
      try {
        await this.connect();
        if (this.closed) return;
        this.attempt = 0;
        this.reconnects += 1;
        // Anything may have happened while we were away: every stream reads what it missed.
        this.tellCatchUp();
      } catch (error) {
        this.log.warn({ err: error, attempt: this.attempt }, "realtime listen reconnect failed");
        this.reconnectSoon();
      }
    }, delay);
  }

  /**
   * B1.16: the catch-up signal for every listener there is now, `catchUpBatch` at a time, one batch every
   * `catchUpEveryMs`. A listener that unsubscribed before its batch is skipped; one that subscribed later read on
   * its own when it opened.
   */
  private tellCatchUp(): void {
    const pending: Array<[Set<Listener>, Listener]> = [];
    for (const set of this.listeners.values()) for (const listener of set) pending.push([set, listener]);
    let next = 0;
    const batch = () => {
      this.catchUp = undefined;
      if (this.closed) return;
      const end = Math.min(pending.length, next + Math.max(1, this.health.catchUpBatch));
      for (; next < end; next += 1) {
        const [set, listener] = pending[next]!;
        if (set.has(listener)) listener(null);
      }
      if (next < pending.length) {
        this.catchUp = setTimeout(batch, this.health.catchUpEveryMs);
        this.catchUp.unref();
      }
    };
    batch();
  }

  subscribe(channel: string, listener: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  subscriberCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  /** For /healthz: whether the LISTEN connection is up, how often it came back, and when it last heard anything. */
  healthSnapshot(): HubHealth {
    return {
      status: this.client !== undefined && !this.closed ? "ok" : "down",
      reconnects: this.reconnects,
      subscribers: this.subscriberCount(),
      secondsSinceNotification: this.lastNotification === undefined ? null : Math.floor((Date.now() - this.lastNotification) / 1000),
    };
  }

  async stop(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retry);
    clearTimeout(this.catchUp);
    clearInterval(this.ping);
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }
}
