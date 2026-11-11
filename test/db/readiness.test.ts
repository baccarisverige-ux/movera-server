import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createDb, createPool } from "../../src/db/db.js";
import { readEnv } from "../../src/env.js";
import { IDEMPOTENCY_KEY_TTL_MS, SWEEP_IDEMPOTENCY_KEYS, ensureMaintenanceTimers, maintenanceHandlers } from "../../src/jobs/maintenance.js";
import { CLEANUP_IDEMPOTENCY_KEYS, HOUSEKEEPING_KINDS } from "../../src/jobs/housekeeping.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

const env = readEnv({ MOVERA_ENV: "development" });

describe("/readyz", () => {
  it("is ready when the database answers", async () => {
    const app = await buildApp({ env, logger: false, db: database.db });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", database: "ok" });
  });

  it("is 503 unavailable when it does not, so traffic goes elsewhere", async () => {
    const dead = createDb(createPool("postgres://movera:movera@127.0.0.1:1/movera", 1));
    const app = await buildApp({ env, logger: false, db: dead });
    const res = await app.inject({ method: "GET", url: "/readyz", headers: { "x-request-id": "ready-1" } });
    await app.close();
    await dead.destroy();
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.json()).toEqual({
      code: "unavailable",
      message: "The database is not reachable.",
      requestId: "ready-1",
      retryable: true,
      reason: "database_unavailable",
    });
  });
});

describe("environment", () => {
  it("staging and production refuse to start without a database or a token secret", () => {
    expect(() => readEnv({ MOVERA_ENV: "staging" })).toThrow(/DATABASE_URL: required when MOVERA_ENV is staging/);
    expect(() => readEnv({ MOVERA_ENV: "production" })).toThrow(/DATABASE_URL/);
    expect(() => readEnv({ MOVERA_ENV: "staging", DATABASE_URL: "postgres://a:b@db:5432/movera" })).toThrow(/JWT_SECRET: required when MOVERA_ENV is staging/);
    expect(() => readEnv({ MOVERA_ENV: "staging", DATABASE_URL: "postgres://a:b@db:5432/movera", JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
    expect(readEnv({ MOVERA_ENV: "staging", DATABASE_URL: "postgres://a:b@db:5432/movera", JWT_SECRET: "k".repeat(32) })).toMatchObject({
      MIGRATE_ON_START: true,
      DATABASE_POOL_MAX: 20,
      TRUST_PROXY_HOPS: 0,
    });
    expect(readEnv({ MOVERA_ENV: "development", MIGRATE_ON_START: "false" }).MIGRATE_ON_START).toBe(false);
    // A deploy that forgets MOVERA_ENV is production: no test sign-in, and a database and secret are required.
    expect(() => readEnv({ NODE_ENV: "production", DATABASE_URL: "postgres://a:b@db:5432/movera" })).toThrow(/JWT_SECRET: required when MOVERA_ENV is production/);
  });
});

describe("maintenance", () => {
  it("the hourly Idempotency-Key clean-up forgets day-old keys and books the next run (and the sweep its next)", async () => {
    const old = new Date(Date.now() - IDEMPOTENCY_KEY_TTL_MS - 60_000);
    const row = { actor: "rider", subject_id: "rdr_1", method: "POST", route: "/api/v1/x", body_sha256: "0".repeat(64), status_code: 200, response: null };
    await database.db.insertInto("idempotency_keys").values({ ...row, key: "old-key-0123456789", created_at: old }).execute();
    await database.db.insertInto("idempotency_keys").values({ ...row, key: "new-key-0123456789" }).execute();
    await ensureMaintenanceTimers(database.db);
    await ensureMaintenanceTimers(database.db);
    const worker = new TimerWorker(database.db, { handlers: maintenanceHandlers, logger: { warn: () => undefined, error: () => undefined } });
    // S4 0.14b: the sweep and each housekeeping job (its own timer) are due at start; the nightly one is not.
    // S4 0.14a: the payout timer (its own job since owner W1 Q69) too.
    expect(await worker.runDue()).toBe(2 + HOUSEKEEPING_KINDS.length);
    const keys = await database.db.selectFrom("idempotency_keys").select("key").execute();
    expect(keys.map((k) => k.key)).toEqual(["new-key-0123456789"]);
    const next = await database.db.selectFrom("timers").selectAll().where("kind", "in", [SWEEP_IDEMPOTENCY_KEYS, CLEANUP_IDEMPOTENCY_KEYS]).execute();
    expect(next).toHaveLength(2);
    for (const t of next) expect(t.due_at.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
  });
});
