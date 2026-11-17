import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { haversineKm, type LatLng, type RouteLeg, type Router } from "../../src/maps/routing.js";
import * as routeChange from "../../src/trips/routeChange.js";
import { PLACES, Sim, bookAndAccept, drive, newKey, type Driver, type Rider } from "../e2e/harness.js";

/**
 * S7 0.17 (owner W2 Q120 part 3 "Yes, all three", 2026-11-15): POST /trips/{tripId}/route-quote asked the road route
 * INSIDE its transaction, after it had locked the trip row (trips/routeChange.ts quoteRouteChange), so the trip stayed
 * locked - GPS writes, the driver's steps, the trip's timers waiting - for as long as OSRM took. Now the road is asked
 * first (no transaction, no lock); the transaction then locks the trip, checks everything as before and uses the road
 * only if it is for exactly the trip's route as it is under the lock; else it reads and routes again (3 times at
 * most), then answers "the trip changed" - never a price for another route.
 * Every road call here looks, from another database connection, whether the trip row is locked.
 */

const TRIES = (routeChange as unknown as { ROUTE_QUOTE_TRIES?: number }).ROUTE_QUOTE_TRIES ?? 3;
const ODENPLAN = { address: "Odenplan", ...PLACES.odenplan };
const FRIDHEMSPLAN = { address: "Fridhemsplan", lat: 59.3343, lng: 18.0293 };

let sim: Sim;
let rider: Rider;
let other: Rider;
let a: Driver;
let tripId = "";

type Call = { points: LatLng[]; options: unknown; tripLocked: boolean };
let calls: Call[] = [];
let during: (n: number) => Promise<void> = async () => undefined;

async function tripRowLocked(): Promise<boolean> {
  if (tripId === "") return false;
  try {
    await sql`SELECT 1 FROM trips WHERE trip_id = ${tripId} FOR UPDATE NOWAIT`.execute(sim.db);
    return false;
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return true;
    throw error;
  }
}
const metersOf = (points: LatLng[]) => Math.round(points.slice(1).reduce((sum, p, i) => sum + haversineKm(points[i]!, p), 0) * 1300);
/** A road that follows the points (so the stored distance says which points were priced). */
const probeRouter = {
  async route(points: LatLng[], options?: unknown): Promise<RouteLeg> {
    calls.push({ points, options, tripLocked: await tripRowLocked() });
    await during(calls.length);
    const meters = metersOf(points);
    return { distanceMeters: meters, durationSeconds: Math.round(meters / 8), source: "osrm" };
  },
} as unknown as Router;

beforeAll(async () => {
  sim = await Sim.start({ router: probeRouter, now: new Date("2026-11-16T05:00:00Z") });
  rider = await sim.rider(0);
  other = await sim.rider(1);
  a = await sim.driver(1, PLACES.nearSergels);
});
afterAll(async () => {
  await sim.stop();
});
beforeEach(async () => {
  tripId = "";
  during = async () => undefined;
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
  await sim.db.updateTable("drivers").set({ online_status: "online" }).where("online_status", "=", "on_trip").execute();
  sim.clock.now = new Date(sim.clock.now.getTime() + 3600_000);
  await a.moveTo(PLACES.nearSergels);
});

/** A live trip with the rider on board; returns its version. From here on every road call is counted. */
async function onTrip(): Promise<number> {
  const made = await bookAndAccept(sim, rider, a);
  const trip = await drive(a, made.tripId, "in_trip");
  tripId = made.tripId;
  calls = [];
  return trip["version"] as number;
}
const quotesOf = () => sim.db.selectFrom("route_quotes").select(["route_quote_id", "distance_meters", "dropoff"]).where("trip_id", "=", tripId).execute();
const point = (p: { lat: number; lng: number }) => ({ lat: p.lat, lng: p.lng });

describe("S7 0.17: the route-change price asks its road with no lock held", () => {
  it("no road call while the trip row is locked; the road is asked without its shape; the price is the road's", async () => {
    const version = await onTrip();
    const res = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, dropoff: ODENPLAN, stops: [] });
    console.log(`0.17 proof (route quote): ${calls.length} road call(s); trip row locked during a call: ${calls.map((c) => c.tripLocked).join(", ")}`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(calls.length).toBe(1);
    expect(calls[0]!.tripLocked).toBe(false);
    expect(calls[0]!.options).toEqual({ shape: false });
    expect(calls[0]!.points).toEqual([point(PLACES.sergels), point(ODENPLAN)]);
    expect(await quotesOf()).toEqual([{ route_quote_id: res.body.routeQuoteId, distance_meters: metersOf(calls[0]!.points), dropoff: ODENPLAN }]);
    // And the price can be used as before.
    const asked = await rider.send("PATCH", `/trips/${tripId}`, { expectedVersion: version, routeQuoteId: res.body.routeQuoteId });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body.routeChange).toMatchObject({ status: "pending", total: res.body.total });
  });

  it("the trip's route input changed while the road was asked: detected under the lock, nothing stored, asked again; the price is for the trip as it is", async () => {
    const version = await onTrip();
    // While the first road is being asked, the trip's drop-off changes (the request keeps the drop-off and adds a stop).
    during = async (n) => void (n === 1 && (await sim.db.updateTable("trips").set({ dropoff: JSON.stringify(FRIDHEMSPLAN) }).where("trip_id", "=", tripId).execute()));
    const res = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, stops: [ODENPLAN] });
    console.log(`0.17 proof (changed input): road calls ${calls.length}; last point asked: ${calls.map((c) => c.points.at(-1)!.lng).join(" then ")}; locked: ${calls.map((c) => c.tripLocked).join(", ")}`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(calls.length).toBe(2);
    expect(calls.map((c) => c.tripLocked)).toEqual([false, false]);
    expect(calls[0]!.points.at(-1)).toEqual(point(PLACES.medborgar));
    expect(calls[1]!.points).toEqual([point(PLACES.sergels), point(ODENPLAN), point(FRIDHEMSPLAN)]);
    // One price only, for the second road (the trip as it was under the lock); the first road priced nothing.
    expect(await quotesOf()).toEqual([{ route_quote_id: res.body.routeQuoteId, distance_meters: metersOf(calls[1]!.points), dropoff: FRIDHEMSPLAN }]);
    expect(metersOf(calls[1]!.points)).not.toBe(metersOf(calls[0]!.points));
  });

  it(`inputs that keep changing: after ${TRIES} tries the answer is "the trip changed" (409 version_mismatch with the trip), nothing stored, and the same key works later`, async () => {
    const version = await onTrip();
    during = async (n) => void (await sim.db.updateTable("trips").set({ dropoff: JSON.stringify({ ...FRIDHEMSPLAN, lat: FRIDHEMSPLAN.lat + n * 0.001 }) }).where("trip_id", "=", tripId).execute());
    const key = newKey("q120");
    const res = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, stops: [ODENPLAN] }, key);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({ code: "version_mismatch", projection: { tripId, version } });
    expect(calls.length).toBe(TRIES);
    expect(calls.every((c) => !c.tripLocked)).toBe(true);
    expect(await quotesOf()).toEqual([]);
    // Nothing of the failed tries is kept (no stored answer for the key): the same request with the same key now prices.
    during = async () => undefined;
    const again = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, stops: [ODENPLAN] }, key);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await quotesOf()).length).toBe(1);
  });

  it("the trip moved to a new version while the road was asked: the usual 409 version_mismatch, nothing stored", async () => {
    const version = await onTrip();
    during = async (n) => void (n === 1 && (await sim.db.updateTable("trips").set({ version: version + 1 }).where("trip_id", "=", tripId).execute()));
    const res = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, dropoff: ODENPLAN, stops: [] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "version_mismatch", projection: { version: version + 1 } });
    expect(calls.length).toBe(1);
    expect(await quotesOf()).toEqual([]);
  });

  it("a request that is refused anyway is not routed at all, and is refused as before", async () => {
    const version = await onTrip();
    const stale = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version - 1, dropoff: ODENPLAN, stops: [] });
    expect([stale.status, stale.body.code]).toEqual([409, "version_mismatch"]);
    const notMine = await other.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, dropoff: ODENPLAN, stops: [] });
    expect([notMine.status, notMine.body.reason]).toEqual([404, "trip_not_found"]);
    const bad = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, dropoff: { lat: "x" }, stops: [] });
    expect([bad.status, bad.body.reason]).toEqual([400, "invalid_body"]);
    const pickup = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, pickup: ODENPLAN, stops: [] });
    expect([pickup.status, pickup.body.reason]).toEqual([400, "invalid_body"]);
    expect(calls).toEqual([]);
    expect(await quotesOf()).toEqual([]);
  });

  it("a replayed request (same Idempotency-Key) gets the first answer again", async () => {
    const version = await onTrip();
    const key = newKey("q120");
    const first = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, dropoff: ODENPLAN, stops: [] }, key);
    const second = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, dropoff: ODENPLAN, stops: [] }, key);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body).toEqual(first.body);
    expect((await quotesOf()).length).toBe(1);
    expect(calls.every((c) => !c.tripLocked)).toBe(true);
  });
});
