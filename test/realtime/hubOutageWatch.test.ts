import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationHub } from "../../src/realtime/hub.js";

/**
 * S4 B1.16 Q-B13 (owner W1 Q78 "Do not count it", contract v0.18.120 autoOffline.outage): the hub tells a watcher
 * when its LISTEN link goes down (from its last proof that the link worked: connect, ping or notification), that it is
 * still down (each failed reconnect attempt), and when it is back. The outage recorder (realtime/outages.ts) writes
 * these windows; missedInRow skips an Exclusive that expired inside one. Fake clock, fake pg client: no database.
 */

type FakeDb = { up: boolean };
let db: FakeDb;

beforeEach(() => {
  db = { up: true };
  vi.spyOn(pg.Client.prototype, "connect").mockImplementation(async function () {
    if (!db.up) throw new Error("simulated: database is restarting");
  } as unknown as pg.Client["connect"]);
  vi.spyOn(pg.Client.prototype, "query").mockImplementation(async function () {
    if (!db.up) throw new Error("simulated: connection lost");
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

function watcher() {
  const calls: Array<[string, number]> = [];
  return {
    calls,
    down: (lastProvenAt: Date) => void calls.push(["down", lastProvenAt.getTime()]),
    stillDown: () => void calls.push(["stillDown", Date.now()]),
    up: (at: Date) => void calls.push(["up", at.getTime()]),
  };
}

describe("Q-B13: the hub reports its outage windows", () => {
  it("down from the last good ping, still down per failed try, up once back; a second drop is a new window", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    const w = watcher();
    hub.watchLink(w);
    await hub.start();
    await vi.advanceTimersByTimeAsync(10_000); // one good ping
    const lastPing = Date.now();
    await vi.advanceTimersByTimeAsync(3_000);
    db.up = false;
    current(hub)!.emit("error", new Error("simulated: terminating connection"));
    expect(w.calls[0]).toEqual(["down", lastPing]);
    await vi.advanceTimersByTimeAsync(20_000);
    const still = w.calls.filter(([k]) => k === "stillDown");
    expect(still.length).toBeGreaterThanOrEqual(2);
    db.up = true;
    await vi.advanceTimersByTimeAsync(6_000);
    const ups = w.calls.filter(([k]) => k === "up");
    expect(ups).toHaveLength(1);
    expect(hub.healthSnapshot().status).toBe("ok");
    // Once up, nothing more is reported until the next drop.
    const n = w.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.calls.length).toBe(n);
    db.up = false;
    current(hub)!.emit("error", new Error("simulated: again"));
    expect(w.calls.at(-1)![0]).toBe("down");
    await hub.stop();
  });

  it("a notification is a proof too: down starts at the last notification when it is newer than the last ping", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    const w = watcher();
    hub.watchLink(w);
    await hub.start();
    await vi.advanceTimersByTimeAsync(4_000);
    current(hub)!.emit("notification", { channel: "ch", payload: "{}", processId: 1 });
    const heard = Date.now();
    await vi.advanceTimersByTimeAsync(2_000);
    db.up = false;
    current(hub)!.emit("end");
    expect(w.calls[0]).toEqual(["down", heard]);
    await hub.stop();
  });

  it("a first connect that fails at start is an outage from start() until the first connect", async () => {
    vi.useFakeTimers();
    db.up = false;
    const hub = new NotificationHub(URL, ["ch"]);
    const w = watcher();
    hub.watchLink(w);
    const started = Date.now();
    vi.spyOn(pg.Client.prototype, "connect").mockImplementation(async function () {
      if (!db.up) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    } as unknown as pg.Client["connect"]);
    await hub.start();
    expect(w.calls[0]).toEqual(["down", started]);
    db.up = true;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(w.calls.filter(([k]) => k === "up")).toHaveLength(1);
    await hub.stop();
  });

  it("a watcher that throws never stops the hub from reconnecting", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["ch"]);
    hub.watchLink({ down: () => { throw new Error("boom"); }, stillDown: () => { throw new Error("boom"); }, up: () => { throw new Error("boom"); } });
    await hub.start();
    db.up = false;
    current(hub)!.emit("error", new Error("drop"));
    await vi.advanceTimersByTimeAsync(5_000);
    db.up = true;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(hub.healthSnapshot().status).toBe("ok");
    await hub.stop();
  });
});
