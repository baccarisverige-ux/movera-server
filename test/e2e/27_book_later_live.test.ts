import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/** v0.18.19 Book later live test fixes (Rules audits/live-book-later-2026-11-03.md). */
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;
let owner: Admin;

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
  await jump(6 * 3600);
  owner = await sim.admin("super");
});
async function jump(seconds: number) {
  sim.clock.now = new Date(sim.clock.now.getTime() + seconds * 1000);
  for (const d of [a, b]) if (d.position) await d.heartbeat();
  await sim.tick();
}
const minutes = (m: number) => new Date(sim.clock.now.getTime() + m * 60_000).toISOString();
const until = (at: string, plus = 0) => jump((Date.parse(at) - sim.clock.now.getTime()) / 1000 + plus);
async function book(at: string, extra: Json = {}) {
  const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at, ...extra })).body.quotes[0];
  const res = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: extra.dropoff ?? PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
const kinds = async (subjectId: string, tripId: string) => (await sim.db.selectFrom("notifications").select("kind").where("subject_id", "=", subjectId).where("trip_id", "=", tripId).orderBy("created_at").execute()).map((n) => n.kind);
const version = async (tripId: string) => (await owner.get(`/admin/trips/${tripId}`)).body.version;

describe("book later live fixes", () => {
  it("HIGH 1: an admin no-show is refused before the pickup time + the no-show wait", async () => {
    const trip = await book(minutes(120));
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    await until(new Date(Date.parse(trip.scheduledAt) - 29 * 60_000).toISOString());
    const early = await owner.tripCommand(trip.tripId, "no-show", { expectedVersion: await version(trip.tripId), note: "rider not there" });
    expect(early.body).toMatchObject({ reason: "no_show_too_early" });
    expect((await rider.trip(trip.tripId)).status).toBe("accepted");
  });

  it("MED 7: give a ride hours ahead to an offline driver (offer waits, notice sent); a group offer skips who cannot take it", async () => {
    const profile = (await b.get("/driver/profile")).body;
    expect((await b.post("/driver/availability", { expectedVersion: profile.version, onlineStatus: "offline" })).status).toBe(200);
    const trip = await book(minutes(240));
    const given = await owner.tripCommand(trip.tripId, "assign", { expectedVersion: await version(trip.tripId), driverId: b.id });
    expect(given.status, JSON.stringify(given.body)).toBe(200);
    expect(await kinds(b.id, trip.tripId)).toContain("reservation_offered");
    const offer = await sim.db.selectFrom("offers").select("expires_at").where("trip_id", "=", trip.tripId).where("driver_id", "=", b.id).executeTakeFirstOrThrow();
    expect(offer.expires_at.getTime()).toBeGreaterThan(sim.clock.now.getTime() + 3 * 3600_000);
    // A ride soon: the offline driver is skipped, the online one gets it.
    await b.goOnline(PLACES.odenplan);
    const p2 = (await b.get("/driver/profile")).body;
    await b.post("/driver/availability", { expectedVersion: p2.version, onlineStatus: "offline" });
    const soon = await book(minutes(20));
    await sim.tick();
    const group = await owner.tripCommand(soon.tripId, "radar-group", { expectedVersion: await version(soon.tripId), driverIds: [a.id, b.id] });
    expect(group.status, JSON.stringify(group.body)).toBe(200);
    expect(group.body.skipped.map((s: Json) => s.driverId)).toContain(b.id);
    await b.goOnline(PLACES.odenplan);
  });

  it("MED 9: the rider hears 'driver found' once per driver (not again on keep or re-accept)", async () => {
    const trip = await book(minutes(240));
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    const q = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: minutes(260) })).body.quotes[0];
    expect((await rider.post(`/trips/${trip.tripId}/reschedule`, { quoteId: q.quoteId, expectedVersion: (await rider.trip(trip.tripId)).version })).status).toBe(200);
    expect((await a.post(`/driver/reservations/${trip.tripId}/keep`, { keep: true })).status).toBe(200);
    const found = (await kinds(rider.id, trip.tripId)).filter((k) => k === "reservation_driver_found" || k === "trip");
    expect(found).toEqual(["reservation_driver_found"]);
    // A new driver after a give-back: told once more.
    expect((await a.post(`/driver/reservations/${trip.tripId}/release`, { reasonCode: "scheduled_other" })).status).toBe(204);
    expect((await b.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    expect((await kinds(rider.id, trip.tripId)).filter((k) => k === "reservation_driver_found")).toHaveLength(2);
  });

  it("MED 8: the rider's 1 h reminder still comes after 3 changes and an admin send-now", async () => {
    const trip = await book(minutes(240));
    for (const at of [200, 190, 180]) {
      const q = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: minutes(at) })).body.quotes[0];
      expect((await rider.post(`/trips/${trip.tripId}/reschedule`, { quoteId: q.quoteId, expectedVersion: (await rider.trip(trip.tripId)).version })).status).toBe(200);
    }
    const now = (await rider.trip(trip.tripId));
    expect((await owner.tripCommand(trip.tripId, "reservation/dispatch-now", { expectedVersion: await version(trip.tripId) })).status).toBe(200);
    await until(new Date(Date.parse(now.scheduledAt) - 60 * 60_000).toISOString(), 2);
    expect(await kinds(rider.id, trip.tripId)).toContain("reservation_reminder");
  });

  it("LOW 15: the rider config sends the 90-day horizon", async () => {
    expect((await rider.get("/rider/config?zoneId=Z001")).body.booking).toMatchObject({ bookingHorizonDays: 90, maxAheadDays: 90 });
  });

  it("owner A: booked rides switched off in the zone are refused (reservations_off)", async () => {
    await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...(doc.reservations ?? {}), on: false } }));
    expect((await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: minutes(120) })).body).toMatchObject({ reason: "reservations_off" });
    expect((await rider.quote({ categoryIds: ["economy"] })).status).toBe(201);
    await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...(doc.reservations ?? {}), on: true } }));
  });

  it("owner D: the rider sees 'driver assigned' without details until the driver drives; owner B: free waiting from the pickup time", async () => {
    const trip = await book(minutes(120));
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    const held = await rider.trip(trip.tripId);
    expect(held.driverAssigned).toBe(true);
    expect(held.driver).toBeUndefined();
    expect(held.driverLocation).toBeUndefined();
    const notes = await sim.db.selectFrom("notifications").select("body").where("subject_id", "=", rider.id).where("kind", "=", "reservation_driver_found").execute();
    expect(notes.every((n) => !n.body.includes("Test"))).toBe(true);
    await until(new Date(Date.parse(trip.scheduledAt) - 60 * 60_000).toISOString(), 1);
    expect((await a.post(`/driver/reservations/${trip.tripId}/start`, {})).status).toBe(200);
    const driving = await rider.trip(trip.tripId);
    expect(driving.driver?.driverId).toBe(a.id);
    // The driver arrives 5 min late: the free wait still ends at pickup + free minutes.
    await until(new Date(Date.parse(trip.scheduledAt) + 5 * 60_000).toISOString());
    const arrived = await a.command(trip.tripId, "arrive", { location: a.fix(PLACES.sergels) });
    expect(arrived.status, JSON.stringify(arrived.body)).toBe(200);
    const free = arrived.body.terms.freeWaitMin as number;
    expect(Date.parse(arrived.body.waiting.freeUntil)).toBe(Date.parse(trip.scheduledAt) + free * 60_000);
  });

  it("owner C: a booked ride being searched takes a raise like a live ride", async () => {
    const trip = await book(minutes(20));
    const t = await rider.trip(trip.tripId);
    const raised = await rider.post(`/trips/${trip.tripId}/raise-price`, { expectedVersion: t.version, increase: { amountMinor: 1000, currency: "SEK" } });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect(raised.body.fare.amountMinor).toBe(t.fare.amountMinor + 1000);
  });
});
