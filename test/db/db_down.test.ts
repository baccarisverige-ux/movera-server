import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createDb, createPool, type Db } from "../../src/db/db.js";
import { guardProcess, isDatabaseConnectionError, waitForDatabase } from "../../src/db/ready.js";
import { readEnv } from "../../src/env.js";
import { DB_DOWN_MAX_MS, TimerWorker, dbDownDelayMs } from "../../src/jobs/timers.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/** Rule 28 — Render deploy 2026-11-05: 57P03 from TimerWorker.runOne while the database restarted stopped the server. */

const startingUp = () => Object.assign(new Error("the database system is starting up"), { code: "57P03", severity: "FATAL" });
const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
const terminated = () => new Error("Connection terminated unexpectedly");

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

/** A Db whose every transaction fails like a restarting database for the first `down` tries. */
function flakyDb(real: Db, down: number, error: () => Error = startingUp) {
  let calls = 0;
  const db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return () => {
          const builder = target.transaction();
          return {
            execute: async (fn: Parameters<typeof builder.execute>[0]) => {
              calls += 1;
              if (calls <= down) throw error();
              return builder.execute(fn);
            },
          };
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { db, calls: () => calls };
}

describe("connection errors", () => {
  it("57P03, ECONNREFUSED and connection terminated count as 'database unavailable'; other errors do not", () => {
    expect(isDatabaseConnectionError(startingUp())).toBe(true);
    expect(isDatabaseConnectionError(refused())).toBe(true);
    expect(isDatabaseConnectionError(terminated())).toBe(true);
    expect(isDatabaseConnectionError(new AggregateError([refused()]))).toBe(true);
    expect(isDatabaseConnectionError(Object.assign(new Error("syntax"), { code: "42601" }))).toBe(false);
    expect(isDatabaseConnectionError(new TypeError("x is undefined"))).toBe(false);
  });
});

describe("timer worker while the database restarts", () => {
  it("a 57P03 never escapes the loop: it is logged, the loop backs off, and timers run once the database is back", async () => {
    const logs: Array<{ message: string; data: object }> = [];
    const logger = { warn: (data: object, message: string) => logs.push({ message, data }), error: (data: object, message: string) => logs.push({ message, data }) };
    const flaky = flakyDb(database.db, 3);
    const w = new TimerWorker(flaky.db, { handlers: {}, logger, pollMs: 5 });
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => rejections.push(error);
    process.on("unhandledRejection", onRejection);
    try {
      // runOne itself throws (as in the Render log), the loop round does not.
      await expect(w.runOne()).rejects.toMatchObject({ code: "57P03" });
      const delays = [await w.tick(() => w.runDue(100)), await w.tick(() => w.runDue(100))];
      expect(delays).toEqual([dbDownDelayMs(1, 5), dbDownDelayMs(2, 5)]);
      expect(delays[1]!).toBeGreaterThan(delays[0]!);
      expect(await w.tick(() => w.runDue(100))).toBe(5);
      expect(logs.map((l) => l.message)).toEqual([
        "timer worker: database unavailable; retrying",
        "timer worker: database unavailable; retrying",
        "timer worker: database is back",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("the running loop survives connection errors and a logger that throws, and stops cleanly", async () => {
    const flaky = flakyDb(database.db, 2, refused);
    const logger = { warn: () => { throw new Error("logger broke"); }, error: () => undefined };
    const w = new TimerWorker(flaky.db, { handlers: {}, logger, pollMs: 1 });
    w.start();
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(flaky.calls()).toBeGreaterThan(2);
    await w.stop();
  });

  it("the back-off grows and is capped", () => {
    expect(dbDownDelayMs(1, 500)).toBe(1000);
    expect(dbDownDelayMs(2, 500)).toBe(2000);
    expect(dbDownDelayMs(20, 500)).toBe(DB_DOWN_MAX_MS);
  });
});

describe("startup waits for the database", () => {
  it("retries 57P03 / ECONNREFUSED / terminated with growing delays, then goes on", async () => {
    const errors = [startingUp(), refused(), terminated()];
    const sleeps: number[] = [];
    const pool = { query: async () => { const e = errors.shift(); if (e) throw e; return { rows: [] }; } };
    const attempts = await waitForDatabase(pool as never, { sleep: async (ms) => void sleeps.push(ms) });
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it("gives up after about 2 minutes, and at once on a non-connection error", async () => {
    let clock = 0;
    const pool = { query: async () => { throw startingUp(); } };
    await expect(waitForDatabase(pool as never, { now: () => clock, sleep: async (ms) => void (clock += ms) })).rejects.toMatchObject({ code: "57P03" });
    expect(clock).toBeGreaterThanOrEqual(100_000);
    expect(clock).toBeLessThanOrEqual(120_000);
    const bad = { query: async () => { throw Object.assign(new Error("password authentication failed"), { code: "28P01" }); } };
    let slept = 0;
    await expect(waitForDatabase(bad as never, { sleep: async () => void slept++ })).rejects.toMatchObject({ code: "28P01" });
    expect(slept).toBe(0);
  });

  it("waits for a real database that answers", async () => {
    const pool = createPool(database.url, 1);
    expect(await waitForDatabase(pool)).toBe(1);
    await pool.end();
  });
});

describe("process guard", () => {
  it("an escaped database connection error is logged and the process keeps running; other errors still stop it", () => {
    const handlers = new Map<string, (error: unknown) => void>();
    const exits: number[] = [];
    const logged: string[] = [];
    guardProcess({ error: (_data, message) => logged.push(message) }, { on: ((event: string, fn: (e: unknown) => void) => handlers.set(event, fn)) as never, exit: (code) => void exits.push(code) });
    handlers.get("unhandledRejection")!(startingUp());
    handlers.get("uncaughtException")!(terminated());
    expect(exits).toEqual([]);
    handlers.get("unhandledRejection")!(new TypeError("bug"));
    expect(exits).toEqual([1]);
    expect(logged).toHaveLength(3);
  });
});

describe("health while the database is down", () => {
  const env = readEnv({ MOVERA_ENV: "development" });
  it("/healthz stays 200 and says database unavailable; /readyz answers 503", async () => {
    const dead = createDb(createPool("postgres://movera:movera@127.0.0.1:1/movera", 1));
    const app = await buildApp({ env, logger: false, db: dead });
    const health = await app.inject({ method: "GET", url: "/healthz" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    await app.close();
    await dead.destroy();
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", database: "unavailable" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ reason: "database_unavailable" });
  });

  it("/healthz says database ok when it answers", async () => {
    const app = await buildApp({ env, logger: false, db: database.db });
    const health = await app.inject({ method: "GET", url: "/healthz" });
    await app.close();
    expect(health.json()).toMatchObject({ database: "ok" });
  });
});
