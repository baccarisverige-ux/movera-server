import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/db.js";
import type { Listener, NotificationHub } from "../../src/realtime/hub.js";
import { READ_RETRY_DEFAULTS, configureReadRetry } from "../../src/realtime/retry.js";
import { streamConfig } from "../../src/realtime/streams.js";
import { TRIP_EVENTS_CHANNEL } from "../../src/db/tripLog.js";

/**
 * B1.18 (owner W1 Q80 [Q-B1] "After a server reconnect, close app settings streams spread over 30 s so apps re-read
 * — Yes", 2026-11-11): the catch-up signal after a LISTEN reconnect closes the rider / driver settings streams (their
 * trip and booked-ride hints may be lost) at a random moment within 0 – STREAM_CLOSE_SPREAD_MS (30 s), the same
 * spread as B1.9, instead of all in one instant (the reconnect herd). Fake clock, fake hub, no database (F26).
 */

vi.mock("../../src/config/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/config/service.js")>()),
  // The settings stream's own read: nothing newer to send.
  liveDocument: async () => null,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  configureReadRetry(READ_RETRY_DEFAULTS);
});

function steppedRandom(): void {
  let i = 0;
  vi.spyOn(Math, "random").mockImplementation(() => (i++ % 100) / 100);
}

/** One SSE stream on a fake socket: when (fake clock) it ended, what it wrote, and a way to hang up. */
function fakeSse() {
  const out = { endedAt: undefined as number | undefined, ends: 0, written: [] as string[] };
  const raw = Object.assign(new EventEmitter(), {
    writeHead: () => undefined,
    write: (chunk: string) => (out.written.push(chunk), true),
    end: () => ((out.ends += 1), (out.endedAt ??= Date.now())),
  });
  const reply = { hijack: () => undefined, raw, getHeaders: () => ({}) } as unknown as FastifyReply;
  const reqRaw = new EventEmitter();
  const request = { server: {}, raw: reqRaw, log: { warn: () => undefined, info: () => undefined } } as unknown as FastifyRequest;
  return { out, reply, request, hangUp: () => reqRaw.emit("close") };
}

/** A hub that only records listeners; `reconnected()` sends the catch-up signal (null) as the real hub does. */
function fakeHub() {
  const listeners = new Map<string, Set<Listener>>();
  const hub = {
    subscribe: (channel: string, fn: Listener) => {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(fn);
      return () => set!.delete(fn);
    },
  } as unknown as NotificationHub;
  const reconnected = () => {
    for (const set of listeners.values()) for (const fn of [...set]) fn(null);
  };
  const count = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
  return { hub, reconnected, count };
}

const db = {} as Db;

async function openRiderStreams(n: number, hub: NotificationHub) {
  const streams = Array.from({ length: n }, () => fakeSse());
  for (const [i, s] of streams.entries()) await streamConfig(s.request, s.reply, { db, hub }, "rider_app_config", "Z001", 0, `rdr_${i}`);
  return streams;
}

describe("B1.18 proof: settings streams after a LISTEN reconnect", () => {
  it("100 rider settings streams close spread over the 30 s window, not all in one instant", async () => {
    vi.useFakeTimers();
    steppedRandom();
    const { hub, reconnected } = fakeHub();
    const streams = await openRiderStreams(100, hub);
    const start = Date.now();
    reconnected();
    await vi.advanceTimersByTimeAsync(60_000);
    const closedAt = streams.map((s) => s.out.endedAt).filter((at): at is number => at !== undefined).map((at) => at - start);
    const perSecond = new Map<number, number>();
    for (const at of closedAt) perSecond.set(Math.floor(at / 1000), (perSecond.get(Math.floor(at / 1000)) ?? 0) + 1);
    const busiest = Math.max(0, ...perSecond.values());
    console.log(`B1.18 proof (100 rider streams): ${closedAt.length} closed; first ${Math.min(...closedAt) / 1000} s, last ${Math.max(...closedAt) / 1000} s, busiest second ${busiest} closes`);
    expect(closedAt).toHaveLength(100);
    expect(Math.max(...closedAt) - Math.min(...closedAt)).toBeGreaterThanOrEqual(10_000);
    expect(Math.max(...closedAt)).toBeLessThanOrEqual(30_000);
    expect(busiest).toBeLessThanOrEqual(10);
    for (const s of streams) expect(s.out.written.join("")).toContain("realtime reconnected; reconnect to catch up");
  });

  it("the driver settings stream is spread the same way", async () => {
    vi.useFakeTimers();
    steppedRandom();
    const { hub, reconnected } = fakeHub();
    const streams = Array.from({ length: 50 }, () => fakeSse());
    for (const [i, s] of streams.entries()) await streamConfig(s.request, s.reply, { db, hub }, "driver_app_config", "Z001", 0, undefined, `drv_${i}`);
    const start = Date.now();
    reconnected();
    expect(streams.filter((s) => s.out.endedAt !== undefined)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    const closedAt = streams.map((s) => s.out.endedAt! - start);
    expect(closedAt.every((at) => Number.isFinite(at) && at <= 30_000)).toBe(true);
    expect(Math.max(...closedAt) - Math.min(...closedAt)).toBeGreaterThanOrEqual(10_000);
  });

  it("two reconnects in a row close each stream once; a stream the app hangs up first is not closed again", async () => {
    vi.useFakeTimers();
    const { hub, reconnected, count } = fakeHub();
    const [kept, left] = await openRiderStreams(2, hub);
    reconnected();
    await vi.advanceTimersByTimeAsync(100);
    reconnected();
    left!.hangUp();
    const leftWrites = left!.out.written.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kept!.out.ends).toBe(1);
    expect(left!.out.ends).toBe(1);
    expect(left!.out.written.length).toBe(leftWrites);
    expect(count()).toBe(0);
  });

  it("while the database pool is over its shed limit the close waits, but never longer than 2 min (no stream stays open for ever)", async () => {
    vi.useFakeTimers();
    configureReadRetry({ holdClose: () => true });
    const { hub, reconnected } = fakeHub();
    const [s] = await openRiderStreams(1, hub);
    const start = Date.now();
    reconnected();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s!.out.endedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    console.log(`B1.18 proof (pool busy): closed after ${(s!.out.endedAt! - start) / 1000} s`);
    expect(s!.out.endedAt).toBeDefined();
    expect(s!.out.endedAt! - start).toBeLessThanOrEqual(120_000 + 30_000);
  });

  it("STREAM_CLOSE_SPREAD_MS=0 closes at once (the old behaviour, as an off switch)", async () => {
    vi.useFakeTimers();
    configureReadRetry({ closeSpreadMs: 0 });
    const { hub, reconnected } = fakeHub();
    const [s] = await openRiderStreams(1, hub);
    reconnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(s!.out.endedAt).toBeDefined();
  });

  it("an ordinary trip hint (not a reconnect) is still sent at once and does not close the stream", async () => {
    vi.useFakeTimers();
    const listeners: Listener[] = [];
    const hub = { subscribe: (channel: string, fn: Listener) => (channel === TRIP_EVENTS_CHANNEL && listeners.push(fn), () => undefined) } as unknown as NotificationHub;
    const s = fakeSse();
    await streamConfig(s.request, s.reply, { db, hub }, "rider_app_config", "Z001", 0, "rdr_1");
    for (const fn of listeners) fn({ riderId: "rdr_1", tripId: "trp_1" });
    expect(s.out.written.join("")).toContain("rider_trip_changed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.out.endedAt).toBeUndefined();
  });
});
