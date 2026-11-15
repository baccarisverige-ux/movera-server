import net from "node:net";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LISTEN_CONNECT_TIMEOUT_MS, NotificationHub, RECONNECT_BACKOFF } from "../../src/realtime/hub.js";
import { adminUrl } from "../support/globalSetup.js";

/**
 * PM-1 (post-merge supervisor of #249, Rules audits/impact/b116-b118-server-supervisor.md "Post-merge" §3): a
 * reconnect that meets a link which accepts the connection but never answers must not hang for ever. Before the fix
 * `await this.connect()` in the retry never returned: no retry, no ping, the copy stayed "down" and every offer feed,
 * trip stream and the SOS stream got no hint and no close until the process restarted.
 */

const URL = "postgres://movera:movera@127.0.0.1:5432/none";
const current = (h: NotificationHub) => (h as unknown as { client: pg.Client | undefined }).client;
const NEVER = () => new Promise<never>(() => undefined);

describe("PM-1: a silent LISTEN link (fake pg client, fake clock)", () => {
  type Late = { client: pg.Client; answer: () => void };
  type FakeDb = { connect: "ok" | "silent" | "down"; listen: "ok" | "silent"; connects: number[]; opened: pg.Client[]; ended: pg.Client[]; late: Late[] };
  let db: FakeDb;

  beforeEach(() => {
    db = { connect: "ok", listen: "ok", connects: [], opened: [], ended: [], late: [] };
    vi.spyOn(pg.Client.prototype, "connect").mockImplementation(function (this: pg.Client) {
      db.connects.push(Date.now());
      if (db.connect === "down") return Promise.reject(new Error("simulated: database is restarting"));
      // The link accepts the connection and then says nothing; `answer` is the late answer of that same attempt.
      if (db.connect === "silent") return new Promise<void>((resolve) => db.late.push({ client: this, answer: resolve }));
      db.opened.push(this);
      return Promise.resolve();
    } as unknown as pg.Client["connect"]);
    vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, text: unknown) {
      if (db.ended.includes(this)) return Promise.reject(new Error("Client was closed and is not queryable"));
      if (typeof text === "string" && text.startsWith("LISTEN") && db.listen === "silent") return NEVER();
      return Promise.resolve({ rows: [] });
    } as unknown as pg.Client["query"]);
    vi.spyOn(pg.Client.prototype, "end").mockImplementation(function (this: pg.Client) {
      db.ended.push(this);
      return Promise.resolve();
    } as unknown as pg.Client["end"]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function dropConnection(h: NotificationHub): void {
    current(h)!.emit("error", new Error("simulated: terminating connection due to administrator command"));
  }

  it("the connect timeout is at most 5 s", () => {
    expect(LISTEN_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(LISTEN_CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("a reconnect whose connect never answers is given up and retried; the hub is back after the link heals", async () => {
    const warns: string[] = [];
    const hub = new NotificationHub(URL, ["ch"], { warn: (_data, message) => void warns.push(message) });
    await hub.start();
    let catchUps = 0;
    hub.subscribe("ch", (payload) => void (payload === null && (catchUps += 1)));
    db.connect = "silent";
    db.connects = [];
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(60_000);
    const whileSilent = db.connects.length;
    console.log(`PM-1 proof (silent connect): ${whileSilent} connect attempts in 60 s of a silent link; status ${hub.healthSnapshot().status}`);
    // Each attempt costs at most the back-off (≤ 5 s) plus the connect timeout (≤ 5 s): at least 6 in a minute.
    expect(whileSilent).toBeGreaterThanOrEqual(6);
    expect(hub.healthSnapshot().status).toBe("down");
    expect(warns).toContain("realtime listen reconnect failed");
    // The link is back: heard again within one back-off plus one connect timeout.
    db.connect = "ok";
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF.maxMs + LISTEN_CONNECT_TIMEOUT_MS);
    console.log(`PM-1 proof (silent connect): after the link healed: status ${hub.healthSnapshot().status}, reconnects ${hub.healthSnapshot().reconnects}, catch-up signals ${catchUps}`);
    expect(hub.healthSnapshot()).toMatchObject({ status: "ok", reconnects: 1 });
    expect(catchUps).toBe(1);
    await hub.stop();
  });

  it("a reconnect whose LISTEN query never answers is given up and retried the same way", async () => {
    const hub = new NotificationHub(URL, ["ch", "ch2"]);
    await hub.start();
    let catchUps = 0;
    hub.subscribe("ch", (payload) => void (payload === null && (catchUps += 1)));
    db.listen = "silent";
    db.connects = [];
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(60_000);
    console.log(`PM-1 proof (silent LISTEN): ${db.connects.length} connect attempts in 60 s; status ${hub.healthSnapshot().status}`);
    expect(db.connects.length).toBeGreaterThanOrEqual(6);
    expect(hub.healthSnapshot().status).toBe("down");
    // Every half-open client of a given-up attempt was ended (none leaks); the last attempt may still be waiting.
    expect(db.opened.slice(1, -1).every((client) => db.ended.includes(client))).toBe(true);
    db.listen = "ok";
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF.maxMs + LISTEN_CONNECT_TIMEOUT_MS);
    expect(hub.healthSnapshot()).toMatchObject({ status: "ok", reconnects: 1 });
    expect(catchUps).toBe(1);
    await hub.stop();
  });

  it("the back-off between given-up attempts keeps its 5 s cap (a silent link is not hammered, nor left alone)", async () => {
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    db.connect = "silent";
    db.connects = [];
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const gaps = db.connects.slice(1).map((at, i) => at - db.connects[i]!);
    console.log(`PM-1 proof (cap): ${db.connects.length} attempts in 5 min; gaps ms ${gaps.slice(0, 8).join(", ")} …`);
    // Gap = connect timeout (5 s) + back-off (2.5–5 s once capped): never above 10 s, never below the timeout.
    expect(Math.max(...gaps)).toBeLessThanOrEqual(LISTEN_CONNECT_TIMEOUT_MS + RECONNECT_BACKOFF.maxMs);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(LISTEN_CONNECT_TIMEOUT_MS);
    await hub.stop();
  });

  it("no double client: a late answer of a given-up attempt cannot become a second client or steal the live one", async () => {
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    const first = current(hub)!;
    let catchUps = 0;
    let notes = 0;
    hub.subscribe("ch", (payload) => void (payload === null ? (catchUps += 1) : (notes += 1)));
    db.connect = "silent";
    db.connects = [];
    dropConnection(hub);
    // First attempt hangs and is given up.
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF.baseMs + LISTEN_CONNECT_TIMEOUT_MS + 1);
    expect(db.late.length).toBeGreaterThanOrEqual(1);
    const stale = db.late[0]!;
    expect(db.ended).toContain(stale.client);
    // The link heals; the next attempt becomes the one live client.
    db.connect = "ok";
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF.maxMs + LISTEN_CONNECT_TIMEOUT_MS);
    const live = current(hub)!;
    expect(live).toBeDefined();
    expect(live).not.toBe(stale.client);
    expect(live).not.toBe(first);
    const attempts = db.connects.length;
    // Now the given-up attempt answers late, and its socket then reports end + error.
    for (const late of db.late) late.answer();
    await vi.advanceTimersByTimeAsync(0);
    stale.client.emit("end");
    stale.client.emit("error", new Error("simulated: late error of the given-up client"));
    stale.client.emit("notification", { channel: "ch", payload: "{}" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(current(hub)).toBe(live);
    expect(db.connects).toHaveLength(attempts);
    expect(hub.healthSnapshot()).toMatchObject({ status: "ok", reconnects: 1 });
    expect(catchUps).toBe(1);
    // A given-up client no longer delivers anything (its listeners are gone): no doubled hints.
    expect(notes).toBe(0);
    expect(stale.client.listenerCount("notification")).toBe(0);
    // Exactly one client is not ended: the live one.
    const all = [first, ...db.late.map((late) => late.client), ...db.opened];
    expect([...new Set(all)].filter((client) => !db.ended.includes(client))).toEqual([live]);
    await hub.stop();
  });

  it("stop() during a hung attempt clears every timer, ends the half-open client and starts nothing more", async () => {
    const warns: string[] = [];
    const hub = new NotificationHub(URL, ["ch"], { warn: (_data, message) => void warns.push(message) });
    await hub.start();
    db.connect = "silent";
    db.connects = [];
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF.baseMs + 100);
    expect(db.connects).toHaveLength(1);
    const hung = db.late[0]!;
    warns.length = 0;
    await hub.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(db.ended).toContain(hung.client);
    // A late answer after stop() must not bring the hub back.
    db.connect = "ok";
    hung.answer();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(db.connects).toHaveLength(1);
    expect(current(hub)).toBeUndefined();
    expect(hub.healthSnapshot().status).toBe("down");
    expect(vi.getTimerCount()).toBe(0);
    expect(warns).toEqual([]);
  });

  it("stop() during the back-off after a given-up attempt leaves no timer", async () => {
    const hub = new NotificationHub(URL, ["ch"]);
    await hub.start();
    db.connect = "silent";
    dropConnection(hub);
    // Past the first attempt's timeout, inside the next back-off.
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF.baseMs + LISTEN_CONNECT_TIMEOUT_MS + 10);
    await hub.stop();
    expect(vi.getTimerCount()).toBe(0);
    db.connects = [];
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(db.connects).toHaveLength(0);
  });

  it("start() against a silent link fails in time instead of hanging the boot", async () => {
    db.connect = "silent";
    const hub = new NotificationHub(URL, ["ch"]);
    const outcome = hub.start().then(
      () => "connected",
      (error: unknown) => (error as Error).message,
    );
    await vi.advanceTimersByTimeAsync(LISTEN_CONNECT_TIMEOUT_MS + 1);
    expect(await Promise.race([outcome, Promise.resolve("still hanging")])).toMatch(/timed out/);
    expect(db.ended).toContain(db.late[0]!.client);
    await hub.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * The supervisor's probe, kept: the real NotificationHub and the real pg driver, through a local TCP proxy to the
 * real database. "Silent" = the proxy still accepts connections but forwards nothing in either direction.
 */
describe("PM-1: a silent LISTEN link (real pg through a TCP proxy that goes silent)", () => {
  type Proxy = { url: string; accepted: () => number; upPorts: () => number[]; goSilent: () => void; heal: () => void; close: () => Promise<void> };

  async function startProxy(): Promise<Proxy> {
    const target = new globalThis.URL(adminUrl());
    let silent = false;
    let accepted = 0;
    const pairs = new Set<{ down: net.Socket; up?: net.Socket; held?: boolean }>();
    const server = net.createServer((down) => {
      accepted += 1;
      const pair: { down: net.Socket; up?: net.Socket; held?: boolean } = { down, held: silent };
      pairs.add(pair);
      down.on("error", () => undefined);
      down.on("close", () => {
        pair.up?.destroy();
        pairs.delete(pair);
      });
      // Silent: the connection is accepted and held open; nothing is read or answered.
      if (silent) return;
      const up = net.connect(Number(target.port || 5432), target.hostname);
      pair.up = up;
      up.on("error", () => undefined);
      up.on("close", () => void (pair.held || down.destroy()));
      down.pipe(up);
      up.pipe(down);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const through = new globalThis.URL(adminUrl());
    through.hostname = "127.0.0.1";
    through.port = String((server.address() as net.AddressInfo).port);
    return {
      url: through.toString(),
      accepted: () => accepted,
      // The proxy's own ports toward the database, to find this hub's sessions in pg_stat_activity.
      upPorts: () => [...pairs].flatMap((pair) => (pair.up?.localPort === undefined ? [] : [pair.up.localPort])),
      goSilent: () => {
        silent = true;
        // Existing connections stay open but carry nothing any more.
        for (const pair of pairs) {
          pair.held = true;
          if (pair.up === undefined) continue;
          pair.down.unpipe(pair.up);
          pair.up.unpipe(pair.down);
          pair.down.pause();
          pair.up.pause();
        }
      },
      heal: () => {
        silent = false;
        // The link is back for NEW connections only. The connections caught by the silence stay silent toward the
        // hub (a hung attempt gets no answer and no close, ever); only the proxy's own held session on the database
        // side is dropped, which a paused socket would not do by itself.
        for (const pair of pairs) if (pair.held) pair.up?.destroy();
      },
      close: async () => {
        for (const pair of pairs) {
          pair.down.destroy();
          pair.up?.destroy();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function until(what: () => boolean, withinMs: number): Promise<boolean> {
    const end = Date.now() + withinMs;
    while (Date.now() < end) {
      if (what()) return true;
      await sleep(20);
    }
    return what();
  }

  it("the hub comes back by itself after the link was silent (probe: before the fix it stayed down for ever)", async () => {
    const proxy = await startProxy();
    const warns: string[] = [];
    const hub = new NotificationHub(proxy.url, ["pm1_probe"], { warn: (_data, message) => void warns.push(message) }, {
      everyMs: 200,
      timeoutMs: 100,
      reconnectBaseMs: 100,
      reconnectMaxMs: 100,
      connectTimeoutMs: 300,
    });
    try {
      await hub.start();
      let catchUps = 0;
      hub.subscribe("pm1_probe", (payload) => void (payload === null && (catchUps += 1)));
      expect(hub.healthSnapshot().status).toBe("ok");
      const before = proxy.accepted();

      proxy.goSilent();
      // The health check fails (no answer), then at least one reconnect attempt meets the silent link.
      expect(await until(() => warns.includes("realtime listen health check failed") && proxy.accepted() > before, 3_000)).toBe(true);
      await sleep(1_000);
      const whileSilent = proxy.accepted() - before;
      expect(hub.healthSnapshot().status).toBe("down");

      proxy.heal();
      const back = await until(() => hub.healthSnapshot().status === "ok", 5_000);
      const health = hub.healthSnapshot();
      console.log(
        `PM-1 probe (real pg, silent proxy): attempts while silent ${whileSilent}; 5 s after the link was back: status ${health.status}, reconnects ${health.reconnects}, catch-up signals ${catchUps}, attempts in all ${proxy.accepted() - before}`,
      );
      expect(whileSilent).toBeGreaterThanOrEqual(2);
      expect(back).toBe(true);
      expect(health.reconnects).toBe(1);
      expect(catchUps).toBe(1);

      // And it really listens again: a NOTIFY sent straight to the database arrives.
      let heard = 0;
      hub.subscribe("pm1_probe", (payload) => void (payload !== null && (heard += 1)));
      const direct = new pg.Client({ connectionString: adminUrl() });
      await direct.connect();
      try {
        await direct.query(`NOTIFY pm1_probe, '{"n":1}'`);
        expect(await until(() => heard === 1, 3_000)).toBe(true);
        // No double client: exactly one LISTEN session of this hub is left on the database.
        await sleep(500);
        const sessions = await direct.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'movera-server-listen' AND client_port = ANY($1::int[])",
          [proxy.upPorts()],
        );
        expect(sessions.rows[0]!.n).toBe(1);
        expect(heard).toBe(1);
      } finally {
        await direct.end();
      }
    } finally {
      await hub.stop();
      await proxy.close();
    }
  });
});
