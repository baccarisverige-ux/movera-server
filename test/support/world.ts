import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import type { Db } from "../../src/db/db.js";
import { readEnv } from "../../src/env.js";
import type { LatLng, Router } from "../../src/maps/routing.js";

/** A test server with Z001 prices published, a fixed 8 km / 18 min route and a controllable clock. */
export const NORRMALM = { address: "Sergels torg", lat: 59.3326, lng: 18.0649 };
export const SODERMALM = { address: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 };

export const fixedRouter: Router = { route: async (_points: LatLng[]) => ({ distanceMeters: 8000, durationSeconds: 1080, source: "osrm" }) };

export async function testWorld(db: Db, url: string, clock: { now: Date }) {
  await seedTestPhones(db);
  const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
  await db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 1, document: JSON.stringify(pricing), published_at: clock.now, published_by: null }).execute();
  const app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: url, JWT_SECRET: "world-test-secret".padEnd(48, "w") }), logger: false, db, clock: () => clock.now, router: fixedRouter });
  return app;
}

let keys = 0;
export const newKey = () => `world-key-${String(++keys).padStart(10, "0")}`;

export async function signIn(app: FastifyInstance, phone: string, appName: "rider" | "driver") {
  const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone, app: appName } });
  const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone, sessionId: challenge.json().sessionId, code: "1234" } });
  const body = verify.json();
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
