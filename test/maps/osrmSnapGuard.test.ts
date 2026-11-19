import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { readEnv } from "../../src/env.js";
import { OSRM_MAX_SNAP_METERS_DEFAULT } from "../../src/maps/osrmSettings.js";
import { EstimateRouter, type LatLng, OsrmRouter } from "../../src/maps/routing.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Route guard (Rules audits/routing-kit/PROOF.md, "point outside the map"): OSRM answers code "Ok" even when an asked
 * point lies outside its map. It moves the point to the nearest road it knows and answers a route that is far too
 * short, and a price was worked out from it. OSRM says how far it moved each point (`waypoints[].distance`, metres;
 * `waypoints[].location`). A point moved further than the limit makes the answer unusable: the straight-line estimate
 * is used, exactly as when OSRM cannot route the points (4xx NoRoute), and the breaker treats the server as up.
 *
 * The fake OSRM is a stubbed global fetch; nothing leaves the test.
 */

const BASE = "http://osrm.test:5000";
const NORRMALM = { address: "Sergels torg", lat: 59.3326, lng: 18.0649 };
const SODERMALM = { address: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 };
/** Outside a Sweden-only map: Mariehamn (Åland). */
const MARIEHAMN = { address: "Torggatan, Mariehamn", lat: 60.0973, lng: 19.9348 };
/** No log line may hold any of the asked or snapped places. */
const COORDINATES = /59\.33|18\.06|59\.31|18\.07|60\.09|19\.93|59\.75|19\.05/;

type Waypoint = { distance?: unknown; location?: unknown; name?: string };
type Mode = { waypoints?: (asked: LatLng[]) => Waypoint[] | undefined; down?: boolean };
let mode: Mode = {};
const urls: string[] = [];

/** 8 km and 18 minutes whatever the points (the pricing fixture's economy_plain route: 217.00 SEK). */
const fakeFetch = vi.fn(async (input: string | URL | Request) => {
  const url = String(input);
  if (!url.startsWith(BASE)) throw new Error("only the fake OSRM is reachable in this test");
  urls.push(url);
  if (mode.down) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const asked = url
    .split("/route/v1/driving/")[1]!
    .split("?")[0]!
    .split(";")
    .map((pair) => ({ lng: Number(pair.split(",")[0]), lat: Number(pair.split(",")[1]) }));
  const waypoints = mode.waypoints?.(asked);
  const body = { code: "Ok", routes: [{ distance: 8000, duration: 1080, geometry: { coordinates: asked.map((p) => [p.lng, p.lat]) } }], ...(waypoints ? { waypoints } : {}) };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

const near = (asked: LatLng[]): Waypoint[] => asked.map((p, i) => ({ distance: 4.2 + i * 30, location: [p.lng, p.lat], name: "x" }));
/** The last point (the drop-off) was moved `meters` to the map's edge. */
const lastMoved =
  (meters: number) =>
  (asked: LatLng[]): Waypoint[] =>
    asked.map((p, i) => (i === asked.length - 1 ? { distance: meters, location: [19.05, 59.75] } : { distance: 6, location: [p.lng, p.lat] }));

beforeEach(() => {
  vi.stubGlobal("fetch", fakeFetch);
  mode = {};
  urls.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OsrmRouter: an answer whose point was moved too far is not used", () => {
  const collect = () => {
    const lines: Array<{ level: string; data: Record<string, unknown>; message: string }> = [];
    const log = {
      warn: (data: Record<string, unknown>, message: string) => void lines.push({ level: "warn", data, message }),
      info: (data: Record<string, unknown>, message: string) => void lines.push({ level: "info", data, message }),
    };
    return { lines, log };
  };

  it("the default limit is 300 m", () => {
    expect(OSRM_MAX_SNAP_METERS_DEFAULT).toBe(300);
  });

  it("snapped far: the leg is exactly the straight-line estimate, with one log line that holds no coordinates", async () => {
    mode = { waypoints: lastMoved(104_000) };
    const { lines, log } = collect();
    const fallbacks: unknown[] = [];
    const router = new OsrmRouter(BASE, 2500, (error) => fallbacks.push(error), { failuresToOpen: 3, coolDownMs: 60_000, log });
    const leg = await router.route([NORRMALM, MARIEHAMN]);
    expect(leg).toEqual(await new EstimateRouter().route([NORRMALM, MARIEHAMN]));
    expect(leg.source).toBe("estimate");
    expect(leg.distanceMeters).toBeGreaterThan(100_000);
    // One line, and not the "OSRM unavailable" one as well.
    expect(lines).toHaveLength(1);
    expect(fallbacks).toHaveLength(0);
    expect(lines[0]).toMatchObject({ level: "warn", data: { osrmSnap: "too_far", movedMeters: 104_000, limitMeters: 300, point: 1, points: 2 } });
    expect(JSON.stringify(lines)).not.toMatch(COORDINATES);
  });

  it("snapped far without a logger: the fallback callback gets one error, and its text holds no coordinates", async () => {
    mode = { waypoints: lastMoved(104_000) };
    const fallbacks: unknown[] = [];
    const router = new OsrmRouter(BASE, 2500, (error) => fallbacks.push(error));
    expect((await router.route([NORRMALM, MARIEHAMN])).source).toBe("estimate");
    expect(fallbacks).toHaveLength(1);
    const error = fallbacks[0] as Error;
    expect(`${error.name} ${error.message} ${JSON.stringify(error)}`).not.toMatch(COORDINATES);
    expect(error.message).toMatch(/104000 m/);
  });

  it("snapped near: the road answer is used unchanged", async () => {
    mode = { waypoints: near };
    const { lines, log } = collect();
    const router = new OsrmRouter(BASE, 2500, () => undefined, { log });
    const leg = await router.route([NORRMALM, SODERMALM]);
    expect(leg).toEqual({ distanceMeters: 8000, durationSeconds: 1080, source: "osrm", points: [{ lat: NORRMALM.lat, lng: NORRMALM.lng }, { lat: SODERMALM.lat, lng: SODERMALM.lng }] });
    expect(await router.route([NORRMALM, SODERMALM], { shape: false })).toEqual({ distanceMeters: 8000, durationSeconds: 1080, source: "osrm" });
    expect(lines).toHaveLength(0);
  });

  it("the limit itself is still a road answer; one metre more is not", async () => {
    const router = new OsrmRouter(BASE);
    mode = { waypoints: lastMoved(300) };
    expect((await router.route([NORRMALM, SODERMALM])).source).toBe("osrm");
    mode = { waypoints: lastMoved(301) };
    expect((await router.route([NORRMALM, SODERMALM])).source).toBe("estimate");
  });

  it("any point counts: the pickup or a stop in the middle", async () => {
    const router = new OsrmRouter(BASE);
    mode = { waypoints: (asked) => asked.map((p, i) => ({ distance: i === 0 ? 5000 : 3, location: [p.lng, p.lat] })) };
    expect((await router.route([MARIEHAMN, NORRMALM, SODERMALM])).source).toBe("estimate");
    mode = { waypoints: (asked) => asked.map((p, i) => ({ distance: i === 1 ? 5000 : 3, location: [p.lng, p.lat] })) };
    expect((await router.route([NORRMALM, MARIEHAMN, SODERMALM])).source).toBe("estimate");
  });

  it("no usable waypoints in the answer: behaviour unchanged (the road answer is used)", async () => {
    const router = new OsrmRouter(BASE);
    const shapes: Array<Mode["waypoints"]> = [
      undefined,
      () => [],
      () => [{}, {}],
      () => [{ distance: "104000" }, { distance: null }],
      () => [{ distance: Number.NaN }, { distance: -5 }],
      () => [{ location: ["a", "b"] }, { location: [18.07] }],
      () => "nonsense" as unknown as Waypoint[],
      () => [null as unknown as Waypoint, 7 as unknown as Waypoint],
    ];
    for (const waypoints of shapes) {
      mode = waypoints ? { waypoints } : {};
      expect(await router.route([NORRMALM, SODERMALM], { shape: false })).toEqual({ distanceMeters: 8000, durationSeconds: 1080, source: "osrm" });
    }
  });

  it("no distance in the answer but the snapped place: the move is measured from the asked point", async () => {
    const router = new OsrmRouter(BASE);
    // Moved to a place about 100 km away.
    mode = { waypoints: (asked) => asked.map((p, i) => (i === 1 ? { location: [19.05, 59.75] } : { location: [p.lng, p.lat] })) };
    expect((await router.route([NORRMALM, MARIEHAMN])).source).toBe("estimate");
    // Moved by about 11 m (0.0001 degrees of latitude).
    mode = { waypoints: (asked) => asked.map((p) => ({ location: [p.lng, p.lat + 0.0001] })) };
    expect((await router.route([NORRMALM, SODERMALM])).source).toBe("osrm");
  });

  it("a caller's own limit is respected", async () => {
    mode = { waypoints: lastMoved(900) };
    expect((await new OsrmRouter(BASE, 2500, () => undefined, undefined, 1000).route([NORRMALM, SODERMALM])).source).toBe("osrm");
    expect((await new OsrmRouter(BASE, 2500, () => undefined, undefined, 500).route([NORRMALM, SODERMALM])).source).toBe("estimate");
  });

  describe("breaker", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-19T10:00:00Z"));
    });

    it("moved-too-far answers never open it: the server is up, every ask still reaches it", async () => {
      mode = { waypoints: lastMoved(104_000) };
      const { lines, log } = collect();
      const router = new OsrmRouter(BASE, 2500, () => undefined, { failuresToOpen: 3, coolDownMs: 60_000, log });
      for (let i = 0; i < 20; i++) expect((await router.route([NORRMALM, MARIEHAMN])).source).toBe("estimate");
      expect(urls).toHaveLength(20);
      expect(router.state).toBe("closed");
      expect(lines.filter((l) => /circuit/.test(l.message))).toHaveLength(0);
      // A ride inside the map is still routed on the road right after them.
      mode = { waypoints: near };
      expect((await router.route([NORRMALM, SODERMALM])).source).toBe("osrm");
    });

    it("a moved-too-far answer counts as an answer: it ends a row of failures", async () => {
      const router = new OsrmRouter(BASE, 2500, () => undefined, { failuresToOpen: 3, coolDownMs: 60_000 });
      mode = { down: true };
      await router.route([NORRMALM, SODERMALM]);
      await router.route([NORRMALM, SODERMALM]);
      mode = { waypoints: lastMoved(104_000) };
      await router.route([NORRMALM, MARIEHAMN]);
      mode = { down: true };
      await router.route([NORRMALM, SODERMALM]);
      await router.route([NORRMALM, SODERMALM]);
      expect(router.state).toBe("closed");
      await router.route([NORRMALM, SODERMALM]);
      expect(router.state).toBe("open");
    });

    it("an open breaker's probe that is answered moved-too-far closes it (the server is back), and that ask is estimated", async () => {
      const { lines, log } = collect();
      const router = new OsrmRouter(BASE, 2500, () => undefined, { failuresToOpen: 2, coolDownMs: 60_000, log });
      mode = { down: true };
      await router.route([NORRMALM, SODERMALM]);
      await router.route([NORRMALM, SODERMALM]);
      expect(router.state).toBe("open");
      vi.setSystemTime(Date.now() + 60_000);
      mode = { waypoints: lastMoved(104_000) };
      expect((await router.route([NORRMALM, MARIEHAMN])).source).toBe("estimate");
      expect(router.state).toBe("closed");
      expect(lines.filter((l) => /circuit closed/.test(l.message))).toHaveLength(1);
      mode = { waypoints: near };
      expect((await router.route([NORRMALM, SODERMALM])).source).toBe("osrm");
    });

    it("while the breaker is open nothing is asked, so nothing is guarded: the estimate, as before", async () => {
      const router = new OsrmRouter(BASE, 2500, () => undefined, { failuresToOpen: 1, coolDownMs: 60_000 });
      mode = { down: true };
      await router.route([NORRMALM, SODERMALM]);
      const before = urls.length;
      mode = { waypoints: lastMoved(104_000) };
      expect((await router.route([NORRMALM, MARIEHAMN])).source).toBe("estimate");
      expect(urls).toHaveLength(before);
    });
  });
});

describe("the price (POST /quotes) and the map line (POST /routes) with a real OsrmRouter", () => {
  const SECRET = "route-guard-test-secret".padEnd(48, "g");
  const clock = { now: new Date("2026-11-19T10:00:00Z") };
  let database: TestDatabase;
  let withOsrm: FastifyInstance;
  let noOsrm: FastifyInstance;
  let rider: Record<string, string>;
  const logLines: string[] = [];
  let keys = 0;

  const quote = (server: FastifyInstance, payload: unknown) =>
    server.inject({ method: "POST", url: "/api/v1/quotes", headers: { ...rider, "content-type": "application/json", "idempotency-key": `guard-key-${String(++keys).padStart(8, "0")}` }, payload: payload as object });
  const totals = (body: { quotes: Array<{ categoryId: string; total: { amountMinor: number; currency: string } }> }) => body.quotes.map((q) => [q.categoryId, q.total.amountMinor, q.total.currency]);
  const storedSources = async (body: { quotes: Array<{ quoteId: string }> }) => {
    const rows = await database.db.selectFrom("quotes").select(["route_source", "distance_meters"]).where("quote_id", "in", body.quotes.map((q) => q.quoteId)).execute();
    return [...new Set(rows.map((r) => `${r.route_source}:${r.distance_meters}`))];
  };

  beforeAll(async () => {
    database = await freshDatabase();
    await seedTestPhones(database.db);
    const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
    await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 3, document: JSON.stringify(pricing), published_at: clock.now, published_by: null }).execute();
    const stream = new Writable({ write: (chunk, _enc, done) => (logLines.push(String(chunk)), done()) });
    const base = { MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET };
    // No `router` handed in: the app builds its own OsrmRouter from OSRM_URL, as on Render.
    withOsrm = await buildApp({ env: readEnv({ ...base, OSRM_URL: BASE }), logger: { stream }, db: database.db, clock: () => clock.now });
    noOsrm = await buildApp({ env: readEnv(base), logger: false, db: database.db, clock: () => clock.now });
    const challenge = await noOsrm.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone: TEST_PHONES[0]!, app: "rider" } });
    const verify = await noOsrm.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone: TEST_PHONES[0]!, sessionId: challenge.json().sessionId, code: TEST_CODE } });
    rider = { authorization: `Bearer ${verify.json().accessToken}` };
  });
  afterAll(async () => {
    await withOsrm.close();
    await noOsrm.close();
    await database.drop();
  });

  it("drop-off outside the map (moved 104 km): every price equals the estimate price, stored as an estimate; one log line, no coordinates", async () => {
    const ride = { pickup: NORRMALM, dropoff: MARIEHAMN, stops: [] };
    const estimate = await quote(noOsrm, ride);
    expect(estimate.statusCode).toBe(201);
    const estimateLeg = await new EstimateRouter().route([NORRMALM, MARIEHAMN]);
    expect(await storedSources(estimate.json())).toEqual([`estimate:${estimateLeg.distanceMeters}`]);

    mode = { waypoints: lastMoved(104_000) };
    logLines.length = 0;
    const guarded = await quote(withOsrm, ride);
    expect(guarded.statusCode).toBe(201);
    expect(urls).toHaveLength(1);
    // The too-short "Ok" route (8 km = 217.00 SEK economy) is not what the rider is shown.
    expect(totals(guarded.json())).toEqual(totals(estimate.json()));
    expect(guarded.json().quotes[0].total.amountMinor).toBeGreaterThan(21700);
    expect(await storedSources(guarded.json())).toEqual([`estimate:${estimateLeg.distanceMeters}`]);

    const log = logLines.join("");
    expect(log.match(/"osrmSnap":"too_far"/g)).toHaveLength(1);
    expect(log).toMatch(/"movedMeters":104000/);
    expect(log).not.toMatch(/OSRM unavailable/);
    expect(log).not.toMatch(COORDINATES);
  });

  it("both points on the map (moved a few metres): the road price, unchanged", async () => {
    mode = { waypoints: near };
    logLines.length = 0;
    const res = await quote(withOsrm, { pickup: NORRMALM, dropoff: SODERMALM, stops: [] });
    expect(res.statusCode).toBe(201);
    expect(res.json().quotes[0]).toMatchObject({ categoryId: "economy", total: { amountMinor: 21700, currency: "SEK" } });
    expect(await storedSources(res.json())).toEqual(["osrm:8000"]);
    expect(logLines.join("")).not.toMatch(/osrmSnap/);
  });

  it("an answer without waypoints: the road price, unchanged", async () => {
    mode = {};
    const res = await quote(withOsrm, { pickup: NORRMALM, dropoff: SODERMALM, stops: [] });
    expect(res.json().quotes[0]).toMatchObject({ categoryId: "economy", total: { amountMinor: 21700, currency: "SEK" } });
    expect(await storedSources(res.json())).toEqual(["osrm:8000"]);
  });

  it("the rider's map line: straight through the points and marked as an estimate when a point was moved too far", async () => {
    const ask = () => withOsrm.inject({ method: "POST", url: "/api/v1/routes", headers: { ...rider, "content-type": "application/json" }, payload: { mode: "driving", from: { lat: NORRMALM.lat, lng: NORRMALM.lng }, to: { lat: MARIEHAMN.lat, lng: MARIEHAMN.lng } } });
    mode = { waypoints: lastMoved(104_000) };
    const estimateLeg = await new EstimateRouter().route([NORRMALM, MARIEHAMN]);
    expect((await ask()).json()).toEqual({ provider: "estimate", distanceMeters: estimateLeg.distanceMeters, durationSeconds: estimateLeg.durationSeconds, points: [{ lat: NORRMALM.lat, lng: NORRMALM.lng }, { lat: MARIEHAMN.lat, lng: MARIEHAMN.lng }] });
    mode = { waypoints: near };
    expect((await ask()).json()).toMatchObject({ provider: "osrm", distanceMeters: 8000, durationSeconds: 1080 });
  });
});
