import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EstimateRouter, haversineKm, type LatLng, type RouteLeg, type Router } from "../../src/maps/routing.js";
import * as reservations from "../../src/reservations/service.js";
import { setLeaveRouter } from "../../src/reservations/service.js";
import { ROUTE_QUOTE_TRIES } from "../../src/trips/routeChange.js";
import { PLACES, Sim, type Admin, type Driver, type Rider } from "../e2e/harness.js";

/**
 * S7 0.17 (owner W2 Q120 part 3 "Yes, all three", 2026-11-15): the booked ride's "leave now" check asked the road
 * route INSIDE the timer's transaction (reservations/service.ts leaveCheck → driveSecondsOf), with the trip row and the
 * timer row locked for as long as OSRM took. Now the road is asked in the timer's `prepare` step (no transaction, no
 * lock); the handler re-reads the driver's position under the lock and uses the road only if its inputs still hold,
 * else the timer runs again with a new road.
 * Every road call here looks, from another database connection, whether the trip row or the timer row is locked.
 */

const LEAVE_FIX_MOVED_M = (reservations as unknown as { LEAVE_FIX_MOVED_M?: number }).LEAVE_FIX_MOVED_M ?? 250;
const LEAVE_CHECK = "resv_leave_check";

let sim: Sim;
let rider: Rider;
let a: Driver;
let owner: Admin;

type Call = { from: LatLng; to: LatLng; options: unknown; tripLocked: boolean; timerLocked: boolean };
let calls: Call[] = [];
/** What the test wants to happen while the road is being asked (the n-th call, from 1). */
let during: (n: number) => Promise<void> = async () => undefined;
let fail = false;
let tripId = "";

/** Whether another connection finds the row locked right now (NOWAIT: asks, never waits). */
async function locked(query: ReturnType<typeof sql>): Promise<boolean> {
  try {
    await query.execute(sim.db);
    return false;
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return true;
    throw error;
  }
}

/** The road: 1 minute per straight-line km (so the answer says which position it was asked from). */
const probeRouter = {
  async route(points: LatLng[], options?: unknown): Promise<RouteLeg> {
    const [from, to] = points as [LatLng, LatLng];
    const call: Call = {
      from,
      to,
      options,
      tripLocked: await locked(sql`SELECT 1 FROM trips WHERE trip_id = ${tripId} FOR UPDATE NOWAIT`),
      timerLocked: await locked(sql`SELECT 1 FROM timers WHERE kind = ${LEAVE_CHECK} AND ref_id = ${tripId} FOR UPDATE NOWAIT`),
    };
    calls.push(call);
    await during(calls.length);
    if (fail) throw new Error("simulated: the router is broken");
    const km = haversineKm(from, to);
    return { distanceMeters: Math.round(km * 1000), durationSeconds: Math.round(600 + km * 60), source: "osrm" };
  },
} as unknown as Router;

beforeAll(async () => {
  sim = await Sim.start({ now: new Date("2026-11-16T05:00:00Z") });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  setLeaveRouter(probeRouter);
});
afterAll(async () => {
  setLeaveRouter(new EstimateRouter());
  await sim.stop();
});
beforeEach(async () => {
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
  await sim.db.deleteFrom("timers").where("kind", "=", LEAVE_CHECK).execute();
  sim.clock.now = new Date(sim.clock.now.getTime() + 6 * 3600_000);
  await a.moveTo(PLACES.nearSergels);
  await sim.tick();
  owner = await sim.admin("super");
  calls = [];
  during = async () => undefined;
  fail = false;
  tripId = "";
});

const minutes = (m: number) => new Date(sim.clock.now.getTime() + m * 60_000).toISOString();
/** A booked ride 2 h ahead that driver `a` holds; its first leave check is due now and has not run yet. */
async function held(): Promise<string> {
  const at = minutes(120);
  const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at })).body.quotes[0];
  const res = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  tripId = res.body.tripId as string;
  expect((await a.post(`/driver/reservations/${tripId}/accept`, {})).status).toBe(200);
  expect(await leaveTimer()).toBeDefined();
  return tripId;
}
const leaveTimer = () => sim.db.selectFrom("timers").select(["due_at", "attempts", "last_error"]).where("kind", "=", LEAVE_CHECK).where("ref_id", "=", tripId).executeTakeFirst();
const reservation = async () => (await owner.get(`/admin/trips/${tripId}`)).body.reservation as { driveSeconds?: number; leaveAt?: string };
const expected = (from: LatLng) => Math.round(600 + haversineKm(from, PLACES.sergels) * 60);
/** Sets the driver's position straight in the table: "a GPS fix came in while the road was being asked". */
async function jumpTo(at: LatLng): Promise<void> {
  await sim.db.updateTable("driver_locations").set({ lat: at.lat, lng: at.lng }).where("driver_id", "=", a.id).execute();
  // The app's next periodic fix (sim.advance) comes from there too.
  a.position = { lat: at.lat, lng: at.lng };
}

describe("S7 0.17: the booked leave check asks its road with no lock held", () => {
  it("no road call while the trip row or the timer row is locked; the road is asked without its shape; the check still works", async () => {
    await held();
    await sim.tick();
    console.log(`0.17 proof (leave check): ${calls.length} road call(s); trip row locked during a call: ${calls.map((c) => c.tripLocked).join(", ")}; timer row locked: ${calls.map((c) => c.timerLocked).join(", ")}`);
    expect(calls.length).toBe(1);
    expect(calls.map((c) => [c.tripLocked, c.timerLocked])).toEqual([[false, false]]);
    expect(calls[0]!.options).toEqual({ shape: false });
    expect(calls[0]!.from).toEqual(PLACES.nearSergels);
    expect(calls[0]!.to).toEqual({ lat: PLACES.sergels.lat, lng: PLACES.sergels.lng });
    // The check did its work with that road: the drive time is on the ride, and the next check is booked 2 min on.
    expect((await reservation()).driveSeconds).toBe(expected(PLACES.nearSergels));
    expect((await leaveTimer())!.due_at.getTime()).toBe(sim.clock.now.getTime() + 120_000);
    expect(sim.timerErrors).toEqual([]);
  });

  it("the driver's position changed while the road was asked: detected under the lock, nothing written, run again with a new road", async () => {
    await held();
    // During the first road call the car "moves" 1 km (to Odenplan): the first road is for a place he is not at.
    during = async (n) => void (n === 1 && (await jumpTo(PLACES.odenplan)));
    await sim.tick();
    // Detected: nothing of the stale road was written; the timer is still there, due as before, not a failure.
    expect(calls.length).toBe(1);
    expect((await reservation()).driveSeconds).toBeUndefined();
    const waiting = await leaveTimer();
    expect(waiting).toMatchObject({ attempts: 0, last_error: null });
    expect(waiting!.due_at.getTime()).toBeLessThanOrEqual(sim.clock.now.getTime());
    // Shortly after, it runs again: a new read, a new road from where he is now.
    await sim.advance(5);
    console.log(`0.17 proof (changed input): road calls ${calls.length}; asked from ${calls.map((c) => `${c.from.lat},${c.from.lng}`).join(" then ")}; drive time kept: ${(await reservation()).driveSeconds} s`);
    expect(calls.length).toBe(2);
    expect(calls[1]!.from).toEqual(PLACES.odenplan);
    expect(calls.every((c) => !c.tripLocked && !c.timerLocked)).toBe(true);
    expect((await reservation()).driveSeconds).toBe(expected(PLACES.odenplan));
    expect(expected(PLACES.odenplan)).not.toBe(expected(PLACES.nearSergels));
    expect(sim.timerErrors).toEqual([]);
  });

  it(`a position that moved less than ${LEAVE_FIX_MOVED_M} m while the road was asked keeps the road (no second call)`, async () => {
    await held();
    const near = { lat: PLACES.nearSergels.lat + 0.0009, lng: PLACES.nearSergels.lng };
    expect(haversineKm(PLACES.nearSergels, near) * 1000).toBeLessThan(LEAVE_FIX_MOVED_M);
    during = async (n) => void (n === 1 && (await jumpTo(near)));
    await sim.tick();
    await sim.advance(5);
    expect(calls.length).toBe(1);
    expect((await reservation()).driveSeconds).toBe(expected(PLACES.nearSergels));
  });

  it("the pickup changed while the road was asked: detected, run again with the new pickup", async () => {
    await held();
    const moved = { ...PLACES.sergels, lat: PLACES.sergels.lat + 0.02 };
    during = async (n) => void (n === 1 && (await sim.db.updateTable("trips").set({ pickup: JSON.stringify(moved) }).where("trip_id", "=", tripId).execute()));
    await sim.tick();
    expect((await reservation()).driveSeconds).toBeUndefined();
    await sim.advance(5);
    expect(calls.length).toBe(2);
    expect(calls[1]!.to).toEqual({ lat: moved.lat, lng: moved.lng });
    expect((await reservation()).driveSeconds).toBe(Math.round(600 + haversineKm(PLACES.nearSergels, moved) * 60));
  });

  it("a router that fails: the straight-line estimate is worked out under the lock without any road call (no loop, no failure)", async () => {
    await held();
    fail = true;
    await sim.tick();
    await sim.advance(5);
    // One call (outside the locks), it failed; the handler estimated by itself and went on.
    expect(calls.length).toBe(1);
    expect(calls.every((c) => !c.tripLocked && !c.timerLocked)).toBe(true);
    const estimate = await new EstimateRouter().route([PLACES.nearSergels, PLACES.sergels]);
    expect((await reservation()).driveSeconds).toBe(Math.max(60, Math.round(estimate.durationSeconds)));
    expect((await leaveTimer())).toMatchObject({ attempts: 0, last_error: null });
    expect(sim.timerErrors).toEqual([]);
  });
});

/**
 * Q120 follow-up SF-3 (Rules REMINDERS 137, audits/impact/s7-q120-supervisor.md): the "input changed" retry had no hard
 * count. If the driver's position kept jumping more than 250 m between the road call and the lock, every run was busy
 * again, for ever (one road call every 2 s, nothing decided). Now: after ROUTE_QUOTE_TRIES busy tries (3, the
 * route-change price's count of tries for the same race) the next run uses the straight-line estimate from the position
 * as it is under the lock, with no road call.
 */
const LEAVE_ROUTE_TRIES = ROUTE_QUOTE_TRIES;
describe("Q120 SF-3: the leave check's busy retry has a hard count", () => {
  it(`a position that changes on every road call: after ${LEAVE_ROUTE_TRIES} busy tries, the straight-line estimate (no endless retry)`, async () => {
    await held();
    // Every road call: the car "jumps" 1 km to the other place, so the road asked is never for where he is under the lock.
    during = async (n) => void (await jumpTo(n % 2 === 1 ? PLACES.odenplan : PLACES.nearSergels));
    await sim.tick();
    for (let i = 0; i < 8; i++) await sim.advance(5);
    const decided = (await reservation()).driveSeconds;
    console.log(`SF-3 proof: road calls ${calls.length}; drive time ${decided ?? "none"} s; timer errors ${sim.timerErrors.length}`);
    // LEAVE_ROUTE_TRIES runs with a road (all busy), then one run with the estimate and no road call.
    expect(calls.length).toBe(LEAVE_ROUTE_TRIES);
    const at = calls.length % 2 === 1 ? PLACES.odenplan : PLACES.nearSergels;
    const estimate = await new EstimateRouter().route([at, PLACES.sergels]);
    expect(decided).toBe(Math.max(60, Math.round(estimate.durationSeconds)));
    expect(calls.every((c) => !c.tripLocked && !c.timerLocked)).toBe(true);
    expect(await leaveTimer()).toMatchObject({ attempts: 0, last_error: null });
    expect(sim.timerErrors).toEqual([]);
  });
});
