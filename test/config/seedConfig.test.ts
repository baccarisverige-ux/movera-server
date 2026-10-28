import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { seedSampleConfig } from "../../src/config/seedConfig.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { NORRMALM, SODERMALM, call, fixedRouter, signIn } from "../support/world.js";

/** seed-test's starting settings: the contract's samples, published once as each country's standard (v0.8.0). */

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
  it("publishes every document once as the standard of each country with an open zone, and keeps what is there (v0.8.0)", async () => {
    const open = await database.db.selectFrom("zones").select(["zone_id", "country"]).where("open", "=", true).execute();
    const countries = [...new Set(open.map((z) => z.country))].sort();
    const first = await database.db.transaction().execute((trx) => seedSampleConfig(trx, now));
    expect(first).toHaveLength(countries.length * 4);
    for (const country of countries) {
      const docs = first.filter((p) => p.zoneId === `standard-${country}`).map((p) => p.doc).sort();
      expect(docs).toEqual(["dispatch", "driver_app_config", "pricing", "rider_app_config"]);
    }
    const live = await database.db.selectFrom("config_live").select(["zone_id", "document"]).execute();
    expect(live.every((row) => row.zone_id.startsWith("standard-"))).toBe(true);
    for (const row of live) expect((row.document as { zoneId: string }).zoneId).toBe(row.zone_id);
    expect(await database.db.transaction().execute((trx) => seedSampleConfig(trx, now))).toEqual([]);
  });

  it("prices Paris in euro, converted from the Swedish sample", async () => {
    const live = await database.db.selectFrom("config_live").select("document").where("doc", "=", "pricing").where("zone_id", "=", "standard-FR").executeTakeFirstOrThrow();
    const doc = live.document as { currency: string; country: string; timeZone: string; priceStep: { amountMinor: number; currency: string }; categories: Record<string, { base: { amountMinor: number; currency: string } }> };
    expect(doc).toMatchObject({ zoneId: "standard-FR", currency: "EUR", country: "FR", timeZone: "Europe/Paris" });
    // 29,00 kr × 0.09 = 2,61 € → whole 10 cents.
    expect(doc.categories["economy"]!.base).toEqual({ amountMinor: 260, currency: "EUR" });
    expect(doc.priceStep).toEqual({ amountMinor: 10, currency: "EUR" });
    const rider = (await signIn(app, "+46701740609", "rider")).headers;
    const quotes = await call(app, "POST", "/quotes", rider, { pickup: { address: "Place de la Concorde", lat: 48.8656, lng: 2.3212 }, dropoff: { address: "Gare de Lyon", lat: 48.8443, lng: 2.3744 }, stops: [], categoryIds: ["economy"] });
    expect(quotes.json()).toMatchObject({ zoneId: "FR-PC" });
    expect(quotes.json().quotes[0].total.currency).toBe("EUR");
    // All of Île-de-France is Paris (owner, 2026-10-26): the outer towns of the region are priced in euro too.
    for (const pickup of [
      { address: "Fontainebleau", lat: 48.4047, lng: 2.7016 },
      { address: "Provins", lat: 48.5597, lng: 3.2995 },
      { address: "Mantes-la-Jolie", lat: 48.9908, lng: 1.7167 },
      { address: "Rambouillet", lat: 48.6436, lng: 1.8296 },
      { address: "Disneyland Paris", lat: 48.8722, lng: 2.7758 },
    ]) {
      const res = await call(app, "POST", "/quotes", rider, { pickup, dropoff: { address: "Gare de Lyon", lat: 48.8443, lng: 2.3744 }, stops: [], categoryIds: ["economy"] });
      expect(res.statusCode, pickup.address).toBe(201);
      expect(res.json()).toMatchObject({ zoneId: "FR-PC" });
    }
    // Outside the region: still no service.
    const orleans = await call(app, "POST", "/quotes", rider, { pickup: { address: "Orléans", lat: 47.9029, lng: 1.9093 }, dropoff: { address: "Gare de Lyon", lat: 48.8443, lng: 2.3744 }, stops: [], categoryIds: ["economy"] });
    expect(orleans.statusCode).toBe(403);
    // The whole county is one zone now: Nacka, outside the old districts, is Stockholm.
    const nacka = await call(app, "POST", "/quotes", rider, { pickup: { address: "Nacka Forum", lat: 59.3072, lng: 18.164 }, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] });
    expect(nacka.json()).toMatchObject({ zoneId: "Z001" });
    // Inside a closed district box (Södertälje, Södermalm): still the open county zone, never "no service".
    for (const pickup of [{ address: "Genetaleden 9, Södertälje", lat: 59.1954, lng: 17.6252 }, SODERMALM, { address: "Nynäshamn", lat: 58.9034, lng: 17.9479 }, { address: "Norrtälje", lat: 59.758, lng: 18.705 }]) {
      const res = await call(app, "POST", "/quotes", rider, { pickup, dropoff: NORRMALM, stops: [], categoryIds: ["economy"] });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ zoneId: "Z001" });
    }
  });

  it("takes a driver offline after 10 missed Exclusive offers in a row (owner decision 36, contract v0.5.6)", async () => {
    const live = await database.db.selectFrom("config_live").select(["zone_id", "document"]).where("doc", "=", "driver_app_config").execute();
    expect(live.length).toBeGreaterThan(0);
    for (const row of live) {
      const doc = row.document as { offers: { autoOffline: { missedExclusive: number } } };
      expect(doc.offers.autoOffline.missedExclusive, row.zone_id).toBe(10);
    }
  });

  it("lets a rider get a price right away", async () => {
    const rider = (await signIn(app, "+46701740608", "rider")).headers;
    const quotes = await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] });
    expect(quotes.json()).toMatchObject({ quotes: expect.any(Array) });
    expect(quotes.json().quotes[0].total.currency).toBe("SEK");
  });
});
