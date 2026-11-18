import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sweepAlerts } from "../../src/alerts/detector.js";
import type { Trx } from "../../src/db/db.js";
import { MAX_ATTEMPTS, RESTART_ONCE_AFTER_MS, TimerWorker, type TimerHandler } from "../../src/jobs/timers.js";
import { buildWorkerConfig } from "../../src/jobs/workerConfig.js";
import { EstimateRouter, type Router } from "../../src/maps/routing.js";
import { setLeaveRouter } from "../../src/reservations/service.js";
import { ETA_EVERY_MS, etaHandler, startEta, TRIP_ETA } from "../../src/trips/eta.js";
import { etaNowLocked } from "../../src/trips/etaNow.js";
import { bookAndAccept, drive, PLACES, Sim, type Driver, type Rider } from "../e2e/harness.js";

/**
 * S4 B1.1 SF-2, round 4 (Rules audits/impact/s4-b101-supervisor.md SF-2; OQ-B101-2 "Yes, restart once + urgent alert
 * (Rec.)", a SESSION decision under the owner's night rule, decisions/session-2026-11-06.md 2026-11-16 17:53 UTC).
 * Since B1.1 round 1 nothing wakes a failing or parked trip_eta, so after MAX_ATTEMPTS failures the live road ETA, the
 * rider's "almost there" push and the late check of a booked ride were off for the rest of the trip, with an alert at
 * the book's normal level. Now trip_eta is in RESTART_ONCE_KINDS and LOUD_PARKED_KINDS (src/jobs/parkedKinds.ts): it
 * runs once more 60 s later and its alert is critical at once; a second parking is for good.
 *
 * trip_eta is not a one-off check: it books its own next run, has a prepare step outside the transaction, and one run
 * may send the rider's "almost there" push and take a late booked ride back. So the three things a restart must never
 * do are tests here, with the REAL handler (src/trips/eta.ts) on a real server and real Postgres:
 *   1. no second "almost there" push;  2. no second take-back;  3. never two trip_eta rows for one trip.
 * The failure is put AFTER the real handler's work ("after": it pushed / took the ride back / booked its next tick,
 * then the run fails), which is the worst case for a restart: everything a failed run did must be undone with it.
 * Fails before: parked at 'infinity' on its first parking, never run again, alert level "important".
 */

let sim: Sim;
let rider: Rider;
let a: Driver;
let b: Driver;
const logger = { warn: () => undefined, error: () => undefined };
const real = etaHandler(new EstimateRouter());
/** How the tick behaves: fine, fails before the real handler, or fails after the real handler did all its work. */
const fault = { mode: "ok" as "ok" | "before" | "after", runs: 0, pushedThenFailed: 0, mostPushesSeen: 0, tookBackThenFailed: 0, bookedThenFailed: 0 };
/** Each test walks a real server through minutes of 5 s steps: far over the 20 s default on a loaded machine. */
const SLOW = 120_000;
const NEAR_150M = { lat: PLACES.sergels.lat + 150 / 111_195, lng: PLACES.sergels.lng };

function faulty(prepare = real.prepare): TimerHandler {
  const handler: TimerHandler = async (trx: Trx, timer) => {
    fault.runs += 1;
    if (fault.mode === "before") throw new Error("eta boom");
    await real(trx, timer);
    if (fault.mode !== "after") return;
    // What this run did before it fails (seen inside its own transaction; all of it must be rolled back).
    const pushes = await arrivingPushes(timer.refId, trx);
    if (pushes > 0) fault.pushedThenFailed += 1;
    fault.mostPushesSeen = Math.max(fault.mostPushesSeen, pushes);
    if ((await trx.selectFrom("driver_cancels").select("driver_id").where("trip_id", "=", timer.refId).execute()).length > 0) fault.tookBackThenFailed += 1;
    if ((await trx.selectFrom("timers").select("timer_id").where("kind", "=", TRIP_ETA).where("ref_id", "=", timer.refId).where("attempts", "=", 0).execute()).length > 0) fault.bookedThenFailed += 1;
    throw new Error("eta boom after its work");
  };
  if (prepare !== undefined) handler.prepare = prepare;
  return handler;
}
/** A worker set up as main.ts sets it up (buildWorkerConfig: restart-once kinds, the parked alert), with the faulty real tick. */
function worker(handler: TimerHandler = faulty()) {
  const config = buildWorkerConfig(new EstimateRouter(), { timerLanes: 1, dispatchLanes: 1 });
  return new TimerWorker(sim.db, { ...config.parked, handlers: { ...config.handlers, [TRIP_ETA]: handler }, logger, clock: () => sim.clock.now });
}

const rows = (tripId: string) => sim.db.selectFrom("timers").selectAll().where("kind", "=", TRIP_ETA).where("ref_id", "=", tripId).execute();
const shape = async (tripId: string) => (await rows(tripId)).map((r) => [Number(r.due_at) === Infinity ? "infinity" : r.due_at.toISOString(), r.attempts]);
const arrivingPushes = async (tripId: string, ex: Trx | typeof sim.db = sim.db) =>
  (await ex.selectFrom("notifications").select("notification_id").where("trip_id", "=", tripId).where("audience", "=", "rider").where(sql<boolean>`data->>'moment' = 'driver_arriving'`).execute()).length;
const alerts = () => sim.db.selectFrom("admin_alerts_live").selectAll().where("kind", "=", "system_health").where("detail", "like", `${TRIP_ETA}:%`).execute();
const iso = (ms: number) => new Date(sim.clock.now.getTime() + ms).toISOString();
const tripRow = (tripId: string) => sim.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
const sweep = () => sim.db.transaction().execute((trx) => sweepAlerts(trx, sim.clock.now));

/** Time passes (5 s steps, a GPS fix from every car each 30 s) until the tick has failed MAX_ATTEMPTS times: its first parking. */
async function untilParked(tripId: string) {
  for (let i = 0; i < 80; i++) {
    await sim.advance(5);
    const [r] = await rows(tripId);
    if (r !== undefined && r.attempts >= MAX_ATTEMPTS) return;
  }
  throw new Error("the tick never reached MAX_ATTEMPTS failures");
}

beforeAll(async () => {
  sim = await Sim.start({ now: new Date("2026-11-16T05:00:00Z") });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.odenplan);
  b = await sim.driver(2, PLACES.odenplan);
  sim.worker = worker();
});
afterAll(async () => {
  setLeaveRouter(new EstimateRouter());
  await sim.stop();
});
beforeEach(async () => {
  Object.assign(fault, { mode: "ok", runs: 0, pushedThenFailed: 0, mostPushesSeen: 0, tookBackThenFailed: 0, bookedThenFailed: 0 });
  sim.worker = worker();
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"]).execute();
  await sim.db.updateTable("drivers").set({ online_status: "online" }).where("online_status", "=", "on_trip").execute();
  await sim.db.deleteFrom("timers").where("kind", "=", TRIP_ETA).execute();
  await sim.db.deleteFrom("admin_alerts_live").execute();
  sim.clock.now = new Date(sim.clock.now.getTime() + 6 * 3600_000);
  for (const d of [a, b]) await d.moveTo(PLACES.odenplan);
  await sim.tick();
});

/** A live trip whose driver (1 km away: no "almost there" yet) is driving to the pickup; its tick is healthy. */
async function toPickup() {
  const { tripId, driver } = await bookAndAccept(sim, rider, [a, b]);
  await drive(driver, tripId, "driver_to_pickup");
  await sim.advance(35);
  expect(await arrivingPushes(tripId)).toBe(0);
  expect((await shape(tripId)).map((s) => s[1])).toEqual([0]);
  return { tripId, driver };
}

describe("SF-2: a parked trip_eta restarts once after 1 min, with a critical alert", () => {
  it("no duplicate 'almost there': runs that pushed and then failed leave no push; the restart sends exactly one; a later parking + restart sends none", async () => {
    const { tripId, driver } = await toPickup();
    fault.mode = "after";
    // He is 150 m from the pickup now: every tick from here wants to send "almost there".
    await driver.moveTo(NEAR_150M);
    await untilParked(tripId);
    // First parking: onto its ONE restart (60 s after the last failure), not 'infinity'. One row.
    expect(await shape(tripId)).toEqual([[iso(RESTART_ONCE_AFTER_MS), MAX_ATTEMPTS]]);
    // The failed runs really did the work first (pushed, booked the next tick) and all of it went with the failure.
    expect(fault.pushedThenFailed).toBe(MAX_ATTEMPTS);
    expect(fault.bookedThenFailed).toBe(MAX_ATTEMPTS);
    expect(await arrivingPushes(tripId)).toBe(0);
    // The worker raised the alert at once (no sweep): critical (loud), naming the kind and the trip.
    const raised = await alerts();
    expect(raised.length).toBeGreaterThan(0);
    for (const alert of raised) {
      expect([alert.state, alert.level]).toEqual(["open", "critical"]);
      expect(alert.detail).toContain(tripId);
    }
    // During the minute nothing pulls it earlier or resets it: GPS (heartbeats in advance), a move, the boarding call.
    const restartAt = (await rows(tripId))[0]!.due_at;
    const failedRuns = fault.runs;
    fault.mode = "ok";
    await sim.advance(55);
    await driver.moveTo({ lat: NEAR_150M.lat + 0.0001, lng: NEAR_150M.lng });
    await sim.db.transaction().execute((trx) => etaNowLocked(trx, tripId, sim.clock.now));
    await sim.tick();
    expect(fault.runs).toBe(failedRuns);
    expect(await shape(tripId)).toEqual([[restartAt.toISOString(), MAX_ATTEMPTS]]);
    expect(await arrivingPushes(tripId)).toBe(0);
    // The restart: once, it works: ONE push, and ONE healthy row for the next tick (30 s on).
    await sim.advance(5);
    expect(fault.runs).toBe(failedRuns + 1);
    expect(await arrivingPushes(tripId)).toBe(1);
    expect(await shape(tripId)).toEqual([[iso(ETA_EVERY_MS), 0]]);
    await sweep();
    expect((await alerts()).map((alert) => alert.state)).toEqual(raised.map(() => "solved"));
    // A push that is out stays the only one: later ticks, a second round of 8 failures and its restart add none.
    await sim.advance(65);
    fault.mode = "after";
    await untilParked(tripId);
    expect(await shape(tripId)).toEqual([[iso(RESTART_ONCE_AFTER_MS), MAX_ATTEMPTS]]);
    // Not even inside a run that then failed was there ever a second one.
    expect(fault.mostPushesSeen).toBe(1);
    fault.mode = "ok";
    const before = fault.runs;
    await sim.advance(65);
    expect(fault.runs).toBeGreaterThan(before);
    expect(await arrivingPushes(tripId)).toBe(1);
    expect((await shape(tripId)).map((s) => s[1])).toEqual([0]);
  }, SLOW);

  it("a second parking is for good (no loop): 'infinity', MAX_ATTEMPTS + 1, never run again, one row, the alert stays critical; only a new accept books a fresh tick", async () => {
    const { tripId, driver } = await toPickup();
    fault.mode = "before";
    await untilParked(tripId);
    expect(await shape(tripId)).toEqual([[iso(RESTART_ONCE_AFTER_MS), MAX_ATTEMPTS]]);
    const runs = fault.runs;
    await sim.advance(60);
    expect(fault.runs).toBe(runs + 1);
    expect(await shape(tripId)).toEqual([["infinity", MAX_ATTEMPTS + 1]]);
    // 10 min of GPS, a move into the arrive radius, the boarding call: never woken, never a second row.
    await sim.advance(600);
    await driver.moveTo(NEAR_150M);
    await sim.db.transaction().execute((trx) => etaNowLocked(trx, tripId, sim.clock.now));
    await sim.tick();
    expect(fault.runs).toBe(runs + 1);
    expect(await shape(tripId)).toEqual([["infinity", MAX_ATTEMPTS + 1]]);
    await sweep();
    const open = await alerts();
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((alert) => alert.state === "open" && alert.level === "critical" && alert.detail.includes(tripId))).toBe(true);
    // A new accept (startEta) is the one thing that books a fresh tick: the same row, healthy, still one.
    fault.mode = "ok";
    await sim.db.transaction().execute((trx) => startEta(trx, tripId, sim.clock.now));
    expect(await shape(tripId)).toEqual([[iso(0), 0]]);
    await sim.tick();
    expect(fault.runs).toBe(runs + 2);
    expect(await shape(tripId)).toEqual([[iso(ETA_EVERY_MS), 0]]);
  }, SLOW);

  it("a restart-once tick that is waiting is replaced, not doubled, by a new accept: one healthy row", async () => {
    const { tripId } = await toPickup();
    fault.mode = "before";
    await untilParked(tripId);
    expect(await shape(tripId)).toEqual([[iso(RESTART_ONCE_AFTER_MS), MAX_ATTEMPTS]]);
    await sim.db.transaction().execute((trx) => startEta(trx, tripId, sim.clock.now));
    expect(await shape(tripId)).toEqual([[iso(0), 0]]);
  }, SLOW);
});

describe("SF-2: a restart never takes a booked ride back twice", () => {
  const leaveRouter = { route: async () => ({ distanceMeters: 30 * 800, durationSeconds: 30 * 60, source: "osrm" }) } as unknown as Router;
  const cancels = (tripId: string) => sim.db.selectFrom("driver_cancels").select(["driver_id", "reason_code"]).where("trip_id", "=", tripId).execute();
  const kinds = async (subjectId: string, tripId: string, kind: string) => (await sim.db.selectFrom("notifications").select("kind").where("subject_id", "=", subjectId).where("trip_id", "=", tripId).where("kind", "=", kind).execute()).length;
  const changed = async (tripId: string) =>
    (await sim.db.selectFrom("notifications").select("notification_id").where("trip_id", "=", tripId).where("audience", "=", "rider").where(sql<boolean>`data->>'moment' = 'driver_changed'`).execute()).length;

  it("runs that took the ride back and then failed leave it with the driver (nothing half done); the restart takes it back once; later ticks never again", async () => {
    setLeaveRouter(leaveRouter);
    // As test/e2e/32 "started but not heading": a booked ride, its driver 9.6 km away (about 30 min) and standing still.
    const scheduledAt = iso(120 * 60_000);
    const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt })).body["quotes"][0];
    const booked = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt, paymentMethod: "cash" });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const tripId: string = booked.body["tripId"];
    expect((await b.post(`/driver/reservations/${tripId}/accept`, {})).status).toBe(200);
    await b.moveTo({ lat: PLACES.sergels.lat + 0.08633, lng: PLACES.sergels.lng });
    const toMinutesBefore = async (min: number) => sim.advance((Date.parse(scheduledAt) - min * 60_000 - sim.clock.now.getTime()) / 1000);
    // The long wait before he starts: 1-minute steps (as test/e2e/32 walkTo), each with a GPS fix and the timers due.
    while (sim.clock.now.getTime() + 60_000 <= Date.parse(scheduledAt) - 40 * 60_000) {
      sim.clock.now = new Date(sim.clock.now.getTime() + 60_000);
      await b.heartbeat();
      await sim.tick();
    }
    await toMinutesBefore(40);
    const started = await b.post(`/driver/reservations/${tripId}/start`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    // 25.5 min before: not late enough yet (taken back from 25 min before: now + 30 min drive > pickup + 5 min).
    await toMinutesBefore(25.5);
    expect((await tripRow(tripId)).driver_id).toBe(b.id);
    expect(await cancels(tripId)).toEqual([]);
    // From here every tick fails AFTER its work; the later ones take the ride back first.
    fault.mode = "after";
    await untilParked(tripId);
    expect(await shape(tripId)).toEqual([[iso(RESTART_ONCE_AFTER_MS), MAX_ATTEMPTS]]);
    expect(fault.tookBackThenFailed).toBeGreaterThan(0);
    // Nothing of a failed take-back is left: he still has the ride, no cancel on his record, no notice, no rider push.
    const during = await tripRow(tripId);
    expect([during.driver_id, during.status]).toEqual([b.id, "driver_to_pickup"]);
    expect(await cancels(tripId)).toEqual([]);
    expect(await kinds(b.id, tripId, "reservation_taken_back")).toBe(0);
    expect(await changed(tripId)).toBe(0);
    // The restart works: taken back ONCE.
    fault.mode = "ok";
    const runs = fault.runs;
    const restartAt = (await rows(tripId))[0]!.due_at.getTime();
    await sim.advance(60);
    expect(fault.runs).toBeGreaterThan(runs);
    const after = await tripRow(tripId);
    expect(after.driver_id).not.toBe(b.id);
    // The run that took it back ended there: no ETA of the driver who lost it is written onto the trip.
    expect(Date.parse((after.eta as { at?: string } | null)?.at ?? "1970-01-01T00:00:00Z")).toBeLessThan(restartAt);
    expect(await cancels(tripId)).toEqual([{ driver_id: b.id, reason_code: "booked_late_taken_back" }]);
    expect(await kinds(b.id, tripId, "reservation_taken_back")).toBe(1);
    expect(await changed(tripId)).toBe(1);
    // Later ticks (the one the restart booked finds no driver and ends the chain), 5 more minutes: still once, and no
    // parked or doubled row is left behind.
    await sim.advance(300);
    expect(await cancels(tripId)).toHaveLength(1);
    expect(await kinds(b.id, tripId, "reservation_taken_back")).toBe(1);
    expect(await changed(tripId)).toBe(1);
    expect((await rows(tripId)).length).toBeLessThanOrEqual(1);
    expect((await rows(tripId)).every((r) => r.attempts === 0)).toBe(true);
    await sweep();
    expect((await alerts()).every((alert) => alert.state === "solved")).toBe(true);
  }, SLOW);
});

describe("SF-2: the self-booking tick never has two live rows, even with two server copies at the restart", () => {
  /** A copy whose prepare step (outside the transaction, no lock) waits at a gate: it has looked at the due tick, not run it. */
  function slowCopy() {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    const gate = new Promise<void>((r) => (release = r));
    const w = worker(
      faulty(async (db, timer) => {
        enter();
        await gate;
        return real.prepare!(db, timer);
      }),
    );
    return { w, entered, release };
  }
  /** The tick fails its 8th time now: parked onto its restart; then the clock is at the restart time. */
  async function atRestart(tripId: string) {
    await sim.db.updateTable("timers").set({ attempts: MAX_ATTEMPTS - 1, due_at: sim.clock.now }).where("kind", "=", TRIP_ETA).where("ref_id", "=", tripId).execute();
    fault.mode = "before";
    await sim.tick();
    expect(await shape(tripId)).toEqual([[iso(RESTART_ONCE_AFTER_MS), MAX_ATTEMPTS]]);
    sim.clock.now = new Date(sim.clock.now.getTime() + RESTART_ONCE_AFTER_MS);
    fault.runs = 0;
  }
  const lane = { kinds: [TRIP_ETA] };
  const locations = async (tripId: string) => (await sim.db.selectFrom("trip_events").select("kind").where("trip_id", "=", tripId).where("kind", "=", "location").execute()).length;

  it("copy A is in its prepare step while copy B runs the restart: the restart runs once, one location event, ONE next tick", async () => {
    const { tripId } = await toPickup();
    await atRestart(tripId);
    fault.mode = "ok";
    const events = await locations(tripId);
    const copyA = slowCopy();
    const running = copyA.w.runOne(lane);
    await copyA.entered;
    expect(await worker().runOne(lane)).toBe(true);
    expect(fault.runs).toBe(1);
    expect(await shape(tripId)).toEqual([[iso(ETA_EVERY_MS), 0]]);
    copyA.release();
    await running;
    expect(fault.runs).toBe(1);
    expect(await locations(tripId)).toBe(events + 1);
    expect(await shape(tripId)).toEqual([[iso(ETA_EVERY_MS), 0]]);
  }, SLOW);

  it("copy B's restart fails (parked for good) while copy A is in its prepare step: A does not run it a third time", async () => {
    const { tripId } = await toPickup();
    await atRestart(tripId);
    const copyA = slowCopy();
    const running = copyA.w.runOne(lane);
    await copyA.entered;
    expect(await worker().runOne(lane)).toBe(true);
    expect(fault.runs).toBe(1);
    expect(await shape(tripId)).toEqual([["infinity", MAX_ATTEMPTS + 1]]);
    copyA.release();
    fault.mode = "ok";
    await running;
    expect(fault.runs).toBe(1);
    expect(await shape(tripId)).toEqual([["infinity", MAX_ATTEMPTS + 1]]);
  }, SLOW);
});
