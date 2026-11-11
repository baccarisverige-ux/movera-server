import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json } from "./harness.js";

/**
 * Owner phone test 2026-11-11 (Rules decisions/session-2026-11-06.md): "double check if driver receive offers or not
 * while on trip and double check if he turn radar off while on trip do offers stop or not".
 * Rules (decisions/driver-g15.md, job 5 answer 2026-11-05, contract.json#afterTestRules.bookedNext): a driver on a trip
 * gets only Exclusive offers (live or booked), never Radar, and only once the rider is on board and he has driven at
 * least minRouteDonePct (70) % of the route. v0.18.65 §86 (contract.json#nextTripsSwitch): the trip sheet's radar
 * "stop next trips" reaches the server: no on-trip offers while it is off (fail-before: the server kept sending them,
 * only the phone hid them; POST /driver/next-trips was 404).
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let a: Driver;
let b: Driver;
let owner: Admin;
const NEAR_DROP = { lat: 59.318, lng: 18.0718 }; // ~80 % of Sergels torg → Medborgarplatsen
const ENDED = ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"];

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-11T05:00:00Z") });
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, PLACES.odenplan);
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
  await sim.db.updateTable("drivers").set({ online_status: "online", online_since: sim.clock.now, offline_after_trip: false, next_trips_off: false }).where("driver_id", "=", a.id).execute();
  await jump(3600);
  await a.moveTo(PLACES.nearSergels);
  await sim.tick();
  owner = await sim.admin("super");
});

async function jump(seconds: number) {
  sim.clock.now = new Date(sim.clock.now.getTime() + seconds * 1000);
  if (a.position) await a.heartbeat();
  await sim.tick();
}
const profile = async (d: Driver) => (await d.get("/driver/profile")).body as Json;
const nextTrips = (d: Driver, on: boolean) => d.post("/driver/next-trips", { on });
const kindsTo = async (driverId: string, tripId: string) =>
  (await sim.db.selectFrom("offers").select("kind").where("driver_id", "=", driverId).where("trip_id", "=", tripId).execute()).map((o) => o.kind);
/** A live trip for A, accepted and driven until `until`. */
async function liveTrip(until: "arrived" | "in_trip"): Promise<Json> {
  const trip = await (await sim.rider(1)).book();
  await sim.tick();
  const offer = await a.offerFor(trip.tripId);
  expect(offer, "A gets the live offer").toBeDefined();
  expect((await a.accept(offer!)).status).toBe(200);
  await drive(a, trip.tripId, until);
  return trip;
}
async function complete(tripId: string) {
  await a.moveTo(PLACES.medborgar);
  const pv = (await a.get(`/driver/trips/${tripId}/complete-preview`)).body;
  const done = await a.command(tripId, "complete", { previewId: pv.previewId, cashCollected: pv.cashDue });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
}

describe("offers while on a trip (owner phone test 2026-11-11)", () => {
  it("rule check: none before the rider is on board, none under 70 % of the route, then Exclusive only — never Radar", async () => {
    const live = await liveTrip("arrived");
    const other = await (await sim.rider(2)).book();
    await sim.tick();
    expect(await kindsTo(a.id, other.tripId), "waiting at the pickup: no offer").toEqual([]);
    await drive(a, live.tripId, "in_trip");
    await jump(31);
    expect(await kindsTo(a.id, other.tripId), "rider on board, 0 % of the route: no offer").toEqual([]);
    await a.moveTo(NEAR_DROP);
    await jump(31);
    const offer = await a.offerFor(other.tripId);
    expect(offer?.["kind"], "80 %: an Exclusive").toBe("exclusive");
    // He says no; the search goes on for minutes with Radar rounds, none of them to him.
    expect((await a.decline(offer!)).status).toBe(200);
    for (let i = 0; i < 8; i++) await jump(20);
    const kinds = await kindsTo(a.id, other.tripId);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((k) => k === "exclusive"), `only Exclusive offers to the on-trip driver: ${kinds.join(",")}`).toBe(true);
  });

  it("radar off on the trip sheet: open offer withdrawn, a late accept refused, no new offers; on again → they come; the trip end clears it", async () => {
    const live = await liveTrip("in_trip");
    await a.moveTo(NEAR_DROP);
    const first = await (await sim.rider(2)).book();
    await sim.tick();
    const inFlight = await a.offerFor(first.tripId);
    expect(inFlight?.["kind"], "control: before radar off the on-trip Exclusive comes").toBe("exclusive");

    const off = await nextTrips(a, false);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ onlineStatus: "on_trip", nextTripsOff: true });
    // Idempotent.
    expect((await nextTrips(a, false)).body).toMatchObject({ nextTripsOff: true, version: off.body["version"] });
    // The open offer cannot be taken any more (withdrawn by the job, or refused in the race window).
    const late = await a.accept(inFlight!);
    expect(late.status).toBe(409);
    expect(["next_trips_off", "offer_withdrawn"]).toContain(late.body["reason"]);
    await sim.tick();
    expect(await a.offerFor(first.tripId), "withdrawn at once").toBeUndefined();
    // New rides: nothing to A while it is off.
    const second = await (await sim.rider(0)).book();
    for (let i = 0; i < 3; i++) await jump(20);
    expect(await kindsTo(a.id, second.tripId), "no offer while next trips are off").toEqual([]);
    // Admin Live shows it.
    const liveList = (await owner.get("/admin/live/drivers")).body as Json;
    expect((liveList["items"] as Json[]).find((d) => d["driverId"] === a.id)).toMatchObject({ onlineStatus: "on_trip", nextTripsOff: true });
    // The profile carries it (an app restart shows the radar off again).
    expect(await profile(a)).toMatchObject({ nextTripsOff: true });

    // Radar on again: the next round offers him a waiting ride.
    expect((await nextTrips(a, true)).body).toMatchObject({ nextTripsOff: false });
    let back: Json | undefined;
    for (let i = 0; i < 6 && back === undefined; i++) {
      await jump(20);
      back = (await a.offers()).find((o) => o["tripId"] === first.tripId || o["tripId"] === second.tripId);
    }
    expect(back?.["kind"], "radar on: on-trip Exclusives come again").toBe("exclusive");
    await a.decline(back!);

    // Off again, then the trip ends: the next trip starts with it on.
    expect((await nextTrips(a, false)).body).toMatchObject({ nextTripsOff: true });
    await complete(live.tripId);
    expect(await profile(a)).toMatchObject({ onlineStatus: "online", nextTripsOff: false });
  });

  it("radar off, then his queued next trip is cancelled by its rider: the switch stays off until his last trip ends (fail-before: cleared while trip A ran, offers came again)", async () => {
    // Owner "Yes, prove + fix" 2026-11-11 (Rules decisions/session-2026-11-06.md): the switch belongs to the trip he is
    // driving; a queued next trip that ends (here cancelled by its rider) does not end that trip.
    const live = await liveTrip("in_trip");
    await a.moveTo(NEAR_DROP);
    const queuedRider = await sim.rider(2);
    const queued = await queuedRider.book();
    await sim.tick();
    const offer = await a.offerFor(queued.tripId);
    expect(offer?.["kind"], "control: the on-trip Exclusive comes").toBe("exclusive");
    expect((await a.accept(offer!)).status).toBe(200);
    expect(await sim.db.selectFrom("trips").select(["status", "next_after_trip_id"]).where("trip_id", "=", queued.tripId).executeTakeFirstOrThrow()).toEqual({ status: "accepted", next_after_trip_id: live.tripId });

    expect((await nextTrips(a, false)).body).toMatchObject({ onlineStatus: "on_trip", nextTripsOff: true });
    const cancelled = await queuedRider.command(queued.tripId, "cancel", { reasonCode: "plans_changed" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body["status"]).toBe("cancelled_by_rider");
    // Trip A still runs: the radar on his trip sheet is still off, and so is the server's switch.
    expect(await profile(a), "the switch stays off while trip A runs").toMatchObject({ onlineStatus: "on_trip", activeTripId: live.tripId, nextTripsOff: true });
    const other = await (await sim.rider(0)).book();
    for (let i = 0; i < 3; i++) await jump(20);
    expect(await kindsTo(a.id, other.tripId), "no offer to him while next trips are off").toEqual([]);

    // His last trip ends: the switch goes back on.
    await complete(live.tripId);
    expect(await profile(a)).toMatchObject({ onlineStatus: "online", nextTripsOff: false });
  });

  it("an accept in the race window (switch off, withdraw job not run yet) is refused 409 next_trips_off", async () => {
    await liveTrip("in_trip");
    await a.moveTo(NEAR_DROP);
    const ride = await (await sim.rider(2)).book();
    await sim.tick();
    const open = await a.offerFor(ride.tripId);
    expect(open?.["kind"]).toBe("exclusive");
    // The switch as the route leaves it, before the withdraw_driver_offers job closes his open offer.
    await sim.db.updateTable("drivers").set({ next_trips_off: true }).where("driver_id", "=", a.id).execute();
    expect((await sim.db.selectFrom("offers").select("status").where("offer_id", "=", open!["offerId"] as string).executeTakeFirstOrThrow()).status).toBe("open");
    const late = await a.accept(open!);
    expect([late.status, late.body["reason"]]).toEqual([409, "next_trips_off"]);
    expect((await sim.db.selectFrom("trips").select("driver_id").where("trip_id", "=", ride.tripId).executeTakeFirstOrThrow()).driver_id).toBeNull();
  });

  it("off a trip the switch changes nothing (the Home radar is the online switch)", async () => {
    const before = await profile(a);
    const res = await nextTrips(a, false);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ onlineStatus: "online", nextTripsOff: false, version: before["version"] });
  });

  it("go offline after the trip: no offers after completion, the driver is offline (server side of the phone bug)", async () => {
    const live = await liveTrip("in_trip");
    const p = await profile(a);
    expect((await a.post("/driver/availability", { expectedVersion: p["version"], onlineStatus: "offline" })).body).toMatchObject({ offlineAfterTrip: true });
    await complete(live.tripId);
    expect(await profile(a)).toMatchObject({ onlineStatus: "offline", offlineReason: "after_trip", offlineAfterTrip: false });
    await a.moveTo(PLACES.nearSergels);
    const next = await (await sim.rider(2)).book();
    for (let i = 0; i < 3; i++) await jump(20);
    expect(await kindsTo(a.id, next.tripId), "offline after the trip: no offers").toEqual([]);
  });
});
