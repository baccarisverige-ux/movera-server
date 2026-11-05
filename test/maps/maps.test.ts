import { TEST_CODE } from "../../src/auth/service.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { CachedPlaces, GooglePlaces, type Places } from "../../src/maps/places.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

let database: TestDatabase;
let app: FastifyInstance;
let noKey: FastifyInstance;
const calls: Array<{ kind: string; input: unknown }> = [];
const fakePlaces: Places = {
  autocomplete: async (input) => (calls.push({ kind: "a", input }), [{ title: "Arlanda", subtitle: "Stockholm-Arlanda flygplats", placeId: "p-arn" }]),
  geocode: async (input) => (calls.push({ kind: "g", input }), input.query === "nowhere" ? {} : { address: "Sergels torg, Stockholm", latitude: 59.3326, longitude: 18.0649 }),
  reverse: async (input) => (calls.push({ kind: "r", input }), "Drottninggatan 1, Stockholm"),
};
const SECRET = "maps-test-secret".padEnd(48, "m");
let rider: Record<string, string>;
let driver: Record<string, string>;

async function signIn(server: FastifyInstance, phone: string, appName: "rider" | "driver") {
  const challenge = await server.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone, app: appName } });
  const verify = await server.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone, sessionId: challenge.json().sessionId, code: TEST_CODE } });
  return { authorization: `Bearer ${verify.json().accessToken}` };
}
const post = (server: FastifyInstance, url: string, headers: Record<string, string>, payload: unknown) =>
  server.inject({ method: "POST", url: `/api/v1${url}`, headers: { ...headers, "content-type": "application/json" }, payload: payload as object });

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET });
  app = await buildApp({ env, logger: false, db: database.db, places: fakePlaces });
  noKey = await buildApp({ env, logger: false, db: database.db });
  rider = await signIn(app, TEST_PHONES[0]!, "rider");
  driver = await signIn(app, TEST_PHONES[1]!, "driver");
});
afterAll(async () => {
  await app.close();
  await noKey.close();
  await database.drop();
});

describe("address search (read-only: no Idempotency-Key)", () => {
  it("autocomplete in the rider app's shape, biased by the point, one provider session until a pick", async () => {
    const res = await post(app, "/locations/autocomplete", rider, { query: " arl ", latitude: 59.33, longitude: 18.06, limit: 8 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ suggestions: [{ title: "Arlanda", subtitle: "Stockholm-Arlanda flygplats", placeId: "p-arn" }] });
    await post(app, "/locations/autocomplete", rider, { query: "arla" });
    const [a, b] = calls.filter((c) => c.kind === "a").map((c) => c.input as { session: string; bias?: unknown; query: string });
    expect(a).toMatchObject({ query: "arl", bias: { lat: 59.33, lng: 18.06 }, limit: 8 });
    expect(b!.session).toBe(a!.session);
    await post(app, "/locations/geocode", rider, { query: "Arlanda", placeId: "p-arn" });
    await post(app, "/locations/autocomplete", rider, { query: "sergel" });
    const third = calls.filter((c) => c.kind === "a").at(-1)!.input as { session: string };
    expect(third.session).not.toBe(a!.session);
  });

  it("FR zone autocomplete language fr; SE zone sv (v0.18.32 L20, the zone's language)", async () => {
    await post(app, "/locations/autocomplete", rider, { query: "rue de", latitude: 48.8656, longitude: 2.3212 });
    expect((calls.filter((c) => c.kind === "a").at(-1)!.input as { language: string }).language).toBe("fr");
    await post(app, "/locations/autocomplete", rider, { query: "sergel", latitude: 59.33, longitude: 18.06 });
    expect((calls.filter((c) => c.kind === "a").at(-1)!.input as { language: string }).language).toBe("sv");
  });

  it("autocomplete asks for the countries with an open zone", async () => {
    await post(app, "/locations/autocomplete", rider, { query: "rue de", latitude: 48.86, longitude: 2.35 });
    expect((calls.filter((c) => c.kind === "a").at(-1)!.input as { regions: string[] }).regions.sort()).toEqual(["fr", "se"]);
  });

  it("geocode: a match has coordinates; no match is 200 with none", async () => {
    expect((await post(app, "/locations/geocode", rider, { query: "Sergels torg" })).json()).toEqual({ address: "Sergels torg, Stockholm", latitude: 59.3326, longitude: 18.0649 });
    const none = await post(app, "/locations/geocode", rider, { query: "nowhere" });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({});
  });

  it("reverse geocode for riders and drivers, in the asked language; bad coordinates are 400 invalid_coordinates", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/locations/reverse-geocode", headers: { ...driver, "content-type": "application/json", "accept-language": "en-GB,en;q=0.9" }, payload: { latitude: 59.33, longitude: 18.06 } });
    expect(res.json()).toEqual({ address: "Drottninggatan 1, Stockholm", latitude: 59.33, longitude: 18.06 });
    expect((calls.filter((c) => c.kind === "r").at(-1)!.input as { language: string }).language).toBe("en");
    const bad = await post(app, "/locations/reverse-geocode", rider, { latitude: 123, longitude: 18 });
    expect(bad.json()).toMatchObject({ code: "invalid_request", reason: "invalid_coordinates" });
  });

  it("drivers search any address too (owner decision G3-D3); without a token it is 401", async () => {
    const ac = await post(app, "/locations/autocomplete", driver, { query: "arl" });
    expect(ac.statusCode).toBe(200);
    expect(ac.json()).toEqual({ suggestions: [{ title: "Arlanda", subtitle: "Stockholm-Arlanda flygplats", placeId: "p-arn" }] });
    const geo = await post(app, "/locations/geocode", driver, { query: "Sergels torg" });
    expect(geo.statusCode).toBe(200);
    expect(geo.json()).toEqual({ address: "Sergels torg, Stockholm", latitude: 59.3326, longitude: 18.0649 });
    const rev = await post(app, "/locations/reverse-geocode", driver, { latitude: 59.33, longitude: 18.06 });
    expect(rev.statusCode).toBe(200);
    for (const [path, payload] of [["autocomplete", { query: "arl" }], ["geocode", { query: "Sergels torg" }], ["reverse-geocode", { latitude: 59.33, longitude: 18.06 }]] as const) {
      const anon = await app.inject({ method: "POST", url: `/api/v1/locations/${path}`, headers: { "content-type": "application/json" }, payload });
      expect(anon.statusCode).toBe(401);
    }
  });

  it("without a Google key the server says 503 maps_unavailable", async () => {
    const res = await post(noKey, "/locations/autocomplete", rider, { query: "arl" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "unavailable", reason: "maps_unavailable", retryable: true });
  });
});

describe("routes", () => {
  it("POST /routes gives points, distance and duration (estimated until OSRM runs)", async () => {
    const res = await post(app, "/routes", rider, { mode: "driving", from: { lat: 59.3326, lng: 18.0649 }, to: { lat: 59.3143, lng: 18.0735 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ points: [{ lat: 59.3326, lng: 18.0649 }, { lat: 59.3143, lng: 18.0735 }], provider: "estimate", distanceMeters: expect.any(Number), durationSeconds: expect.any(Number) });
  });

  it("driver navigation needs OSRM (503 routing_unavailable now) and valid points", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/routes/driving/18.0649,59.3326;18.0735,59.3143?overview=full&geometries=geojson&steps=true", headers: driver });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ reason: "routing_unavailable" });
    const bad = await app.inject({ method: "GET", url: "/api/v1/routes/driving/18.06,59.33", headers: driver });
    expect(bad.json()).toMatchObject({ reason: "invalid_coordinates" });
    const asRider = await app.inject({ method: "GET", url: "/api/v1/routes/driving/18.0649,59.3326;18.0735,59.3143", headers: rider });
    expect(asRider.json()).toMatchObject({ reason: "wrong_actor" });
  });
});

describe("Google client", () => {
  it("maps Places (New) autocomplete and the Geocoding API to the contract's shapes", async () => {
    const seen: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      const text = String(url);
      seen.push(text);
      if (text.includes("places:autocomplete")) {
        return new Response(JSON.stringify({ suggestions: [{ placePrediction: { placeId: "ChIJ1", structuredFormat: { mainText: { text: "Sergels torg" }, secondaryText: { text: "Stockholm" } } } }] }));
      }
      if (text.includes("latlng=")) return new Response(JSON.stringify({ status: "OK", results: [{ formatted_address: "Sergels torg 1, Stockholm" }] }));
      if (text.includes("address=nowhere")) return new Response(JSON.stringify({ status: "ZERO_RESULTS", results: [] }));
      return new Response(JSON.stringify({ status: "OK", results: [{ formatted_address: "Sergels torg, 111 57 Stockholm", place_id: "ChIJ1", geometry: { location: { lat: 59.3326, lng: 18.0649 } } }] }));
    }) as typeof fetch;
    const google = new CachedPlaces(new GooglePlaces("test-key-123456", "se", fetcher));
    expect(await google.autocomplete({ query: "serg", limit: 8, language: "sv", session: "s1" })).toEqual([{ title: "Sergels torg", subtitle: "Stockholm", placeId: "ChIJ1" }]);
    expect(await google.geocode({ query: "", placeId: "ChIJ1", language: "sv" })).toEqual({ address: "Sergels torg, 111 57 Stockholm", latitude: 59.3326, longitude: 18.0649, placeId: "ChIJ1" });
    expect(await google.geocode({ query: "nowhere", language: "sv" })).toEqual({});
    expect(await google.reverse({ lat: 59.3326, lng: 18.0649, language: "sv" })).toBe("Sergels torg 1, Stockholm");
    await google.autocomplete({ query: "SERG", limit: 8, language: "sv", session: "s2" });
    expect(seen.filter((u) => u.includes("places:autocomplete"))).toHaveLength(1);
  });
});
