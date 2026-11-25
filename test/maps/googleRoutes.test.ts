import { describe, expect, it, vi } from "vitest";
import { GOOGLE_ROUTES_FIELD_MASK, GOOGLE_ROUTES_URL, GoogleRoutesRouter, parseGoogleDuration } from "../../src/maps/googleRoutes.js";
import type { LatLng, Router } from "../../src/maps/routing.js";
import { encodePolyline } from "../../src/maps/polyline.js";

// v0.18.163 (contract.json#liveTraffic): Google Routes with live traffic, falling back to the estimate (owner: no OSRM).
const KEY = "test-google-key-0123456789";
const A: LatLng = { lat: 59.3326, lng: 18.0649 };
const B: LatLng = { lat: 59.3143, lng: 18.0735 };
const C: LatLng = { lat: 59.32, lng: 18.07 };
const osrm: Router = { route: vi.fn(async () => ({ distanceMeters: 4000, durationSeconds: 780, source: "estimate" as const })) };

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const LINE = encodePolyline([A, C, B]);
const ok = () => answer({ routes: [{ duration: "1560s", distanceMeters: 4210, polyline: { encodedPolyline: LINE } }] });
const logs = () => ({ warn: vi.fn(), info: vi.fn() });

describe("GoogleRoutesRouter", () => {
  it("asks computeRoutes TRAFFIC_AWARE, departure now, duration + distance only, and answers source google", async () => {
    const fetch = vi.fn(async () => ok());
    const now = Date.parse("2026-11-25T08:00:00Z");
    const router = new GoogleRoutesRouter(KEY, osrm, { fetch: fetch as unknown as typeof globalThis.fetch, now: () => now });
    const leg = await router.route([A, C, B]);
    expect(leg).toMatchObject({ distanceMeters: 4210, durationSeconds: 1560, source: "google", polyline: LINE });
    expect(leg.points).toHaveLength(3);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GOOGLE_ROUTES_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-goog-api-key": KEY, "x-goog-fieldmask": GOOGLE_ROUTES_FIELD_MASK });
    expect(GOOGLE_ROUTES_FIELD_MASK).toBe("routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE" });
    expect(body.departureTime).toBeUndefined();
    expect(body.origin.location.latLng).toEqual({ latitude: A.lat, longitude: A.lng });
    expect(body.destination.location.latLng).toEqual({ latitude: B.lat, longitude: B.lng });
    expect(body.intermediates).toHaveLength(1);
  });

  it.each([
    ["a 403 (Routes API not enabled)", async () => answer({ error: { status: "PERMISSION_DENIED" } }, 403), "status_403"],
    ["a 500", async () => answer({}, 500), "status_500"],
    ["no route", async () => answer({}), "no_route"],
    ["a network error", async () => { throw new TypeError("fetch failed"); }, "network"],
    ["a timeout", async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, "timeout"],
  ])("falls back to the estimate on %s, logs one line without the key", async (_name, impl, reason) => {
    const log = logs();
    const router = new GoogleRoutesRouter(KEY, osrm, { fetch: vi.fn(impl) as unknown as typeof globalThis.fetch, log });
    expect(await router.route([A, B])).toMatchObject({ source: "estimate", durationSeconds: 780 });
    expect(log.warn).toHaveBeenCalledWith({ googleRoutes: "fallback", reason }, expect.any(String));
    expect(JSON.stringify([log.warn.mock.calls, log.info.mock.calls])).not.toContain(KEY);
  });

  it("opens the breaker after the failures in a row, probes after the cool-down and closes on an answer", async () => {
    let t = 0;
    let down = true;
    const fetch = vi.fn(async () => (down ? answer({}, 503) : ok()));
    const log = logs();
    const router = new GoogleRoutesRouter(KEY, osrm, { fetch: fetch as unknown as typeof globalThis.fetch, failuresToOpen: 2, coolDownMs: 60_000, now: () => t, log, perMinute: 0 });
    await router.route([A, B]);
    await router.route([A, B]);
    expect(router.state).toBe("open");
    await router.route([A, B]);
    expect(fetch).toHaveBeenCalledTimes(2); // open: the estimate at once, Google not asked
    t = 61_000;
    down = false;
    expect(await router.route([A, B])).toMatchObject({ source: "google" });
    expect(router.state).toBe("closed");
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ googleRoutesBreaker: "closed" }), expect.any(String));
  });

  it("the per-copy cap sends the rest of the minute to the estimate, without a fallback log", async () => {
    let t = 0;
    const fetch = vi.fn(async () => ok());
    const log = logs();
    const router = new GoogleRoutesRouter(KEY, osrm, { fetch: fetch as unknown as typeof globalThis.fetch, perMinute: 2, now: () => t, log });
    expect((await router.route([A, B])).source).toBe("google");
    expect((await router.route([A, B])).source).toBe("google");
    expect((await router.route([A, B])).source).toBe("estimate");
    expect(log.warn).not.toHaveBeenCalled();
    t = 60_000;
    expect((await router.route([A, B])).source).toBe("google");
  });

  it("reads Google durations", () => {
    expect(parseGoogleDuration("1560s")).toBe(1560);
    expect(parseGoogleDuration("12.6s")).toBe(13);
    expect(parseGoogleDuration("PT5M")).toBeNull();
    expect(parseGoogleDuration(undefined)).toBeNull();
  });
});
