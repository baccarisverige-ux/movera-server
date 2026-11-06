import { TEST_CODE } from "../../src/auth/service.js";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { readEnv } from "../../src/env.js";
import type { LatLng, Router } from "../../src/maps/routing.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/** FIX JOB 7 (contract v0.18.30, contract.json#smallFixes): quote pickup time (Q8), pickup ≈ drop-off warning (Q9), ticket reasons. */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-24T10:00:00Z") };
const SECRET = "job7-test-secret".padEnd(48, "j");
const router: Router = { route: async (_points: LatLng[]) => ({ distanceMeters: 8000, durationSeconds: 1080, source: "osrm" }) };
const NORRMALM = { address: "Sergels torg", lat: 59.3326, lng: 18.0649 };
const NEXT_DOOR = { address: "Sergels torg 2", lat: 59.3329, lng: 18.065 }; // about 35 m away
const SODERMALM = { address: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 };

let keys = 0;
let rider: Record<string, string>;
const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: { ...rider, "content-type": "application/json", "idempotency-key": `job7-key-${String(++keys).padStart(8, "0")}` }, payload: payload as object });

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  // v0.18.42 §67: the Q9 warning cases (35 m) run with the zone's minTripMeters off (0); the 300 m default refuses them
  // (dropoff_too_close, test/quotes/same_place.test.ts). Owner to confirm the Q9 "warn but can book" vs 300 m refusal.
  const pricing = { ...JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8")), minTripMeters: 0 };
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 3, document: JSON.stringify(pricing), published_at: clock.now, published_by: null }).execute();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, clock: () => clock.now, router });
  const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone: TEST_PHONES[0]!, app: "rider" } });
  const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone: TEST_PHONES[0]!, sessionId: challenge.json().sessionId, code: TEST_CODE } });
  rider = { authorization: `Bearer ${verify.json().accessToken}` };
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("Quote.pickupAt (owner Q8: only for booked rides)", () => {
  it("a live quote has pickupAt null", async () => {
    const res = await post("/quotes", { pickup: NORRMALM, dropoff: SODERMALM, stops: [] });
    expect(res.statusCode).toBe(201);
    for (const q of res.json().quotes) expect(q.pickupAt).toBeNull();
  });
  it("a booked quote carries its pickup time", async () => {
    const at = "2026-10-25T08:30:00.000Z";
    const res = await post("/quotes", { pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "scheduled", scheduledAt: at });
    expect(res.statusCode).toBe(201);
    for (const q of res.json().quotes) expect(q.pickupAt).toBe(at);
  });
});

describe("pickup ≈ drop-off (owner Q9: warn but can book)", () => {
  it("warns at the default 100 m and still prices the ride, which can be booked", async () => {
    const res = await post("/quotes", { pickup: NORRMALM, dropoff: NEXT_DOOR, stops: [] });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.quotes.length).toBeGreaterThan(0);
    expect(body.warnings).toEqual([{ reason: "same_pickup_dropoff", meters: expect.any(Number), limitMeters: 100 }]);
    expect(body.warnings[0].meters).toBeLessThan(100);
    const q = body.quotes[0];
    const trip = await post("/trips", { quoteId: q.quoteId, categoryId: q.categoryId, pickup: NORRMALM, dropoff: NEXT_DOOR, stops: [], kind: "live", paymentMethod: "cash" });
    expect(trip.statusCode, trip.body).toBe(201);
  });
  it("no warning for a normal ride or with stops", async () => {
    expect((await post("/quotes", { pickup: NORRMALM, dropoff: SODERMALM, stops: [] })).json().warnings).toBeUndefined();
    expect((await post("/quotes", { pickup: NORRMALM, dropoff: NEXT_DOOR, stops: [SODERMALM] })).json().warnings).toBeUndefined();
  });
  it("the zone's admin setting decides (0 = never warn)", async () => {
    await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify({ booking: { samePointWarnMeters: 0 } }), published_at: clock.now, published_by: null }).execute();
    expect((await post("/quotes", { pickup: NORRMALM, dropoff: NEXT_DOOR, stops: [] })).json().warnings).toBeUndefined();
    await database.db.updateTable("config_live").set({ document: JSON.stringify({ booking: { samePointWarnMeters: 20 } }) }).where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
    expect((await post("/quotes", { pickup: NORRMALM, dropoff: NEXT_DOOR, stops: [] })).json().warnings).toBeUndefined();
    await database.db.updateTable("config_live").set({ document: JSON.stringify({ booking: { samePointWarnMeters: 500 } }) }).where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
    expect((await post("/quotes", { pickup: NORRMALM, dropoff: NEXT_DOOR, stops: [] })).json().warnings[0].limitMeters).toBe(500);
    await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
  });
});

describe("ticket reasons (L24)", () => {
  it("unknown ticket category → invalid_ticket_category", async () => {
    const res = await post("/support/tickets", { category: "no_such_topic", subject: "Hi", text: "Hello" });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe("invalid_ticket_category");
    const shape = await post("/support/tickets", { category: "Bad Topic", subject: "Hi", text: "Hello" });
    expect(shape.json().reason).toBe("invalid_ticket_category");
  });
  it("empty subject or text → invalid_ticket_body", async () => {
    expect((await post("/support/tickets", { category: "help", subject: "", text: "Hello" })).json().reason).toBe("invalid_ticket_body");
    expect((await post("/support/tickets", { category: "help", subject: "Hi", text: "x".repeat(5001) })).json().reason).toBe("invalid_ticket_body");
  });
  it("re-test: a code that is not 4 digits is invalid_otp_code", async () => {
    const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone: TEST_PHONES[1]!, app: "rider" } });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone: TEST_PHONES[1]!, sessionId: challenge.json().sessionId, code: "12a" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe("invalid_otp_code");
  });
});
