import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sweepAlerts } from "../../src/alerts/detector.js";
import { MAX_ATTEMPTS, RESTART_ONCE_AFTER_MS, TimerWorker, type TimerHandler } from "../../src/jobs/timers.js";
import { buildWorkerConfig } from "../../src/jobs/workerConfig.js";
import { EstimateRouter } from "../../src/maps/routing.js";
import { PICKUP_GEOFENCE, maybePickupGeofence } from "../../src/trips/ride/geofence.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertRider, insertTrip } from "../support/seed.js";

/**
 * S4 B1.1 SF-1 (Rules audits/impact/s4-b101-supervisor.md; owner 2026-11-16 "Yes, same as drop-off (Rec.)",
 * decisions/session-2026-11-06.md): since round 2 a GPS batch never wakes a failing or parked pickup_geofence, so after
 * MAX_ATTEMPTS failures the automatic arrival at the pickup, the waiting clock's away / back and the automatic arrival
 * at the middle stops were off for the rest of the trip, with an alert at the book's normal level only. Now the kind is
 * in RESTART_ONCE_KINDS and LOUD_PARKED_KINDS (src/jobs/parkedKinds.ts), as near_dropoff: it runs once more 60 s later
 * and its alert is critical at once; a second parking is for good (no loop) and stays critical.
 * Fails before: parked at 'infinity' on its first parking, alert level "important".
 *
 * SF-3 (supervisor probes P1, P2 kept as real tests): a worker in the middle of the timer while GPS batches arrive.
 */

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});
beforeEach(async () => {
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("admin_alerts_live").execute();
});

const T0 = new Date("2026-11-16T10:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const HERE = { lat: 59.33, lng: 18.06 };
const FIX = { ...HERE, accuracy: 5 };
const logger = { warn: () => undefined, error: () => undefined };
const row = () => database.db.selectFrom("timers").selectAll().where("kind", "=", PICKUP_GEOFENCE).executeTakeFirst();
const shape = async () => {
  const r = await row();
  return r === undefined ? undefined : [Number(r.due_at) === Infinity ? "infinity" : r.due_at.toISOString(), r.attempts];
};
const alerts = () => database.db.selectFrom("admin_alerts_live").selectAll().where("kind", "=", "system_health").where("detail", "like", `${PICKUP_GEOFENCE}:%`).execute();
const near = (tripId: string) => ({ trip_id: tripId, status: "driver_to_pickup", pickup: HERE });

async function driverToPickup() {
  return insertTrip(database.db, await insertRider(database.db), { status: "driver_to_pickup" });
}

/** A worker set up as main.ts sets it up (buildWorkerConfig: restart-once kinds, the parked alert), its pickup_geofence replaced. */
function worker(clock: { now: Date }, handler: TimerHandler) {
  const config = buildWorkerConfig(new EstimateRouter(), { timerLanes: 1, dispatchLanes: 1 });
  return new TimerWorker(database.db, { ...config.parked, handlers: { ...config.handlers, [PICKUP_GEOFENCE]: handler }, logger, clock: () => clock.now, pollMs: 20 });
}

describe("SF-1: a parked pickup_geofence restarts once after 1 min, with a critical alert", () => {
  it("parks after MAX_ATTEMPTS failures onto its one restart (due + 60 s, not 'infinity'); the alert is critical and names the trip; GPS does not wake it early", async () => {
    const tripId = await driverToPickup();
    const clock = { now: at(0) };
    const broken = { on: true, runs: 0 };
    const w = worker(clock, async () => {
      broken.runs += 1;
      if (broken.on) throw new Error("geofence boom");
    });
    await maybePickupGeofence(database.db as never, near(tripId), FIX, at(0));
    await database.db.updateTable("timers").set({ attempts: MAX_ATTEMPTS - 1 }).where("kind", "=", PICKUP_GEOFENCE).execute();
    await w.runDue();
    expect(broken.runs).toBe(1);
    expect(await shape()).toEqual([at(RESTART_ONCE_AFTER_MS / 1000).toISOString(), MAX_ATTEMPTS]);
    // The worker raised the alert at once (no sweep needed): critical (loud), naming the kind and the trip.
    const raised = await alerts();
    expect(raised.length).toBeGreaterThan(0);
    for (const a of raised) {
      expect([a.state, a.level]).toEqual(["open", "critical"]);
      expect(a.detail).toContain(tripId);
    }
    // GPS batches inside the circle during the minute neither pull it earlier nor reset its count (round 2 rule).
    for (let s = 1; s <= 30; s++) await maybePickupGeofence(database.db as never, near(tripId), FIX, at(s));
    expect(await shape()).toEqual([at(60).toISOString(), MAX_ATTEMPTS]);
    // Not before the minute is up; then once, and this time it works: the timer is done, the next sweep solves the alert.
    broken.on = false;
    clock.now = at(59);
    await w.runDue();
    expect(broken.runs).toBe(1);
    clock.now = at(60);
    await w.runDue();
    expect(broken.runs).toBe(2);
    expect(await shape()).toBeUndefined();
    await database.db.transaction().execute((trx) => sweepAlerts(trx, clock.now));
    expect((await alerts()).map((a) => a.state)).toEqual(raised.map(() => "solved"));
    // The next GPS batch books a fresh, healthy check (attempts 0).
    await maybePickupGeofence(database.db as never, near(tripId), FIX, at(61));
    expect(await shape()).toEqual([at(61).toISOString(), 0]);
  });

  it("a second parking is for good (no loop): 'infinity', MAX_ATTEMPTS + 1, never run again, GPS never wakes it, the alert stays open and critical", async () => {
    const tripId = await driverToPickup();
    const clock = { now: at(0) };
    let runs = 0;
    const w = worker(clock, async () => {
      runs += 1;
      throw new Error("geofence boom");
    });
    await maybePickupGeofence(database.db as never, near(tripId), FIX, at(0));
    await database.db.updateTable("timers").set({ attempts: MAX_ATTEMPTS - 1 }).where("kind", "=", PICKUP_GEOFENCE).execute();
    await w.runDue();
    clock.now = at(60);
    await w.runDue();
    expect(runs).toBe(2);
    expect(await shape()).toEqual(["infinity", MAX_ATTEMPTS + 1]);
    for (const minutes of [1, 10, 60]) {
      clock.now = at(60 + minutes * 60);
      await maybePickupGeofence(database.db as never, near(tripId), FIX, clock.now);
      await w.runDue();
    }
    expect(runs).toBe(2);
    expect(await shape()).toEqual(["infinity", MAX_ATTEMPTS + 1]);
    await database.db.transaction().execute((trx) => sweepAlerts(trx, clock.now));
    const open = await alerts();
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((a) => a.state === "open" && a.level === "critical" && a.detail.includes(tripId))).toBe(true);
  });
});

/** A handler that waits at a gate (the worker holds the timer row, its transaction open) until `release` is called. */
function gated() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => (enter = r));
  const gate = new Promise<void>((r) => (release = r));
  const state = { runs: 0, fail: false };
  const handler: TimerHandler = async () => {
    state.runs += 1;
    if (state.runs === 1) {
      enter();
      await gate;
    }
    if (state.fail) throw new Error("boom");
  };
  return { handler, entered, release, state };
}
const settled = async <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

describe("SF-3: scheduleTimerEarlier against a worker in the middle of the timer (supervisor probes P1, P2)", () => {
  it("P1: a GPS batch that finds the check already due moves nothing but holds the row until it commits; the worker skips it meanwhile and runs it right after", async () => {
    const tripId = await driverToPickup();
    const clock = { now: at(5) };
    let runs = 0;
    const w = new TimerWorker(database.db, { handlers: { [PICKUP_GEOFENCE]: async () => void (runs += 1) }, logger, clock: () => clock.now, pollMs: 20 });
    await maybePickupGeofence(database.db as never, near(tripId), FIX, at(0));
    let commit!: () => void;
    const hold = new Promise<void>((r) => (commit = r));
    let booked!: () => void;
    const inside = new Promise<void>((r) => (booked = r));
    const batch = database.db.transaction().execute(async (trx) => {
      await maybePickupGeofence(trx, near(tripId), FIX, at(5));
      booked();
      await hold;
    });
    await inside;
    // Due at(0) is kept (earlier than the batch), yet the row is locked by the batch: the worker takes nothing.
    expect(await w.runOne()).toBe(false);
    expect(runs).toBe(0);
    commit();
    await batch;
    expect(await shape()).toEqual([at(0).toISOString(), 0]);
    expect(await w.runOne()).toBe(true);
    expect(runs).toBe(1);
    expect(await shape()).toBeUndefined();
  });

  it("P2: a batch while the handler runs (and succeeds) waits for it, then books a NEW check at the batch time, which runs", async () => {
    const tripId = await driverToPickup();
    const clock = { now: at(0) };
    const g = gated();
    const w = new TimerWorker(database.db, { handlers: { [PICKUP_GEOFENCE]: g.handler }, logger, clock: () => clock.now, pollMs: 20 });
    await maybePickupGeofence(database.db as never, near(tripId), FIX, at(0));
    const running = w.runOne();
    await g.entered;
    const batch = maybePickupGeofence(database.db as never, near(tripId), FIX, at(3));
    // The batch's statement waits on the row the worker holds (deleted, not committed yet).
    expect(await settled(batch, 300)).toBe(false);
    g.release();
    expect(await running).toBe(true);
    await batch;
    // Nothing lost: the new position has its own check, healthy, at the batch time.
    expect(await shape()).toEqual([at(3).toISOString(), 0]);
    clock.now = at(3);
    expect(await w.runOne()).toBe(true);
    expect(g.state.runs).toBe(2);
    expect(await shape()).toBeUndefined();
  });

  it("P2b: a batch while the handler runs and FAILS leaves the failure's back-off (attempts 1, due + 1 s, the error) as is", async () => {
    const tripId = await driverToPickup();
    const clock = { now: at(0) };
    const g = gated();
    g.state.fail = true;
    const w = new TimerWorker(database.db, { handlers: { [PICKUP_GEOFENCE]: g.handler }, logger, clock: () => clock.now, pollMs: 20 });
    await maybePickupGeofence(database.db as never, near(tripId), FIX, at(0));
    const running = w.runOne();
    await g.entered;
    const batch = maybePickupGeofence(database.db as never, near(tripId), FIX, at(0.5));
    expect(await settled(batch, 300)).toBe(false);
    g.release();
    await running;
    await batch;
    const r = await row();
    expect([r!.due_at.toISOString(), r!.attempts, r!.last_error]).toEqual([at(1).toISOString(), 1, "boom"]);
  });
});
