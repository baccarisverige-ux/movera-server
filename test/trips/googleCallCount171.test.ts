import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lockTripNow } from "../../src/dispatch/runtime.js";
import { backToDispatch } from "../../src/trips/ride/cancel.js";
import { call, NORRMALM, SODERMALM } from "../support/world.js";
import { roadWorld, type RoadWorld } from "../support/roadLines171.js";

/**
 * v0.18.171 (contract.json#googleRoadLines.calls / counter; plan 3.3): the trip's Google call counter starts at 1 when
 * its quote came from Google and is kept outside eta_route, so a driver change keeps it.
 */
let w: RoadWorld;
beforeAll(async () => {
  w = await roadWorld();
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
});

describe("the trip's Google call count (v0.18.171)", () => {
  it("a Google quote starts the trip at 1; a quote without Google at 0", async () => {
    const book = async () => {
      const quote = (await call(w.app, "POST", "/quotes", w.rider(), { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
      const res = await call(w.app, "POST", "/trips", w.rider(), { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
      expect(res.statusCode, res.body).toBe(201);
      return { routeSource: quote.routeSource as string, tripId: res.json().tripId as string };
    };
    const google = await book();
    expect(google.routeSource).toBe("google");
    expect((await w.trip(google.tripId)).google_route_calls).toBe(1);
    await w.reset();
    w.google.fail = "error";
    const estimate = await book();
    expect(estimate.routeSource).toBe("estimate");
    expect((await w.trip(estimate.tripId)).google_route_calls).toBe(0);
  });

  it("a driver change keeps the count (the new driver uses what is left)", async () => {
    const { tripId } = await w.accepted();
    expect((await w.trip(tripId)).google_route_calls).toBe(2);
    await w.database.db.transaction().execute(async (trx) => {
      const trip = await lockTripNow(trx, tripId);
      await backToDispatch(trx, trip!, { command: "reassign", actor: "admin", now: w.clock.now });
    });
    const after = await w.trip(tripId);
    expect(after.driver_id).toBeNull();
    expect(after.eta_route).toBeNull();
    expect(after.google_route_calls).toBe(2);
  });
});
