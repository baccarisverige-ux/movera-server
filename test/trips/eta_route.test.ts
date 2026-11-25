import { describe, expect, it } from "vitest";
import { alongRoute, decodePolyline, encodePolyline } from "../../src/maps/polyline.js";
import { followRoute, type EtaRoute } from "../../src/trips/etaRoute.js";

// v0.18.163 (contract.json#liveTraffic.calls / recall; owner 2026-11-25 "the cheapest method"): the ETA during the trip
// follows the stored Google route with no call; a new call only off the route for long enough, or far behind.
const S = { offRouteMeters: 200, offRouteSeconds: 30, behindMinutes: 5 };
// A straight 2 km road north from (59.30, 18.05): 0.018 deg of latitude ≈ 2,000 m.
const LINE = [{ lat: 59.3, lng: 18.05 }, { lat: 59.309, lng: 18.05 }, { lat: 59.318, lng: 18.05 }];
const at = new Date("2026-11-25T08:00:00Z");
const route: EtaRoute = { target: "dropoff", polyline: encodePolyline(LINE), meters: 2000, seconds: 400, at: at.toISOString(), offSince: null, calls: 1 };
const plus = (s: number) => new Date(at.getTime() + s * 1000);

describe("polyline", () => {
  it("encodes and decodes Google's format", () => {
    expect(encodePolyline([{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }])).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }]);
  });
  it("finds the remaining metres along the route and the distance off it", () => {
    const half = alongRoute(LINE, { lat: 59.309, lng: 18.05 });
    expect(half.offMeters).toBeLessThan(1);
    expect(Math.round(half.remainingMeters / 10)).toBe(100);
    expect(alongRoute(LINE, { lat: 59.309, lng: 18.056 }).offMeters).toBeGreaterThan(300);
  });
});

describe("followRoute", () => {
  it("on the route: remaining metres × the route's average speed, no call", () => {
    const r = followRoute(route, { lat: 59.309, lng: 18.05 }, plus(200), S);
    expect(r.recall).toBe(false);
    expect(Math.abs(r.remainingSeconds - 200)).toBeLessThanOrEqual(2);
  });
  it("off the route: no call for the first 30 s, then a call", () => {
    const off = { lat: 59.309, lng: 18.056 };
    const first = followRoute(route, off, plus(100), S);
    expect(first.recall).toBe(false);
    expect(first.route.offSince).toBe(plus(100).toISOString());
    expect(followRoute(first.route, off, plus(125), S).recall).toBe(false);
    expect(followRoute(first.route, off, plus(131), S).recall).toBe(true);
    expect(followRoute(first.route, { lat: 59.309, lng: 18.05 }, plus(140), S).route.offSince).toBeNull();
  });
  it("more than 5 minutes behind the planned arrival: a call", () => {
    // Still at the start 6 min after the route was taken: arrival 08:12:40 vs planned 08:06:40.
    expect(followRoute(route, LINE[0]!, plus(360), S).recall).toBe(true);
    expect(followRoute(route, LINE[0]!, plus(240), S).recall).toBe(false);
  });
});

describe("followRoute near the end (review #328 F3)", () => {
  it("a 0 m route or the last 50 m never asks Google again", () => {
    const zero: EtaRoute = { ...route, meters: 0, seconds: 0 };
    expect(followRoute(zero, LINE[2]!, plus(600), S).recall).toBe(false);
    expect(followRoute(route, { lat: 59.3178, lng: 18.05 }, plus(3600), S).recall).toBe(false);
  });
});
