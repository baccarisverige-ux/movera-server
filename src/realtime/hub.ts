import pg from "pg";
import { recordNotify } from "../telemetry/load.js";

/**
 * One LISTEN connection per server instance for every stream (contract §4 transport). PostgreSQL delivers a
 * NOTIFY only after its transaction commits, so a stream never sees a change that was rolled back. Notifications
 * only say "something new for X"; streams read the events themselves, so a lost or reordered notification is
 * harmless. After a reconnect every subscriber is told to catch up.
 */

export type Listener = (payload: Record<string, unknown> | null) => void;

/** S04 A4 / S03 C1: the LISTEN connection is pinged this often; a ping that fails or hangs reconnects it. */
export const HEALTH_CHECK_MS = 30_000;
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;

export type HubHealth = { status: "ok" | "down"; reconnects: number; subscribers: number; secondsSinceNotification: number | null };

export class NotificationHub {
  private client: pg.Client | undefined;
  private readonly listeners = new Map<string, Set<Listener>>();
  private closed = false;
  private retry: NodeJS.Timeout | undefined;
  private ready: Promise<void> | undefined;
  private ping: NodeJS.Timeout | undefined;
  private reconnects = 0;
  private lastNotification: number | undefined;

  constructor(
    private readonly url: string,
    private readonly channels: readonly string[],
    private readonly log: { warn: (data: object, message: string) => void } = { warn: () => undefined },
    private readonly health = { everyMs: HEALTH_CHECK_MS, timeoutMs: HEALTH_CHECK_TIMEOUT_MS },
  ) {}

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

  /** A `SELECT 1` on the LISTEN connection every 30 s; failure or no answer in time reconnects (with the catch-up signal). */
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
    this.retry = setTimeout(async () => {
      this.retry = undefined;
      try {
        await this.connect();
        this.reconnects += 1;
        // Anything may have happened while we were away: every stream reads what it missed.
        for (const set of this.listeners.values()) for (const listener of set) listener(null);
      } catch (error) {
        this.log.warn({ err: error }, "realtime listen reconnect failed");
        this.reconnectSoon();
      }
    }, 1000);
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
    clearInterval(this.ping);
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }
}
