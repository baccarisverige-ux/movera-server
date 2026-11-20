import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PLACES, Sim, bookAndAccept, type Driver, type Rider } from "../e2e/harness.js";

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
});
