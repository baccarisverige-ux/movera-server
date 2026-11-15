import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { startSilentProxy, type SilentProxy } from "../support/silentProxy.js";

/**
 * PM-1 SF-2 + N-1 (pre-merge supervisor, Rules audits/impact/pm1-listen-timeout-supervisor.md §5): the real
 * src/main.ts, started as its own process with a database that answers and a LISTEN link that does not.
 * The HTTP server must come up anyway, /healthz must say realtime "down" (and /readyz must show it), and the hub
 * must connect by itself once the link answers. Before: a silent link ended the process (exit 1) and a refused
 * connection left a process that listened on nothing.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let database: TestDatabase;
let child: ChildProcess | undefined;
let proxy: SilentProxy | undefined;

beforeAll(async () => {
  database = await freshDatabase();
});
afterEach(async () => {
  if (child !== undefined && child.exitCode === null) {
    const gone = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await gone;
  }
  child = undefined;
  await proxy?.close();
  proxy = undefined;
});
afterAll(async () => {
  await database.drop();
});

/**
 * A free port for the child's HTTP server. SF-5: "open, close, use" has a small race (another process may take the
 * port in between); it cannot be port 0 because PORT must be 1–65535 (src/env.ts) and the child's output is not read.
 * The worst case is a failed test, never a false pass: the tests need /healthz of THIS child to answer as expected.
 */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Boot = { port: number; exit: () => number | null };
/** Starts src/main.ts. Its output is not read (never printed); only its exit code and its HTTP answers count. */
function boot(listenUrl: string, port: number): Boot {
  child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: ROOT,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MOVERA_ENV: "staging",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: database.url,
      DATABASE_LISTEN_URL: listenUrl,
      MIGRATE_ON_START: "false",
      JWT_SECRET: "boot-listen-test-secret".padEnd(48, "b"),
    },
  });
  const started = child;
  return { port, exit: () => started.exitCode };
}

type Health = { status: string; database: string; realtime?: { status: string; reconnects: number } };
async function get(port: number, path: string): Promise<{ code: number; body: unknown } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2_000) });
    return { code: res.status, body: await res.json() };
  } catch {
    return undefined;
  }
}
/** Waits until /healthz answers, the process ends, or the time is up. */
async function healthWithin(server: Boot, ms: number): Promise<{ health?: Health; exit: number | null; afterMs: number }> {
  const begun = Date.now();
  while (Date.now() - begun < ms) {
    if (server.exit() !== null) break;
    const res = await get(server.port, "/healthz");
    if (res?.code === 200) return { health: res.body as Health, exit: server.exit(), afterMs: Date.now() - begun };
    await sleep(250);
  }
  return { exit: server.exit(), afterMs: Date.now() - begun };
}

describe("PM-1 boot: the HTTP server comes up while the LISTEN link is down", () => {
  it("N-1: LISTEN connection refused at boot (connection-class error): HTTP up, realtime down, never a dark process", async () => {
    // SF-5: port 1 is never listened on (as test/db/readiness.test.ts uses it): refused for sure, no port race.
    const url = new URL(database.url);
    url.port = "1";
    const server = boot(url.toString(), await freePort());
    const up = await healthWithin(server, 40_000);
    console.log(`PM-1 boot proof (LISTEN refused): /healthz ${up.health === undefined ? "no answer" : `200 realtime ${up.health.realtime?.status}`} after ${up.afterMs} ms; process ${up.exit === null ? "alive" : `exited ${up.exit}`}`);
    expect(up.exit).toBeNull();
    expect(up.health).toMatchObject({ status: "ok", database: "ok", realtime: { status: "down", reconnects: 0 } });
    // Round 4 (owner "Wait up to 30 s"): the new copy is not ready until its first LISTEN connect, at most 30 s
    // after the start; then ready anyway, so a link that stays down never blocks a deploy for ever.
    const early = await get(server.port, "/readyz");
    expect(early).toMatchObject({ code: 503, body: { code: "unavailable", reason: "realtime_starting" } });
    let ready = early;
    const begun = Date.now();
    while (ready?.code !== 200 && Date.now() - begun < 40_000) {
      await sleep(500);
      ready = await get(server.port, "/readyz");
    }
    console.log(`PM-1 boot proof (LISTEN refused): /readyz 503 at boot; 200 about ${Math.round((up.afterMs + (Date.now() - begun)) / 1000)} s after the process started`);
    expect(ready).toEqual({ code: 200, body: { status: "ready", database: "ok", realtime: "down" } });
    // Not before the 30 s were over (the process started at least `up.afterMs` + this wait ago).
    expect(up.afterMs + (Date.now() - begun)).toBeGreaterThanOrEqual(25_000);
    expect(server.exit()).toBeNull();
  }, 120_000);

  // MF-1 (supervisor round 2): a wrong LISTEN address is not a link problem and must fail the boot, so the host
  // keeps the old copy (which has working realtime) instead of putting a copy live that will never hear anything.
  it("MF-1: LISTEN address with a database that does not exist: the boot fails (exit code not 0), nothing is served", async () => {
    const url = new URL(database.url);
    url.pathname = "/movera_pm1_no_such_database";
    const server = boot(url.toString(), await freePort());
    const up = await healthWithin(server, 20_000);
    console.log(`PM-1 boot proof (LISTEN unknown database): /healthz ${up.health === undefined ? "no answer" : `200 realtime ${up.health.realtime?.status}`} after ${up.afterMs} ms; process ${up.exit === null ? "alive" : `exited ${up.exit}`}`);
    expect(up.health).toBeUndefined();
    expect(up.exit).not.toBeNull();
    expect(up.exit).not.toBe(0);
  }, 40_000);

  it("SF-2: LISTEN link silent at boot: HTTP up within the 5 s try, realtime down; the hub connects by itself when the link answers", async () => {
    proxy = await startSilentProxy(database.url, "accept");
    const server = boot(proxy.url, await freePort());
    const up = await healthWithin(server, 40_000);
    console.log(`PM-1 boot proof (LISTEN silent): /healthz ${up.health === undefined ? "no answer" : `200 realtime ${up.health.realtime?.status}`} after ${up.afterMs} ms; process ${up.exit === null ? "alive" : `exited ${up.exit}`}`);
    expect(up.exit).toBeNull();
    expect(up.health).toMatchObject({ status: "ok", database: "ok", realtime: { status: "down" } });
    expect(await get(server.port, "/readyz")).toMatchObject({ code: 503, body: { code: "unavailable", reason: "realtime_starting" } });

    proxy.heal();
    let health: Health | undefined;
    const begun = Date.now();
    while (Date.now() - begun < 15_000) {
      health = (await get(server.port, "/healthz"))?.body as Health | undefined;
      if (health?.realtime?.status === "ok") break;
      await sleep(250);
    }
    console.log(`PM-1 boot proof (LISTEN silent): ${Date.now() - begun} ms after the link answered: realtime ${health?.realtime?.status}, reconnects ${health?.realtime?.reconnects}`);
    expect(health).toMatchObject({ realtime: { status: "ok", reconnects: 0 } });
    expect(await get(server.port, "/readyz")).toEqual({ code: 200, body: { status: "ready", database: "ok", realtime: "ok" } });
    expect(server.exit()).toBeNull();
  }, 90_000);
});
