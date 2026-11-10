import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { API_PREFIX, buildApp } from "../../src/app.js";
import { readEnv } from "../../src/env.js";
import { MAX_ATTEMPTS, TimerWorker, scheduleTimer } from "../../src/jobs/timers.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { openEventStream } from "../../src/realtime/sse.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/** Global plan step 63 (T6 Server-Timing, T6b load counters). */
let database: TestDatabase;
let hub: NotificationHub;
let app: FastifyInstance;
let base: string;
const env = (extra: Record<string, string> = {}) => readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "load-test-secret".padEnd(48, "s"), ...extra });
const quiet = { warn: () => undefined, error: () => undefined };

beforeAll(async () => {
  database = await freshDatabase();
  hub = new NotificationHub(database.url, ["step63_load"]);
  await hub.start();
  hub.subscribe("step63_load", () => undefined);
  app = await buildApp({ env: env({ LOAD_COUNTERS: "true" }), logger: false, db: database.db, hub });
  app.get(`${API_PREFIX}/__test/db`, async () => {
    await sql`SELECT pg_sleep(0.02)`.execute(database.db);
    return { ok: true };
  });
  app.get(`${API_PREFIX}/__test/stream`, async (request, reply) => {
    openEventStream(request, reply);
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  await hub.stop();
  await database.drop();
});

const load = async () => (await app.inject({ method: "GET", url: "/internal/load" })).json();
const timing = (header: unknown) => Object.fromEntries(String(header).split(", ").map((part) => {
  const [name, dur, desc] = part.split(";");
  return [name, { dur: Number(dur!.slice(4)), desc: desc?.slice(6, -1) }];
}));
const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 20));
};

describe("Server-Timing (T6)", () => {
  it("is on every answer, with total ≥ app ≥ db and the db time of the statements", async () => {
    const res = await app.inject({ method: "GET", url: `${API_PREFIX}/__test/db` });
    const t = timing(res.headers["server-timing"]);
    expect(t.db.desc).toBe("1");
    expect(t.db.dur).toBeGreaterThanOrEqual(15);
    expect(t.app.dur).toBeGreaterThanOrEqual(t.db.dur);
    expect(t.total.dur).toBeGreaterThanOrEqual(t.app.dur);
    expect(t.total.dur).toBeLessThan(5000);
  });
  it("is on errors (404) and on routes without database work (db 0)", async () => {
    const missing = await app.inject({ method: "GET", url: `${API_PREFIX}/nope` });
    expect(missing.statusCode).toBe(404);
    expect(String(missing.headers["server-timing"])).toMatch(/^total;dur=\d+\.\d/);
    const push = timing((await app.inject({ method: "GET", url: `${API_PREFIX}/push/config` })).headers["server-timing"]);
    expect(push.db).toEqual({ dur: 0, desc: "0" });
  });
});

describe("load counters (T6b)", () => {
  it("are served only with LOAD_COUNTERS, which production refuses", async () => {
    const off = await buildApp({ env: env(), logger: false, db: database.db });
    expect((await off.inject({ method: "GET", url: "/internal/load" })).statusCode).toBe(404);
    await off.close();
    expect(() => readEnv({ MOVERA_ENV: "production", LOAD_COUNTERS: "true" })).toThrow(/LOAD_COUNTERS/);
  });

  it("timer lane lag and parked timers move when timers run late or park", async () => {
    const worker = new TimerWorker(database.db, { handlers: { s63_ok: async () => undefined, s63_bad: async () => { throw new Error("no"); } }, logger: quiet });
    await scheduleTimer(database.db, { kind: "s63_ok", refId: "a", dueAt: new Date(Date.now() - 3000) });
    await scheduleTimer(database.db, { kind: "s63_bad", refId: "b", dueAt: new Date(Date.now() - 1000) });
    await database.db.updateTable("timers").set({ attempts: MAX_ATTEMPTS - 1 }).where("kind", "=", "s63_bad").execute();
    const before = await load();
    expect(before.timersInDatabase.s63_ok.overdue).toBe(1);
    expect(before.timersInDatabase.s63_ok.overdueOldestMs).toBeGreaterThanOrEqual(2900);
    await worker.runOne({ kinds: ["s63_ok"] });
    await worker.runOne({ kinds: ["s63_bad"] });
    const after = await load();
    expect(after.timerLanes.s63_ok.runs).toBe((before.timerLanes.s63_ok?.runs ?? 0) + 1);
    expect(after.timerLanes.s63_ok.lagLastMs).toBeGreaterThanOrEqual(2900);
    expect(after.timersParkedByThisCopy.byKind.s63_bad).toBe(1);
    expect(after.timersInDatabase.s63_bad).toEqual({ parked: 1, overdue: 0, overdueOldestMs: 0 });
    expect(after.timersInDatabase.s63_ok).toBeUndefined();
  });

  it("NOTIFY count moves when the hub receives a notification", async () => {
    const before = (await load()).notify.total;
    for (let i = 0; i < 3; i++) await sql`SELECT pg_notify('step63_load', '{}')`.execute(database.db);
    await waitFor(async () => (await load()).notify.total >= before + 3);
    expect((await load()).notify.total).toBe(before + 3);
  });

  it("open streams count up while a stream is open and down when it closes", async () => {
    const before = (await load()).streams.open;
    const req = http.get(`${base}${API_PREFIX}/__test/stream`, { headers: { accept: "text/event-stream" } });
    await new Promise<void>((resolve) => req.on("response", () => resolve()));
    await waitFor(async () => (await load()).streams.open === before + 1);
    expect((await load()).streams.open).toBe(before + 1);
    req.destroy();
    await waitFor(async () => (await load()).streams.open === before);
    expect((await load()).streams.open).toBe(before);
    const body = await load();
    expect(body.dbPool).toMatchObject({ waiting: 0 });
    expect(JSON.stringify(body)).not.toMatch(/postgres:|secret/i);
  });
});
