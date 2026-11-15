import type net from "node:net";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LISTEN_CONNECT_TIMEOUT_MS, NotificationHub, RECONNECT_BACKOFF } from "../../src/realtime/hub.js";
import { adminUrl } from "../support/globalSetup.js";
import { startSilentProxy } from "../support/silentProxy.js";

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

  // SF-2 + N-1 (pre-merge supervisor, Rules audits/impact/pm1-listen-timeout-supervisor.md): the first start() must
  // neither hang the boot nor fail it on one try, and must never leave a rejected promise behind (main.ts awaits it:
  // a rejection there ended the process, or - for a connection-class error - left a process listening on nothing).
  it("SF-2: start() on a LISTEN link that is slow at boot gives the boot back in time and keeps retrying until connected", async () => {
    const warns: string[] = [];
    db.connect = "silent";
    const hub = new NotificationHub(URL, ["ch"], { warn: (_data, message) => void warns.push(message) });
    const outcome = hub.start().then(
      () => "started",
      (error: unknown) => `rejected: ${(error as Error).message}`,
    );
    await vi.advanceTimersByTimeAsync(LISTEN_CONNECT_TIMEOUT_MS + 1);
    expect(await Promise.race([outcome, Promise.resolve("still hanging")])).toBe("started");
    expect(hub.healthSnapshot().status).toBe("down");
    expect(db.ended).toContain(db.late[0]!.client);
    expect(warns).toContain("realtime listen connect failed at start; retrying");
    // A second start() is the same settled promise, never a rejection.
    await expect(hub.start()).resolves.toBeUndefined();
    // A stream that opens while the hub is still down is told to catch up once the link answers.
    let catchUps = 0;
    hub.subscribe("ch", (payload) => void (payload === null && (catchUps += 1)));
    await vi.advanceTimersByTimeAsync(30_000);
    const whileSlow = db.connects.length;
    expect(whileSlow).toBeGreaterThanOrEqual(4);
    expect(hub.healthSnapshot().status).toBe("down");
    db.connect = "ok";
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF.maxMs + LISTEN_CONNECT_TIMEOUT_MS);
    const health = hub.healthSnapshot();
    console.log(`PM-1 proof (slow LISTEN at boot): start() ${await outcome}; ${whileSlow} attempts while slow; then status ${health.status}, reconnects ${health.reconnects}, catch-up signals ${catchUps}`);
    // The first connect is not a "reconnect".
    expect(health).toMatchObject({ status: "ok", reconnects: 0 });
    expect(catchUps).toBe(1);
    await hub.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("N-1: start() that meets a connection-class error at boot does not reject; the hub retries with the back-off until connected", async () => {
    db.connect = "down";
    vi.mocked(pg.Client.prototype.connect).mockImplementation(function (this: pg.Client) {
      db.connects.push(Date.now());
      if (db.connect === "down") return Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }));
      db.opened.push(this);
      return Promise.resolve();
    } as unknown as pg.Client["connect"]);
    const hub = new NotificationHub(URL, ["ch"]);
    const begun = Date.now();
    const outcome = hub.start().then(
      () => "started",
      (error: unknown) => `rejected: ${(error as Error).message}`,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([outcome, Promise.resolve("still hanging")])).toBe("started");
    expect(hub.healthSnapshot().status).toBe("down");
    await vi.advanceTimersByTimeAsync(60_000);
    const gaps = db.connects.map((at, i) => at - (i === 0 ? begun : db.connects[i - 1]!));
    console.log(`PM-1 proof (connection error at boot): start() ${await outcome}; ${db.connects.length} attempts in 60 s; gaps ms ${gaps.slice(0, 8).join(", ")} …`);
    // The same back-off as a reconnect: 0.5–1, 1–2, 2–4, then 2.5–5 s.
    expect(db.connects.length).toBeGreaterThanOrEqual(12);
    expect(db.connects.length).toBeLessThanOrEqual(30);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(RECONNECT_BACKOFF.maxMs);
    db.connect = "ok";
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF.maxMs);
    expect(hub.healthSnapshot()).toMatchObject({ status: "ok", reconnects: 0 });
    await hub.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  // MF-1 (supervisor round 2): only what can heal by itself is retried at the first start. A wrong LISTEN address
  // (unknown database, wrong password or user) must fail the boot as before, so a deploy with a wrong
  // DATABASE_LISTEN_URL never replaces the working copy.
  it.each([
    ["3D000", 'database "nope" does not exist'],
    ["28P01", 'password authentication failed for user "movera"'],
    ["28000", 'role "nobody" does not exist'],
  ])("MF-1: start() that meets a permanent error (%s) rejects, and nothing is retried", async (code, message) => {
    const warns: string[] = [];
    vi.mocked(pg.Client.prototype.connect).mockImplementation(function (this: pg.Client) {
      db.connects.push(Date.now());
      return Promise.reject(Object.assign(new Error(message), { code }));
    } as unknown as pg.Client["connect"]);
    const hub = new NotificationHub(URL, ["ch"], { warn: (_data, text) => void warns.push(text) });
    const outcome = hub.start().then(
      () => "started",
      (error: unknown) => `rejected: ${(error as { code?: string }).code}`,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([outcome, Promise.resolve("still hanging")])).toBe(`rejected: ${code}`);
    await vi.advanceTimersByTimeAsync(60_000);
    console.log(`PM-1 proof (permanent error at boot, ${code}): start() ${await outcome}; connect attempts in 60 s: ${db.connects.length}; timers left ${vi.getTimerCount()}`);
    expect(db.connects).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(warns).toEqual([]);
    expect(hub.healthSnapshot().status).toBe("down");
    await hub.stop();
  });

  it("MF-1: a malformed LISTEN address rejects at start too", async () => {
    vi.mocked(pg.Client.prototype.connect).mockImplementation(function (this: pg.Client) {
      db.connects.push(Date.now());
      return Promise.reject(new TypeError("Invalid URL"));
    } as unknown as pg.Client["connect"]);
    const hub = new NotificationHub("not a url", ["ch"]);
    await expect(hub.start()).rejects.toThrow(/Invalid URL/);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(db.connects).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await hub.stop();
  });

  // SF-4 (supervisor round 2): a link that stays down is not one warning per attempt for ever.
  it("SF-4: while the link stays down the retry warning is thinned: the first failure, then at most one a minute", async () => {
    const warns: { at: number; data: Record<string, unknown> }[] = [];
    const hub = new NotificationHub(URL, ["ch"], { warn: (data, text) => void (text === "realtime listen reconnect failed" && warns.push({ at: Date.now(), data: data as Record<string, unknown> })) });
    await hub.start();
    db.connect = "down";
    db.connects = [];
    const begun = Date.now();
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const gaps = warns.slice(1).map((w, i) => w.at - warns[i]!.at);
    console.log(`PM-1 proof (SF-4): ${db.connects.length} failed attempts in 10 min, ${warns.length} warnings; first after ${warns[0]!.at - begun} ms; shortest gap ${Math.min(...gaps)} ms`);
    expect(db.connects.length).toBeGreaterThan(100);
    // The first failure is reported at once.
    expect(warns[0]!.at).toBe(db.connects[0]!);
    expect(warns.length).toBeGreaterThanOrEqual(9);
    expect(warns.length).toBeLessThanOrEqual(11);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(60_000);
    // Each later warning says how many failures it stands for.
    expect(warns[1]!.data).toMatchObject({ failedSinceLastWarning: expect.any(Number) });
    // After a connect that worked, the next failure is reported at once again.
    db.connect = "ok";
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF.maxMs);
    expect(hub.healthSnapshot().status).toBe("ok");
    const before = warns.length;
    db.connect = "down";
    dropConnection(hub);
    await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF.baseMs);
    expect(warns.length).toBe(before + 1);
    await hub.stop();
  });

  it("stop() while the first start is still retrying ends the retries and leaves no timer", async () => {
    db.connect = "silent";
    const hub = new NotificationHub(URL, ["ch"]);
    void hub.start();
    await vi.advanceTimersByTimeAsync(LISTEN_CONNECT_TIMEOUT_MS + RECONNECT_BACKOFF.baseMs + 100);
    await hub.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    db.connect = "ok";
    db.connects = [];
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(db.connects).toHaveLength(0);
    expect(hub.healthSnapshot().status).toBe("down");
  });
});

/**
 * The supervisors' probes, kept: the real NotificationHub and the real pg driver, through a local TCP proxy to the
 * real database (test/support/silentProxy.ts). Nothing is mocked here: "closed" means the socket really closed.
 */
describe("PM-1: a silent LISTEN link (real pg through a TCP proxy that goes silent)", () => {
  const TUNING = { everyMs: 200, timeoutMs: 100, reconnectBaseMs: 100, reconnectMaxMs: 100, connectTimeoutMs: 300 };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function until(what: () => boolean, withinMs: number): Promise<boolean> {
    const end = Date.now() + withinMs;
    while (Date.now() < end) {
      if (what()) return true;
      await sleep(20);
    }
    return what();
  }

  /**
   * Every pg client the hub makes, with the REAL connect (nothing is replaced): the test reads each client's own
   * socket. `end()` is not mocked, so "closed" below is the socket's real state.
   */
  function hubClients(): pg.Client[] {
    const made: pg.Client[] = [];
    const connect = pg.Client.prototype.connect;
    vi.spyOn(pg.Client.prototype, "connect").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      if ((this as unknown as { connectionParameters: { application_name?: string } }).connectionParameters.application_name === "movera-server-listen") made.push(this);
      return (connect as unknown as (...a: unknown[]) => Promise<void>).apply(this, args);
    } as unknown as pg.Client["connect"]);
    return made;
  }
  const socketOpen = (client: pg.Client) => !(client as unknown as { connection: { stream: net.Socket } }).connection.stream.destroyed;
  afterEach(() => vi.restoreAllMocks());

  it("the hub comes back by itself after the link was silent (probe: before the fix it stayed down for ever)", async () => {
    const made = hubClients();
    const proxy = await startSilentProxy(adminUrl());
    const warns: string[] = [];
    const hub = new NotificationHub(proxy.url, ["pm1_probe"], { warn: (_data, message) => void warns.push(message) }, TUNING);
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
      // SF-3: every given-up client's socket is really closed (they were still signing in: the link never answered
      // their goodbye either, so only the destroy in `discard` closes them); the one open socket is the live client's.
      const live = (hub as unknown as { client: pg.Client }).client;
      console.log(`PM-1 probe (real pg, silent proxy): ${made.length} clients made, sockets still open ${made.filter(socketOpen).length} (the live one)`);
      expect(made.length).toBeGreaterThanOrEqual(4);
      expect(made.filter(socketOpen)).toEqual([live]);

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

  // MF-1 with the real driver: the LISTEN address names a database that does not exist.
  it("MF-1: start() against a database that does not exist rejects (3D000) and the hub does not retry", async () => {
    const made = hubClients();
    const wrong = new globalThis.URL(adminUrl());
    wrong.pathname = "/movera_pm1_no_such_database";
    const warns: string[] = [];
    const hub = new NotificationHub(wrong.toString(), ["pm1_probe"], { warn: (_data, message) => void warns.push(message) }, TUNING);
    try {
      const outcome = await hub.start().then(
        () => "started",
        (error: unknown) => `rejected: ${(error as { code?: string }).code}`,
      );
      await sleep(1_500);
      console.log(`PM-1 probe (real pg, unknown database): start() ${outcome}; clients made in 1.5 s: ${made.length}; warnings ${warns.length}; status ${hub.healthSnapshot().status}`);
      expect(outcome).toBe("rejected: 3D000");
      expect(made).toHaveLength(1);
      expect(made.filter(socketOpen)).toHaveLength(0);
      expect(warns).toEqual([]);
    } finally {
      await hub.stop();
    }
  });

  // SF-3 (pre-merge supervisor): the silent-LISTEN case with the real driver, and the given-up sockets really closed
  // (hub.ts `discard`: end() alone would wait for ever on a client that is signed in but gets no answer).
  it("SF-3: a LISTEN that gets no answer (sign-in works) is given up, its socket is really closed, and the hub comes back", async () => {
    const made = hubClients();
    const proxy = await startSilentProxy(adminUrl());
    const hub = new NotificationHub(proxy.url, ["pm1_probe_listen"], undefined, TUNING);
    try {
      await hub.start();
      let catchUps = 0;
      hub.subscribe("pm1_probe_listen", (payload) => void (payload === null && (catchUps += 1)));
      const before = proxy.accepted();

      proxy.goSilent("listen");
      // Each attempt signs in (the proxy forwards it) and then waits on its first LISTEN.
      expect(await until(() => proxy.accepted() - before >= 4, 5_000)).toBe(true);
      expect(hub.healthSnapshot().status).toBe("down");
      // Every given-up socket is closed by the hub; at most the attempt still waiting is open.
      expect(await until(() => made.filter(socketOpen).length <= 1, 2_000)).toBe(true);
      const whileSilent = { attempts: proxy.accepted() - before, made: made.length, open: made.filter(socketOpen).length };
      expect(proxy.caught()).toBeGreaterThanOrEqual(4);

      proxy.heal();
      expect(await until(() => hub.healthSnapshot().status === "ok", 5_000)).toBe(true);
      // Exactly one socket is open now: the live client's.
      const live = (hub as unknown as { client: pg.Client }).client;
      expect(await until(() => made.filter(socketOpen).length === 1, 2_000)).toBe(true);
      expect(made.filter(socketOpen)).toEqual([live]);
      const health = hub.healthSnapshot();
      console.log(
        `PM-1 probe (real pg, silent LISTEN): while silent ${whileSilent.attempts} attempts, ${whileSilent.made - whileSilent.open} of ${whileSilent.made} client sockets closed; after the link was back: status ${health.status}, reconnects ${health.reconnects}, catch-up signals ${catchUps}, ${made.length} clients made, sockets open ${made.filter(socketOpen).length}`,
      );
      expect(health.reconnects).toBe(1);
      expect(catchUps).toBe(1);
    } finally {
      await hub.stop();
      // stop() closes the live socket too: nothing is left open.
      expect(await until(() => made.filter(socketOpen).length === 0, 2_000)).toBe(true);
      await proxy.close();
    }
  });
});
