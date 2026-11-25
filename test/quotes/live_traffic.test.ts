import { TEST_CODE } from "../../src/auth/service.js";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { findCauses } from "../../src/alerts/detector.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { forgetLiveDocuments } from "../../src/config/service.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { readEnv } from "../../src/env.js";
import { setLiveTrafficConfigured } from "../../src/maps/googleRoutes.js";
import { liveTrafficDefault, liveTrafficOn, tripTimeRouter } from "../../src/maps/liveTraffic.js";
import type { LatLng, RouteLeg, Router } from "../../src/maps/routing.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

// v0.18.163 (contract.json#liveTraffic; owner 2026-11-25 "Google trafic réel"): quotes use the traffic router where the
// zone's setting is on (default SE, FR), store route_source google, answer tripSeconds; the alert while it falls back.
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-25T08:00:00Z") };
const SECRET = "live-traffic-test-secret".padEnd(48, "t");
const roads: Router = { route: async (_p: LatLng[]): Promise<RouteLeg> => ({ distanceMeters: 8000, durationSeconds: 780, source: "osrm" }) };
let googleUp = true;
const traffic: Router = { route: async (p: LatLng[]): Promise<RouteLeg> => (googleUp ? { distanceMeters: 8100, durationSeconds: 1560, source: "google" } : roads.route(p)) };
const NORRMALM = { address: "Sergels torg", lat: 59.3326, lng: 18.0649 };
const SODERMALM = { address: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 };

let keys = 0;
let rider: Record<string, string>;
const quote = (payload: unknown) =>
  app.inject({ method: "POST", url: "/api/v1/quotes", headers: { ...rider, "content-type": "application/json", "idempotency-key": `live-traffic-key-${String(++keys).padStart(8, "0")}` }, payload: payload as object });

async function setDispatch(document: Record<string, unknown> | null) {
  await database.db.deleteFrom("config_live").where("doc", "=", "dispatch").where("zone_id", "=", "Z001").execute();
  if (document !== null) await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(document), published_at: clock.now, published_by: null }).execute();
  forgetLiveDocuments();
}

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 3, document: JSON.stringify(pricing), published_at: clock.now, published_by: null }).execute();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, clock: () => clock.now, router: roads, traffic });
  const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone: TEST_PHONES[0]!, app: "rider" } });
  const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone: TEST_PHONES[0]!, sessionId: challenge.json().sessionId, code: TEST_CODE } });
  rider = { authorization: `Bearer ${verify.json().accessToken}` };
});
afterAll(async () => {
  setLiveTrafficConfigured(false);
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  googleUp = true;
  await database.db.deleteFrom("quotes").execute();
  await setDispatch(null);
});

describe("live traffic (v0.18.163)", () => {
  it("defaults: on for SE and FR, off elsewhere", async () => {
    expect([liveTrafficDefault("SE"), liveTrafficDefault("FR"), liveTrafficDefault("TN"), liveTrafficDefault(null)]).toEqual([true, true, false, false]);
    expect(await liveTrafficOn(database.db, "Z001")).toBe(true);
  });

  it("a Stockholm quote uses live traffic: tripSeconds, tripMeters, routeSource google, stored as google, priced per minute on it", async () => {
    const res = await quote({ pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] });
    expect(res.statusCode, res.body).toBe(201);
    const [q] = res.json().quotes;
    expect(q).toMatchObject({ tripSeconds: 1560, tripMeters: 8100, routeSource: "google" });
    const stored = await database.db.selectFrom("quotes").selectAll().where("quote_id", "=", q.quoteId).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ duration_seconds: 1560, distance_meters: 8100, route_source: "google" });
  });

  it("tripTimeRouter (quotes, the leave-on-time check, the route-change price): traffic when on, roads when off or none", async () => {
    expect(await tripTimeRouter(database.db, "Z001", { roads, traffic })).toBe(traffic);
    expect(await tripTimeRouter(database.db, "Z001", { roads })).toBe(roads);
    await setDispatch({ liveTraffic: { on: false } });
    expect(await tripTimeRouter(database.db, "Z001", { roads, traffic })).toBe(roads);
  });

  it("the zone's setting off: roads without traffic (OSRM)", async () => {
    await setDispatch({ liveTraffic: { on: false } });
    const [q] = (await quote({ pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes;
    expect(q).toMatchObject({ tripSeconds: 780, routeSource: "osrm" });
  });

  it("Google down: the quote falls back to OSRM, and the admin gets one system_health alert while it lasts", async () => {
    setLiveTrafficConfigured(true);
    googleUp = false;
    for (let k = 0; k < 2; k++) expect((await quote({ pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0].routeSource).toBe("osrm");
    expect((await findCauses(database.db, clock.now)).filter((c) => c.key.startsWith("system_health:live_traffic"))).toEqual([]);
    await quote({ pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] });
    const alerts = (await findCauses(database.db, clock.now)).filter((c) => c.key.startsWith("system_health:live_traffic"));
    expect(alerts.map((c) => c.key)).toEqual(["system_health:live_traffic:SE"]);
    googleUp = true;
    await quote({ pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] });
    expect((await findCauses(database.db, clock.now)).filter((c) => c.key.startsWith("system_health:live_traffic"))).toEqual([]);
  });
});
