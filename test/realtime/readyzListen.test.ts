import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readEnv } from "../../src/env.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { startSilentProxy, type SilentProxy } from "../support/silentProxy.js";

/**
 * PM-1 round 4 (owner 2026-11-15 "Wait up to 30 s (Rec.)", Rules decisions/session-2026-11-06.md): a NEW copy answers
 * /readyz 503 until its first LISTEN connect, for at most 30 s (here a short limit through the hub's tuning), then
 * ready anyway. Once ready, a LISTEN drop never turns /readyz back to 503. /healthz stays 200 and honest throughout.
 * The real app, the real hub, the real pg driver, a real database; the LISTEN link goes through the silent proxy.
 */

let database: TestDatabase;
let app: FastifyInstance | undefined;
let hub: NotificationHub | undefined;
let proxy: SilentProxy | undefined;

beforeAll(async () => {
  database = await freshDatabase();
});
afterEach(async () => {
  await app?.close();
  await hub?.stop();
  await proxy?.close();
  app = hub = proxy = undefined;
});
afterAll(async () => {
  await database.drop();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const FAST = { everyMs: 200, timeoutMs: 100, reconnectBaseMs: 100, reconnectMaxMs: 100, connectTimeoutMs: 300 };
async function open(readyWaitMs: number, silentAtBoot: boolean): Promise<void> {
  proxy = await startSilentProxy(database.url, silentAtBoot ? "accept" : undefined);
  hub = new NotificationHub(proxy.url, ["pm1_ready"], undefined, { ...FAST, readyWaitMs });
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "readyz-listen-secret".padEnd(48, "r") }), logger: false, db: database.db, hub });
}
type Answer = { code: number; body: Record<string, unknown>; retryAfter: unknown };
async function get(path: string): Promise<Answer> {
  const res = await app!.inject({ method: "GET", url: path });
  return { code: res.statusCode, body: res.json(), retryAfter: res.headers["retry-after"] };
}
const realtime = async () => ((await get("/healthz")).body.realtime as { status: string }).status;
/** Polls /readyz until it answers `code` or the time is up; returns the ms it took, or undefined. */
async function readyzBecomes(code: number, withinMs: number): Promise<number | undefined> {
  const begun = Date.now();
  while (Date.now() - begun < withinMs) {
    if ((await get("/readyz")).code === code) return Date.now() - begun;
    await sleep(25);
  }
  return undefined;
}

describe("PM-1 round 4: /readyz waits for the first LISTEN connect, at most the ready wait", () => {
  it("silent link at boot: /readyz 503 (realtime_starting), /healthz 200 realtime down; after the ready wait /readyz 200 although realtime is still down", async () => {
    // SF-8: 3 s wait, last 503 check at 1 s (was 1.1 s of 1.5 s), so a slow CI runner cannot flake it.
    await open(3_000, true);
    const begun = Date.now();
    await hub!.start();
    const early = await get("/readyz");
    const health = await get("/healthz");
    expect(early.code).toBe(503);
    expect(early.body).toMatchObject({ code: "unavailable", reason: "realtime_starting" });
    expect(early.retryAfter).toBe("5");
    expect(health.code).toBe(200);
    expect(health.body).toMatchObject({ status: "ok", database: "ok", realtime: { status: "down" } });
    // Still not ready shortly before the limit.
    await sleep(Math.max(0, 1_000 - (Date.now() - begun)));
    expect((await get("/readyz")).code).toBe(503);
    const took = await readyzBecomes(200, 5_000);
    const late = await get("/readyz");
    console.log(`PM-1 proof (/readyz, silent link, ready wait 3000 ms): 503 ${JSON.stringify(early.body.reason)} at ${0} ms; 200 at ${Date.now() - begun} ms with realtime ${JSON.stringify(late.body.realtime)}`);
    expect(took).toBeDefined();
    expect(Date.now() - begun).toBeGreaterThanOrEqual(3_000);
    expect(late).toMatchObject({ code: 200, body: { status: "ready", database: "ok", realtime: "down" } });
    expect(await realtime()).toBe("down");
  });

  it("link that connects after the boot: /readyz 503 until the connect, then 200 (long before the ready wait)", async () => {
    await open(60_000, true);
    const begun = Date.now();
    await hub!.start();
    expect((await get("/readyz")).code).toBe(503);
    await sleep(500);
    expect((await get("/readyz")).code).toBe(503);
    proxy!.heal();
    const took = await readyzBecomes(200, 5_000);
    const now = await get("/readyz");
    console.log(`PM-1 proof (/readyz, link up after ${500} ms, ready wait 60 s): 503 until the connect; 200 at ${Date.now() - begun} ms with realtime ${JSON.stringify(now.body.realtime)}`);
    expect(took).toBeDefined();
    expect(now).toMatchObject({ code: 200, body: { status: "ready", database: "ok", realtime: "ok" } });
  });

  it("mid-day drop after the copy was ready: /readyz stays 200 (realtime down shown), also inside the ready wait", async () => {
    await open(60_000, false);
    await hub!.start();
    expect(await get("/readyz")).toMatchObject({ code: 200, body: { realtime: "ok" } });
    proxy!.goSilent();
    const begun = Date.now();
    while ((await realtime()) !== "down" && Date.now() - begun < 3_000) await sleep(25);
    expect(await realtime()).toBe("down");
    const codes = new Set<number>();
    for (let i = 0; i < 20; i += 1) {
      codes.add((await get("/readyz")).code);
      await sleep(50);
    }
    const during = await get("/readyz");
    console.log(`PM-1 proof (/readyz, mid-day drop): realtime down; /readyz codes over 1 s: ${[...codes].join(",")}; body realtime ${JSON.stringify(during.body.realtime)}`);
    expect([...codes]).toEqual([200]);
    expect(during.body).toMatchObject({ status: "ready", database: "ok", realtime: "down" });
  });

  it("no hub (no database listener configured): /readyz is as before", async () => {
    app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "readyz-listen-secret".padEnd(48, "r") }), logger: false, db: database.db });
    expect(await get("/readyz")).toMatchObject({ code: 200, body: { status: "ready", database: "ok" } });
  });
});
