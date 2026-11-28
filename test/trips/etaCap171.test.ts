import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call } from "../support/world.js";
import { eastDeg, FAR, roadWorld, type RoadWorld } from "../support/roadLines171.js";

/**
 * v0.18.171 (contract.json#googleRoadLines.atCap; plan 3.5): at the trip's cap the ETA tick makes no Google call even
 * when its re-call rule says so (off the route long enough), and keeps following the stored Google route (source google,
 * the remaining distance along it), never the straight-line estimate jump.
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

describe("ETA tick at the cap (v0.18.171)", () => {
  it("recall true at the cap: follows the stored line, no call, no estimate jump", async () => {
    const { tripId } = await w.accepted();
    await w.database.db.updateTable("trips").set({ google_route_calls: 4 }).where("trip_id", "=", tripId).execute();
    w.google.calls = 0;
    // 1 km east of the stored route for more than offRouteSeconds (30 s): the re-call rule fires.
    const off = { lat: FAR.lat, lng: FAR.lng + eastDeg(1000) };
    await w.moveTo(off);
    await w.advance(30);
    await w.moveTo(off);
    await w.advance(31);
    expect(w.google.calls).toBe(0);
    const eta = (await call(w.app, "GET", `/trips/${tripId}`, w.rider())).json().eta;
    expect(eta).toMatchObject({ target: "pickup", source: "google" });
    // Along the stored line from its nearest point (FAR, its start): about 1.3 km; the estimate would be about 2.05 km
    // (1.64 km straight × the road factor 1.25).
    expect(eta.distanceMeters).toBeGreaterThan(1200);
    expect(eta.distanceMeters).toBeLessThan(1400);
    expect((await w.trip(tripId)).google_route_calls).toBe(4);
  });
});
