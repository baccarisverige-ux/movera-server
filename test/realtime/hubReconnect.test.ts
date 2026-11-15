import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_CHECK_MS, NotificationHub, RECONNECT_BACKOFF } from "../../src/realtime/hub.js";

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
  it("the health check pings at most every 10 s (Q77): a dead socket is found within 10 s ping + 5 s timeout", async () => {
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

  it("a database that stays down is retried with a growing back-off capped at 5 s (until Q-B13), not every 1 s", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    db.up = false;
    db.connects = [];
    const start = Date.now();
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const gaps = db.connects.map((at, i) => at - (i === 0 ? start : db.connects[i - 1]!));
    console.log(`B1.16 proof (back-off): ${db.connects.length} connect attempts in 5 min; gaps ms ${gaps.slice(0, 12).join(", ")} …`);
    // Old code: a fixed 1 s, so ~300 attempts in 5 min. Back-off 1, 2, 4, 5, 5 … s (each a half-to-full jitter).
    // Supervisor MF-2: the cap stays at 5 s until Q-B13 ships (an Exclusive missed while this copy is blind counts
    // toward auto-offline today); it goes to the plan's 30 s together with Q-B13.
    expect(RECONNECT_BACKOFF.maxMs).toBeLessThanOrEqual(5_000);
    expect(db.connects.length).toBeLessThanOrEqual(130);
    expect(db.connects.length).toBeGreaterThanOrEqual(55);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(5_000);
    expect(gaps[0]!).toBeLessThanOrEqual(1_000);
    expect(Math.min(...gaps.slice(4))).toBeGreaterThanOrEqual(2_500);
    expect(hub.healthSnapshot().status).toBe("down");
    await hub.stop();
  });

  it("the database back in the middle of a long outage is heard again within 5 s", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    db.up = false;
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 123);
    db.up = true;
    const back = Date.now();
    let t = 0;
    while (hub.healthSnapshot().status !== "ok" && t < 60_000) {
      await vi.advanceTimersByTimeAsync(10);
      t += 10;
    }
    console.log(`B1.16 proof (cap): LISTEN up again ${Date.now() - back} ms after the database`);
    expect(Date.now() - back).toBeLessThanOrEqual(5_000);
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

  it("the catch-up signal after a reconnect reaches 1,000 settings listeners in batches (staggered), each exactly once", async () => {
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
      }, { catchUp: "spread" }));
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
    for (let i = 0; i < 1000; i += 1) hub.subscribe("ch", (payload) => void (payload === null && (catchUps += 1)), { catchUp: "spread" });
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

  // Supervisor MF-1 (b116-b118-server-supervisor.md): 10,000 drivers on one copy = 30,001 listeners. Offer feeds,
  // trip streams and the SOS / incident stream must catch up at once, before any settings listener, and a link that
  // keeps dropping must not starve the tail of the list.
  function tenThousandDrivers(hub: NotificationHub) {
    let order = 0;
    const told = { offer: [] as number[], trip: [] as number[], incident: [] as number[], settings: [] as number[] };
    const seq = { firstSafety: [] as number[], settings: [] as number[] };
    const times = new Map<string, number[]>();
    const tell = (kind: keyof typeof told, id: string) => (payload: Record<string, unknown> | null) => {
      if (payload !== null) return;
      told[kind].push(Date.now());
      (kind === "settings" ? seq.settings : seq.firstSafety).push((order += 1));
      const list = times.get(id) ?? [];
      list.push(Date.now());
      times.set(id, list);
    };
    // As main.ts:62 / :65: the caches subscribe to the config channel first.
    hub.subscribe("config", () => undefined);
    for (let i = 0; i < 10_000; i += 1) {
      // A driver settings stream: its config read and its booked-ride hint (streams.ts), both spread.
      hub.subscribe("config", tell("settings", `cfg${i}`), { catchUp: "spread" });
      hub.subscribe("trip", tell("settings", `hint${i}`), { catchUp: "spread" });
    }
    for (let i = 0; i < 10_000; i += 1) hub.subscribe("offer", tell("offer", `offer${i}`));
    for (let i = 0; i < 100; i += 1) hub.subscribe("trip", tell("trip", `trip${i}`));
    hub.subscribe("incident", tell("incident", "sos"));
    return { told, seq, times };
  }

  it("MF-1: after a reconnect, offer feeds, trip streams and the SOS stream are told at once, before any settings listener", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["config", "trip", "offer", "incident"]);
    await hub.start();
    const { told, seq } = tenThousandDrivers(hub);
    dropConnection(hub);
    let t = 0;
    while (hub.healthSnapshot().reconnects === 0 && t < 5_000) {
      await vi.advanceTimersByTimeAsync(10);
      t += 10;
    }
    // The reconnect landed in the last 10 ms step: its connect call is the instant to measure from.
    const upAt = db.connects[db.connects.length - 1]!;
    await vi.advanceTimersByTimeAsync(1_000);
    const lastSafety = Math.max(...told.offer, ...told.trip, ...told.incident);
    console.log(`MF-1 proof (order): offer ${told.offer.length}/10000, trip ${told.trip.length}/100, sos ${told.incident.length}/1 told ≤ ${lastSafety - upAt} ms after the reconnect; settings told in that second ${told.settings.length}`);
    expect(told.offer).toHaveLength(10_000);
    expect(told.trip).toHaveLength(100);
    expect(told.incident).toHaveLength(1);
    expect(lastSafety - upAt).toBeLessThanOrEqual(1_000);
    expect(Math.max(...seq.firstSafety)).toBeLessThan(Math.min(...seq.settings));
    // The settings listeners are still spread: not all in the first second.
    expect(told.settings.length).toBeLessThan(20_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(told.settings).toHaveLength(20_000);
    await hub.stop();
  });

  it("MF-1: a link that drops every 4 s (5 times) still reaches every listener, and every offer feed on each reconnect", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["config", "trip", "offer", "incident"]);
    await hub.start();
    const { told, times } = tenThousandDrivers(hub);
    for (let drop = 0; drop < 5; drop += 1) {
      dropConnection(hub);
      await vi.advanceTimersByTimeAsync(4_000);
    }
    const reconnectsWhileFlapping = hub.healthSnapshot().reconnects;
    const settingsReached = [...times.keys()].filter((id) => id.startsWith("cfg") || id.startsWith("hint")).length;
    console.log(`MF-1 proof (flapping): ${reconnectsWhileFlapping} reconnects in 20 s; settings listeners reached ${settingsReached}/20000; offer catch-ups ${told.offer.length} (10000 × ${reconnectsWhileFlapping})`);
    expect(reconnectsWhileFlapping).toBe(5);
    expect(told.offer).toHaveLength(10_000 * 5);
    expect(told.incident).toHaveLength(5);
    expect(settingsReached).toBe(20_000);
    await hub.stop();
  });

  it("N6: a listener that throws in a later batch does not stop the batches (or crash the process)", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    let told = 0;
    for (let i = 0; i < 1000; i += 1) {
      hub.subscribe("ch", (payload) => {
        if (payload !== null) return;
        told += 1;
        if (i === 500) throw new Error("simulated listener bug");
      }, { catchUp: "spread" });
    }
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(told).toBe(1000);
    await hub.stop();
  });

  it("N5: a late end/error of the dead connection while the reconnect is connecting does not start a second connect", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    const dead = current(hub)!;
    let release: (() => void) | undefined;
    vi.mocked(pg.Client.prototype.connect).mockImplementation(function (this: pg.Client) {
      db.connects.push(Date.now());
      db.clients.push(this);
      return new Promise<void>((resolve) => (release = resolve));
    } as unknown as pg.Client["connect"]);
    db.connects = [];
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(db.connects).toHaveLength(1);
    dead.emit("end");
    dead.emit("error", new Error("late error of the old socket"));
    await vi.advanceTimersByTimeAsync(5_000);
    release?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(db.connects).toHaveLength(1);
    expect(hub.healthSnapshot()).toMatchObject({ status: "ok", reconnects: 1 });
    await hub.stop();
  });
});
