import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PLACES, Sim, bookAndAccept, type Driver, type Rider } from "../e2e/harness.js";
import { requestRouteChange } from "../../src/trips/routeChange.js";

/**
 * v0.18.143 (owner 2026-11-20 "must rider can change !!!!", contract.json#onTrip.routeChange.whileSearching): while a
 * live trip is still searched (requested, searching, offered; no driver accepted) the rider changes the pickup to ANY
 * place (also the destination and stops): route-quote with pickup, then PATCH { routeQuoteId } = command change_route in
 * one transaction: open offers withdrawn, new pickup and price, a new search. Free. After accept the old rules stay.
 */

// Far from the booked pickup (Sergels torg): several km, well past maxPickupMoveMeters (200).
const FAR = { ...PLACES.medborgar, address: "Far pickup", lat: PLACES.medborgar.lat + 0.02 };

let sim: Sim;
let rider: Rider;
let a: Driver;

beforeAll(async () => {
  sim = await Sim.start({ now: new Date("2026-11-20T10:00:00Z") });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
});
afterAll(async () => {
  await sim.stop();
});
beforeEach(async () => {
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
  await sim.db.updateTable("drivers").set({ online_status: "online" }).where("online_status", "=", "on_trip").execute();
  await sim.db.updateTable("offers").set({ status: "withdrawn" }).where("status", "=", "open").execute();
  sim.clock.now = new Date(sim.clock.now.getTime() + 3600_000);
  await a.moveTo(PLACES.nearSergels);
});

describe("change route while searching (v0.18.143)", () => {
  it("offered: a far pickup is priced, confirmed, the offer is withdrawn and a new search with the new pickup starts", async () => {
    const { tripId } = await rider.book();
    await sim.tick();
    const offer = await a.offerFor(tripId);
    expect(offer, "the driver has an offer").toBeDefined();
    const before = await rider.trip(tripId);
    expect(before["status"]).toBe("offered");

    const q = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: before["version"], pickup: FAR, stops: [] });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body["pickup"]).toMatchObject({ lat: FAR.lat, lng: FAR.lng });
    expect(q.body["total"]["amountMinor"]).not.toBe(before["fare"]?.["amountMinor"] ?? -1);

    // The old pickup move is still refused for this distance (unchanged rule).
    const move = await rider.send("PATCH", `/trips/${tripId}`, { expectedVersion: before["version"], pickup: FAR });
    expect([move.status, move.body.reason]).toEqual([400, "pickup_move_too_far"]);

    const res = await rider.send("PATCH", `/trips/${tripId}`, { expectedVersion: before["version"], routeQuoteId: q.body["routeQuoteId"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body["status"]).toBe("searching");
    expect(res.body["pickup"]).toMatchObject({ lat: FAR.lat, lng: FAR.lng });
    expect(res.body["routeChange"]).toMatchObject({ status: "accepted", answeredBy: "system", reason: "rider_changed_route", pickup: { lat: FAR.lat } });
    expect(res.body["fare"]["amountMinor"]).toBe(q.body["total"]["amountMinor"]);
    expect(res.body["cancellation"] ?? null).toBeNull();

    const old = await sim.db.selectFrom("offers").select("status").where("offer_id", "=", offer!["offerId"]).executeTakeFirstOrThrow();
    expect(old.status).toBe("withdrawn");
    const event = await sim.db.selectFrom("trip_events").select(["kind"]).where("trip_id", "=", tripId).orderBy("sequence", "desc").executeTakeFirstOrThrow();
    expect(event.kind).toBe("trip_projection");

    // The driver gets a new offer with the new pickup (he was asked again).
    await a.moveTo({ lat: FAR.lat, lng: FAR.lng });
    await sim.tick();
    const again = await a.offerFor(tripId);
    expect(again, "a new offer").toBeDefined();
    expect(again!["offerId"]).not.toBe(offer!["offerId"]);
    expect(again!["pickup"]).toMatchObject({ lat: FAR.lat, lng: FAR.lng });
  });

  it("after a driver accepted, route-quote with a pickup stays refused (400 invalid_body)", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    const trip = await rider.trip(tripId);
    const q = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: trip["version"], pickup: FAR, stops: [] });
    expect([q.status, q.body.reason]).toEqual([400, "invalid_body"]);
  });

  it("a quote made while searching is refused once a driver accepted", async () => {
    const { tripId } = await rider.book();
    await sim.tick();
    const before = await rider.trip(tripId);
    const q = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: before["version"], pickup: FAR, stops: [] });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    const offer = await a.offerFor(tripId);
    expect((await a.accept(offer!)).status).toBe(200);
    const now = await rider.trip(tripId);
    const res = await rider.send("PATCH", `/trips/${tripId}`, { expectedVersion: now["version"], routeQuoteId: q.body["routeQuoteId"] });
    expect(res.status).toBe(409);
    expect((await rider.trip(tripId))["pickup"]).toMatchObject({ lat: PLACES.sergels.lat });
  });
  it("offered: fare, commission, booked pickup and driver pay follow the quote; nothing is charged", async () => {
    const { tripId } = await rider.book();
    await sim.tick();
    const before = await rider.trip(tripId);
    const q = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: before["version"], pickup: FAR, stops: [] });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    const res = await rider.send("PATCH", `/trips/${tripId}`, { expectedVersion: before["version"], routeQuoteId: q.body["routeQuoteId"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await sim.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    const quote = await sim.db.selectFrom("route_quotes").selectAll().where("route_quote_id", "=", q.body["routeQuoteId"]).executeTakeFirstOrThrow();
    expect(Number(row.fare_minor)).toBe(Number(quote.total_minor));
    expect(Number(row.driver_earnings_minor)).toBe(Number(quote.driver_earnings_minor));
    expect(Number(row.commission_minor)).toBeGreaterThanOrEqual(0);
    expect(row.booked_pickup).toMatchObject({ lat: FAR.lat, lng: FAR.lng });
    expect(row.pickup).toMatchObject({ lat: FAR.lat, lng: FAR.lng });
    expect(row.cancellation).toBeNull();
    expect(row.zone_id).toBe("Z001");
    expect(quote.used_at).not.toBeNull();
    // The same price cannot be used twice.
    const again = await rider.send("PATCH", `/trips/${tripId}`, { expectedVersion: res.body["version"], routeQuoteId: q.body["routeQuoteId"] });
    expect([again.status, again.body.reason]).toEqual([409, "route_quote_used"]);
  });

  it("searching (no driver near): the change applies and the search starts again", async () => {
    await a.moveTo(PLACES.atSea);
    const { tripId } = await rider.book();
    await sim.tick();
    const before = await rider.trip(tripId);
    expect(before["status"]).toBe("searching");
    const q = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: before["version"], pickup: FAR, stops: [] });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    const res = await rider.send("PATCH", `/trips/${tripId}`, { expectedVersion: before["version"], routeQuoteId: q.body["routeQuoteId"] });
    expect([res.status, res.body["status"]]).toEqual([200, "searching"]);
    const search = await sim.db.selectFrom("trips").select("search_started_at").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(search.search_started_at?.toISOString()).toBe(sim.clock.now.toISOString());
  });

  it("a pickup in another open zone keeps the booked zone's pricing (owner: the price applies to the booking zone)", async () => {
    await sim.db.insertInto("zones").values({ zone_id: "ZUP", name: "Uppsala", country: "SE", currency: "SEK", time_zone: "Europe/Stockholm", kind: "operating", center_lat: 59.86, center_lng: 17.64, open: true, south: 59.8, west: 17.5, north: 59.9, east: 17.8, names: JSON.stringify({ sv: "Uppsala", fr: "Uppsala", en: "Uppsala" }), polygon: JSON.stringify([[59.8, 17.5], [59.9, 17.5], [59.9, 17.8], [59.8, 17.8]]) } as never).onConflict((c) => c.column("zone_id").doNothing()).execute();
    const { tripId } = await rider.book();
    await sim.tick();
    const before = await sim.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    const view = await rider.trip(tripId);
    const UPPSALA = { address: "Uppsala C", lat: 59.858, lng: 17.646 };
    const q = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: view["version"], pickup: UPPSALA, stops: [] });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body["total"]["currency"]).toBe(before.currency);
    const res = await rider.send("PATCH", `/trips/${tripId}`, { expectedVersion: view["version"], routeQuoteId: q.body["routeQuoteId"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await sim.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect([after.zone_id, after.pricing_version, after.pricing_scope, after.currency]).toEqual([before.zone_id, before.pricing_version, before.pricing_scope, before.currency]);
    expect(after.pickup).toMatchObject({ lat: UPPSALA.lat });
  });

  it("a pickup in no open zone is refused: 403 service_not_available, nothing changes", async () => {
    const { tripId } = await rider.book();
    await sim.tick();
    const view = await rider.trip(tripId);
    const q = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: view["version"], pickup: PLACES.atSea, stops: [] });
    expect([q.status, q.body.reason]).toEqual([403, "service_not_available"]);
    expect((await rider.trip(tripId))["version"]).toBe(view["version"]);
  });

  it("a booked (scheduled) ride is not changed this way: 400 invalid_body for a pickup", async () => {
    const at = new Date(sim.clock.now.getTime() + 2 * 3600_000).toISOString();
    const quotes = await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at });
    expect(quotes.status, JSON.stringify(quotes.body)).toBe(201);
    const made = await rider.post("/trips", { quoteId: quotes.body["quotes"][0].quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const q = await rider.post(`/trips/${made.body["tripId"]}/route-quote`, { expectedVersion: made.body["version"], pickup: FAR, stops: [] });
    expect([q.status, q.body.reason]).toEqual([400, "invalid_body"]);
  });

  it("rollback: a change whose transaction fails leaves the trip, its price and its open offer as they were", async () => {
    const { tripId } = await rider.book();
    await sim.tick();
    const offer = await a.offerFor(tripId);
    const view = await rider.trip(tripId);
    const q = await rider.post(`/trips/${tripId}/route-quote`, { expectedVersion: view["version"], pickup: FAR, stops: [] });
    expect(q.status).toBe(201);
    await expect(sim.db.transaction().execute(async (trx) => {
      await requestRouteChange(trx, rider.id, tripId, { expectedVersion: view["version"], routeQuoteId: q.body["routeQuoteId"] }, sim.clock.now);
      throw new Error("boom after the change");
    })).rejects.toThrow("boom");
    const row = await sim.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect([row.status, row.version]).toEqual(["offered", view["version"]]);
    expect(row.pickup).toMatchObject({ lat: PLACES.sergels.lat });
    expect((await sim.db.selectFrom("offers").select("status").where("offer_id", "=", offer!["offerId"]).executeTakeFirstOrThrow()).status).toBe("open");
    expect((await sim.db.selectFrom("route_quotes").select("used_at").where("route_quote_id", "=", q.body["routeQuoteId"]).executeTakeFirstOrThrow()).used_at).toBeNull();
  });
  it("PATCH side: a price with a new pickup is refused for a booked (scheduled) ride; nothing changes (S3)", async () => {
    const at = new Date(sim.clock.now.getTime() + 2 * 3600_000).toISOString();
    const quotes = await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at });
    const made = await rider.post("/trips", { quoteId: quotes.body["quotes"][0].quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const tripId = made.body["tripId"] as string;
    const trip = await sim.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    await sim.db.insertInto("route_quotes").values({
      route_quote_id: "rtq_s3_scheduled", trip_id: tripId, trip_version: trip.version, base_change_id: null,
      dropoff: JSON.stringify(trip.dropoff), stops: JSON.stringify([]), pickup: JSON.stringify(FAR),
      distance_meters: 1000, duration_seconds: 120, currency: trip.currency, total_minor: Number(trip.fare_minor), difference_minor: 0,
      fare_lines: JSON.stringify(trip.fare_lines), driver_earnings_minor: Number(trip.driver_earnings_minor ?? 0), leaves_fixed_price: false,
      expires_at: new Date(sim.clock.now.getTime() + 300_000), created_at: sim.clock.now,
    }).execute();
    const res = await rider.send("PATCH", `/trips/${tripId}`, { expectedVersion: trip.version, routeQuoteId: "rtq_s3_scheduled" });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const after = await sim.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect([after.status, after.version]).toEqual(["requested", trip.version]);
    expect(after.pickup).toMatchObject({ lat: PLACES.sergels.lat });
  });
});
