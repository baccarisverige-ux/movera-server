import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Driver, type Rider } from "./harness.js";

/**
 * Audit Phase 7: server time and request count for one whole ride (book → offer → accept → arrive → board → start →
 * complete), measured with Fastify's elapsedTime on every response. Baseline on the audit container (Postgres 16,
 * e2e harness, docs/audit/phase-7.md): whole suite p50 4.8 ms, p95 28.7 ms, slowest non-stream request 255 ms
 * (admin sign-in, argon2). Budgets are set well above the baseline so a slow CI runner passes and a regression
 * (a missing index, a query per row, a retry loop) does not.
 */
const SLOWEST_MS = 1000;
const P95_MS = 250;
// Measured: 54 requests (3 runs, same count; the driver app's 30 s position updates included), p95 about 20 ms,
// slowest 47 ms. A new call per step or a polling loop shows up here.
const MAX_REQUESTS = 60;
// Long-lived Server-Sent Event streams stay open for the whole test; their "time" is the stream's life.
const isStream = (route: string) => route.endsWith("/stream") || route.endsWith("/events");

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let driver: Driver;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  driver = await sim.driver(1, PLACES.nearSergels);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

describe("timing budget: one whole ride (audit Phase 7)", () => {
  it("every request answers within budget and the ride needs a bounded number of requests", async () => {
    const feed = await driver.offerFeed();
    const start = sim.timings.length;
    const { tripId } = await rider.book();
    const events = await rider.events(tripId);
    await sim.tick();
    const offered = await feed.waitFor((e) => e.data["offer"]?.["tripId"] === tripId);
    expect((await driver.accept(offered.data["offer"])).status).toBe(200);
    for (const path of ["head-to-pickup", "arrive", "board", "start"]) {
      if (path === "arrive") await driver.moveTo(PLACES.sergels);
      expect((await driver.command(tripId, path)).status).toBe(200);
    }
    await sim.advance(60);
    await driver.moveTo(PLACES.medborgar);
    await sim.advance(17 * 60);
    await driver.moveTo(PLACES.medborgar);
    expect((await driver.command(tripId, "complete")).status).toBe(200);
    await events.reach("completed");

    const ride = sim.timings.slice(start).filter((t) => !isStream(t.route));
    const ms = ride.map((t) => t.ms).sort((a, b) => a - b);
    const p95 = ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]!;
    expect(ride.filter((t) => t.ms > SLOWEST_MS), JSON.stringify(ride)).toEqual([]);
    expect(p95).toBeLessThan(P95_MS);
    expect(ride.length).toBeLessThanOrEqual(MAX_REQUESTS);
  });
});
