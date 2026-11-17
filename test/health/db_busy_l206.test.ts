import { describe, expect, it } from "vitest";
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type DatabaseConnection, type Driver } from "kysely";
import { buildApp, databaseState } from "../../src/app.js";
import { createDb, createHealthPool, type Db } from "../../src/db/db.js";
import { readEnv } from "../../src/env.js";

/**
 * L20-6 (Rules audits/load/load-20k-2026-11-16.md): /healthz and /readyz said "database unavailable" when the database
 * was only busy (slow answer / no free connection). Now: busy is "busy" (/readyz stays 200, the copy stays in service),
 * down is "unavailable" (/readyz 503).
 */
const env = readEnv({ MOVERA_ENV: "development" });

/** A database whose every statement waits `waitMs` and then fails with `error`, or never answers. */
function fakeDb(behave: { waitMs?: number; error?: unknown }): Db {
  const connection: DatabaseConnection = {
    executeQuery: () =>
      new Promise((_, reject) => {
        if (behave.waitMs !== undefined) setTimeout(() => reject(behave.error), behave.waitMs);
      }),
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error("no streaming");
    },
  };
  const driver: Driver = { init: async () => undefined, acquireConnection: async () => connection, beginTransaction: async () => undefined, commitTransaction: async () => undefined, rollbackTransaction: async () => undefined, releaseConnection: async () => undefined, destroy: async () => undefined };
  return new Kysely({ dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => driver, createIntrospector: (db) => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler() } }) as unknown as Db;
}

describe("L20-6: database busy is not database down", () => {
  it("databaseState: slow → busy, statement cancelled / too many clients → busy, refused → unavailable", async () => {
    expect(await databaseState(fakeDb({}), 50)).toBe("busy");
    expect(await databaseState(fakeDb({ waitMs: 1, error: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }) }), 500)).toBe("busy");
    expect(await databaseState(fakeDb({ waitMs: 1, error: Object.assign(new Error("sorry, too many clients already"), { code: "53300" }) }), 500)).toBe("busy");
    expect(await databaseState(fakeDb({ waitMs: 1, error: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }), 500)).toBe("unavailable");
  });

  it("/healthz says busy and /readyz stays 200 (database busy) while the database is slow", async () => {
    const app = await buildApp({ env, logger: false, healthDb: fakeDb({}) });
    try {
      const health = await app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ database: "busy" });
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({ status: "ready", database: "busy" });
    } finally {
      await app.close();
    }
  }, 10_000);

  it("a database that is down: /healthz unavailable, /readyz 503", async () => {
    const dead = createDb(createHealthPool("postgres://movera:movera@127.0.0.1:1/movera"));
    const app = await buildApp({ env, logger: false, healthDb: dead });
    try {
      expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toMatchObject({ database: "unavailable" });
      const ready = await app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ reason: "database_unavailable" });
    } finally {
      await app.close();
      await dead.destroy();
    }
  });
});
