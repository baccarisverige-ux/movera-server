import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findCauses } from "../../src/alerts/detector.js";
import { buildApp } from "../../src/app.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { readEnv } from "../../src/env.js";
import { dbDailyGuard } from "../../src/maps/googleBudget.js";
import { GoogleRoutesRouter, setLiveTrafficConfigured } from "../../src/maps/googleRoutes.js";
import { EstimateRouter } from "../../src/maps/routing.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * v0.18.171 (contract.json#googleRoadLines.quotaExceeded): Google's quota answer (HTTP 429 or RESOURCE_EXHAUSTED) is
 * logged as google_routes.quota_exceeded and falls back. On quotes, 3 such quotes in 10 min raise the existing
 * system_health:live_traffic:SE (the real path through the quotes table); on a road line it is a log line only.
 */
const KEY = "AIza-test-key-never-logged";
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-27T20:00:00Z") };
const logs: Array<{ data: Record<string, unknown>; message: string }> = [];
const log = { warn: (data: Record<string, unknown>, message: string) => logs.push({ data, message }), info: (data: Record<string, unknown>, message: string) => logs.push({ data, message }) };
let answer: () => Response = () => new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
const fakeFetch = (async () => answer()) as unknown as typeof fetch;
let router: GoogleRoutesRouter;
let rider: Record<string, string>;
const NORRMALM = { address: "Sergels torg", lat: 59.3326, lng: 18.0649 };
const SODERMALM = { address: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 };

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 1, document: JSON.stringify(pricing), published_at: clock.now, published_by: null }).execute();
  router = new GoogleRoutesRouter(KEY, new EstimateRouter(), { fetch: fakeFetch, log, failuresToOpen: 0, now: () => clock.now.getTime(), daily: dbDailyGuard(database.db, () => clock.now) });
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "quota-test-secret".padEnd(48, "q") }), logger: false, db: database.db, clock: () => clock.now, router: new EstimateRouter(), traffic: router });
  const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone: TEST_PHONES[0]!, app: "rider" } });
  const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone: TEST_PHONES[0]!, sessionId: challenge.json().sessionId, code: TEST_CODE } });
  rider = { authorization: `Bearer ${verify.json().accessToken}` };
});
afterAll(async () => {
  setLiveTrafficConfigured(false);
  await app.close();
  await database.drop();
});

let keys = 0;
const quote = () =>
  app.inject({ method: "POST", url: "/api/v1/quotes", headers: { ...rider, "content-type": "application/json", "idempotency-key": `quota-key-${String(++keys).padStart(10, "0")}` }, payload: { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] } });

describe("Google quota exceeded (v0.18.171)", () => {
  it("a 429 on quotes: the quotes fall back to the estimate, and 3 in 10 min raise system_health:live_traffic:SE", async () => {
    setLiveTrafficConfigured(true);
    for (let k = 0; k < 3; k++) {
      const res = await quote();
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().quotes[0].routeSource).toBe("estimate");
    }
    expect(logs.filter((l) => l.message === "google_routes.quota_exceeded")).toHaveLength(3);
    expect(JSON.stringify(logs)).not.toContain(KEY);
    const keysNow = (await findCauses(database.db, clock.now)).map((c) => c.key);
    expect(keysNow).toContain("system_health:live_traffic:SE");
  });

  it("a road-line RESOURCE_EXHAUSTED (any status) gives a log line only", async () => {
    logs.length = 0;
    answer = () => new Response(JSON.stringify({ error: { code: 403, status: "RESOURCE_EXHAUSTED" } }), { status: 403 });
    const leg = await router.route([NORRMALM, SODERMALM], { budget: { kind: "road_line", stage: "pickup", country: "SE" } });
    expect(leg.source).toBe("estimate");
    const quota = logs.filter((l) => l.message === "google_routes.quota_exceeded");
    expect(quota).toHaveLength(1);
    expect(quota[0]!.data).toEqual({ googleRoutes: "quota_exceeded", status: 403 });
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect((await findCauses(database.db, clock.now)).filter((c) => c.key.startsWith("system_health:google_routes_budget"))).toEqual([]);
  });
});
