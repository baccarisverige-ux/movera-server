import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_CHECK_MS, NotificationHub } from "../../src/realtime/hub.js";

/**
 * B1.16 (owner W1 Q77 "Database listener health check every 10 s and reconnect? — Yes", 2026-11-11): the LISTEN
 * connection is pinged every ≤ 10 s (shorter than the 14 s Exclusive window), a lost connection is retried with a
 * back-off of 1 → 30 s plus jitter (not a fixed 1 s, so many server copies do not hit the database together after a
 * database restart), and the catch-up signal after a reconnect is handed to the streams in batches, not all in one
 * instant. Fake clock and a fake pg client only (F26): no database, no real sleeps.
 */

type FakeDb = { up: boolean; connects: number[]; pings: number[]; clients: pg.Client[] };

let db: FakeDb;

beforeEach(() => {
  db = { up: true, connects: [], pings: [], clients: [] };
  vi.spyOn(pg.Client.prototype, "connect").mockImplementation(async function (this: pg.Client) {
    db.connects.push(Date.now());
    if (!db.up) throw new Error("simulated: database is restarting");
    db.clients.push(this);
  } as unknown as pg.Client["connect"]);
  vi.spyOn(pg.Client.prototype, "query").mockImplementation(async function (text: unknown) {
    if (!db.up) throw new Error("simulated: connection lost");
    if (text === "SELECT 1") db.pings.push(Date.now());
    return { rows: [] };
  } as unknown as pg.Client["query"]);
  vi.spyOn(pg.Client.prototype, "end").mockImplementation((async () => undefined) as unknown as pg.Client["end"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const URL = "postgres://movera:movera@127.0.0.1:5432/none";
const current = (h: NotificationHub) => (h as unknown as { client: pg.Client | undefined }).client;

/** Drops the LISTEN connection the way pg reports it: an "error" on the client. */
function dropConnection(h: NotificationHub): void {
  current(h)!.emit("error", new Error("simulated: terminating connection due to administrator command"));
}

/** A deterministic Math.random: 0, 0.01, 0.02, … 0.99, 0, … */
function steppedRandom(): void {
  let i = 0;
  vi.spyOn(Math, "random").mockImplementation(() => (i++ % 100) / 100);
}

describe("B1.16 proof: LISTEN health check and reconnect", () => {
  it("the health check pings at most every 10 s (Q77), so a dead socket is found inside the 14 s Exclusive window", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(10_000);
    console.log(`B1.16 proof (ping): HEALTH_CHECK_MS=${HEALTH_CHECK_MS}, pings in the first 10 s: ${db.pings.length}`);
    expect(HEALTH_CHECK_MS).toBeLessThanOrEqual(10_000);
    expect(db.pings.length).toBeGreaterThanOrEqual(1);
    expect(db.pings[0]! - start).toBeLessThanOrEqual(10_000);
    await hub.stop();
  });

  it("a database that stays down is retried with a growing back-off capped at 30 s, not every 1 s", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    db.up = false;
    db.connects = [];
    const start = Date.now();
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const gaps = db.connects.map((at, i) => at - (i === 0 ? start : db.connects[i - 1]!));
    console.log(`B1.16 proof (back-off): ${db.connects.length} connect attempts in 5 min; gaps ms ${gaps.join(", ")}`);
    // Old code: a fixed 1 s, so ~300 attempts in 5 min. Back-off 1, 2, 4, 8, 16, 30, 30 … (each a half-to-full jitter).
    expect(db.connects.length).toBeLessThanOrEqual(25);
    expect(db.connects.length).toBeGreaterThanOrEqual(10);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000);
    expect(gaps[0]!).toBeLessThanOrEqual(1_000);
    expect(Math.max(...gaps.slice(5))).toBeGreaterThanOrEqual(15_000);
    expect(hub.healthSnapshot().status).toBe("down");
    await hub.stop();
  });

  it("after a reconnect works, the next drop starts again at the short delay (the back-off resets)", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    db.up = false;
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    db.up = true;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(hub.healthSnapshot()).toMatchObject({ status: "ok", reconnects: 1 });
    db.connects = [];
    const dropAt = Date.now();
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(db.connects).toHaveLength(1);
    expect(db.connects[0]! - dropAt).toBeLessThanOrEqual(1_000);
    expect(hub.healthSnapshot()).toMatchObject({ status: "ok", reconnects: 2 });
    await hub.stop();
  });

  it("100 server copies that lose the database together do not all reconnect in the same instant (jitter)", async () => {
    vi.useFakeTimers();
    steppedRandom();
    const hubs = Array.from({ length: 100 }, () => new NotificationHub(URL, ["ch"]));
    for (const hub of hubs) await hub.start();
    db.up = false;
    db.connects = [];
    const start = Date.now();
    for (const hub of hubs) dropConnection(hub);
    db.up = true;
    await vi.advanceTimersByTimeAsync(1_000);
    const firstTry = db.connects.map((at) => at - start);
    const per100ms = new Map<number, number>();
    for (const at of firstTry) per100ms.set(Math.floor(at / 100), (per100ms.get(Math.floor(at / 100)) ?? 0) + 1);
    const busiest = Math.max(0, ...per100ms.values());
    console.log(`B1.16 proof (100 copies): ${firstTry.length} reconnects in 1 s; first ${Math.min(...firstTry)} ms, last ${Math.max(...firstTry)} ms, busiest 100 ms: ${busiest}`);
    expect(firstTry).toHaveLength(100);
    expect(Math.max(...firstTry) - Math.min(...firstTry)).toBeGreaterThanOrEqual(400);
    expect(busiest).toBeLessThanOrEqual(25);
    for (const hub of hubs) expect(hub.healthSnapshot().status).toBe("ok");
    for (const hub of hubs) await hub.stop();
  });

  it("the catch-up signal after a reconnect reaches 1,000 streams in batches (staggered), each exactly once", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    const got: number[] = [];
    let start = 0;
    const offs: Array<() => void> = [];
    for (let i = 0; i < 1000; i += 1) {
      offs.push(hub.subscribe("ch", (payload) => {
        if (payload !== null) return;
        got.push(Date.now() - start);
        // A stream that closes during the catch-up (here: the last one, closed by the first) is not called after.
        if (i === 0) offs[999]!();
      }));
    }
    start = Date.now();
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(30_000);
    const first = Math.min(...got);
    const inFirstInstant = got.filter((at) => at === first).length;
    console.log(`B1.16 proof (catch-up): ${got.length} streams told to catch up; ${inFirstInstant} in the first instant; first after ${first} ms, last after ${Math.max(...got)} ms`);
    expect(got).toHaveLength(999);
    expect(inFirstInstant).toBeLessThanOrEqual(200);
    expect(Math.max(...got) - first).toBeLessThanOrEqual(5_000);
    await hub.stop();
  });

  it("stop() during the back-off or the catch-up ends the retries and any catch-up still pending", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    let catchUps = 0;
    for (let i = 0; i < 1000; i += 1) hub.subscribe("ch", (payload) => void (payload === null && (catchUps += 1)));
    dropConnection(hub);
    // Up to the moment the reconnect lands (the first catch-up batch), then stop.
    for (let t = 0; t < 2_000 && catchUps === 0; t += 10) await vi.advanceTimersByTimeAsync(10);
    await hub.stop();
    const seen = catchUps;
    db.connects = [];
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(1000);
    expect(catchUps).toBe(seen);
    expect(db.connects).toHaveLength(0);
    expect(hub.healthSnapshot().status).toBe("down");
  });

  it("stop() while the database is down ends the retries", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    db.up = false;
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(20_000);
    await hub.stop();
    db.connects = [];
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(db.connects).toHaveLength(0);
  });
});
