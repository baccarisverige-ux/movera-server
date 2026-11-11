import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Timer, TimerHandler } from "../../src/jobs/timers.js";
import { LOUD_PARKED_KINDS, RESTART_ONCE_KINDS } from "../../src/jobs/workerConfig.js";
import { escalateHandler, INCIDENT_ESCALATE } from "../../src/safety/incidents.js";
import { noAnswerHandler, RIDE_CHECK_NO_ANSWER } from "../../src/safety/rideCheck.js";
import { RIDE_CHECK_SCAN, rideCheckScanHandler } from "../../src/safety/rideCheckServer.js";
import { DRIVER_SILENCE, NEAR_DROPOFF, rideHandlers, WAITING_NO_SHOW, WAITING_PAID } from "../../src/trips/ride.js";
import { dispatchHandlers, END, ROUND, STEP, WITHDRAW } from "../../src/dispatch/runtime.js";
import { newId } from "../../src/ids.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * B1.6b gate (owner W1 Q70, 2026-11-11): a parked trip or safety timer is run once more only if its handler looks at
 * the trip / case again first, so a second run can never do the thing twice. One test per kind in RESTART_ONCE_KINDS:
 * the handler runs twice (the restart after a run that already did it), or once after the trip / case moved on, and
 * the second time it changes nothing. A kind is added to RESTART_ONCE_KINDS only together with its test here.
 */

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

const NOW = new Date("2026-11-11T10:00:00Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const db = () => database.db;
const timer = (kind: string, refId: string, firedAt: Date, payload: unknown = {}): Timer => ({ timerId: "0", kind, refId, dueAt: firedAt, payload, attempts: 8, firedAt });
const run = (handler: TimerHandler, t: Timer) => db().transaction().execute((trx) => handler(trx, t));
const tripRow = (id: string) => db().selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow();
const events = async (id: string) => Number((await db().selectFrom("trip_events").select((eb) => eb.fn.countAll<string>().as("n")).where("trip_id", "=", id).executeTakeFirstOrThrow()).n);
/** What a second run must leave alone: the trip row, its events, its incidents, its ride checks. */
async function snapshot(tripId: string) {
  const trip = await tripRow(tripId);
  const incidents = await db().selectFrom("incidents").select(["incident_id", "status", "escalated_at"]).where("trip_id", "=", tripId).orderBy("incident_id").execute();
  const checks = await db().selectFrom("ride_checks").select(["check_id", "no_answer_at", "incident_id"]).where("trip_id", "=", tripId).orderBy("check_id").execute();
  return { status: trip.status, version: trip.version, events: await events(tripId), alert: trip.driver_silent_alert, waiting: trip.waiting, step: trip.search_step, rideCheck: trip.ride_check, incidents, checks };
}
async function onTrip(status: string, set: Record<string, unknown> = {}) {
  const riderId = await insertRider(db());
  const driverId = await insertDriver(db());
  const id = await insertTrip(db(), riderId, { status, driverId });
  await db().updateTable("trips").set({ accepted_at: at(-3600), boarded_at: at(-3600), started_at: at(-3600), ...set } as never).where("trip_id", "=", id).execute();
  return { id, riderId, driverId };
}

const tested = new Set<string>();
const kind = (k: string) => (tested.add(k), k);

describe("B1.6b gate: every restart-once handler re-checks the trip or case before it acts", () => {
  it("incident_escalate: a second run does not escalate again", async () => {
    const t = await onTrip("in_trip");
    const id = newId("inc", NOW.getTime());
    await db().insertInto("incidents").values({ incident_id: id, trip_id: t.id, kind: "sos", severity: "critical", raised_by: "rider", zone_id: "stockholm", rider_id: t.riderId, driver_id: t.driverId, opened_at: at(-120), updated_at: at(-120), alarm: true } as never).execute();
    await run(escalateHandler, timer(kind(INCIDENT_ESCALATE), id, NOW));
    const escalated = await db().selectFrom("incident_events").select("kind").where("incident_id", "=", id).execute();
    expect(escalated.map((e) => e.kind)).toEqual(["incident_escalated"]);
    const before = await snapshot(t.id);
    await run(escalateHandler, timer(INCIDENT_ESCALATE, id, at(60)));
    expect(await snapshot(t.id)).toEqual(before);
    expect(await db().selectFrom("incident_events").select("kind").where("incident_id", "=", id).execute()).toHaveLength(1);
  });

  it("ride_check_no_answer: a second run opens no second case; an answered check opens none", async () => {
    const t = await onTrip("in_trip");
    const check = (checkId: string, answer: "ok" | null) => db().insertInto("ride_checks").values({ trip_id: t.id, side: "rider", check_id: checkId, trigger: "long_stop", subject_id: t.riderId, shown_at: at(-120), answer, answered_at: answer ? at(-60) : null, created_at: at(-120) } as never).execute();
    await check("c1", null);
    await run(noAnswerHandler, timer(kind(RIDE_CHECK_NO_ANSWER), `${t.id}|rider|c1`, NOW));
    const before = await snapshot(t.id);
    expect(before.incidents).toHaveLength(1);
    await run(noAnswerHandler, timer(RIDE_CHECK_NO_ANSWER, `${t.id}|rider|c1`, at(60)));
    expect(await snapshot(t.id)).toEqual(before);
    const other = await onTrip("in_trip");
    await db().insertInto("ride_checks").values({ trip_id: other.id, side: "rider", check_id: "c2", trigger: "long_stop", subject_id: other.riderId, shown_at: at(-120), answer: "ok", answered_at: at(-60), created_at: at(-120) } as never).execute();
    await run(noAnswerHandler, timer(RIDE_CHECK_NO_ANSWER, `${other.id}|rider|c2`, NOW));
    expect((await snapshot(other.id)).incidents).toEqual([]);
  });

  it("ride_check_scan: nothing once the trip ended, nothing while a server check is still waiting", async () => {
    const ended = await onTrip("completed", { ended_at: at(-60) });
    const before = await snapshot(ended.id);
    await run(rideCheckScanHandler(), timer(kind(RIDE_CHECK_SCAN), ended.id, NOW));
    expect(await snapshot(ended.id)).toEqual(before);
    const asked = { checkId: "s1", trigger: "long_stop", askedAt: at(-30).toISOString(), answerBy: at(90).toISOString(), answers: {} };
    const t = await onTrip("in_trip", { ride_check: JSON.stringify(asked) });
    const open = await snapshot(t.id);
    await run(rideCheckScanHandler(), timer(RIDE_CHECK_SCAN, t.id, NOW));
    expect(await snapshot(t.id)).toEqual(open);
  });

  it("near_dropoff: a second run does not move the trip again", async () => {
    const t = await onTrip("in_trip");
    await run(rideHandlers[kind(NEAR_DROPOFF)]!, timer(NEAR_DROPOFF, t.id, NOW));
    const before = await snapshot(t.id);
    expect(before.status).toBe("approaching_dropoff");
    await run(rideHandlers[NEAR_DROPOFF]!, timer(NEAR_DROPOFF, t.id, at(60)));
    expect(await snapshot(t.id)).toEqual(before);
  });

  for (const k of [WAITING_PAID, WAITING_NO_SHOW]) {
    it(`${k}: a second run adds no second island alert; a new arrival is not touched by the old timer`, async () => {
      const arrivedAt = at(-600).toISOString();
      const waiting = { arrivedAt, freeUntil: at(-300).toISOString(), noShowAt: at(0).toISOString(), chargedSeconds: 0, alerts: [] };
      const t = await onTrip("arrived", { waiting: JSON.stringify(waiting), boarded_at: null, started_at: null });
      await run(rideHandlers[kind(k)]!, timer(k, t.id, NOW, { arrivedAt }));
      const before = await snapshot(t.id);
      expect((before.waiting as { alerts: unknown[] }).alerts).toHaveLength(1);
      await run(rideHandlers[k]!, timer(k, t.id, at(60), { arrivedAt }));
      expect(await snapshot(t.id)).toEqual(before);
      const moved = await onTrip("arrived", { waiting: JSON.stringify({ ...waiting, arrivedAt: at(-30).toISOString() }), boarded_at: null, started_at: null });
      const fresh = await snapshot(moved.id);
      await run(rideHandlers[k]!, timer(k, moved.id, NOW, { arrivedAt }));
      expect(await snapshot(moved.id)).toEqual(fresh);
    });
  }

  it("driver_silence: a second run after the server failed the trip changes nothing", async () => {
    const t = await onTrip("in_trip", { boarded_at: at(-4 * 3600) });
    await run(rideHandlers[kind(DRIVER_SILENCE)]!, timer(DRIVER_SILENCE, t.id, NOW));
    const before = await snapshot(t.id);
    expect(before.status).toBe("failed");
    await db().deleteFrom("timers").execute();
    await run(rideHandlers[DRIVER_SILENCE]!, timer(DRIVER_SILENCE, t.id, at(60)));
    expect(await snapshot(t.id)).toEqual(before);
    expect(await db().selectFrom("timers").select("kind").where("ref_id", "=", t.id).execute()).toEqual([]);
  });

  it("search_step: a step already shown is not shown again", async () => {
    const riderId = await insertRider(db());
    const id = await insertTrip(db(), riderId, { status: "searching" });
    const steps = [{ id: "st1", kind: "keep_waiting", message: "Still looking", atSec: 60 }];
    await db().insertInto("searches").values({ trip_id: id, started_at: at(-120), start_mode: null, busy: 0, document: JSON.stringify({}), doc_version: 1, state: null, end_at: at(600), steps: JSON.stringify(steps), fired: JSON.stringify([]), answered: JSON.stringify([]), updated_at: at(-120) } as never).execute();
    await run(dispatchHandlers[kind(STEP)]!, timer(STEP, id, NOW, { tripId: id, stepId: "st1" }));
    const before = await snapshot(id);
    expect(before.step).toMatchObject({ id: "st1" });
    await run(dispatchHandlers[STEP]!, timer(STEP, id, at(60), { tripId: id, stepId: "st1" }));
    expect(await snapshot(id)).toEqual(before);
    expect((await db().selectFrom("searches").select("fired").where("trip_id", "=", id).executeTakeFirstOrThrow()).fired).toEqual(["st1"]);
  });

  it("search_end: a search that already ended is not ended again", async () => {
    const riderId = await insertRider(db());
    const id = await insertTrip(db(), riderId, { status: "searching" });
    await db().insertInto("searches").values({ trip_id: id, started_at: at(-900), start_mode: null, busy: 0, document: JSON.stringify({}), doc_version: 1, state: null, end_at: NOW, steps: JSON.stringify([]), fired: JSON.stringify([]), answered: JSON.stringify([]), updated_at: at(-900) } as never).execute();
    await run(dispatchHandlers[kind(END)]!, timer(END, id, NOW));
    const before = await snapshot(id);
    expect(before.status).toBe("expired");
    await run(dispatchHandlers[END]!, timer(END, id, at(60)));
    expect(await snapshot(id)).toEqual(before);
  });

  it("every restart-once kind has its test above (add the test first, then the kind)", () => {
    expect([...RESTART_ONCE_KINDS].sort()).toEqual([...tested].sort());
    // Loud (critical) when parked: every restart-once kind, and the trip kinds not restarted (yet): withdrawals, rounds.
    expect([...LOUD_PARKED_KINDS].sort()).toEqual([...tested, WITHDRAW, ROUND].sort());
  });
});
