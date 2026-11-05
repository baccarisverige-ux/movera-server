import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setLeaveRouter } from "../../src/reservations/service.js";
import { EstimateRouter, type Router } from "../../src/maps/routing.js";
import { fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * FIX JOB 4 "take-back" (contract v0.18.35 §59, contract.json#bookedTakeBack; owner Q2 / Q-A / Q-B / fix-plan Q2 and
 * job-4 Q2–Q4 of 2026-11-04, Rules decisions/driver-g15.md). A booked ride is taken back from its driver in ONE case:
 * he would be more than 5 min late, he is more than 10 min' drive away and the pickup is at least 15 min away.
 */
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;
let owner: Admin;
/** The drive the leave check sees (minutes); each test sets it. */
let driveMin = 10;
const leaveRouter = { route: async () => ({ distanceMeters: driveMin * 800, durationSeconds: driveMin * 60, source: "osrm" }) } as unknown as Router;

beforeAll(async () => {
  // The ETA ticks (heading check) route through this fake OSRM: a car that does not move never gets closer.
  osrm = await fakeOsrm({ distance: 20_000, duration: 1800 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-05T05:00:00Z") });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, PLACES.odenplan);
  setLeaveRouter(leaveRouter);
});
afterAll(async () => {
  setLeaveRouter(new EstimateRouter());
  await sim.stop();
  await osrm.close();
});
beforeEach(async () => {
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
  await sim.db.updateTable("drivers").set({ online_status: "online" }).where("online_status", "=", "on_trip").execute();
  await jump(6 * 3600);
  owner = await sim.admin("super");
});
afterEach(() => {
  driveMin = 10;
});
async function jump(seconds: number) {
  sim.clock.now = new Date(sim.clock.now.getTime() + seconds * 1000);
  for (const d of [a, b]) if (d.position) await d.heartbeat();
  await sim.tick();
}
const minutes = (m: number) => new Date(sim.clock.now.getTime() + m * 60_000).toISOString();
/** Jump to `min` minutes before the pickup in 1-minute steps (each step runs the timers due, like the server). */
async function walkTo(scheduledAt: string, min: number) {
  const target = Date.parse(scheduledAt) - min * 60_000;
  while (sim.clock.now.getTime() + 60_000 <= target) await jump(60);
  if (sim.clock.now.getTime() < target) await jump((target - sim.clock.now.getTime()) / 1000);
}
async function book(at: string) {
  const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at })).body.quotes[0];
  const res = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
const kinds = async (subjectId: string, tripId: string) => (await sim.db.selectFrom("notifications").select("kind").where("subject_id", "=", subjectId).where("trip_id", "=", tripId).orderBy("created_at").execute()).map((n) => n.kind);
const cancels = async (tripId: string) => sim.db.selectFrom("driver_cancels").select(["driver_id", "reason_code"]).where("trip_id", "=", tripId).execute();
const adminTrip = async (tripId: string) => (await owner.get(`/admin/trips/${tripId}`)).body;
async function zoneReservations(change: Json) {
  await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...(doc.reservations ?? {}), ...change } }));
}

describe("job 4: booked take-back", () => {
  it("L6: a ride given back goes to the next driver with a clean leave state: he gets his own 'start now' and late-risk notices", async () => {
    driveMin = 60;
    const trip = await book(minutes(180));
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    // Leave at pickup − 10 − 60 min; 5 min after it he is at risk.
    await walkTo(trip.scheduledAt, 64);
    expect(await kinds(a.id, trip.tripId)).toEqual(expect.arrayContaining(["reservation_leave_now", "reservation_late_risk"]));
    const given = await a.post(`/driver/reservations/${trip.tripId}/release`, { reasonCode: "scheduled_cannot_make_time" });
    expect(given.status, JSON.stringify(given.body)).toBe(204);
    const back = await adminTrip(trip.tripId);
    expect(back.status).toBe("requested");
    expect(back.reservation).toMatchObject({ atRisk: false, notStarted: false });
    expect(back.reservation.leaveAt).toBeUndefined();
    expect(back.reservation.driveSeconds).toBeUndefined();
    expect((await b.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    await jump(5);
    expect(await kinds(b.id, trip.tripId)).toEqual(expect.arrayContaining(["reservation_leave_now", "reservation_late_risk"]));
  });

  it("late 7 min, 26 min drive, 19 min before pickup: taken back, counted (no fee), the driver told, the rider told nothing, an alert", async () => {
    driveMin = 26;
    const trip = await book(minutes(120));
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    // 22 min before: 4 min late at most, kept.
    await walkTo(trip.scheduledAt, 21.5);
    expect((await adminTrip(trip.tripId)).driverId).toBe(a.id);
    const riderBefore = (await kinds(rider.id, trip.tripId)).length;
    // The check 21 min before: exactly 5 min late, kept. The next (2 min later) at 19 min before: 7 min late, 26 min
    // drive, still 19 ≥ 15 min before the pickup: taken back.
    await walkTo(trip.scheduledAt, 18.5);
    const after = await adminTrip(trip.tripId);
    expect(after.driverId ?? null).not.toBe(a.id);
    expect(["requested", "searching", "offered", "accepted"]).toContain(after.status);
    expect(after.reservation).toMatchObject({ takenBack: { driverId: a.id } });
    expect(await cancels(trip.tripId)).toEqual([{ driver_id: a.id, reason_code: "booked_late_taken_back" }]);
    expect(await kinds(a.id, trip.tripId)).toContain("reservation_taken_back");
    // Drivers never pay a fee: no money row for him on this trip.
    expect(await sim.db.selectFrom("earnings_entries").select("kind").where("trip_id", "=", trip.tripId).execute()).toEqual([]);
    // Owner job-4 Q2: before the driver started driving the rider sees nothing.
    expect((await kinds(rider.id, trip.tripId)).slice(riderBefore).filter((k) => k !== "reservation_driver_found")).toEqual([]);
    await sim.tick();
    const book2 = (await owner.get("/admin/alerts/book?country=SE")).body;
    if (after.status !== "accepted") expect(book2.alerts.map((x: Json) => x.kind)).toContain("booked_taken_back");
    // A second check (another server copy) finds him gone: still one cancel row.
    await jump(120);
    expect(await cancels(trip.tripId)).toHaveLength(1);
  });

  it("late 6 min but only 8 min' drive away: he keeps it (keep-if-close; until-time set to 0 by the admin)", async () => {
    await zoneReservations({ takeBackUntilMinBeforePickup: 0 });
    try {
      driveMin = 8;
      const trip = await book(minutes(120));
      expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
      await walkTo(trip.scheduledAt, 1.5);
      const kept = await adminTrip(trip.tripId);
      expect(kept.driverId).toBe(a.id);
      expect(kept.reservation).toMatchObject({ atRisk: true });
      expect(await cancels(trip.tripId)).toEqual([]);
    } finally {
      await zoneReservations({ takeBackUntilMinBeforePickup: 15 });
    }
  });

  it("late 6 min, 10 min before pickup: he keeps it (no time left to find another driver); the rider gets no late message", async () => {
    driveMin = 16;
    const trip = await book(minutes(120));
    expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    await walkTo(trip.scheduledAt, 9.5);
    const kept = await adminTrip(trip.tripId);
    expect(kept.driverId).toBe(a.id);
    expect(await cancels(trip.tripId)).toEqual([]);
    expect(await kinds(a.id, trip.tripId)).not.toContain("reservation_taken_back");
  });

  it("the admin's take-back numbers are read per zone: late-more-than 30 min keeps a 27-min-late driver", async () => {
    await zoneReservations({ takeBackLateMin: 30 });
    try {
      driveMin = 46;
      const trip = await book(minutes(120));
      expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
      await walkTo(trip.scheduledAt, 18.5);
      expect((await adminTrip(trip.tripId)).driverId).toBe(a.id);
    } finally {
      await zoneReservations({ takeBackLateMin: 5 });
    }
  });

  it("started but not heading: 'not driving to the rider' every minute; once he would be >5 min late it is taken back and the rider sees a new search", async () => {
    driveMin = 30;
    const trip = await book(minutes(120));
    expect((await b.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
    // He waits 9.6 km away: about 30 min by the server's road estimate (12 km road at the dispatch pickup speed).
    await b.moveTo({ lat: PLACES.sergels.lat + 0.08633, lng: PLACES.sergels.lng });
    await walkTo(trip.scheduledAt, 40);
    const started = await b.post(`/driver/reservations/${trip.tripId}/start`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    // He stands still: not heading after 2 min, then a notice every minute; not late yet (arrives 10 min early).
    await sim.advance(5 * 60);
    const notices = (await kinds(b.id, trip.tripId)).filter((k) => k === "heading_not_to_rider");
    expect(notices.length).toBeGreaterThanOrEqual(2);
    expect(notices.length).toBeLessThanOrEqual(4);
    expect((await adminTrip(trip.tripId)).driverId).toBe(b.id);
    // 24 min before: now + 30 min drive = 6 min late, still ≥ 15 min before: taken back.
    await sim.advance(12 * 60);
    const after = await adminTrip(trip.tripId);
    expect(after.driverId ?? null).not.toBe(b.id);
    expect(await cancels(trip.tripId)).toEqual([{ driver_id: b.id, reason_code: "booked_late_taken_back" }]);
    expect(await kinds(b.id, trip.tripId)).toContain("reservation_taken_back");
    // Owner job-4 Q2: after he started driving the rider sees "searching for a new driver".
    expect(await kinds(rider.id, trip.tripId)).toContain("trip_update");
  });
});
