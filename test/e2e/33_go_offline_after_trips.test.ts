import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * v0.18.37 §61 Go offline after trips (owner 2026-11-05, Rules decisions/driver-g15.md, plan
 * GO-OFFLINE-AFTER-TRIPS-PLAN-2026-11-05.md): "Go offline" during a trip = scheduled offline. From the tap no new offers
 * (the 70 % on-trip Exclusives too); he finishes the current trip, a queued next trip and a held booked ride that is
 * due, then goes offline (Driver.offlineReason after_trip). A booked ride for later stays his. No admin switch.
 * Fail-before (main 0.18.35): the tap answered 409 on_trip and nothing was scheduled.
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;
let owner: Admin;
const NEAR_DROP = { lat: 59.318, lng: 18.0718 }; // ~80 % of Sergels torg → Medborgarplatsen
const ENDED = ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"];

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-05T05:00:00Z") });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, PLACES.odenplan);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
beforeEach(async () => {
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ENDED as never).execute();
  await sim.db.updateTable("offers").set({ status: "withdrawn" }).where("status", "=", "open").execute();
  // Only A is around (B offline), so every offer of a case is A's or nobody's.
  await sim.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", b.id).execute();
  await sim.db.updateTable("drivers").set({ online_status: "online", online_since: sim.clock.now }).where("driver_id", "=", a.id).execute();
  await sql`UPDATE drivers SET offline_after_trip = false`.execute(sim.db).catch(() => undefined);
  sim.clock.now = new Date(sim.clock.now.getTime() + 3600_000);
  await a.moveTo(PLACES.nearSergels);
  await sim.tick();
  owner = await sim.admin("super");
});

const profile = async (d: Driver) => (await d.get("/driver/profile")).body as Json;
async function tapOffline(d: Driver) {
  const p = await profile(d);
  return d.post("/driver/availability", { expectedVersion: p["version"], onlineStatus: "offline" });
}
async function tapOnline(d: Driver) {
  const p = await profile(d);
  return d.post("/driver/availability", { expectedVersion: p["version"], onlineStatus: "online" });
}
/** A live trip for A, driven until the rider is on board. */
async function liveTrip(riderIndex: 1 | 2): Promise<Json> {
  const r = await sim.rider(riderIndex);
  const trip = await r.book();
  await sim.tick();
  const offer = await a.offerFor(trip.tripId);
  expect(offer, "A gets the live offer").toBeDefined();
  expect((await a.accept(offer!)).status).toBe(200);
  await drive(a, trip.tripId, "in_trip");
  return trip;
}
async function complete(d: Driver, tripId: string) {
  await d.moveTo(PLACES.medborgar);
  const pv = (await d.get(`/driver/trips/${tripId}/complete-preview`)).body;
  const done = await d.command(tripId, "complete", { previewId: pv.previewId, cashCollected: pv.cashDue });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
}
async function bookLater(minutesAhead: number): Promise<Json> {
  const at = new Date(sim.clock.now.getTime() + minutesAhead * 60_000).toISOString();
  const quotes = await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at });
  expect(quotes.status, JSON.stringify(quotes.body)).toBe(201);
  const res = await rider.post("/trips", { quoteId: quotes.body["quotes"][0].quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const took = await a.post(`/driver/reservations/${res.body.tripId}/accept`, { expectedVersion: res.body.version });
  expect(took.status, JSON.stringify(took.body)).toBe(200);
  return res.body;
}

describe("go offline after trips (0.18.37 §61, owner 2026-11-05)", () => {
  it("tap during a trip: 200, stays on_trip with offlineAfterTrip; the trip ends → offline, reason after_trip (fail-before: 409 on_trip)", async () => {
    const live = await liveTrip(1);
    const tap = await tapOffline(a);
    expect(tap.status, JSON.stringify(tap.body)).toBe(200);
    expect(tap.body).toMatchObject({ onlineStatus: "on_trip", offlineAfterTrip: true });
    expect(typeof tap.body["offlineAfterTripSince"]).toBe("string");
    // Tapping twice is the same answer (idempotent).
    expect((await tapOffline(a)).body).toMatchObject({ onlineStatus: "on_trip", offlineAfterTrip: true });
    await complete(a, live.tripId);
    const after = await profile(a);
    expect(after).toMatchObject({ onlineStatus: "offline", offlineReason: "after_trip", offlineAfterTrip: false });
    const notices = await sim.db.selectFrom("notifications").select(["kind", "data"]).where("subject_id", "=", a.id).where("kind", "=", "set_offline").orderBy("created_at", "desc").executeTakeFirst();
    expect(notices?.data).toMatchObject({ reason: "after_trip" });
  });

  it("undo (online while on a trip) clears it; the trip ends → online again", async () => {
    const live = await liveTrip(1);
    expect((await tapOffline(a)).body).toMatchObject({ offlineAfterTrip: true });
    const undo = await tapOnline(a);
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ onlineStatus: "on_trip", offlineAfterTrip: false });
    await complete(a, live.tripId);
    expect(await profile(a)).toMatchObject({ onlineStatus: "online", offlineAfterTrip: false });
  });

  it("no offers after the tap, the 70 % on-trip Exclusive included; an accept in the race window is refused going_offline", async () => {
    const live = await liveTrip(1);
    await a.moveTo(NEAR_DROP); // 80 % of his route: normally he gets live Exclusives now (job 5)
    // An Exclusive in flight before the tap …
    const first = await (await sim.rider(2)).book();
    await sim.tick();
    const inFlight = await a.offerFor(first.tripId);
    expect(inFlight?.["kind"], "control: before the tap the on-trip Exclusive comes").toBe("exclusive");
    expect((await tapOffline(a)).status).toBe(200);
    // … cannot be taken after the tap (withdrawn by the job, or refused if he taps in the race window).
    const late = await a.accept(inFlight!);
    expect(late.status).toBe(409);
    expect(["going_offline", "offer_withdrawn"]).toContain(late.body["reason"]);
    await sim.tick();
    // A new live ride: no offer to A at all.
    const second = await rider.book();
    await sim.tick();
    await sim.tick();
    expect(await a.offerFor(second.tripId), "no offer after the tap").toBeUndefined();
    const offers = await sim.db.selectFrom("offers").select("offer_id").where("driver_id", "=", a.id).where("trip_id", "=", second.tripId).execute();
    expect(offers).toEqual([]);
    await complete(a, live.tripId);
    expect((await profile(a))["onlineStatus"]).toBe("offline");
  });

  it("a queued next trip (accepted before the tap) still happens, then offline", async () => {
    const live = await liveTrip(1);
    await a.moveTo(NEAR_DROP);
    const next = await (await sim.rider(2)).book();
    await sim.tick();
    const offer = await a.offerFor(next.tripId);
    expect(offer?.["kind"]).toBe("exclusive");
    expect((await a.accept(offer!)).status).toBe(200);
    expect((await tapOffline(a)).body).toMatchObject({ onlineStatus: "on_trip", offlineAfterTrip: true });
    await complete(a, live.tripId);
    // The queued trip is his current trip now; he is still on a trip and still going offline after it.
    const queued = await sim.db.selectFrom("trips").select(["status", "driver_id", "next_after_trip_id"]).where("trip_id", "=", next.tripId).executeTakeFirstOrThrow();
    expect(queued).toEqual({ status: "accepted", driver_id: a.id, next_after_trip_id: null });
    expect(await profile(a)).toMatchObject({ onlineStatus: "on_trip", offlineAfterTrip: true });
    await a.moveTo(PLACES.sergels);
    await drive(a, next.tripId, "in_trip");
    await complete(a, next.tripId);
    expect(await profile(a)).toMatchObject({ onlineStatus: "offline", offlineReason: "after_trip", offlineAfterTrip: false });
  });

  it("a held booked ride that is due starts after the trip, then offline", async () => {
    const booked = await bookLater(180);
    const live = await liveTrip(1);
    expect((await tapOffline(a)).status).toBe(200);
    // Its time to drive has come while he is on the live trip (pickup in 20 min, leave time passed).
    await sim.db.updateTable("trips").set({ scheduled_at: new Date(sim.clock.now.getTime() + 20 * 60_000), reservation: sql`reservation || jsonb_build_object('leaveAt', ${new Date(sim.clock.now.getTime() - 60_000).toISOString()}::text)` }).where("trip_id", "=", booked.tripId).execute();
    await complete(a, live.tripId);
    const started = await sim.db.selectFrom("trips").select(["status", "driver_id"]).where("trip_id", "=", booked.tripId).executeTakeFirstOrThrow();
    expect(started).toEqual({ status: "driver_to_pickup", driver_id: a.id });
    expect(await profile(a)).toMatchObject({ onlineStatus: "on_trip", offlineAfterTrip: true });
    expect((await rider.command(booked.tripId, "cancel", { reasonCode: "plans_changed" })).status).toBe(200);
    expect(await profile(a)).toMatchObject({ onlineStatus: "offline", offlineReason: "after_trip" });
  });

  it("a booked ride for later stays his after he goes offline", async () => {
    const booked = await bookLater(180);
    const live = await liveTrip(1);
    expect((await tapOffline(a)).status).toBe(200);
    await complete(a, live.tripId);
    expect(await profile(a)).toMatchObject({ onlineStatus: "offline", offlineReason: "after_trip" });
    const kept = await sim.db.selectFrom("trips").select(["status", "driver_id"]).where("trip_id", "=", booked.tripId).executeTakeFirstOrThrow();
    expect(kept).toEqual({ status: "accepted", driver_id: a.id });
    expect(((await a.get("/driver/reservations?scope=accepted")).body["items"] as Json[]).map((i) => i["tripId"])).toContain(booked.tripId);
  });

  it("a cancelled trip ends it the same way; the admin driver view shows offlineAfterTrip", async () => {
    const r = await sim.rider(1);
    const trip = await r.book();
    await sim.tick();
    expect((await a.accept((await a.offerFor(trip.tripId))!)).status).toBe(200);
    expect((await tapOffline(a)).status).toBe(200);
    const view = await owner.get(`/admin/drivers/${a.id}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ offlineAfterTrip: true });
    // The admin live drivers list carries it too ("Going offline after trips").
    const live = await owner.get("/admin/live/drivers");
    expect(((live.body["items"] as Json[]).find((d) => d["driverId"] === a.id) ?? {})["offlineAfterTrip"]).toBe(true);
    expect((await r.command(trip.tripId, "cancel", { reasonCode: "plans_changed" })).status).toBe(200);
    expect(await profile(a)).toMatchObject({ onlineStatus: "offline", offlineReason: "after_trip", offlineAfterTrip: false });
  });
});
