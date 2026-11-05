import { TEST_CODE } from "../../src/auth/service.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import type { LatLng, RouteLeg, Router } from "../../src/maps/routing.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * A14 (contract v0.18.41 §66): POST /routes takes the trip's stops as `via` and routes [from, ...via, to] with the
 * same router as POST /quotes, so the drawn line goes through every stop. Stateless: the answer depends only on the
 * request (rule 33).
 */

const SODERTALJE = { lat: 59.1955, lng: 17.6252 };
const STOCKHOLM = { lat: 59.3293, lng: 18.0686 };
const ARLANDA = { lat: 59.6498, lng: 17.9238 };
const SECRET = "route-via-test-secret".padEnd(48, "v");

let database: TestDatabase;
let app: FastifyInstance;
let noRoad: FastifyInstance;
let rider: Record<string, string>;
const asked: LatLng[][] = [];

/** A road router that bends every leg through one extra point. */
const roadRouter: Router = {
  async route(points: LatLng[]): Promise<RouteLeg> {
    asked.push(points);
    const shape: LatLng[] = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      if (i === 1) shape.push(a);
      shape.push({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 + 0.01 }, b);
    }
    return { distanceMeters: 1000 * points.length, durationSeconds: 60 * points.length, source: "osrm", points: shape };
  },
};
/** OSRM down with no geometry at all. */
const noRoadRouter: Router = { route: async () => ({ distanceMeters: 5, durationSeconds: 5, source: "estimate" }) };

const post = (server: FastifyInstance, payload: unknown) =>
  server.inject({ method: "POST", url: "/api/v1/routes", headers: { ...rider, "content-type": "application/json" }, payload: payload as object });

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET });
  app = await buildApp({ env, logger: false, db: database.db, router: roadRouter });
  noRoad = await buildApp({ env, logger: false, db: database.db, router: noRoadRouter });
  const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone: TEST_PHONES[0]!, app: "rider" } });
  const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone: TEST_PHONES[0]!, sessionId: challenge.json().sessionId, code: TEST_CODE } });
  rider = { authorization: `Bearer ${verify.json().accessToken}` };
});
afterAll(async () => {
  await app.close();
  await noRoad.close();
  await database.drop();
});

describe("POST /routes via the stops (A14, §66)", () => {
  it("routes from → every stop → to with the quotes' router, one line through the stop", async () => {
    asked.length = 0;
    const res = await post(app, { mode: "driving", from: SODERTALJE, via: [STOCKHOLM], to: ARLANDA });
    expect(res.statusCode).toBe(200);
    expect(asked).toEqual([[SODERTALJE, STOCKHOLM, ARLANDA]]);
    const body = res.json() as { points: LatLng[]; distanceMeters: number; provider: string };
    expect(body.points.length).toBeGreaterThan(3);
    expect(body.points[0]).toEqual(SODERTALJE);
    expect(body.points.at(-1)).toEqual(ARLANDA);
    expect(body.points).toContainEqual(STOCKHOLM);
    expect(body).toMatchObject({ distanceMeters: 3000, provider: "osrm" });
  });

  it("without via it is the two-point request it always was", async () => {
    asked.length = 0;
    const res = await post(app, { mode: "driving", from: SODERTALJE, to: ARLANDA });
    expect(res.statusCode).toBe(200);
    expect(asked).toEqual([[SODERTALJE, ARLANDA]]);
  });

  it("no road: the straight line through every stop, never from → to", async () => {
    const res = await post(noRoad, { mode: "driving", from: SODERTALJE, via: [STOCKHOLM], to: ARLANDA });
    expect(res.statusCode).toBe(200);
    expect(res.json().points).toEqual([SODERTALJE, STOCKHOLM, ARLANDA]);
  });

  it("more than 10 stops or a bad stop is 400", async () => {
    const many = await post(app, { mode: "driving", from: SODERTALJE, via: Array.from({ length: 11 }, () => STOCKHOLM), to: ARLANDA });
    expect(many.statusCode).toBe(400);
    const bad = await post(app, { mode: "driving", from: SODERTALJE, via: [{ lat: 123, lng: 18 }], to: ARLANDA });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ reason: "invalid_coordinates" });
  });
});
