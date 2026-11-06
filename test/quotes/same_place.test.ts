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

/**
 * Same-address fix (contract v0.18.42 §67, contract.json#sameAddress). Proven case (Rules plan/FIX-PLAN-RERUN-2026-11-05.md
 * "Proof: same-address booking"): the rider stood at 59.360000,18.000000 and "Solna Centrum" resolved to 59.3596729,18.0005394,
 * 46 m away; the server priced it at the minimum fare and booked it. /quotes and /trips must refuse it (dropoff_too_close).
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-24T10:00:00Z") };
const SECRET = "same-place-test-secret".padEnd(48, "s");
const router: Router = { route: async (_points: LatLng[]) => ({ distanceMeters: 300, durationSeconds: 180, source: "osrm" }) };
const PROBE = { address: "Solnavägen 13, 171 45 Solna, Sverige", lat: 59.36, lng: 18.0 };
const SOLNA_CENTRUM = { address: "Solna Centrum, Solnavägen, Solna, Sverige", lat: 59.3596729, lng: 18.0005394 }; // 48 m from PROBE (haversine; the proof wrote about 46 m)
const NEAR_400M = { address: "Solna 400 m", lat: 59.3636, lng: 18.0 }; // about 400 m north
const SODERMALM = { address: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 };
let pricing: Record<string, unknown>;

let keys = 0;
let rider: Record<string, string>;
const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: { ...rider, "content-type": "application/json", "idempotency-key": `same-place-${String(++keys).padStart(8, "0")}` }, payload: payload as object });
const setMinTrip = (value: number | undefined) =>
  database.db
    .updateTable("config_live")
    .set({ document: JSON.stringify(value === undefined ? pricing : { ...pricing, minTripMeters: value }) })
    .where("doc", "=", "pricing")
    .where("zone_id", "=", "Z001")
    .execute();

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
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

describe("POST /quotes refuses a drop-off too close to the pickup when the zone sets minTripMeters (default off, owner Q9)", () => {
  it("default (no minTripMeters): the 48 m case is priced (owner Q9: warn but can book)", async () => {
    await setMinTrip(undefined);
    expect((await post("/quotes", { pickup: PROBE, dropoff: SOLNA_CENTRUM, stops: [] })).statusCode).toBe(201);
  });
  it("the proven 48 m case is refused with dropoff_too_close when the zone sets 300 m", async () => {
    await setMinTrip(300);
    const res = await post("/quotes", { pickup: PROBE, dropoff: SOLNA_CENTRUM, stops: [] });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_request", reason: "dropoff_too_close", details: ["meters=48", "limitMeters=300"] });
  });
  it("a real short ride (400 m) and a normal ride are priced", async () => {
    expect((await post("/quotes", { pickup: PROBE, dropoff: NEAR_400M, stops: [] })).statusCode).toBe(201);
    expect((await post("/quotes", { pickup: PROBE, dropoff: SODERMALM, stops: [] })).statusCode).toBe(201);
  });
  it("a trip with a stop is not checked (round trip through a stop)", async () => {
    expect((await post("/quotes", { pickup: PROBE, dropoff: SOLNA_CENTRUM, stops: [SODERMALM] })).statusCode).toBe(201);
    await setMinTrip(undefined);
  });
  it("the zone's pricing setting decides: 0 = off, 500 refuses 400 m", async () => {
    await setMinTrip(0);
    expect((await post("/quotes", { pickup: PROBE, dropoff: SOLNA_CENTRUM, stops: [] })).statusCode).toBe(201);
    await setMinTrip(500);
    const res = await post("/quotes", { pickup: PROBE, dropoff: NEAR_400M, stops: [] });
    expect(res.json()).toMatchObject({ reason: "dropoff_too_close", details: [expect.stringMatching(/^meters=\d+$/), "limitMeters=500"] });
    await setMinTrip(undefined);
  });
});

describe("POST /trips re-checks with the zone's live value", () => {
  it("a quote made while the setting was off is refused once the admin turns it on", async () => {
    await setMinTrip(0);
    const quote = (await post("/quotes", { pickup: PROBE, dropoff: SOLNA_CENTRUM, stops: [] })).json().quotes[0];
    await setMinTrip(300);
    const trip = await post("/trips", { quoteId: quote.quoteId, categoryId: quote.categoryId, pickup: PROBE, dropoff: SOLNA_CENTRUM, stops: [], kind: "live", paymentMethod: "cash" });
    expect(trip.statusCode, trip.body).toBe(400);
    expect(trip.json()).toMatchObject({ reason: "dropoff_too_close" });
    await setMinTrip(undefined);
  });
});
