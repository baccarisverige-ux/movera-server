import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorkerConfig } from "../../src/jobs/workerConfig.js";
import { HOUSEKEEPING_KINDS } from "../../src/jobs/housekeeping.js";
import { NIGHTLY, SWEEP_IDEMPOTENCY_KEYS } from "../../src/jobs/maintenance.js";
import { TimerWorker, scheduleTimer, type TimerHandler } from "../../src/jobs/timers.js";
import { EstimateRouter } from "../../src/maps/routing.js";
import { TIMER } from "../../src/reservations/timerKinds.js";
import { INCIDENT_ESCALATE } from "../../src/safety/incidents.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * B1.7 (stage S4 wave B1; owner W1 Q71 "Cleaning on its own lane, after a test proves it delays SOS escalation?" =
 * "Yes, after the proof", 2026-11-11). Rule 36/47 proof: the worker's REAL lanes (buildWorkerConfig, today's defaults
 * TIMER_LANES 4 / DISPATCH_LANES 1). Two long housekeeping runs are due first (stress T-A part 4 measured one hourly
 * sweep at 74 s; here 2 s each, a statement holding the lane like a slow delete). Then an SOS escalation and a booked
 * ride's dispatch fall due. They must start within TARGET_MS of their due time; with housekeeping on the general lanes
 * both wait until a housekeeping run ends (~2 s late).
 */

const HOLD_S = 2;
const TARGET_MS = 500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { warn: () => undefined, error: () => undefined };

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

describe("B1.7: housekeeping never delays SOS escalation or a booked ride", () => {
  it("two long housekeeping runs do not hold back a due incident_escalate and a due booked-ride timer", async () => {
    const { handlers: real, lanes } = buildWorkerConfig(new EstimateRouter(), { timerLanes: 4, dispatchLanes: 1 });
    const started = new Map<string, number>();
    const slowHousekeeping: TimerHandler = async (trx, timer) => {
      started.set(timer.kind, Date.now());
      await sql`SELECT pg_sleep(${HOLD_S})`.execute(trx);
    };
    const record: TimerHandler = async (_trx, timer) => void started.set(timer.kind, Date.now());
    const handlers: Record<string, TimerHandler> = { ...real };
    for (const kind of [...HOUSEKEEPING_KINDS, SWEEP_IDEMPOTENCY_KEYS, NIGHTLY]) handlers[kind] = slowHousekeeping;
    handlers[INCIDENT_ESCALATE] = record;
    handlers[TIMER.dispatch] = record;

    const now = Date.now();
    // The hourly sweep and the nightly run are due first (oldest first: the general lanes take them before anything else).
    await scheduleTimer(database.db, { kind: SWEEP_IDEMPOTENCY_KEYS, refId: "all", dueAt: new Date(now - 2_000) });
    await scheduleTimer(database.db, { kind: NIGHTLY, refId: "all", dueAt: new Date(now - 1_000) });
    const worker = new TimerWorker(database.db, { handlers, logger: quiet, pollMs: 50, lanes });
    worker.start();
    try {
      for (let i = 0; i < 100 && !(started.has(SWEEP_IDEMPOTENCY_KEYS) && started.has(NIGHTLY)); i++) await sleep(10);
      expect(started.has(SWEEP_IDEMPOTENCY_KEYS) || started.has(NIGHTLY)).toBe(true);
      // While housekeeping runs: an SOS case escalates now, a booked ride is dispatched now.
      const due = Date.now();
      await scheduleTimer(database.db, { kind: INCIDENT_ESCALATE, refId: "inc_b17", dueAt: new Date(due) });
      await scheduleTimer(database.db, { kind: TIMER.dispatch, refId: "trp_b17", dueAt: new Date(due) });
      worker.kick();
      for (let i = 0; i < 400 && !(started.has(INCIDENT_ESCALATE) && started.has(TIMER.dispatch)); i++) await sleep(10);
      const lateMs = { [INCIDENT_ESCALATE]: (started.get(INCIDENT_ESCALATE) ?? Infinity) - due, [TIMER.dispatch]: (started.get(TIMER.dispatch) ?? Infinity) - due };
      console.log(`B1.7 proof: housekeeping holds ${HOLD_S} s; late by ${JSON.stringify(lateMs)} ms (target ${TARGET_MS} ms)`);
      expect(lateMs[INCIDENT_ESCALATE]).toBeLessThan(TARGET_MS);
      expect(lateMs[TIMER.dispatch]).toBeLessThan(TARGET_MS);
      // The housekeeping still runs (both of them, on its own lane).
      for (let i = 0; i < 600 && !(started.has(SWEEP_IDEMPOTENCY_KEYS) && started.has(NIGHTLY)); i++) await sleep(10);
      expect(started.has(SWEEP_IDEMPOTENCY_KEYS) && started.has(NIGHTLY)).toBe(true);
    } finally {
      await worker.stop();
    }
  });
});
