import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createDb, createPool, poolOptionsFrom, poolStats } from "../../src/db/db.js";
import { readEnv } from "../../src/env.js";

/** B12: pool size, idle and wait timeouts and the LISTEN address come from the environment; /healthz shows counts. */
describe("database pool settings", () => {
  it("reads sane defaults for Render basic-1gb and lets env override them", () => {
    const env = readEnv({ MOVERA_ENV: "development" });
    expect(poolOptionsFrom(env)).toEqual({ max: 20, idleMs: 30_000, connectTimeoutMs: 10_000 });
    expect(env.DATABASE_LISTEN_URL).toBeUndefined();
    const custom = readEnv({ MOVERA_ENV: "development", DATABASE_POOL_MAX: "40", DATABASE_POOL_IDLE_MS: "5000", DATABASE_POOL_CONNECT_TIMEOUT_MS: "2000", DATABASE_LISTEN_URL: "postgres://u:p@direct/db" });
    expect(poolOptionsFrom(custom)).toEqual({ max: 40, idleMs: 5000, connectTimeoutMs: 2000 });
    expect(custom.DATABASE_LISTEN_URL).toBe("postgres://u:p@direct/db");
  });

  it("applies the options to the pool and shows only counts on /healthz", async () => {
    const pool = createPool("postgres://secretuser:secretpass@127.0.0.1:1/movera", { max: 7, idleMs: 1000, connectTimeoutMs: 500 });
    expect(pool.options.idleTimeoutMillis).toBe(1000);
    expect(pool.options.connectionTimeoutMillis).toBe(500);
    expect(poolStats(pool)).toEqual({ max: 7, total: 0, idle: 0, waiting: 0 });
    const db = createDb(pool);
    const app = await buildApp({ env: readEnv({ MOVERA_ENV: "development" }), logger: false, db });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    await app.close();
    await db.destroy();
    expect(res.json().dbPool).toEqual({ max: 7, total: 0, idle: 0, waiting: 0 });
    expect(res.body).not.toContain("secret");
  });
});
