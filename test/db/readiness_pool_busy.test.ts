import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { buildApp } from "../../src/app.js";
import { createDb, createHealthPool, createPool, poolStats } from "../../src/db/db.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * G34 load test P2 (audits/load-g34/PROOF-2026-11-13.md): /readyz and /healthz/jobs answered 503 "The database is not
 * reachable." while Postgres was idle and only the app's pool was full (every connection taken by app work). Render's
 * health check is /readyz (render.yaml), so a busy but healthy copy was reported dead. The checks now ask the database on
 * their own small pool (db.ts createHealthPool), so a full app pool no longer reads as "database down", while a database
 * that really does not answer still gives 503.
 */
let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

const env = readEnv({ MOVERA_ENV: "development" });

describe("health checks while the app pool is full (G34 P2)", () => {
  it("/readyz, /healthz and /healthz/jobs still see the database when every app connection is taken", async () => {
    const appPool = createPool(database.url, { max: 2, connectTimeoutMs: 10_000 });
    const db = createDb(appPool);
    const healthPool = createHealthPool(database.url);
    const healthDb = createDb(healthPool);
    const app = await buildApp({ env, logger: false, db, healthDb });
    await app.ready();
    // Every app connection is taken by "app work" (held, never released until the end).
    const held: pg.PoolClient[] = [await appPool.connect(), await appPool.connect()];
    try {
      // The app pool really is full: a query on it waits.
      expect(poolStats(appPool)).toMatchObject({ max: 2, total: 2, idle: 0 });
      const started = Date.now();
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      const readyMs = Date.now() - started;
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: "ready", database: "ok" });
      expect(readyMs).toBeLessThan(1000);

      const health = await app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ database: "ok", dbPool: { max: 2, total: 2, idle: 0 } });

      // /healthz/jobs reads the timers table on the health pool too: it answers about the jobs (here none is booked,
      // so they are "missing"), never "database not reachable".
      const jobs = await app.inject({ method: "GET", url: "/healthz/jobs" });
      expect(jobs.json()).toHaveProperty("jobs");
      expect(jobs.json()).not.toHaveProperty("reason", "database_unavailable");
    } finally {
      for (const client of held) client.release();
      await app.close();
      await db.destroy();
      await healthDb.destroy();
    }
  });

  it("still answers 503 database_unavailable when the database itself does not answer the health pool", async () => {
    const dead = createDb(createHealthPool("postgres://movera:movera@127.0.0.1:1/movera"));
    const app = await buildApp({ env, logger: false, db: database.db, healthDb: dead });
    try {
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ code: "unavailable", reason: "database_unavailable" });
      const jobs = await app.inject({ method: "GET", url: "/healthz/jobs" });
      expect(jobs.statusCode).toBe(503);
      expect(jobs.json()).toMatchObject({ reason: "database_unavailable" });
    } finally {
      await app.close();
      await dead.destroy();
    }
  });

  it("the health pool is not the app pool: /healthz keeps reporting the app pool's numbers", () => {
    const appPool = createPool(database.url, { max: 7 });
    const healthPool = createHealthPool(database.url);
    try {
      expect(poolStats()).toMatchObject({ max: 7 });
      expect(healthPool.options.max).toBe(2);
    } finally {
      void appPool.end();
      void healthPool.end();
    }
  });
});
