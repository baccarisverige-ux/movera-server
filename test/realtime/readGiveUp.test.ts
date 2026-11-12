import { EventEmitter } from "node:events";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/db.js";
import { AdminLiveFeed } from "../../src/realtime/adminEvents.js";
import type { NotificationHub } from "../../src/realtime/hub.js";
import { readRetry } from "../../src/realtime/retry.js";
import { SettledCursor } from "../../src/realtime/settled.js";
import { streamConfig, streamTrip } from "../../src/realtime/streams.js";
import type { Principal } from "../../src/auth/guard.js";

/**
 * B1.9 (owner W1 Q73, 2026-11-11): a stream read that keeps failing is retried 3 times (1, 2, 4 s), then the stream
 * is closed so the app reconnects (and re-reads, contract v0.18.63); when many streams fail together (a DB blip)
 * their closes are spread over 30 s, not all in one instant. Fake clock only (F26): no real sleeps.
 */

const MINUTES_10 = 10 * 60_000;
/** The latest a stream may close: retries 1 + 2 + 4 s, then at most the 30 s spread. */
const LATEST_CLOSE_MS = 7_000 + 30_000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A deterministic Math.random: 0, 0.01, 0.02, … (the spread is then easy to check). */
function steppedRandom(): void {
  let i = 0;
  vi.spyOn(Math, "random").mockImplementation(() => (i++ % 100) / 100);
}

/** One SSE stream on a fake socket: when (fake clock) it ended and what it wrote. */
function fakeSse() {
  const out = { endedAt: undefined as number | undefined, written: [] as string[] };
  const raw = Object.assign(new EventEmitter(), {
    writeHead: () => undefined,
    write: (chunk: string) => (out.written.push(chunk), true),
    end: () => (out.endedAt ??= Date.now()),
  });
  const reply = { hijack: () => undefined, raw, getHeaders: () => ({}) } as unknown as FastifyReply;
  const request = { server: {}, raw: new EventEmitter(), log: { warn: () => undefined, info: () => undefined } } as unknown as FastifyRequest;
  return { out, reply, request };
}

const brokenDb = { selectFrom: () => { throw new Error("simulated pool timeout"); } } as unknown as Db;
const quietHub = { subscribe: () => () => undefined } as unknown as NotificationHub;

describe("B1.9 proof: a read that fails for ever", () => {
  it("is retried 3 times, then the stream is closed (within 7 s plus the 30 s spread)", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let runs = 0;
    let closedAt: number | undefined;
    let closes = 0;
    const retry = readRetry(() => {
      runs += 1;
      retry.failed();
    }, () => closedAt !== undefined, () => {
      closes += 1;
      closedAt = Date.now();
    });
    retry.failed(); // the first read failed
    await vi.advanceTimersByTimeAsync(MINUTES_10);
    console.log(`B1.9 proof (one stream): ${runs} retries in 10 min, closed=${closedAt !== undefined}${closedAt !== undefined ? ` after ${(closedAt - start) / 1000} s` : ""}`);
    expect(runs).toBe(3);
    expect(closes).toBe(1);
    expect(closedAt! - start).toBeGreaterThanOrEqual(7_000);
    expect(closedAt! - start).toBeLessThanOrEqual(LATEST_CLOSE_MS);
  });

  it("100 streams failing in the same instant close spread over the 30 s window, not all at once", async () => {
    vi.useFakeTimers();
    steppedRandom();
    const start = Date.now();
    const closedAt: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      let closed = false;
      const retry = readRetry(() => retry.failed(), () => closed, () => {
        closed = true;
        closedAt.push(Date.now() - start);
      });
      retry.failed();
    }
    await vi.advanceTimersByTimeAsync(MINUTES_10);
    const first = Math.min(...closedAt);
    const last = Math.max(...closedAt);
    const perSecond = new Map<number, number>();
    for (const at of closedAt) perSecond.set(Math.floor(at / 1000), (perSecond.get(Math.floor(at / 1000)) ?? 0) + 1);
    const busiest = Math.max(0, ...perSecond.values());
    console.log(`B1.9 proof (100 streams): ${closedAt.length} closed; first ${closedAt.length ? first / 1000 : "-"} s, last ${closedAt.length ? last / 1000 : "-"} s, busiest second ${busiest} closes`);
    expect(closedAt).toHaveLength(100);
    expect(last - first).toBeGreaterThanOrEqual(25_000);
    expect(last).toBeLessThanOrEqual(LATEST_CLOSE_MS);
    expect(busiest).toBeLessThanOrEqual(10);
  });

  it("the trip stream (GET /trips/{id}/events) ends when its read keeps failing", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const sse = fakeSse();
    await streamTrip(sse.request, sse.reply, { db: brokenDb, hub: quietHub }, "trp_1", { actor: "admin", subjectId: "adm_1" }, 0);
    await vi.advanceTimersByTimeAsync(MINUTES_10);
    console.log(`B1.9 proof (trip stream): ended=${sse.out.endedAt !== undefined}`);
    expect(sse.out.endedAt).toBeDefined();
    expect(sse.out.endedAt! - start).toBeLessThanOrEqual(LATEST_CLOSE_MS);
    expect(sse.out.written.join("")).toContain("reconnect");
  });

  it("the settings stream (GET /rider/config/stream) ends when its read keeps failing", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const sse = fakeSse();
    await streamConfig(sse.request, sse.reply, { db: brokenDb, hub: quietHub }, "rider_app_config", "Z001", 0, "rdr_1");
    await vi.advanceTimersByTimeAsync(MINUTES_10);
    console.log(`B1.9 proof (settings stream): ended=${sse.out.endedAt !== undefined}`);
    expect(sse.out.endedAt).toBeDefined();
    expect(sse.out.endedAt! - start).toBeLessThanOrEqual(LATEST_CLOSE_MS);
  });

  it("the admin live feed's shared read gives up and closes its admin streams", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    // The join's own catch-up read succeeds; every shared read after it fails.
    vi.spyOn(SettledCursor.prototype, "next").mockResolvedValueOnce({ rows: [], full: false }).mockRejectedValue(new Error("simulated pool timeout"));
    const db = { selectFrom: () => ({ select: () => ({ executeTakeFirst: async () => ({ top: 0 }) }) }) } as unknown as Db;
    let notify: (() => void) | undefined;
    const hub = { subscribe: (_channel: string, fn: () => void) => ((notify = fn), () => undefined) } as unknown as NotificationHub;
    const feed = new AdminLiveFeed(db, hub, { warn: () => undefined });
    const who = { actor: "admin", subjectId: "adm_1", zones: ["*"], perms: [] } as unknown as Principal;
    const closedAt: number[] = [];
    const sub = { who, last: 0, catchingUp: true, send: () => undefined, cursor: () => undefined, close: () => (closedAt.push(Date.now() - start), leave()) };
    // `leave` is only called when the feed closes the stream, long after join returned.
    const leave: () => void = await feed.join(sub);
    notify!();
    await vi.advanceTimersByTimeAsync(MINUTES_10);
    console.log(`B1.9 proof (admin live feed): ${feed.reads} shared reads in 10 min, stream closed=${closedAt.length > 0}`);
    expect(closedAt).toHaveLength(1);
    expect(closedAt[0]!).toBeLessThanOrEqual(LATEST_CLOSE_MS);
    expect(feed.reads).toBe(4);
    expect(feed.open).toBe(0);
  });
});
