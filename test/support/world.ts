import { TEST_CODE } from "../../src/auth/service.js";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import type { Translator } from "../../src/chat/translate.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import type { Db } from "../../src/db/db.js";
import { readEnv } from "../../src/env.js";
import type { LatLng, Router } from "../../src/maps/routing.js";

/** A test server with Z001 prices published, a fixed 8 km / 18 min route and a controllable clock. */
export const NORRMALM = { address: "Sergels torg", lat: 59.3326, lng: 18.0649 };
export const SODERMALM = { address: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 };

export const fixedRouter: Router = { route: async (_points: LatLng[]) => ({ distanceMeters: 8000, durationSeconds: 1080, source: "osrm" }) };

/** The test server's JWT secret (also the HMAC key of the rider's nearby cars, src/riders/nearby.ts). */
export const WORLD_JWT_SECRET = "world-test-secret".padEnd(48, "w");

export async function testWorld(db: Db, url: string, clock: { now: Date }, extra: { translator?: Translator } = {}) {
  await seedTestPhones(db);
  const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
  await db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 1, document: JSON.stringify(pricing), published_at: clock.now, published_by: null }).execute();
  // v0.18.145: the nearby cache off here (the exact path); test/riders/nearby.test.ts tests NearbyCache itself.
  const app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: url, JWT_SECRET: WORLD_JWT_SECRET, NEARBY_CACHE_MS: "0" }), logger: false, db, clock: () => clock.now, router: fixedRouter, ...extra });
  return app;
}

let keys = 0;
export const newKey = () => `world-key-${String(++keys).padStart(10, "0")}`;

/**
 * v0.18.14 (one phone at a time): signing a driver in again would be "another phone" (the first goes offline). The test
 * world plays the SAME phone: it refreshes the session it already has (as the app does), and signs in only the first
 * time or when that session is gone.
 */
const held = new Map<string, string>();
export async function signIn(app: FastifyInstance, phone: string, appName: "rider" | "driver") {
  const key = `${appName}:${phone}`;
  const refresh = appName === "driver" ? held.get(key) : undefined;
  if (refresh) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken: refresh } });
    if (res.statusCode === 200) {
      held.set(key, res.json().refreshToken);
      return { headers: { authorization: `Bearer ${res.json().accessToken}` } as Record<string, string>, token: res.json().accessToken as string };
    }
  }
  const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone, app: appName } });
  const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone, sessionId: challenge.json().sessionId, code: TEST_CODE } });
  const body = verify.json();
  if (appName === "driver" && body.refreshToken) held.set(key, body.refreshToken);
  return { headers: { authorization: `Bearer ${body.accessToken}` } as Record<string, string>, token: body.accessToken as string };
}

export function call(app: FastifyInstance, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown, key: string = newKey()) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...headers, ...(method === "GET" ? {} : { "content-type": "application/json", "idempotency-key": key }) },
    ...(payload === undefined ? (method === "GET" ? {} : { payload: {} }) : { payload: payload as object }),
  });
}
