import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { seedSampleConfig } from "../../src/config/seedConfig.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { NORRMALM, SODERMALM, call, fixedRouter, signIn } from "../support/world.js";

/** seed-test's starting settings: the contract's samples, published once in every open zone that has none. */

let database: TestDatabase;
let app: FastifyInstance;
const now = new Date("2026-10-26T08:00:00Z");

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "seed-config-test-secret".padEnd(48, "s") });
  app = await buildApp({ env, logger: false, db: database.db, clock: () => now, router: fixedRouter });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("sample settings", () => {
  it("publishes every document in every open zone once, and keeps what a zone already has", async () => {
    const open = (await database.db.selectFrom("zones").select("zone_id").where("open", "=", true).execute()).map((z) => z.zone_id);
    const first = await database.db.transaction().execute((trx) => seedSampleConfig(trx, now));
    expect(first).toHaveLength(open.length * 4);
    for (const zoneId of open) {
      const docs = first.filter((p) => p.zoneId === zoneId).map((p) => p.doc).sort();
      expect(docs).toEqual(["dispatch", "driver_app_config", "pricing", "rider_app_config"]);
    }
    const live = await database.db.selectFrom("config_live").select(["zone_id", "document"]).where("doc", "=", "pricing").execute();
    for (const row of live) expect((row.document as { zoneId: string }).zoneId).toBe(row.zone_id);
    expect(await database.db.transaction().execute((trx) => seedSampleConfig(trx, now))).toEqual([]);
  });

  it("lets a rider get a price right away", async () => {
    const rider = (await signIn(app, "+46701740608", "rider")).headers;
    const quotes = await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] });
    expect(quotes.json()).toMatchObject({ quotes: expect.any(Array) });
    expect(quotes.json().quotes[0].total.currency).toBe("SEK");
  });
});
