import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/**
 * v0.18.51 §73 (owner 2026-11-07, contract.json#bookedRide0_18_51.waitFrom): a booked ride's free waiting starts at the
 * later of the driver's Arrived and the pickup time. Early arrival: nothing runs before the pickup time (as before).
 * Late arrival: the free minutes start at the Arrived (before: already over, the rider was charged and could be marked a
 * no-show 1 s after arrival). Proof first written in Rules scratchpad waitproof/early_arrival.test.ts.
 */
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let owner: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-05T05:00:00Z") });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
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
  if (a.position) await a.heartbeat();
  await sim.tick();
}
const minutes = (m: number) => new Date(sim.clock.now.getTime() + m * 60_000).toISOString();
const until = (at: string, plus = 0) => jump((Date.parse(at) - sim.clock.now.getTime()) / 1000 + plus);
/** Minutes from the booked time T. */
const T = (at: string, trip: Json) => (Date.parse(at) - Date.parse(trip.scheduledAt)) / 60_000;
const atT = (trip: Json, m: number) => new Date(Date.parse(trip.scheduledAt) + m * 60_000).toISOString();

async function book(): Promise<Json> {
  const at = minutes(120);
  const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at })).body.quotes[0];
  const res = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}
/** Booked at T; the driver takes it, starts at T−60 and arrives at T + arriveAtMin. */
async function arriveAt(arriveAtMin: number): Promise<{ trip: Json; w: Json }> {
  const trip = await book();
  expect((await a.post(`/driver/reservations/${trip.tripId}/accept`, {})).status).toBe(200);
  await until(atT(trip, -60), 1);
  expect((await a.post(`/driver/reservations/${trip.tripId}/start`, {})).status).toBe(200);
  await until(atT(trip, arriveAtMin));
  const arrived = await a.command(trip.tripId, "arrive", { location: a.fix(PLACES.sergels) });
  expect(arrived.status, JSON.stringify(arrived.body)).toBe(200);
  return { trip, w: arrived.body.waiting };
}

describe("v0.18.51 §73 booked ride: free waiting from the later of arrival and pickup time", () => {
  it("EARLY (arrived T−10): free wait, paid wait and no-show count from the pickup time; waitFrom = T", async () => {
    const { trip, w } = await arriveAt(-10);
    expect(T(w.arrivedAt, trip)).toBe(-10);
    expect(T(w.waitFrom, trip)).toBe(0);
    expect(T(w.freeUntil, trip)).toBe(w.freeWaitMin);
    expect(T(w.noShowAt, trip)).toBe(w.noShowAfterMin);
    await until(atT(trip, 0));
    expect((await a.get(`/trips/${trip.tripId}`)).body.waiting.chargedSecondsNow).toBe(0);
    expect((await a.command(trip.tripId, "no-show", { reasonCode: "rider_no_show" })).body.reason).toBe("no_show_too_early");
    await until(atT(trip, w.freeWaitMin), 60);
    expect((await a.get(`/trips/${trip.tripId}`)).body.waiting.chargedSecondsNow).toBe(60);
    // The rider sees the same clock (the negative countdown runs to waitFrom).
    expect((await rider.trip(trip.tripId)).waiting.waitFrom).toBe(w.waitFrom);
  });

  it("LATE (arrived T+7): the free minutes start at the arrival — nothing charged, no no-show at once", async () => {
    const { trip, w } = await arriveAt(7);
    expect(w.waitFrom).toBe(w.arrivedAt);
    expect(T(w.freeUntil, trip)).toBe(7 + w.freeWaitMin);
    expect(T(w.noShowAt, trip)).toBe(7 + w.noShowAfterMin);
    await jump(1);
    expect((await a.get(`/trips/${trip.tripId}`)).body.waiting.chargedSecondsNow).toBe(0);
    const early = await a.command(trip.tripId, "no-show", { reasonCode: "rider_no_show" });
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect(early.body.reason).toBe("no_show_too_early");
    // Past T + noShowAfterMin (the old rule's time) but before the arrival + noShowAfterMin: the admin is refused too.
    await until(atT(trip, 7 + w.noShowAfterMin), -30);
    const version = (await a.trip(trip.tripId)).version;
    const adminEarly = await owner.post(`/admin/trips/${trip.tripId}/no-show`, { expectedVersion: version, note: "rider not there" });
    expect(adminEarly.status, JSON.stringify(adminEarly.body)).toBe(409);
    expect(adminEarly.body.reason).toBe("no_show_too_early");
    await until(w.freeUntil, 60);
    expect((await a.get(`/trips/${trip.tripId}`)).body.waiting.chargedSecondsNow).toBe(60);
    await until(w.noShowAt);
    expect((await a.command(trip.tripId, "no-show", { reasonCode: "rider_no_show" })).status).toBe(200);
  });

  it("LATE (arrived T+7): a rider cancel 1 min after the arrival is not a no-show (the free wait has just begun)", async () => {
    const { trip } = await arriveAt(7);
    await jump(60);
    const c = await rider.command(trip.tripId, "cancel", { reasonCode: "plans_changed" });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.cancellation?.feeKind).not.toBe("no_show");
  });

  it("LATE (arrived T+7): the rider boards 2 min after the arrival: no waiting charged", async () => {
    const { trip } = await arriveAt(7);
    await jump(120);
    const b = await a.command(trip.tripId, "board", {});
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.waiting.chargedSeconds).toBe(0);
    expect((b.body.fareLines ?? []).map((l: Json) => l.code)).not.toContain("waiting");
  });
});
