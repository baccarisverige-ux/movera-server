import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, TimerWorker, scheduleTimer, type TimerHandler } from "../../src/jobs/timers.js";
import { NEAR_DROPOFF } from "../../src/trips/ride/shared.js";
import { maybeNearDropoff } from "../../src/trips/ride/steps.js";
import { TRIP_ETA, etaNowLocked, etaOnPosition } from "../../src/trips/etaNow.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertRider, insertTrip } from "../support/seed.js";

/**
 * S4 B1.1 rest (owner W1 Q66 "Yes": ride-check and "almost there" timers only move earlier, never later; plan
 * GLOBAL-SAFE-PLAN.md A7.3 B1.1 and S4-W1-RECHECK-2026-11-11.md:32 (b)-(d)): a GPS batch may pull the trip's
 * near_dropoff and trip_eta timer EARLIER, but never later, never resets the failure count, and never wakes a timer that
 * is failing (attempts > 0, in its back-off) or parked ('infinity').
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
});

const T0 = new Date("2026-11-16T10:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const HERE = { lat: 59.33, lng: 18.06 };

async function timer(kind: string) {
  return database.db.selectFrom("timers").selectAll().where("kind", "=", kind).executeTakeFirst();
}

async function inTrip(status = "in_trip") {
  const rider = await insertRider(database.db);
  return insertTrip(database.db, rider, { status });
}

describe("B1.1 near_dropoff: GPS only moves it earlier", () => {
  it("GPS batches every 1 s within 500 m keep the pending timer's due time, attempts and last error", async () => {
    const tripId = await inTrip();
    const trip = { trip_id: tripId, status: "in_trip" };
    await maybeNearDropoff(database.db as never, trip, HERE, at(0));
    // The handler failed twice: back-off until at(40).
    await database.db.updateTable("timers").set({ attempts: 2, last_error: "boom", due_at: at(40) }).where("kind", "=", NEAR_DROPOFF).execute();
    for (let s = 1; s <= 10; s++) await maybeNearDropoff(database.db as never, trip, HERE, at(s));
    const row = await timer(NEAR_DROPOFF);
    expect([row!.due_at.toISOString(), row!.attempts, row!.last_error]).toEqual([at(40).toISOString(), 2, "boom"]);
  });

  it("a pending timer not failing is pulled earlier, never later", async () => {
    const tripId = await inTrip();
    const trip = { trip_id: tripId, status: "in_trip" };
    await scheduleTimer(database.db, { kind: NEAR_DROPOFF, refId: tripId, dueAt: at(30) });
    await maybeNearDropoff(database.db as never, trip, HERE, at(5));
    expect((await timer(NEAR_DROPOFF))!.due_at.toISOString()).toBe(at(5).toISOString());
    await maybeNearDropoff(database.db as never, trip, HERE, at(9));
    expect((await timer(NEAR_DROPOFF))!.due_at.toISOString()).toBe(at(5).toISOString());
  });

  it("a parked near_dropoff stays parked whatever the GPS sends", async () => {
    const tripId = await inTrip();
    const trip = { trip_id: tripId, status: "in_trip" };
    await database.db
      .insertInto("timers")
      .values({ kind: NEAR_DROPOFF, ref_id: tripId, due_at: sql<Date>`'infinity'::timestamptz`, attempts: MAX_ATTEMPTS + 1, last_error: "boom" })
      .execute();
    for (let s = 0; s < 5; s++) await maybeNearDropoff(database.db as never, trip, HERE, at(s));
    const row = await timer(NEAR_DROPOFF);
    expect([Number(row!.due_at), row!.attempts]).toEqual([Infinity, MAX_ATTEMPTS + 1]);
  });

  it("an always-failing near_dropoff parks after its tries and the GPS never wakes it; no log line per GPS batch", async () => {
    const tripId = await inTrip();
    const trip = { trip_id: tripId, status: "in_trip" };
    const logs: string[] = [];
    const logger = { warn: (_d: object, m: string) => void logs.push(m), error: (_d: object, m: string) => void logs.push(m) };
    const clock = { now: at(0) };
    const failing: TimerHandler = async () => {
      throw new Error("always");
    };
    const w = new TimerWorker(database.db, { handlers: { [NEAR_DROPOFF]: failing }, logger, clock: () => clock.now, pollMs: 20 });
    await maybeNearDropoff(database.db as never, trip, HERE, clock.now);
    let runs = 0;
    for (let i = 0; i < 40; i++) {
      const row = await timer(NEAR_DROPOFF);
      if (row === undefined || Number(row.due_at) === Infinity) break;
      clock.now = new Date(Math.max(clock.now.getTime(), row.due_at.getTime()));
      runs += await w.runDue();
      // A GPS batch every time: it must not move the failing timer earlier or reset its count.
      await maybeNearDropoff(database.db as never, trip, HERE, clock.now);
    }
    const parked = await timer(NEAR_DROPOFF);
    expect(Number(parked!.due_at)).toBe(Infinity);
    expect(parked!.attempts).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
    expect(runs).toBeLessThanOrEqual(MAX_ATTEMPTS + 1);
    const before = logs.length;
    for (let s = 0; s < 20; s++) await maybeNearDropoff(database.db as never, trip, HERE, at(10_000 + s));
    expect(Number((await timer(NEAR_DROPOFF))!.due_at)).toBe(Infinity);
    expect(logs.length).toBe(before);
  });
});

describe("B1.1 ETA path: a position only moves trip_eta earlier, and never wakes a failing or parked tick", () => {
  const etaTrip = (tripId: string) => ({ trip_id: tripId, status: "accepted", pickup: HERE, dropoff: { lat: 59.4, lng: 18.2 }, eta: null });

  it("a parked trip_eta stays parked after etaOnPosition", async () => {
    const tripId = await inTrip("accepted");
    await database.db
      .insertInto("timers")
      .values({ kind: TRIP_ETA, ref_id: tripId, due_at: sql<Date>`'infinity'::timestamptz`, attempts: MAX_ATTEMPTS, last_error: "boom" })
      .execute();
    expect(await etaOnPosition(database.db as never, etaTrip(tripId), null, HERE, at(0))).toBe(true);
    const row = await timer(TRIP_ETA);
    expect([Number(row!.due_at), row!.attempts, row!.last_error]).toEqual([Infinity, MAX_ATTEMPTS, "boom"]);
  });

  it("a failing trip_eta keeps its back-off and attempts after etaOnPosition", async () => {
    const tripId = await inTrip("accepted");
    await database.db.insertInto("timers").values({ kind: TRIP_ETA, ref_id: tripId, due_at: at(60), attempts: 3, last_error: "boom" }).execute();
    await etaOnPosition(database.db as never, etaTrip(tripId), null, HERE, at(0));
    const row = await timer(TRIP_ETA);
    expect([row!.due_at.toISOString(), row!.attempts, row!.last_error]).toEqual([at(60).toISOString(), 3, "boom"]);
  });

  it("a healthy trip_eta is still pulled earlier (unchanged behaviour)", async () => {
    const tripId = await inTrip("accepted");
    await database.db.insertInto("timers").values({ kind: TRIP_ETA, ref_id: tripId, due_at: at(60) }).execute();
    await etaOnPosition(database.db as never, etaTrip(tripId), null, HERE, at(0));
    expect((await timer(TRIP_ETA))!.due_at.toISOString()).toBe(at(0).toISOString());
  });

  it("boarding (etaNowLocked) does not wake a parked or failing trip_eta, and still pulls a healthy one to now", async () => {
    const parkedTrip = await inTrip("in_trip");
    await database.db
      .insertInto("timers")
      .values({ kind: TRIP_ETA, ref_id: parkedTrip, due_at: sql<Date>`'infinity'::timestamptz`, attempts: MAX_ATTEMPTS, last_error: "boom" })
      .execute();
    await database.db.transaction().execute((trx) => etaNowLocked(trx as never, parkedTrip, at(0)));
    expect(Number((await timer(TRIP_ETA))!.due_at)).toBe(Infinity);
    await database.db.deleteFrom("timers").execute();
    const healthy = await inTrip("in_trip");
    await database.db.insertInto("timers").values({ kind: TRIP_ETA, ref_id: healthy, due_at: at(60) }).execute();
    await database.db.transaction().execute((trx) => etaNowLocked(trx as never, healthy, at(0)));
    expect((await timer(TRIP_ETA))!.due_at.toISOString()).toBe(at(0).toISOString());
  });
});
