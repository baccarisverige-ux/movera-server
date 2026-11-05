import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EstimateRouter, type LatLng, type RouteLeg, type Router } from "../../src/maps/routing.js";
import { newKey, Sim, type Rider } from "./harness.js";

/**
 * Fix plan rerun 2026-11-05, proof job Q1/Q3 (rule 36 fail-before test): a price quote must not hold a pooled
 * database connection while it waits for the route service. With a pool of 2 and a route service that takes 2 s,
 * 3 quotes at once must not hold up a plain GET /trips/{id}.
 */
const SLOW_MS = 2000;

class SlowRouter implements Router {
  slow = false;
  calls = 0;
  private readonly estimate = new EstimateRouter();
  async route(points: LatLng[]): Promise<RouteLeg> {
    this.calls++;
    if (this.slow) await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    return this.estimate.route(points);
  }
}

describe("a quote holds no database connection while it waits for the route service", () => {
  const router = new SlowRouter();
  let sim: Sim;
  let rider: Rider;
  let tripId: string;

  beforeAll(async () => {
    sim = await Sim.start({ router, poolMax: 2 });
    rider = await sim.rider(0);
    tripId = (await rider.book()).tripId;
  });
  afterAll(async () => {
    await sim.stop();
  });

  it("pool of 2, route service 2 s: 3 quotes at once, GET /trips/{id} still answers in < 200 ms", async () => {
    const other = [await sim.rider(1), await sim.rider(2)];
    router.slow = true;
    try {
      const quotes = [rider.quote(), other[0]!.quote(), other[1]!.quote()];
      // Let the 3 quotes reach the route service.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const started = Date.now();
      const read = await rider.get(`/trips/${tripId}`);
      const ms = Date.now() - started;
      expect(read.status).toBe(200);
      expect(read.body["tripId"]).toBe(tripId);
      const answers = await Promise.all(quotes);
      for (const answer of answers) expect(answer.status).toBe(201);
      expect(ms, `GET /trips/{id} took ${ms} ms while 3 quotes waited for the route service`).toBeLessThan(200);
    } finally {
      router.slow = false;
    }
  }, 20_000);

  it("idempotency is unchanged: the same key replays the first answer, a different body is 409", async () => {
    const key = newKey("pool");
    const body = { pickup: { address: "Sergels torg", lat: 59.3326, lng: 18.0649 }, dropoff: { address: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 }, stops: [] };
    const first = await rider.post("/quotes", body, key);
    const again = await rider.post("/quotes", body, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    const other = await rider.post("/quotes", { ...body, stops: [{ address: "x", lat: 59.32, lng: 18.07 }] }, key);
    expect(other.status).toBe(409);
    expect(other.body["reason"]).toBe("idempotency_key_reused");
  });
});
