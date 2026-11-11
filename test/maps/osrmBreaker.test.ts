import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "../../src/env.js";
import { type LatLng, OsrmRouter, prepareLegs, preparedRouter } from "../../src/maps/routing.js";

/**
 * B1.3 (S4 wave B1, owner W1 Q67 2026-11-11: "Stop waiting for a hanging route server after a few failures, then never
 * store a straight line as the road"). The route server (OSRM) hangs while 20 trips are on board and the ride-check scan
 * asks each trip's road route on every scan (prepareLegs, as rideCheckScanHandler.prepare does).
 *
 * Proof: after N failures in a row the breaker opens; while it is open no call reaches OSRM and no call waits; after
 * the cool-down one probe goes out (so at most one router call per trip per cool-down); when OSRM answers again the
 * breaker closes and road routes come back; a straight-line estimate is never handed out as a road route (B1.2); one
 * log line per open and one per close.
 *
 * Fake clock (frame rule F26): the fake OSRM "hangs" by counting the whole timeout as waited and then failing the way a
 * timed-out fetch fails, so nothing really sleeps.
 */

const BASE = "http://osrm.test:5000";
const TIMEOUT_MS = 2500;
const FAILURES_TO_OPEN = 3;
const COOL_DOWN_MS = 60_000;
const SCAN_EVERY_MS = 20_000;

const trips: Array<{ id: string; points: LatLng[] }> = Array.from({ length: 20 }, (_, i) => ({
  id: `trip-${i}`,
  points: [
    { lat: 59.3 + i * 0.001, lng: 18.0 },
    { lat: 59.32 + i * 0.001, lng: 18.07 },
  ],
}));
const tripOfUrl = (url: string): string => {
  const trip = trips.find((t) => url.includes(`${t.points[0]!.lng.toFixed(6)},${t.points[0]!.lat.toFixed(6)}`));
  if (!trip) throw new Error(`unknown route ${url}`);
  return trip.id;
};

let osrmUp = false;
let waitedMs = 0;
const calls: Array<{ trip: string; at: number }> = [];

const fakeFetch = vi.fn(async (input: string | URL | Request) => {
  const url = String(input);
  calls.push({ trip: tripOfUrl(url), at: Date.now() });
  if (!osrmUp) {
    // Hanging: the caller waits the whole timeout, then the fetch fails as a timed-out fetch does. Each trip's scan is
    // its own timer, so the waits run side by side: they are counted, the shared clock does not move.
    waitedMs += TIMEOUT_MS;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }
  const body = { code: "Ok", routes: [{ distance: 4200, duration: 600, geometry: { coordinates: [[18.0, 59.3], [18.03, 59.31], [18.07, 59.32]] } }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
  vi.stubGlobal("fetch", fakeFetch);
  osrmUp = false;
  waitedMs = 0;
  calls.length = 0;
  fakeFetch.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("B1.3 OSRM circuit breaker: a hanging route server with 20 trips on board", () => {
  it("opens after N failures, sends at most one call per trip per cool-down, closes again, never hands out a straight line as the road, logs one line per open and close", async () => {
    const lines: Array<{ level: string; message: string }> = [];
    const log = {
      warn: (_data: Record<string, unknown>, message: string) => void lines.push({ level: "warn", message }),
      info: (_data: Record<string, unknown>, message: string) => void lines.push({ level: "info", message }),
    };
    const failures: unknown[] = [];
    const router = new OsrmRouter(BASE, TIMEOUT_MS, (error) => failures.push(error), { failuresToOpen: FAILURES_TO_OPEN, coolDownMs: COOL_DOWN_MS, log });

    /** One ride-check scan of every on-board trip; returns how long the scan waited on OSRM. */
    const scanAll = async (): Promise<number> => {
      const before = waitedMs;
      for (const trip of trips) {
        const prepared = await prepareLegs(router, [trip.points]);
        // B1.2: the scan keeps a shape only from a real road route; while OSRM hangs nothing may claim to be one.
        for (const { leg } of prepared.legs) if (!osrmUp) expect(leg.source).toBe("estimate");
        // Inside the transaction the prepared router hands back that leg (no network call there).
        const inside = await preparedRouter(prepared).route(trip.points);
        if (!osrmUp) expect(inside.source).toBe("estimate");
      }
      return waitedMs - before;
    };

    // 5 minutes of hanging OSRM, a scan of every trip every 20 s (15 scans × 20 trips = 300 route asks).
    const start = Date.now();
    const scanWaits: number[] = [];
    while (Date.now() - start < 5 * 60_000) {
      scanWaits.push(await scanAll());
      vi.setSystemTime(Date.now() + SCAN_EVERY_MS);
    }

    // At most one router call per trip in any cool-down window.
    for (const trip of trips) {
      const at = calls.filter((c) => c.trip === trip.id).map((c) => c.at);
      for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!, `${trip.id} called twice inside one cool-down`).toBeGreaterThanOrEqual(COOL_DOWN_MS);
    }
    // In total: N calls to open it, then one probe per cool-down (5 min / 60 s → at most 5).
    expect(calls.length).toBeLessThanOrEqual(FAILURES_TO_OPEN + 5);
    // Once open, a scan never waits on OSRM except for the single probe.
    for (const waited of scanWaits.slice(1)) expect(waited).toBeLessThanOrEqual(TIMEOUT_MS);
    // One warning per real failure while the breaker was closed; the probes say nothing new.
    expect(failures.length).toBe(FAILURES_TO_OPEN);
    expect(lines.filter((l) => /circuit open/.test(l.message))).toHaveLength(1);
    expect(lines.filter((l) => /circuit closed/.test(l.message))).toHaveLength(0);

    // OSRM answers again: after the cool-down the probe succeeds, the breaker closes, every trip gets its road route.
    osrmUp = true;
    vi.setSystemTime(Date.now() + COOL_DOWN_MS);
    const callsBefore = calls.length;
    for (const trip of trips) {
      const prepared = await prepareLegs(router, [trip.points]);
      expect(prepared.legs[0]!.leg.source).toBe("osrm");
      expect(prepared.legs[0]!.leg.points!.length).toBeGreaterThanOrEqual(2);
    }
    expect(calls.length - callsBefore).toBe(trips.length);
    expect(lines.filter((l) => /circuit open/.test(l.message))).toHaveLength(1);
    expect(lines.filter((l) => /circuit closed/.test(l.message))).toHaveLength(1);
  });

  it("a failed probe opens the breaker again for a fresh cool-down without a new log line; one success in between resets the count", async () => {
    const lines: string[] = [];
    const log = { warn: (_d: Record<string, unknown>, m: string) => void lines.push(m), info: (_d: Record<string, unknown>, m: string) => void lines.push(m) };
    const router = new OsrmRouter(BASE, TIMEOUT_MS, () => undefined, { failuresToOpen: FAILURES_TO_OPEN, coolDownMs: COOL_DOWN_MS, log });
    const trip = trips[0]!;

    // Failures that are not in a row never open it.
    await router.route(trip.points);
    await router.route(trip.points);
    osrmUp = true;
    expect((await router.route(trip.points)).source).toBe("osrm");
    osrmUp = false;
    await router.route(trip.points);
    await router.route(trip.points);
    expect(calls.length).toBe(5);
    expect(lines).toEqual([]);

    // Third in a row: open. The next ask returns the estimate at once.
    await router.route(trip.points);
    expect(lines).toHaveLength(1);
    const waited = waitedMs;
    expect((await router.route(trip.points)).source).toBe("estimate");
    expect(waitedMs).toBe(waited);
    expect(calls.length).toBe(6);

    // Cool-down over: one probe, it fails, open again (no second "open" line), the next ask is skipped.
    vi.setSystemTime(Date.now() + COOL_DOWN_MS);
    await router.route(trip.points);
    expect(calls.length).toBe(7);
    await router.route(trip.points);
    expect(calls.length).toBe(7);
    expect(lines).toHaveLength(1);
  });

  it("breaker off (failuresToOpen 0): every ask goes to OSRM as before", async () => {
    const router = new OsrmRouter(BASE, TIMEOUT_MS, () => undefined, { failuresToOpen: 0, coolDownMs: COOL_DOWN_MS });
    for (let i = 0; i < 10; i++) expect((await router.route(trips[0]!.points)).source).toBe("estimate");
    expect(calls.length).toBe(10);
  });

  it("only one probe at a time: while it is out, other asks get the estimate at once", async () => {
    const router = new OsrmRouter(BASE, TIMEOUT_MS, () => undefined, { failuresToOpen: 1, coolDownMs: COOL_DOWN_MS });
    await router.route(trips[0]!.points);
    expect(router.state).toBe("open");
    vi.setSystemTime(Date.now() + COOL_DOWN_MS);
    let answer: (r: Response) => void = () => undefined;
    fakeFetch.mockImplementationOnce(async (input) => {
      calls.push({ trip: tripOfUrl(String(input)), at: Date.now() });
      return new Promise<Response>((resolve) => (answer = resolve));
    });
    const probe = router.route(trips[0]!.points);
    expect(router.state).toBe("half_open");
    const others = await Promise.all(trips.slice(1).map((t) => router.route(t.points)));
    expect(others.every((leg) => leg.source === "estimate")).toBe(true);
    expect(calls.length).toBe(2);
    answer(new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 1, duration: 1, geometry: { coordinates: [[18, 59], [18.1, 59.1]] } }] }), { status: 200 }));
    expect((await probe).source).toBe("osrm");
    expect(router.state).toBe("closed");
  });

  it("env: today's timeout (2500 ms) and the breaker defaults; 0 failures turns it off", () => {
    const base = { MOVERA_ENV: "development" };
    const env = readEnv(base);
    expect([env.OSRM_TIMEOUT_MS, env.OSRM_BREAKER_FAILURES, env.OSRM_BREAKER_COOLDOWN_SECONDS]).toEqual([2500, 5, 60]);
    const set = readEnv({ ...base, OSRM_TIMEOUT_MS: "800", OSRM_BREAKER_FAILURES: "0", OSRM_BREAKER_COOLDOWN_SECONDS: "120" });
    expect([set.OSRM_TIMEOUT_MS, set.OSRM_BREAKER_FAILURES, set.OSRM_BREAKER_COOLDOWN_SECONDS]).toEqual([800, 0, 120]);
    expect(() => readEnv({ ...base, OSRM_BREAKER_COOLDOWN_SECONDS: "0" })).toThrow(/OSRM_BREAKER_COOLDOWN_SECONDS/);
  });
});
