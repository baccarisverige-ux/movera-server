import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Driver, type Json, type Rider } from "./harness.js";

/**
 * v0.18.152 (contract.json#bookedRideSeen.searchSeen; owner 2026-11-21 15:00, Rules decisions/session-2026-11-06.md
 * "2026-11-21 15:15 OWNER DECISION (booked rides, rider screens)"): (A) a booked ride whose search started and that NO list
 * driver ever held is shown to the rider exactly like a normal ride (Finding driver → driver accepted with the driver shown
 * → on the way → …); (B) a ride held for later shows only "driver assigned"; a ride a list driver gave back before driving
 * keeps showing nothing (owner Q2 2026-11-05).
 */
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-05T05:00:00Z") });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, PLACES.odenplan);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
beforeEach(async () => {
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
  await sim.db.updateTable("drivers").set({ online_status: "online" }).where("online_status", "=", "on_trip").execute();
  // The trips closed above leave no open offer behind (an open offer keeps the driver from the next one).
  await sim.db.updateTable("offers").set({ status: "withdrawn" }).where("status", "=", "open").execute();
  await jump(6 * 3600);
  await rider.get("/rider/profile"); // the clock jumped hours: the app refreshes its token first
});
async function jump(seconds: number) {
  sim.clock.now = new Date(sim.clock.now.getTime() + seconds * 1000);
  for (const d of [a, b]) if (d.position) await d.heartbeat();
  await sim.tick();
}
const minutes = (m: number) => new Date(sim.clock.now.getTime() + m * 60_000).toISOString();
const until = (at: string, plus = 0) => jump((Date.parse(at) - sim.clock.now.getTime()) / 1000 + plus);
async function book(at: string) {
  const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at })).body.quotes[0];
  const res = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Json;
}
const active = () => rider.get("/rider/trips/active");
/** The rider's "driver found" pushes of a trip: the normal ride's (kind trip_update, moment driver_found) and the booked one's. */
async function found(tripId: string) {
  const rows = await sim.db.selectFrom("notifications").select(["kind", "data"]).where("subject_id", "=", rider.id).where("trip_id", "=", tripId).execute();
  return {
    normal: rows.filter((r) => r.kind === "trip_update" && (r.data as Json | null)?.moment === "driver_found").length,
    booked: rows.filter((r) => r.kind === "reservation_driver_found").length,
  };
}
/** The first open offer of the trip and the driver who has it. */
async function offered(tripId: string): Promise<{ driver: Driver; offer: Json }> {
  await sim.tick();
  for (const d of [a, b]) {
    const offer = await d.offerFor(tripId);
    if (offer) return { driver: d, offer };
  }
  throw new Error(`no offer for ${tripId}`);
}

describe("v0.18.152 (A): a booked ride being searched, never held by a list driver, is a normal ride for the rider", () => {
  it("GET /rider/trips/active returns it while it is searched (booked under 30 min ahead: the search starts at once)", async () => {
    const trip = await book(minutes(20));
    await sim.tick();
    const res = await active();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ tripId: trip.tripId, kind: "scheduled" });
    expect(["searching", "offered"]).toContain(res.body.status);
  });

  it("the search starts 30 min before the pickup: from then the trip is the active trip (before it stays under Upcoming)", async () => {
    const trip = await book(minutes(120));
    expect((await active()).status).toBe(204);
    await until(new Date(Date.parse(trip.scheduledAt as string) - 30 * 60_000).toISOString(), 5);
    const res = await active();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tripId).toBe(trip.tripId);
    expect(["searching", "offered"]).toContain(res.body.status);
  });

  it("a driver accepts the offer: the rider sees the driver at once and gets ONE driver_found push (no reservation_driver_found)", async () => {
    const trip = await book(minutes(20));
    const { driver, offer } = await offered(trip.tripId as string);
    const accepted = await driver.accept(offer);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const mine = await rider.trip(trip.tripId as string);
    expect(mine.status).toBe("accepted");
    expect(mine.driver?.driverId).toBe(driver.id);
    expect(mine.driverAssigned).toBeUndefined();
    const res = await active();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tripId: trip.tripId, status: "accepted" });
    expect(res.body.driver?.driverId).toBe(driver.id);
    expect(await found(trip.tripId as string)).toEqual({ normal: 1, booked: 0 });
    // Driving on: still one push, the normal ride screens.
    expect((await driver.command(trip.tripId as string, "head-to-pickup")).status).toBe(200);
    expect(await found(trip.tripId as string)).toEqual({ normal: 1, booked: 0 });
  });
});

describe("v0.18.152 (B) + owner Q2: a list driver's ride stays hidden until he drives", () => {
  it("held for later: not the active trip, 'driver assigned' only, the booked push", async () => {
    const trip = await book(minutes(120));
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    expect((await active()).status).toBe(204);
    const held = await rider.trip(trip.tripId as string);
    expect(held.driverAssigned).toBe(true);
    expect(held.driver).toBeUndefined();
    expect(await found(trip.tripId as string)).toEqual({ normal: 0, booked: 1 });
  });

  it("given back before driving, then searched and taken by a new driver: the rider still sees nothing until that driver drives", async () => {
    const trip = await book(minutes(120));
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    expect((await a.post(`/driver/reservations/${trip.tripId}/release`, { reasonCode: "scheduled_other" })).status).toBe(204);
    await until(new Date(Date.parse(trip.scheduledAt as string) - 30 * 60_000).toISOString(), 5);
    const searching = await rider.trip(trip.tripId as string);
    expect(["searching", "offered"]).toContain(searching.status);
    expect((await active()).status).toBe(204);
    const { driver, offer } = await offered(trip.tripId as string);
    expect((await driver.accept(offer)).status).toBe(200);
    expect((await active()).status).toBe(204);
    const taken = await rider.trip(trip.tripId as string);
    expect(taken.status).toBe("accepted");
    expect(taken.driver).toBeUndefined();
    expect(taken.driverAssigned).toBe(true);
    // The booked push as before (once per driver), never the normal one.
    expect(await found(trip.tripId as string)).toEqual({ normal: 0, booked: 2 });
    // He drives to the pickup: from then the normal ride (owner fix-plan Q5).
    expect((await driver.command(trip.tripId as string, "head-to-pickup")).status).toBe(200);
    const res = await active();
    expect(res.status).toBe(200);
    expect(res.body.driver?.driverId).toBe(driver.id);
  });
});
