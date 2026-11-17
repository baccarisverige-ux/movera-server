import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LatLng, RouteLeg, Router } from "../../src/maps/routing.js";
import { haversineKm } from "../../src/maps/routing.js";
import { quoteOutsideLock, quoteRouteChange } from "../../src/trips/routeChange.js";
import { hasStoredAnswer, runIdempotent } from "../../src/http/idempotency.js";
import { PLACES, Sim, bookAndAccept, drive, newKey, type Admin, type Driver, type Rider } from "../e2e/harness.js";

/**
 * S7 Q120 supervisor follow-ups (Rules plan/REMINDERS.md row 137, audits/impact/s7-q120-supervisor.md SF-1, SF-2):
 *  - SF-1: a request with more stops than the zone allows, or for a zone whose route change is off, was routed (with
 *    all its points) before it was refused. POST /trips/{tripId}/route-quote (routeChange.ts routeForQuote) and
 *    POST /quotes (quotes/service.ts routeBeforeTransaction). Now: refused as before, with no road call.
 *  - SF-2: on route-quote, a replay (same Idempotency-Key) and a request without (or with a bad) Idempotency-Key were
 *    routed once before they were answered. Now: answered as before, with no road call.
 * Every answer (status, code, reason, body) is the one the server gave before.
 */

const ODENPLAN = { address: "Odenplan", ...PLACES.odenplan };

let sim: Sim;
let rider: Rider;
let a: Driver;
let owner: Admin;
let tripId = "";
let calls: LatLng[][] = [];

const metersOf = (points: LatLng[]) => Math.round(points.slice(1).reduce((sum, p, i) => sum + haversineKm(points[i]!, p), 0) * 1300);
const countingRouter = {
  async route(points: LatLng[]): Promise<RouteLeg> {
    calls.push(points);
    const meters = metersOf(points);
    return { distanceMeters: meters, durationSeconds: Math.round(meters / 8), source: "osrm" };
  },
} as unknown as Router;

/** 2,000 stops in Stockholm (the schema has no upper limit; only the 1 MB body limit). */
const manyStops = Array.from({ length: 2000 }, (_, i) => ({ lat: 59.33 + (i % 50) * 0.0001, lng: 18.06 + Math.floor(i / 50) * 0.0001 }));

beforeAll(async () => {
  sim = await Sim.start({ router: countingRouter, now: new Date("2026-11-16T05:00:00Z") });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  owner = await sim.admin("super");
});
afterAll(async () => {
  await sim.stop();
});
beforeEach(async () => {
  tripId = "";
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
  await sim.db.updateTable("drivers").set({ online_status: "online" }).where("online_status", "=", "on_trip").execute();
  sim.clock.now = new Date(sim.clock.now.getTime() + 3600_000);
  await a.moveTo(PLACES.nearSergels);
});

async function onTrip(): Promise<number> {
  const made = await bookAndAccept(sim, rider, a);
  const trip = await drive(a, made.tripId, "in_trip");
  tripId = made.tripId;
  calls = [];
  return trip["version"] as number;
}
const routeChangeOn = (on: boolean) =>
  sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, routeChange: { ...((doc["routeChange"] as object | undefined) ?? {}), on } }));

describe("SF-1: too many stops / route change off are refused before any road call", () => {
  it("route-quote with 2,000 stops: 400 too_many_stops, 0 road calls", async () => {
    const version = await onTrip();
    const res = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, stops: manyStops });
    console.log(`SF-1 proof (route-quote, 2,000 stops): ${res.status} ${res.body.reason}; road calls ${calls.length} (points ${calls.map((c) => c.length).join(",") || "-"})`);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_request", reason: "too_many_stops", details: ["maxStops=3"] });
    expect(calls.length).toBe(0);
  });

  it("route-quote with 4 stops (one over the limit): refused as before, 0 road calls; 3 stops are still routed and priced", async () => {
    const version = await onTrip();
    const four = manyStops.slice(0, 4);
    const res = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, stops: four });
    expect([res.status, res.body.reason]).toEqual([400, "too_many_stops"]);
    expect(calls.length).toBe(0);
    const ok = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, stops: four.slice(0, 3) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(calls.length).toBe(1);
  });

  it("route-quote while the zone's route change is off: 409 route_change_off as before, 0 road calls", async () => {
    const version = await onTrip();
    await routeChangeOn(false);
    try {
      calls = [];
      const res = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, dropoff: ODENPLAN, stops: [] });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body).toMatchObject({ code: "conflict", reason: "route_change_off" });
      expect(calls.length).toBe(0);
    } finally {
      await routeChangeOn(true);
    }
  });

  it("POST /quotes with 2,000 stops: 400 too_many_stops as before, 0 road calls", async () => {
    calls = [];
    const res = await rider.quote({ stops: manyStops });
    console.log(`SF-1 proof (POST /quotes, 2,000 stops): ${res.status} ${res.body.reason}; road calls ${calls.length} (points ${calls.map((c) => c.length).join(",") || "-"})`);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_request", reason: "too_many_stops", details: ["maxStops=3"] });
    expect(calls.length).toBe(0);
    // A normal quote is still routed once.
    const ok = await rider.quote({ stops: manyStops.slice(0, 1) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(calls.length).toBe(1);
  });

  it("POST /quotes outside every open zone: 403 service_not_available as before, 0 road calls", async () => {
    calls = [];
    const res = await rider.quote({ pickup: { lat: 0.5, lng: 0.5 }, dropoff: { lat: 0.51, lng: 0.51 } });
    expect([res.status, res.body.reason]).toEqual([403, "service_not_available"]);
    expect(calls.length).toBe(0);
  });
});

describe("SF-2: route-quote replays and requests without an Idempotency-Key are answered without a road call", () => {
  it("a replay with the same key: the first answer again, no second road call", async () => {
    const version = await onTrip();
    const key = newKey("q120f");
    const body = { expectedVersion: version, dropoff: ODENPLAN, stops: [] };
    const first = await rider.post(`/trips/${tripId}/route-quote`, body, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(calls.length).toBe(1);
    const second = await rider.post(`/trips/${tripId}/route-quote`, body, key);
    console.log(`SF-2 proof (replay): ${second.status}, same routeQuoteId ${second.body.routeQuoteId === first.body.routeQuoteId}; road calls ${calls.length}`);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(calls.length).toBe(1);
  });

  it("the same key with another body: 409 idempotency_key_reused as before, no road call", async () => {
    const version = await onTrip();
    const key = newKey("q120f");
    expect((await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, dropoff: ODENPLAN, stops: [] }, key)).status).toBe(201);
    calls = [];
    const other = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: version, stops: [ODENPLAN] }, key);
    expect([other.status, other.body.code, other.body.reason]).toEqual([409, "conflict", "idempotency_key_reused"]);
    expect(calls.length).toBe(0);
  });

  it("no Idempotency-Key, or a bad one: 400 as before, no road call", async () => {
    const version = await onTrip();
    const body = { expectedVersion: version, dropoff: ODENPLAN, stops: [] };
    const missing = await sim.request("POST", `/trips/${tripId}/route-quote`, rider.token, body, { key: null });
    expect([missing.status, missing.body.reason]).toEqual([400, "idempotency_key_missing"]);
    const bad = await sim.request("POST", `/trips/${tripId}/route-quote`, rider.token, body, { key: "short" });
    expect([bad.status, bad.body.reason]).toEqual([400, "idempotency_key_invalid"]);
    console.log(`SF-2 proof (no key / bad key): ${missing.status} ${missing.body.reason}, ${bad.status} ${bad.body.reason}; road calls ${calls.length}`);
    expect(calls.length).toBe(0);
  });

  it("a stored answer that is gone by the time the transaction runs (swept key; real runIdempotent + quoteRouteChange): the first try has no road, the next try routes, the same price, the key stored again", async () => {
    // Round 2 (SF-D, supervisor probe P-A): the real transaction, not a stand-in. The key row is deleted between the
    // stored-answer look (hasStoredAnswer: seen) and the run, as a 24-hour sweep would.
    const version = await onTrip();
    const key = newKey("sfdSwept");
    const body = { expectedVersion: version, dropoff: ODENPLAN, stops: [] };
    const first = await rider.post(`/trips/${tripId}/route-quote`, body, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(calls.length).toBe(1);
    const asked = { actor: "rider" as const, subjectId: rider.id, key, method: "POST", route: `/api/v1/trips/${tripId}/route-quote`, body };
    // The HTTP route stored its answer under exactly this (actor, subject, key).
    expect(await hasStoredAnswer(sim.db, asked)).toBe(true);
    const gone = await sim.db.deleteFrom("idempotency_keys").where("key", "=", key).executeTakeFirst();
    expect(Number(gone.numDeletedRows)).toBe(1);
    const seen: boolean[] = [];
    const out = await quoteOutsideLock(sim.db, countingRouter, rider.id, tripId, body, async (routed) => {
      seen.push(routed !== null);
      return runIdempotent(sim.db, asked, async (trx) => ({ status: 201, body: await quoteRouteChange(trx, routed, rider.id, tripId, body, sim.clock.now) }));
    }, { routeFirstTry: false });
    console.log(`SF-D proof (swept key, real code): replayed ${out.replayed}; tries with a road ${JSON.stringify(seen)}; road calls ${calls.length}`);
    expect([out.replayed, out.status]).toEqual([false, 201]);
    expect(seen).toEqual([false, true]);
    expect(calls.length).toBe(2);
    const strip = (b: unknown) => ({ ...(b as object), routeQuoteId: "x", expiresAt: "x" });
    expect(strip(out.body)).toEqual(strip(first.body));
    expect(await hasStoredAnswer(sim.db, asked)).toBe(true);
    // Nothing half-written by the try without a road: the first answer's row and this one, no more.
    expect((await sim.db.selectFrom("route_quotes").select("route_quote_id").where("trip_id", "=", tripId).execute()).length).toBe(2);
  });
});
