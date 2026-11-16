import pg from "pg";
import { isDatabaseConnectionError } from "../db/ready.js";
import { recordNotify } from "../telemetry/load.js";

/**
 * One LISTEN connection per server instance for every stream (contract §4 transport). PostgreSQL delivers a
 * NOTIFY only after its transaction commits, so a stream never sees a change that was rolled back. Notifications
 * only say "something new for X"; streams read the events themselves, so a lost or reordered notification is
 * harmless. After a reconnect every subscriber is told to catch up.
 */

export type Listener = (payload: Record<string, unknown> | null) => void;

/**
 * How a listener gets the catch-up signal after a reconnect (supervisor MF-1). "first" (the default): at once, before
 * any "spread" listener — offer feeds, trip streams, the SOS / incident stream, admin feeds, caches. "spread": in
 * batches after them — the rider / driver settings streams (B1.18: their close is spread over 30 s anyway).
 */
export type SubscribeOptions = {
  catchUp?: "first" | "spread";
  /**
   * S7 0.15 (owner W2 Q120 part 1): the payloads this listener is for. Each entry names payload fields with the value
   * each must have, e.g. { tripId: "trp_…" } or { reservations: true, zoneId: "Z001" }; ALL fields of an entry must
   * be equal, and ANY ONE entry is enough ([{ reservations: true, zoneId }, { reservations: true, driverId }]). A
   * NOTIFY then runs this listener only when its payload fits an entry; the hub finds it by the values instead of
   * calling every listener of the channel. It is a first sieve only: the listener still checks the payload itself.
   * Without `match` (or with an empty list) the listener gets every NOTIFY of the channel, as before.
   * The catch-up signal (null: after a reconnect, or a payload that cannot be read) always reaches every listener.
   */
  match?: ReadonlyArray<Readonly<Record<string, MatchValue>>>;
};
export type MatchValue = string | number | boolean;
type Sub = { fn: Listener; spread: boolean; live: boolean; seq: number };
/** 0.15: the listeners that asked for the same fields (in this order), by the values they asked for (valuesKey). */
type FieldIndex = { fields: string[]; byValues: Map<string, Set<Sub>> };

const isMatchValue = (value: unknown): value is MatchValue => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
/** One text for a list of values; the type is part of it, so true never equals "true" and 7 never equals "7". */
const valuesKey = (values: readonly MatchValue[]): string => JSON.stringify(values);

/**
 * S04 A4 / S03 C1: the LISTEN connection is pinged this often; a ping that fails or hangs reconnects it.
 * B1.16 (owner W1 Q77): every 10 s (was 30 s). A socket that dies without a close is found at worst after one ping
 * interval plus the ping timeout (10 + 5 = 15 s), then the reconnect wait and the catch-up come on top; a socket that
 * closes or errors is noticed at once. (Supervisor N1: this is not "inside the 14 s Exclusive window" in the worst case.)
 */
export const HEALTH_CHECK_MS = 10_000;
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * B1.16: a lost LISTEN connection is retried after 1, 2, 4, … s, capped, each delay drawn at random between half and
 * all of it (jitter), so the copies of a server that lost the database together (a database restart) do not all come
 * back in the same instant. A connect that works resets the back-off.
 * Supervisor MF-2: the cap is 5 s, not the plan's 30 s, until Q-B13 ships (owner Q78: an Exclusive missed while the
 * live link was down must not count toward auto-offline; today autoOffline.ts missedInRow counts it). It is one
 * connect per server copy, so the short cap costs the database almost nothing. Raise to 30 s together with Q-B13.
 */
export const RECONNECT_BACKOFF = { baseMs: 1_000, maxMs: 5_000 };

/**
 * PM-1 (post-merge supervisor of #249): one connect attempt of the LISTEN connection (TCP + sign-in + every LISTEN)
 * may take this long at most. A link that accepts the connection but never answers used to hang the attempt for ever:
 * no retry, no ping, the copy stayed "down" and no offer feed, trip stream or SOS stream got a hint or a close until
 * the process restarted. Now the attempt is given up, its half-open client is destroyed and the normal back-off goes
 * on. 5 s is the health-check timeout above (HEALTH_CHECK_TIMEOUT_MS). It is NOT the app pool's connect timeout,
 * which is 10 s by default (DATABASE_POOL_CONNECT_TIMEOUT_MS, env.ts → db/db.ts createPool), nor the health pool's
 * 1.5 s (db/db.ts createHealthPool). A short limit is safe here because the attempts go on for ever, at boot too.
 */
export const LISTEN_CONNECT_TIMEOUT_MS = 5_000;
const CONNECT_TIMED_OUT = "MOVERA_LISTEN_CONNECT_TIMEOUT";

/**
 * PM-1 MF-1: whether a failed FIRST connect can heal by itself, so the hub may keep trying in the background: its own
 * timeout (or pg's), or a "database cannot be reached right now" error - the same rule as waitForDatabase
 * (db/ready.ts). Anything else (unknown database, wrong password or user, a bad address) is a wrong setting: it
 * never heals, so start() rejects and the boot fails.
 */
function healsByItself(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (e?.code === CONNECT_TIMED_OUT || e?.message === "timeout expired") return true;
  return isDatabaseConnectionError(error);
}

/**
 * PM-1 round 4 (owner 2026-11-15 "Wait up to 30 s (Rec.)"): a NEW server copy is "not ready" (/readyz 503) until its
 * first LISTEN connect, for at most this long after start(); then it is ready anyway, so a database link that stays
 * down never blocks a deploy for ever. The host keeps the old copy serving meanwhile. Once ready, always ready: a
 * LISTEN drop later in the day never makes a copy "not ready" (the host would take working copies out of service).
 */
export const LISTEN_READY_WAIT_MS = 30_000;

/**
 * PM-1 SF-4: while the link stays down, "realtime listen reconnect failed" is logged for the first failed attempt and
 * then at most this often (with the number of failures since), not once per attempt (every 2.5–10 s, for ever).
 */
export const RECONNECT_WARN_EVERY_MS = 60_000;

/**
 * B1.16 (staggered catch-up): after a reconnect, the "first" listeners get the catch-up signal (null) at once; the
 * "spread" listeners (settings streams) get it this many at a time, one batch every `everyMs`, after them: 200 per
 * 100 ms = 2,000 listeners per second. A rider / driver settings stream has 2 spread listeners (config + hint), so
 * 10,000 settings streams = 20,000 listeners over ~10 s. Listeners not yet told when the link drops again go first
 * in the next round.
 */
export const CATCH_UP_BATCH = { size: 200, everyMs: 100 };

export type HubTuning = { everyMs: number; timeoutMs: number; reconnectBaseMs: number; reconnectMaxMs: number; catchUpBatch: number; catchUpEveryMs: number; connectTimeoutMs: number; readyWaitMs: number };
const HUB_TUNING: HubTuning = {
  everyMs: HEALTH_CHECK_MS,
  timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
  reconnectBaseMs: RECONNECT_BACKOFF.baseMs,
  reconnectMaxMs: RECONNECT_BACKOFF.maxMs,
  catchUpBatch: CATCH_UP_BATCH.size,
  catchUpEveryMs: CATCH_UP_BATCH.everyMs,
  connectTimeoutMs: LISTEN_CONNECT_TIMEOUT_MS,
  readyWaitMs: LISTEN_READY_WAIT_MS,
};

/** The wait before reconnect attempt `attempt` (0 = the first): half to all of min(max, base · 2^attempt). */
export function reconnectDelayMs(attempt: number, tuning: Pick<HubTuning, "reconnectBaseMs" | "reconnectMaxMs"> = HUB_TUNING): number {
  const ceiling = Math.min(tuning.reconnectMaxMs, tuning.reconnectBaseMs * 2 ** Math.min(attempt, 30));
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

export type HubHealth = { status: "ok" | "down"; reconnects: number; subscribers: number; secondsSinceNotification: number | null };

export class NotificationHub {
  private client: pg.Client | undefined;
  /** Every listener of a channel, in subscribe order (the catch-up signal and the count read this). */
  private readonly listeners = new Map<string, Set<Sub>>();
  /** 0.15: the listeners of a channel that gave no `match`: they get every NOTIFY of it. */
  private readonly unmatched = new Map<string, Set<Sub>>();
  /** 0.15: channel → the field sets asked for on it → values → the listeners that asked for them. Empty ones are removed. */
  private readonly index = new Map<string, Map<string, FieldIndex>>();
  private nextSeq = 0;
  /** Spread listeners of the current catch-up round, in order, and how many of them were told already. */
  private spreadQueue: Sub[] = [];
  private spreadNext = 0;
  private closed = false;
  private retry: NodeJS.Timeout | undefined;
  private ready: Promise<void> | undefined;
  private ping: NodeJS.Timeout | undefined;
  private reconnects = 0;
  private attempt = 0;
  private catchUp: NodeJS.Timeout | undefined;
  private lastNotification: number | undefined;
  /** PM-1: gives up the connect attempt that is running now (stop() uses it), or undefined when none is. */
  private abortConnect: (() => void) | undefined;
  /** Whether a connect ever worked: the first one (also a late one after a failed start) is not a "reconnect". */
  private connectedOnce = false;
  /** Round 4: when start() was first called, and whether this copy was ever ready for traffic (then it stays so). */
  private startedAt: number | undefined;
  private wasReady = false;
  /** SF-4: when "reconnect failed" was last logged in this outage, and the failed attempts since. */
  private lastFailWarning: number | undefined;
  private failedSinceWarning = 0;
  private readonly health: HubTuning;

  constructor(
    private readonly url: string,
    private readonly channels: readonly string[],
    private readonly log: { warn: (data: object, message: string) => void } = { warn: () => undefined },
    tuning: Partial<HubTuning> = {},
  ) {
    this.health = { ...HUB_TUNING, ...tuning };
  }

  /**
   * Opens the LISTEN connection. The promise settles after the FIRST attempt (at most `connectTimeoutMs`):
   *  - connected;
   *  - a link problem (the hub's timeout, or a "database cannot be reached right now" error, see healsByItself):
   *    it resolves all the same and the hub keeps trying in the background with the reconnect back-off until it is
   *    connected or stopped; healthSnapshot() says "down" meanwhile (PM-1 SF-2 + N-1: main.ts awaits this before
   *    app.listen, so a rejection there ended the process on one slow try, or - a connection-class error, which
   *    guardProcess keeps alive - left a process that listened on nothing);
   *  - any other error (MF-1: unknown database, wrong password or user, a bad address): it REJECTS and nothing is
   *    retried, so the boot fails and a deploy with a wrong DATABASE_LISTEN_URL never replaces the working copy.
   */
  start(): Promise<void> {
    this.startedAt ??= Date.now();
    this.ready ??= this.connect().catch((error: unknown) => {
      if (!healsByItself(error)) throw error;
      this.log.warn({ err: error }, "realtime listen connect failed at start; retrying");
      this.reconnectSoon();
    });
    return this.ready;
  }

  private async connect(): Promise<void> {
    const limit = this.health.connectTimeoutMs;
    // keepAlive: a socket that died without a close is noticed by TCP too (pg's default is off).
    // connectionTimeoutMillis (PM-1): pg itself destroys a socket whose connect / sign-in gets no answer in time.
    const client = new pg.Client({ connectionString: this.url, application_name: "movera-server-listen", keepAlive: true, connectionTimeoutMillis: limit });
    const onNotification = (message: pg.Notification) => {
      recordNotify();
      this.lastNotification = Date.now();
      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(message.payload ?? "null") as Record<string, unknown>;
      } catch {
        payload = null;
      }
      // A payload that cannot be read (null) is the catch-up signal for every listener of the channel, as before;
      // so is anything that is not an object (no field to look up: every listener gets it as it is, as before).
      if (payload === null || typeof payload !== "object") {
        for (const sub of this.listeners.get(message.channel) ?? []) sub.fn(payload);
        return;
      }
      // `live`: a listener that an earlier one of this same NOTIFY unsubscribed is not run (as when the set was walked).
      for (const sub of this.listenersFor(message.channel, payload)) if (sub.live) sub.fn(payload);
    };
    const onError = (error: Error) => {
      this.log.warn({ err: error }, "realtime listen connection lost");
      this.reconnectSoon(client);
    };
    const onEnd = () => this.reconnectSoon(client);
    client.on("notification", onNotification);
    client.on("error", onError);
    client.on("end", onEnd);
    // PM-1: the whole attempt (connect + every LISTEN) races one deadline, so a LISTEN that gets no answer is given
    // up too. Whatever the given-up attempt does later is ignored: its client is destroyed and has no listeners left.
    let gaveUp = false;
    let timer: NodeJS.Timeout | undefined;
    let giveUp: (error: Error) => void = () => undefined;
    const deadline = new Promise<never>((_, reject) => {
      giveUp = (error) => {
        gaveUp = true;
        clearTimeout(timer);
        reject(error);
      };
      timer = setTimeout(() => giveUp(Object.assign(new Error(`realtime listen connect timed out after ${limit} ms`), { code: CONNECT_TIMED_OUT })), limit);
    });
    const abort = () => giveUp(new Error("realtime hub stopped"));
    this.abortConnect = abort;
    const attempt = (async () => {
      await client.connect();
      for (const channel of this.channels) {
        if (gaveUp) return;
        await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      }
    })();
    try {
      await Promise.race([attempt, deadline]);
    } catch (error) {
      gaveUp = true;
      // The loser of the race may still settle later; that must not become an unhandled rejection.
      attempt.catch(() => undefined);
      client.off("notification", onNotification);
      client.off("error", onError);
      client.off("end", onEnd);
      discard(client);
      // stop() during the attempt: nothing to report, nothing to retry.
      if (this.closed) return;
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.abortConnect === abort) this.abortConnect = undefined;
    }
    if (this.closed) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.connectedOnce = true;
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
    // An old connection's late error/end must not tear down its replacement, nor start a second connect while the
    // replacement is still connecting (supervisor N5: then this.client is undefined).
    if (from !== undefined && this.client !== from) return;
    clearInterval(this.ping);
    this.ping = undefined;
    const dead = this.client;
    this.client = undefined;
    // Drop the dead socket so its own end/error cannot fire later and it does not leak.
    if (dead !== undefined) void dead.end().catch(() => undefined);
    // The batches stop; the listeners not yet told stay in spreadQueue and go first in the next round (MF-1).
    clearTimeout(this.catchUp);
    this.catchUp = undefined;
    const delay = reconnectDelayMs(this.attempt, this.health);
    this.attempt += 1;
    this.retry = setTimeout(async () => {
      this.retry = undefined;
      const again = this.connectedOnce;
      try {
        await this.connect();
        if (this.closed) return;
        this.attempt = 0;
        this.lastFailWarning = undefined;
        this.failedSinceWarning = 0;
        if (again) this.reconnects += 1;
        // Anything may have happened while we were away: every stream reads what it missed. (Also after a first
        // connect that came late: streams may have opened while the hub was still down.)
        this.tellCatchUp();
      } catch (error) {
        // SF-4: the first failure of an outage at once, then at most one line a minute.
        this.failedSinceWarning += 1;
        const now = Date.now();
        if (this.lastFailWarning === undefined || now - this.lastFailWarning >= RECONNECT_WARN_EVERY_MS) {
          this.log.warn({ err: error, attempt: this.attempt, failedSinceLastWarning: this.failedSinceWarning }, "realtime listen reconnect failed");
          this.lastFailWarning = now;
          this.failedSinceWarning = 0;
        }
        this.reconnectSoon();
      }
    }, delay);
  }

  /**
   * B1.16 + MF-1: the catch-up signal for every listener there is now. "first" listeners at once (each in its own
   * try, so one bug cannot stop the others); then the "spread" listeners `catchUpBatch` at a time, one batch every
   * `catchUpEveryMs`: first those a dropped earlier round had not told yet, then the rest. A listener that unsubscribed
   * before its turn is skipped; one that subscribes later read on its own when it opened.
   */
  private tellCatchUp(): void {
    const carried = this.spreadQueue.slice(this.spreadNext).filter((sub) => sub.live);
    const queued = new Set(carried);
    const rest: Sub[] = [];
    for (const set of this.listeners.values()) {
      for (const sub of set) {
        if (!sub.spread) this.tellOne(sub);
        else if (!queued.has(sub)) rest.push(sub);
      }
    }
    this.spreadQueue = [...carried, ...rest];
    this.spreadNext = 0;
    const batch = () => {
      this.catchUp = undefined;
      if (this.closed) return;
      const end = Math.min(this.spreadQueue.length, this.spreadNext + Math.max(1, this.health.catchUpBatch));
      while (this.spreadNext < end) {
        const sub = this.spreadQueue[this.spreadNext]!;
        this.spreadNext += 1;
        if (sub.live) this.tellOne(sub);
      }
      if (this.spreadNext < this.spreadQueue.length) {
        this.catchUp = setTimeout(batch, this.health.catchUpEveryMs);
        this.catchUp.unref();
      } else {
        this.spreadQueue = [];
        this.spreadNext = 0;
      }
    };
    batch();
  }

  private tellOne(sub: Sub): void {
    try {
      sub.fn(null);
    } catch (error) {
      this.log.warn({ err: error }, "realtime catch-up listener failed");
    }
  }

  /**
   * 0.15: the listeners a NOTIFY with this payload runs: those without `match`, and those with an entry the payload
   * fits. Each once, in subscribe order (as when every listener was called). The cost is the number of listeners
   * found plus the number of different field sets asked for on the channel (a handful), not the number of open streams.
   */
  private listenersFor(channel: string, payload: Record<string, unknown>): Iterable<Sub> {
    const open = this.unmatched.get(channel);
    const indexes = this.index.get(channel);
    let found: Set<Sub> | undefined;
    if (indexes !== undefined) {
      for (const { fields, byValues } of indexes.values()) {
        const values: MatchValue[] = [];
        for (const field of fields) {
          const value = payload[field];
          if (!isMatchValue(value)) break;
          values.push(value);
        }
        if (values.length !== fields.length) continue;
        const subs = byValues.get(valuesKey(values));
        if (subs === undefined) continue;
        found ??= new Set();
        for (const sub of subs) found.add(sub);
      }
    }
    if (found === undefined) return open ?? [];
    if (open !== undefined) for (const sub of open) found.add(sub);
    return [...found].sort((a, b) => a.seq - b.seq);
  }

  subscribe(channel: string, listener: Listener, options: SubscribeOptions = {}): () => void {
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    const sub: Sub = { fn: listener, spread: options.catchUp === "spread", live: true, seq: this.nextSeq++ };
    set.add(sub);
    // Each entry as [the index of its fields, its values' key]; an entry without fields would fit every payload.
    const entries = (options.match ?? []).map((entry) => {
      const fields = Object.keys(entry).sort();
      return { fields, fieldsKey: JSON.stringify(fields), values: valuesKey(fields.map((field) => entry[field]!)) };
    });
    if (entries.length === 0 || entries.some((entry) => entry.fields.length === 0)) {
      let open = this.unmatched.get(channel);
      if (!open) this.unmatched.set(channel, (open = new Set()));
      open.add(sub);
      entries.length = 0;
    }
    if (entries.length > 0) {
      let indexes = this.index.get(channel);
      if (!indexes) this.index.set(channel, (indexes = new Map()));
      for (const entry of entries) {
        let index = indexes.get(entry.fieldsKey);
        if (!index) indexes.set(entry.fieldsKey, (index = { fields: entry.fields, byValues: new Map() }));
        let subs = index.byValues.get(entry.values);
        if (!subs) index.byValues.set(entry.values, (subs = new Set()));
        subs.add(sub);
      }
    }
    return () => {
      sub.live = false;
      set!.delete(sub);
      this.unmatched.get(channel)?.delete(sub);
      const indexes = this.index.get(channel);
      if (indexes === undefined) return;
      for (const entry of entries) {
        const index = indexes.get(entry.fieldsKey);
        const subs = index?.byValues.get(entry.values);
        if (index === undefined || subs === undefined) continue;
        subs.delete(sub);
        // Nothing is kept for values nobody listens for any more (a closed trip stream leaves no entry behind).
        if (subs.size === 0) index.byValues.delete(entry.values);
        if (index.byValues.size === 0) indexes.delete(entry.fieldsKey);
      }
    };
  }

  subscriberCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  /**
   * For /readyz (round 4, owner "Wait up to 30 s"): false only while a new copy is still waiting for its FIRST
   * LISTEN connect and less than `readyWaitMs` (30 s) have passed since start(). True once it connected, or once the
   * wait is over - and from then on for ever, whatever the link does (healthSnapshot() keeps telling the truth).
   */
  readyForTraffic(now: number = Date.now()): boolean {
    if (this.wasReady) return true;
    if (this.connectedOnce || this.startedAt === undefined || now - this.startedAt >= this.health.readyWaitMs) this.wasReady = true;
    return this.wasReady;
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
    // PM-1: a connect attempt still waiting for an answer is given up now (its deadline timer and client go too).
    this.abortConnect?.();
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }
}

/**
 * PM-1: drops a client whose connect attempt failed or was given up. `end()` alone can wait for ever on a link that
 * never answers (it sends a goodbye and waits for the close), so it is not awaited and the socket is destroyed too.
 * A late "error" of this client must not crash the process, hence the empty handler.
 */
function discard(client: pg.Client): void {
  client.on("error", () => undefined);
  void client.end().catch(() => undefined);
  (client as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream?.destroy?.();
}
