import pg from "pg";
import { recordNotify } from "../telemetry/load.js";

/**
 * One LISTEN connection per server instance for every stream (contract §4 transport). PostgreSQL delivers a
 * NOTIFY only after its transaction commits, so a stream never sees a change that was rolled back. Notifications
 * only say "something new for X"; streams read the events themselves, so a lost or reordered notification is
 * harmless. After a reconnect every subscriber is told to catch up.
 */

export type Listener = (payload: Record<string, unknown> | null) => void;

export class NotificationHub {
  private client: pg.Client | undefined;
  private readonly listeners = new Map<string, Set<Listener>>();
  private closed = false;
  private retry: NodeJS.Timeout | undefined;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly url: string,
    private readonly channels: readonly string[],
    private readonly log: { warn: (data: object, message: string) => void } = { warn: () => undefined },
  ) {}

  start(): Promise<void> {
    this.ready ??= this.connect();
    return this.ready;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.url, application_name: "movera-server-listen" });
    client.on("notification", (message) => {
      recordNotify();
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
      this.reconnectSoon();
    });
    client.on("end", () => this.reconnectSoon());
    await client.connect();
    for (const channel of this.channels) await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
    this.client = client;
  }

  private reconnectSoon(): void {
    if (this.closed || this.retry) return;
    this.client = undefined;
    this.retry = setTimeout(async () => {
      this.retry = undefined;
      try {
        await this.connect();
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

  async stop(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retry);
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }
}
