import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatchKm } from "../../src/dispatch/engine.js";
import { findCauses } from "../../src/alerts/detector.js";
import { scheduleTimer } from "../../src/jobs/timers.js";
import { WITHDRAW } from "../../src/dispatch/runtime/shared.js";
import { fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * v0.18.39 §63 (fix job N2 + P17 + far rider, contract.json#noDriverNearby). Rule 36: written BEFORE the fix, from the
 * proof in Rules plan/FIX-PLAN-RERUN-2026-11-05.md "Proof: far rider" (engine.ts:138-142 reach capped at the widest
 * step, rounds.ts:101-105 / engine.ts:275 only `wait` or the same driver again, engine.ts:323-325 the busy step ends the
 * search at 8 min). Zone dispatch as in the proof: steps [3, 5, 8], Radar 5 drivers / 15 s, Exclusive 3 / 15 s.
 */

// South of Sergels torg (still Stockholm County, Z001): dispatch km = straight km × roadFactor 1.25.
const south = (dispatchKmWanted: number) => ({ lat: PLACES.sergels.lat - dispatchKmWanted / 1.25 / 111.32, lng: PLACES.sergels.lng });
const AT_6_9 = south(6.9);
const AT_9_5 = south(9.5);

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;
let owner: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-06T09:00:00Z") });
  rider = await sim.rider(0);
  a = await sim.driver(1, AT_6_9);
  b = await sim.driver(2, AT_9_5);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
beforeEach(async () => {
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "in", ["requested", "searching", "offered", "accepted"]).execute();
  await sim.db.updateTable("offers").set({ status: "withdrawn" }).where("status", "=", "open").execute();
  await sim.db.deleteFrom("timers").where("kind", "in", ["dispatch_round", "search_step", "search_end"]).execute();
  await sim.advance(3600);
  owner = await sim.admin("super");
  await setDispatch({});
  for (const d of [a, b]) await sim.db.updateTable("drivers").set({ online_status: "online", last_free_at: sim.clock.now }).where("driver_id", "=", d.id).execute();
  await a.moveTo(AT_6_9);
  await b.moveTo(AT_9_5);
});

/** The proof's zone rules, plus the v0.18.39 settings under test. */
async function setDispatch(extra: Json, limits: Json = {}) {
  await sim.publish(owner, "dispatch", "Z001", (d) => ({
    ...d,
    radius: { steps: [3, 5, 8], maxWaitMin: 10 },
    radar: { ...d["radar"], on: true, drivers: 5, seconds: 15, then: "widen_then_exclusive", steps: undefined },
    exclusive: { ...d["exclusive"], on: true, drivers: 3, seconds: 15, then: "widen_then_radar", steps: undefined },
    start: { mode: "exclusive" },
    neighbours: { on: false, zoneIds: [] },
    limits: { ...limits },
    ...extra,
  }));
}

const offersOf = (tripId: string, driverId: string) => sim.db.selectFrom("offers").select(["kind", "status", "sent_at"]).where("trip_id", "=", tripId).where("driver_id", "=", driverId).orderBy("sent_at").execute();
/** A goes busy the way the server sees it: on a trip, his open offers withdrawn (as accepting another trip does). */
async function goesBusy(d: Driver) {
  await sim.db.updateTable("drivers").set({ online_status: "on_trip" }).where("driver_id", "=", d.id).execute();
  await sim.db.transaction().execute((trx) => scheduleTimer(trx, { kind: WITHDRAW, refId: d.id, dueAt: sim.clock.now, payload: {} }));
  await sim.tick();
}
const offline = (d: Driver) => sim.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", d.id).execute();

describe("far rider (fix plan A2 / A11-FR)", () => {
  it("the places are the proof's: A at 6.9 km (inside the 8 km step), B at 9.5 km (outside)", () => {
    expect(dispatchKm(AT_6_9, PLACES.sergels)).toBe(6.9);
    expect(dispatchKm(AT_9_5, PLACES.sergels)).toBe(9.5);
  });

  it("A lets the Exclusive run out and goes busy: B (9.5 km) gets an offer through the far step (farReachKm 12)", async () => {
    const { tripId } = await rider.book();
    await sim.advance(1);
    expect((await offersOf(tripId, a.id)).map((o) => o.kind)).toEqual(["exclusive"]);
    await sim.advance(15); // A lets it run out; the round after goes to A again on Radar
    await goesBusy(a);
    await sim.advance(60);
    const toB = await offersOf(tripId, b.id);
    expect(toB.length, "B, the next free driver up to farReachKm, gets an offer").toBeGreaterThan(0);
  });

  it("far step off (farReachKm = widest step): the rider sees 'No driver nearby' once at 5 min, the search goes on past 8 and 10 min, admin alert", async () => {
    await setDispatch({}, { farReachKm: 8 });
    const { tripId } = await rider.book();
    await sim.advance(1);
    await sim.advance(15);
    await goesBusy(a);
    await sim.advance(300);
    const shown = await rider.trip(tripId);
    expect(shown.searchStep).toMatchObject({ kind: "no_driver_nearby" });
    expect((await findCauses(sim.db, sim.clock.now)).some((c) => c.kind === "no_driver_nearby" && c.ref["tripId"] === tripId)).toBe(true);
    // No auto-end at the 8-min busy step or the 10-min maxWait for a live ride.
    await sim.advance(420);
    const later = await rider.trip(tripId);
    expect(later.status).toMatch(/^(searching|offered)$/);
    expect(later.searchStep).toMatchObject({ kind: "no_driver_nearby" });
    const fired = (await sim.db.selectFrom("searches").select("fired").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).fired as string[];
    expect(fired.filter((id) => id === "nd")).toEqual(["nd"]);
    // A free driver who comes back still gets it (the search really runs).
    await sim.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", a.id).execute();
    await a.moveTo(AT_6_9);
    await sim.advance(30);
    expect((await offersOf(tripId, a.id)).length).toBeGreaterThan(1);
    // Keep waiting: 200, the search goes on; a second answer to the same step is refused.
    expect((await rider.command(tripId, "keep-waiting", { answer: "wait" })).status).toBe(200);
    expect((await rider.command(tripId, "keep-waiting", { answer: "wait" })).body).toMatchObject({ code: "invalid_transition" });
  });

  it("Cancel free on 'No driver nearby' is the free rider cancel", async () => {
    await setDispatch({}, { farReachKm: 8 });
    await offline(a);
    const { tripId } = await rider.book();
    await sim.advance(301);
    expect((await rider.trip(tripId)).searchStep).toMatchObject({ kind: "no_driver_nearby" });
    const stop = await rider.command(tripId, "keep-waiting", { answer: "stop" });
    expect(stop.body).toMatchObject({ status: "cancelled_by_rider", cancellation: { fee: null } });
  });

  it("one busy driver is not asked forever: after 2 offers he let pass he is not asked again in this search", async () => {
    await setDispatch({}, { farReachKm: 8 });
    await offline(b);
    const { tripId } = await rider.book();
    await sim.advance(600);
    const toA = await offersOf(tripId, a.id);
    expect(toA.filter((o) => o.status === "declined" || o.status === "expired").length).toBeLessThanOrEqual(2);
    expect(toA.length).toBeLessThanOrEqual(2);
    expect((await rider.trip(tripId)).status).toMatch(/^(searching|offered)$/);
  });

  it("the busy-driver limit is an admin setting per zone (DispatchDocument.reaskLimit): 1 = asked once", async () => {
    await setDispatch({ reaskLimit: 1 }, { farReachKm: 8 });
    await offline(b);
    const { tripId } = await rider.book();
    await sim.advance(600);
    const toA = await offersOf(tripId, a.id);
    expect(toA.length).toBe(1);
    expect((await rider.trip(tripId)).status).toMatch(/^(searching|offered)$/);
  });
});

describe("P17: a booked ride with no driver stops at pickup + 15 min", () => {
  it("still searching at pickup + 14 min; at + 15 min expired, no fee, rider told, admin alert", async () => {
    await offline(a);
    await offline(b);
    const at = new Date(sim.clock.now.getTime() + 40 * 60_000).toISOString();
    const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at })).body["quotes"][0];
    const booked = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const tripId = booked.body["tripId"] as string;
    await sim.advance((Date.parse(at) - sim.clock.now.getTime()) / 1000 + 14 * 60);
    expect((await rider.trip(tripId)).status).toMatch(/^(requested|searching|offered)$/);
    await sim.advance(65);
    const ended = await rider.trip(tripId);
    expect(ended.status).toBe("expired");
    expect(ended.searchStep).toMatchObject({ kind: "no_driver_found" });
    expect(ended.reservation).toMatchObject({ noDriverFound: true });
    expect(ended.cancellation?.fee ?? null).toBeNull();
    const pushes = await sim.db.selectFrom("notifications").select("kind").where("trip_id", "=", tripId).execute();
    expect(pushes.map((p) => p.kind)).toContain("reservation_no_driver_found");
    expect((await findCauses(sim.db, sim.clock.now)).some((c) => c.kind === "booked_no_driver_ended" && c.ref["tripId"] === tripId)).toBe(true);
    // Nothing keeps running for it.
    expect((await sim.db.selectFrom("timers").select("kind").where("ref_id", "like", `${tripId}%`).where("kind", "in", ["dispatch_round", "search_end", "search_step"]).execute()).length).toBe(0);
  });
});
