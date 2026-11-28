import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call } from "../support/world.js";
import { eastDeg, MID, roadWorld, type RoadWorld } from "../support/roadLines171.js";

/**
 * v0.18.171 (contract.json#googleRoadLines.riderEvent; plan 3.6): the ETA tick's location event carries
 * eta.legRoute only on the tick where the leg's stored route changed; trips.eta never carries it.
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

type Eta = { target: string; legRoute?: { target: string; polyline: string } };
const etaEvents = async (tripId: string) => ((await call(w.app, "GET", `/trips/${tripId}/events?after=0&limit=200`, w.rider())).json().items as Array<{ kind: string; eta?: Eta }>).filter((e) => e.kind === "location" && e.eta).map((e) => e.eta!);

describe("TripEta.legRoute on the rider's location events (v0.18.171)", () => {
  it("the first tick after accept carries eta.legRoute and the next one does not; trips.eta never carries it", async () => {
    const { tripId } = await w.accepted();
    const first = await etaEvents(tripId);
    expect(first).toHaveLength(1);
    const stored = (await w.trip(tripId)).eta_route as { polyline: string };
    expect(first[0]!.legRoute).toEqual({ target: "pickup", polyline: stored.polyline });
    expect((await w.trip(tripId)).eta).not.toHaveProperty("legRoute");
    await w.moveTo(MID);
    await w.advance(30);
    const next = await etaEvents(tripId);
    expect(next).toHaveLength(2);
    expect(next[1]).not.toHaveProperty("legRoute");
    expect((await w.trip(tripId)).eta).not.toHaveProperty("legRoute");
  });

  it("a re-route carries it again; the leg switch at boarding carries the drop-off route", async () => {
    const { tripId, version } = await w.accepted();
    const off = { lat: MID.lat, lng: MID.lng + eastDeg(120) };
    await w.moveTo(off);
    w.wait(61);
    expect((await w.nav(off)).source).toBe("google");
    const rerouted = (await w.trip(tripId)).eta_route as { polyline: string };
    await w.advance(30);
    const afterReroute = (await etaEvents(tripId)).at(-1)!;
    expect(afterReroute.legRoute).toEqual({ target: "pickup", polyline: rerouted.polyline });
    // To the pickup, arrive, board: the first drop-off tick carries the booked (quote) route.
    let v = (await w.step(tripId, "head-to-pickup", version)).json().version;
    await w.moveTo(w.NORRMALM);
    await w.worker.runDue();
    v = (await w.step(tripId, "arrive", v)).json().version;
    await w.advance(20);
    const board = await w.step(tripId, "board", v);
    expect(board.statusCode, board.body).toBe(200);
    await w.worker.runDue();
    const dropoff = (await etaEvents(tripId)).at(-1)!;
    const quoteLine = (await w.database.db.selectFrom("trips").select("route_polyline").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).route_polyline;
    expect(dropoff.target).toBe("dropoff");
    expect(dropoff.legRoute).toEqual({ target: "dropoff", polyline: quoteLine });
    expect((await w.trip(tripId)).eta).not.toHaveProperty("legRoute");
  });
});
