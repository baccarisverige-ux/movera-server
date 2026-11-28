import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodePolyline } from "../../src/maps/polyline.js";
import { haversineKm } from "../../src/maps/routing.js";
import { eastDeg, FAR, MID, roadWorld, type RoadWorld } from "../support/roadLines171.js";

/**
 * v0.18.171 (contract.json#googleRoadLines.navigation / trust / offRouteRule / calls / spacing / atCap; Rules
 * plan/PLAN-0.18.171-google-road-lines.md 3.2-3.5): GET /routes/driving on the driver's own active trip leg.
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

const first = (body: Awaited<ReturnType<RoadWorld["nav"]>>) => {
  const [lng, lat] = body.routes[0]!.geometry.coordinates[0]!;
  return { lat: lat!, lng: lng! };
};
const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => haversineKm(a, b) * 1000;

describe("GET /routes/driving road lines (v0.18.171)", () => {
  it("stored and within 50 m: the stored line cut at the car, 0 calls", async () => {
    const { tripId } = await w.accepted();
    w.google.calls = 0;
    const near = { lat: MID.lat, lng: MID.lng + eastDeg(30) };
    await w.moveTo(near);
    const body = await w.nav(near);
    expect(body.code).toBe("Ok");
    expect(body.source).toBe("stored");
    expect(w.google.calls).toBe(0);
    // Cut: the line starts on the route next to the car (not back at FAR where the route was asked).
    expect(metres(first(body), MID)).toBeLessThan(5);
    expect(body.routes[0]!.distance).toBeLessThan(metres(FAR, w.NORRMALM) * 0.6);
    expect((await w.trip(tripId)).google_route_calls).toBe(2);
  });

  it("car 120 m off the line: 1 Google call, stored as eta_route, and the next ETA tick makes 0 calls", async () => {
    const { tripId } = await w.accepted();
    const before = await w.trip(tripId);
    w.google.calls = 0;
    const off = { lat: MID.lat, lng: MID.lng + eastDeg(120) };
    await w.moveTo(off);
    w.wait(61);
    const body = await w.nav(off);
    expect(body.source).toBe("google");
    expect(w.google.calls).toBe(1);
    const after = await w.trip(tripId);
    expect(after.google_route_calls).toBe(before.google_route_calls + 1);
    expect((after.eta_route as { polyline: string }).polyline).toBe(encodePolyline([off, { lat: w.NORRMALM.lat, lng: w.NORRMALM.lng }]));
    await w.moveTo(off);
    await w.advance(30);
    expect(w.google.calls).toBe(1);
  });

  it("an asked point 400 m from the stored fix: the Google call starts at the stored fix", async () => {
    const { tripId } = await w.accepted();
    const fix = { lat: MID.lat, lng: MID.lng + eastDeg(120) };
    await w.moveTo(fix);
    // Past the 60 s rule, so the trust rule (not the spacing) decides the origin.
    const stored = (await w.trip(tripId)).eta_route as Record<string, unknown>;
    await w.database.db.updateTable("trips").set({ eta_route: JSON.stringify({ ...stored, at: new Date(w.clock.now.getTime() - 61_000).toISOString() }) }).where("trip_id", "=", tripId).execute();
    w.google.calls = 0;
    w.google.asked = [];
    const body = await w.nav({ lat: fix.lat, lng: fix.lng + eastDeg(400) });
    expect(body.source).toBe("google");
    expect(w.google.calls).toBe(1);
    expect(metres(w.google.asked[0]![0]!, fix)).toBeLessThan(1);
    expect(metres(first(body), fix)).toBeLessThan(1);
  });

  it("driver position older than 120 s: the stored line cut from the asked point, 0 calls, nothing written", async () => {
    const { tripId } = await w.accepted();
    const before = await w.trip(tripId);
    w.google.calls = 0;
    w.wait(200);
    const asked = { lat: MID.lat, lng: MID.lng + eastDeg(120) };
    const body = await w.nav(asked);
    expect(body).toMatchObject({ code: "Ok", source: "stored" });
    expect(w.google.calls).toBe(0);
    expect(metres(first(body), MID)).toBeLessThan(5);
    const after = await w.trip(tripId);
    expect(after.eta_route).toEqual(before.eta_route);
    expect(after.google_route_calls).toBe(before.google_route_calls);
  });

  it("no active trip: 0 calls and nothing written", async () => {
    const off = { lat: MID.lat, lng: MID.lng + eastDeg(120) };
    await w.moveTo(off);
    const body = await w.nav(off);
    expect(body).toMatchObject({ code: "Ok", source: "estimate" });
    expect(body.routes[0]!.geometry.coordinates).toHaveLength(2);
    expect(w.google.calls).toBe(0);
    const written = await w.database.db.selectFrom("trips").select("trip_id").where("eta_route", "is not", null).where("status", "not like", "cancelled%").execute();
    expect(written).toHaveLength(0);
  });

  it("cache hit: a Google answer that lost the write is not asked again", async () => {
    const { tripId } = await w.accepted();
    w.google.calls = 0;
    const off = { lat: MID.lat, lng: MID.lng + eastDeg(120) };
    await w.moveTo(off);
    w.wait(61);
    // The ETA tick wins the same need while Google answers: a route far away, taken 2 min ago.
    const elsewhere = JSON.stringify({ target: "pickup", polyline: encodePolyline([{ lat: 59.35, lng: 18.2 }, { lat: 59.36, lng: 18.2 }]), meters: 1000, seconds: 200, at: new Date(w.clock.now.getTime() - 120_000).toISOString(), offSince: null, calls: 1 });
    w.google.during = async () => {
      await w.database.db.updateTable("trips").set({ eta_route: elsewhere }).where("trip_id", "=", tripId).execute();
    };
    const lost = await w.nav(off);
    expect(lost.source).toBe("google");
    expect(w.google.calls).toBe(1);
    // The loser wrote and counted nothing.
    const after = await w.trip(tripId);
    expect(after.eta_route).toEqual(JSON.parse(elsewhere));
    expect(after.google_route_calls).toBe(2);
    w.google.during = undefined;
    const again = await w.nav(off);
    expect(w.google.calls).toBe(1);
    expect(again.routes[0]!.geometry.coordinates).toEqual(lost.routes[0]!.geometry.coordinates);
  });

  it("the 60 s rule is read from eta_route.at", async () => {
    const { tripId } = await w.accepted();
    w.google.calls = 0;
    const off = { lat: MID.lat, lng: MID.lng + eastDeg(120) };
    await w.moveTo(off);
    const stored = (await w.trip(tripId)).eta_route as Record<string, unknown>;
    await w.database.db.updateTable("trips").set({ eta_route: JSON.stringify({ ...stored, at: new Date(w.clock.now.getTime() - 30_000).toISOString() }) }).where("trip_id", "=", tripId).execute();
    const soon = await w.nav(off);
    expect(soon.source).toBe("stored");
    expect(w.google.calls).toBe(0);
    await w.database.db.updateTable("trips").set({ eta_route: JSON.stringify({ ...stored, at: new Date(w.clock.now.getTime() - 61_000).toISOString() }) }).where("trip_id", "=", tripId).execute();
    const later = await w.nav(off);
    expect(later.source).toBe("google");
    expect(w.google.calls).toBe(1);
  });

  it("the 5th need makes 0 Google calls (counter 4, the quote counted as 1) and answers stored", async () => {
    const { tripId } = await w.accepted();
    // The quote (Google) and the drive to the pickup (the first ETA tick).
    expect((await w.trip(tripId)).google_route_calls).toBe(2);
    w.google.calls = 0;
    for (const metresEast of [120, 240]) {
      const off = { lat: MID.lat, lng: MID.lng + eastDeg(metresEast) };
      await w.moveTo(off);
      w.wait(61);
      expect((await w.nav(off)).source).toBe("google");
    }
    expect(w.google.calls).toBe(2);
    expect((await w.trip(tripId)).google_route_calls).toBe(4);
    w.google.calls = 0;
    const fifth = { lat: MID.lat, lng: MID.lng + eastDeg(400) };
    await w.moveTo(fifth);
    w.wait(61);
    const body = await w.nav(fifth);
    expect(body).toMatchObject({ code: "Ok", source: "stored" });
    expect(w.google.calls).toBe(0);
    expect((await w.trip(tripId)).google_route_calls).toBe(4);
  });

  it("roadLines off: estimate, no call", async () => {
    try {
      const { tripId } = await w.accepted();
      await w.setRoadLines({ on: false });
      await w.database.db.updateTable("trips").set({ eta_route: null }).where("trip_id", "=", tripId).execute();
      w.google.calls = 0;
      const off = { lat: MID.lat, lng: MID.lng + eastDeg(120) };
      await w.moveTo(off);
      const body = await w.nav(off);
      expect(body).toMatchObject({ code: "Ok", source: "estimate" });
      expect(w.google.calls).toBe(0);
    } finally {
      await w.setRoadLines({});
    }
  });
});
