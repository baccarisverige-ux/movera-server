import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { readEnv } from "../../src/env.js";
import { EstimateRouter, haversineKm, type LatLng, type Router } from "../../src/maps/routing.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-24T10:00:00Z") };
const SECRET = "quote-test-secret".padEnd(48, "q");
// 8 km and 18 minutes whatever the points: the fixture's economy_plain route.
const fixedRouter: Router = { route: async (_points: LatLng[]) => ({ distanceMeters: 8000, durationSeconds: 1080, source: "osrm" }) };

const NORRMALM = { address: "Sergels torg", lat: 59.3326, lng: 18.0649 };
const SODERMALM = { address: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 };
const BROMMA = { lat: 59.32, lng: 17.95 };
const GOTHENBURG = { lat: 57.7089, lng: 11.9746 };

let keys = 0;
let rider: Record<string, string>;
const quote = (payload: unknown, headers: Record<string, string> = rider, key = `quote-key-${String(++keys).padStart(8, "0")}`) =>
  app.inject({ method: "POST", url: "/api/v1/quotes", headers: { ...headers, "content-type": "application/json", "idempotency-key": key }, payload: payload as object });

async function signIn(phone: string, appName: "rider" | "driver") {
  const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone, app: appName } });
  const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone, sessionId: challenge.json().sessionId, code: "1234" } });
  return { authorization: `Bearer ${verify.json().accessToken}` };
}

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 3, document: JSON.stringify(pricing), published_at: clock.now, published_by: null }).execute();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, clock: () => clock.now, router: fixedRouter });
  rider = await signIn(TEST_PHONES[0]!, "rider");
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("POST /quotes", () => {
  it("prices every enabled category of the pickup zone, valid 5 minutes, and stores each quote", async () => {
    const res = await quote({ pickup: NORRMALM, dropoff: SODERMALM, stops: [] });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ zoneId: "Z001", serverTime: clock.now.toISOString() });
    expect(body.quotes.map((q: { categoryId: string }) => q.categoryId)).toEqual(["economy", "comfort", "premium", "priority", "xl", "electric", "pet", "child_seat"]);
    const economy = body.quotes[0];
    // Same route as fixtures/fares.json economy_plain.
    expect(economy).toMatchObject({
      quoteId: expect.stringMatching(/^qte_/),
      total: { amountMinor: 21700, currency: "SEK" },
      expiresAt: new Date(clock.now.getTime() + 300_000).toISOString(),
      pickup: NORRMALM,
      dropoff: SODERMALM,
      stops: [],
      surgeMultiplier: 1,
    });
    expect(economy.fareLines.map((l: { code: string }) => l.code)).toEqual(["base", "distance", "time", "app_fee", "rounding"]);
    const stored = await database.db.selectFrom("quotes").selectAll().where("quote_id", "=", economy.quoteId).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ zone_id: "Z001", category_id: "economy", distance_meters: 8000, duration_seconds: 1080, route_source: "osrm", total_minor: "21700", driver_earnings_minor: "15760", pricing_version: 3 });
  });

  it("an extra stop adds its fee; a chosen category list is respected", async () => {
    const res = await quote({ pickup: NORRMALM, dropoff: SODERMALM, stops: [{ lat: 59.33, lng: 18.07 }], categoryIds: ["economy"] });
    const [only] = res.json().quotes;
    expect(res.json().quotes).toHaveLength(1);
    expect(only.fareLines.find((l: { code: string }) => l.code === "stops")).toEqual({ code: "stops", amount: { amountMinor: 1500, currency: "SEK" } });
    expect((await quote({ pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["rocket"] })).json()).toMatchObject({ reason: "category_not_offered" });
  });

  it("a pickup outside the open zones is 403 service_not_available", async () => {
    for (const pickup of [BROMMA, GOTHENBURG]) {
      const res = await quote({ pickup, dropoff: SODERMALM, stops: [] });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "forbidden", reason: "service_not_available" });
    }
  });

  it("an open zone without published prices is 503 pricing_not_published", async () => {
    const res = await quote({ pickup: SODERMALM, dropoff: NORRMALM, stops: [] });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "unavailable", reason: "pricing_not_published", retryable: true });
  });

  it("the request must follow the contract: stops are required", async () => {
    const res = await quote({ pickup: NORRMALM, dropoff: SODERMALM });
    expect(res.json()).toMatchObject({ code: "invalid_request", reason: "invalid_body" });
    const scheduled = await quote({ pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "scheduled" });
    expect(scheduled.json()).toMatchObject({ reason: "scheduled_at_missing" });
  });

  it("the same key gives the same quotes; only riders ask", async () => {
    const first = await quote({ pickup: NORRMALM, dropoff: SODERMALM, stops: [] }, rider, "same-quote-key-123456");
    const again = await quote({ pickup: NORRMALM, dropoff: SODERMALM, stops: [] }, rider, "same-quote-key-123456");
    expect(again.json()).toEqual(first.json());
    const driver = await signIn(TEST_PHONES[1]!, "driver");
    expect((await quote({ pickup: NORRMALM, dropoff: SODERMALM, stops: [] }, driver)).json()).toMatchObject({ reason: "wrong_actor" });
  });
});

describe("estimated routes (no OSRM yet)", () => {
  it("straight line × 1.25 at 24 km/h, as the admin panel's dispatch test", async () => {
    const leg = await new EstimateRouter().route([NORRMALM, SODERMALM]);
    const km = haversineKm(NORRMALM, SODERMALM) * 1.25;
    expect(leg).toMatchObject({ distanceMeters: Math.round(km * 1000), durationSeconds: Math.round((km / 24) * 3600), source: "estimate" });
  });
});
