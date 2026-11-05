import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Driver, type Json, type Rider } from "./harness.js";

/**
 * v0.18.32 fix job 2 "Rider sees booked ride" + P21 / B-n (contract.json#bookedRideSeen; owner fix-plan Q5,
 * job-2 Q1 "Live ride + banner", Q2 driver change, Rules decisions/driver-g15.md).
 */
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let other: Rider;
let a: Driver;
let b: Driver;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-05T05:00:00Z") });
  rider = await sim.rider(0);
  other = await sim.rider(1);
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
  await jump(6 * 3600);
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
async function started() {
  const trip = await book(minutes(120));
  expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
  await until(new Date(Date.parse(trip.scheduledAt) - 60 * 60_000).toISOString(), 1);
  const start = await a.post(`/driver/reservations/${trip.tripId}/start`, {});
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  return trip;
}
const active = () => rider.get("/rider/trips/active");

describe("rider sees the booked ride (job 2)", () => {
  it("a booked ride is not the active trip before its driver starts driving (it stays under Upcoming)", async () => {
    const trip = await book(minutes(120));
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    expect((await active()).status).toBe(204);
  });

  it("owner Q5: once the driver drives to the pickup, GET /rider/trips/active returns the booked trip like a regular ride", async () => {
    const trip = await started();
    const res = await active();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tripId: trip.tripId, kind: "scheduled", status: "driver_to_pickup" });
    expect(res.body.driver?.driverId).toBe(a.id);
  });

  it("owner Q1 'Live ride + banner': a live ride and a started booked ride → the live ride is returned; the booked one is listed for the banner", async () => {
    const booked = await started();
    const quote = (await rider.quote({ categoryIds: ["economy"] })).body.quotes[0];
    const live = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "live", paymentMethod: "cash" });
    expect(live.status, JSON.stringify(live.body)).toBe(201);
    const res = await active();
    expect(res.body).toMatchObject({ tripId: live.body.tripId, kind: "live" });
    const banner = await rider.get("/rider/trips?kind=scheduled&status=driver_to_pickup&status=arrived");
    expect(banner.body.items.map((t: Json) => t.tripId)).toContain(booked.tripId);
  });

  it("owner Q2: after the driver started, a give-back keeps the booked trip on the rider's screen while a new driver is searched", async () => {
    const trip = await started();
    const t = (await a.get(`/trips/${trip.tripId}`)).body;
    const cancel = await a.post(`/trips/${trip.tripId}/cancel`, { expectedVersion: t.version, reasonCode: "scheduled_other" });
    expect(cancel.status, JSON.stringify(cancel.body)).toBeLessThan(300);
    const res = await active();
    expect(res.status).toBe(200);
    expect(res.body.tripId).toBe(trip.tripId);
    expect(["searching", "offered", "accepted", "requested"]).toContain(res.body.status);
  });

  it("leave-now push carries the rider's first name (popup 'Time to drive to pickup · name')", async () => {
    const trip = await book(minutes(180));
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    await jump(2 * 60 + 5);
    const leaveAt = Date.parse((await a.get(`/trips/${trip.tripId}`)).body.reservation.leaveAt);
    await until(new Date(leaveAt).toISOString(), 125);
    const note = await sim.db.selectFrom("notifications").select(["title", "data"]).where("subject_id", "=", a.id).where("trip_id", "=", trip.tripId).where("kind", "=", "reservation_leave_now").executeTakeFirstOrThrow();
    const summary = (await sim.db.selectFrom("trips").select("rider_summary").where("trip_id", "=", trip.tripId).executeTakeFirstOrThrow()).rider_summary as unknown;
    const name = ((typeof summary === "string" ? JSON.parse(summary) : summary) as { firstName: string }).firstName;
    expect(name.length).toBeGreaterThan(0);
    expect((note.data as Json).riderFirstName).toBe(name);
    expect(note.title.endsWith(`· ${name}`)).toBe(true);
    const row = (await a.get("/driver/reservations?scope=accepted")).body.items.find((r: Json) => r.tripId === trip.tripId);
    expect(row.riderFirstName).toBe(name);
  });
});

describe("P21 / B-n: the rider hears about a trip made elsewhere", () => {
  it("rider_trip_changed arrives on the rider config stream for a trip booked by another device, and never for another rider's trip", async () => {
    await rider.get("/rider/profile"); // the clock jumped hours: the app refreshes its token first
    const stream = await sim.stream("/rider/config/stream?zoneId=Z001", rider.token);
    const otherQuote = (await other.quote({ categoryIds: ["economy"] })).body.quotes[0];
    const elsewhere = await other.post("/trips", { quoteId: otherQuote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "live", paymentMethod: "cash" });
    expect(elsewhere.status).toBe(201);
    // "Another phone" of the same rider: a plain API call with the same account, not through this stream's app.
    const quote = (await rider.quote({ categoryIds: ["economy"] })).body.quotes[0];
    const made = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "live", paymentMethod: "cash" });
    expect(made.status).toBe(201);
    const event = await stream.waitFor((e) => e.data["kind"] === "rider_trip_changed");
    expect(event.data).toMatchObject({ kind: "rider_trip_changed", tripId: made.body.tripId });
    expect(stream.events.some((e) => e.data["tripId"] === elsewhere.body.tripId)).toBe(false);
    stream.close();
  });
});
