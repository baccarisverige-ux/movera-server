import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readEnv } from "../../src/env.js";
import { ALERT_SWEEP, ensureAlertSweep } from "../../src/alerts/detector.js";
import { NO_FIX_OFFLINE, NO_FIX_SWEEP } from "../../src/drivers/presence.js";
import { HOUSEKEEPING_KINDS, CLEANUP_QUOTES } from "../../src/jobs/housekeeping.js";
import { NIGHTLY, SWEEP_IDEMPOTENCY_KEYS, ensureMaintenanceTimers } from "../../src/jobs/maintenance.js";
import { SMART_SURGE_CHECK, ensurePricingTimers } from "../../src/pricing/surge.js";
import { LANE_LATE_LIMITS, RECURRING_JOBS } from "../../src/jobs/heartbeat.js";
import { contract } from "../../src/contract/contract.js";
import { TRIP_LANE_KINDS } from "../../src/jobs/workerConfig.js";
import { ROUND, WITHDRAW } from "../../src/dispatch/runtime.js";
import { PAYOUT_CLOSE, PAYOUT_DRIVER } from "../../src/jobs/payouts.js";
import { PAY_REQUEST_SCAN } from "../../src/drivers/payRequest.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * S4 B1.28 (owner W1 Q88 "An outside check that wakes you when background jobs stop? — A) Yes"): GET /healthz/jobs
 * (no token) answers 503 when a recurring server job is parked, missing or more than 3× its period late; else 200.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-12T12:00:00.000Z") };
const at = (ms: number) => new Date(clock.now.getTime() + ms);

beforeAll(async () => {
  database = await freshDatabase();
  const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "heartbeat-secret".padEnd(48, "h") });
  app = await buildApp({ env, logger: false, db: database.db, clock: () => clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

/** Every recurring job booked and due in the future (on time), as after a normal start. */
beforeEach(async () => {
  await database.db.deleteFrom("timers").execute();
  await ensureMaintenanceTimers(database.db, clock.now);
  await ensurePricingTimers(database.db, clock.now);
  await ensureAlertSweep(database.db, clock.now);
});

async function setDue(kind: string, dueAt: Date | "infinity", extra: { attempts?: number; lastError?: string } = {}) {
  await database.db
    .updateTable("timers")
    .set({
      due_at: dueAt === "infinity" ? sql`'infinity'::timestamptz` : dueAt,
      ...(extra.attempts !== undefined ? { attempts: extra.attempts } : {}),
      ...(extra.lastError !== undefined ? { last_error: extra.lastError } : {}),
    })
    .where("kind", "=", kind)
    .where("ref_id", "=", "all")
    .execute();
}

const get = () => app.inject({ method: "GET", url: "/healthz/jobs" });

describe("GET /healthz/jobs", () => {
  it("B1.28: a parked alert_sweep makes /healthz/jobs answer 503 and name it", async () => {
    await setDue(ALERT_SWEEP, "infinity", { attempts: 8 });
    const res = await get();
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("late");
    expect(body.jobs).toEqual([{ kind: ALERT_SWEEP, state: "parked" }]);
  });

  it("B1.28: all recurring jobs booked and on time → 200 ok", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checkedAt: clock.now.toISOString(), jobs: [] });
  });

  it("B1.28: a 30 s job 91 s late is late; 89 s is not; an hourly job 3 h + 1 s late is late", async () => {
    await setDue(ALERT_SWEEP, at(-91_000));
    let res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.json().jobs).toEqual([{ kind: ALERT_SWEEP, state: "late", lateSeconds: 91 }]);

    await setDue(ALERT_SWEEP, at(-89_000));
    res = await get();
    expect(res.statusCode).toBe(200);

    await setDue(CLEANUP_QUOTES, at(-(3 * 3_600_000 + 1_000)));
    res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.json().jobs).toEqual([{ kind: CLEANUP_QUOTES, state: "late", lateSeconds: 3 * 3600 + 1 }]);
  });

  it("B1.28: a deleted recurring row is 'missing'", async () => {
    await database.db.deleteFrom("timers").where("kind", "=", SMART_SURGE_CHECK).execute();
    const res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.json().jobs).toEqual([{ kind: SMART_SURGE_CHECK, state: "missing" }]);
  });

  it("B1.28: no error text, ids or payloads in the answer", async () => {
    await setDue(NIGHTLY, "infinity", { attempts: 8, lastError: "boom anna@example.com" });
    await database.db.updateTable("timers").set({ payload: JSON.stringify({ secretish: "payload-x" }) }).where("kind", "=", NIGHTLY).execute();
    const res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("boom");
    expect(res.body).not.toContain("@");
    expect(res.body).not.toContain("payload-x");
    expect(res.body).not.toContain("timer_id");
    expect(Object.keys(res.json()).sort()).toEqual(["checkedAt", "jobs", "status"]);
  });

  it("B1.28: no_fix_sweep and alert_sweep 'poke' rows never make it late", async () => {
    await database.db
      .insertInto("timers")
      .values([
        { kind: NO_FIX_SWEEP, ref_id: "all", due_at: at(-86_400_000) },
        { kind: ALERT_SWEEP, ref_id: "poke", due_at: at(-86_400_000) },
      ])
      .execute();
    await database.db.insertInto("timers").values({ kind: "some_trip_timer", ref_id: "all", due_at: sql`'infinity'::timestamptz` }).execute();
    const res = await get();
    expect(res.statusCode).toBe(200);
  });

  it("B1.28: the check reads no clock but the app's (a job due in the app's future is on time)", async () => {
    await setDue(ALERT_SWEEP, at(60_000));
    expect((await get()).statusCode).toBe(200);
  });
});

describe("RECURRING_JOBS", () => {
  it("B1.28: names every kind main.ts re-arms at start, except no_fix_sweep (booked per run) and payout_driver (one row per driver)", () => {
    // The same constants main.ts passes to rearmParkedRecurringTimers.
    const rearmed = [SWEEP_IDEMPOTENCY_KEYS, NIGHTLY, NO_FIX_OFFLINE, NO_FIX_SWEEP, SMART_SURGE_CHECK, ALERT_SWEEP, ...HOUSEKEEPING_KINDS, PAYOUT_CLOSE, PAYOUT_DRIVER, PAY_REQUEST_SCAN];
    expect(RECURRING_JOBS.map((job) => job.kind).sort()).toEqual(rearmed.filter((kind) => kind !== NO_FIX_SWEEP && kind !== PAYOUT_DRIVER).sort());
    expect(new Set(RECURRING_JOBS.map((job) => job.kind)).size).toBe(RECURRING_JOBS.length);
    for (const job of RECURRING_JOBS) expect(job.everyMs).toBeGreaterThan(0);
  });
});

describe("G34 S3 (v0.18.83 fastDispatch.lateAlarm, owner 60 s / 30 s): per-trip and dispatch timers watched as groups", () => {
  const timer = (kind: string, ref: string, dueAt: Date | "infinity") =>
    database.db.insertInto("timers").values({ kind, ref_id: ref, due_at: dueAt === "infinity" ? sql`'infinity'::timestamptz` : dueAt, payload: "{}", ...(dueAt === "infinity" ? { attempts: 8 } : {}) }).execute();

  it("the groups, kinds and limits are the contract's", () => {
    const alarm = (contract.fastDispatch as { lateAlarm: { tripTimers: { kinds: string[]; lateSeconds: number }; dispatch: { kinds: string[]; lateSeconds: number } } }).lateAlarm;
    expect(LANE_LATE_LIMITS).toEqual([
      { group: "trip_timers", kinds: alarm.tripTimers.kinds, lateMs: alarm.tripTimers.lateSeconds * 1000 },
      { group: "dispatch", kinds: alarm.dispatch.kinds, lateMs: alarm.dispatch.lateSeconds * 1000 },
    ]);
    // The names are the kinds the worker really books (the trip lane's kinds, the dispatch lane's kinds).
    expect(LANE_LATE_LIMITS[0]!.kinds).toEqual([...TRIP_LANE_KINDS]);
    expect(LANE_LATE_LIMITS[1]!.kinds).toEqual([ROUND, WITHDRAW]);
    expect(alarm.tripTimers.lateSeconds).toBe(60);
    expect(alarm.dispatch.lateSeconds).toBe(30);
  });

  it("a per-trip timer 59 s late is on time; 60 s late answers 503 naming trip_timers with lateSeconds and overdue", async () => {
    await timer("trip_eta", "trp_s3_a", at(-59_000));
    await timer("ride_check_scan", "trp_s3_b", at(-5_000));
    expect((await get()).statusCode).toBe(200);
    await timer("near_dropoff", "trp_s3_c", at(-60_000));
    const res = await get();
    expect(res.statusCode).toBe(503);
    // overdue = every timer of the group past due (3), not only the late one.
    expect(res.json()).toMatchObject({ status: "late", jobs: [{ kind: "trip_timers", state: "late", lateSeconds: 60, overdue: 3 }] });
  });

  it("a dispatch round 29 s late is on time; withdraw_driver_offers 30 s late names dispatch; both groups at once", async () => {
    await timer("dispatch_round", "trp_s3_d", at(-29_000));
    expect((await get()).statusCode).toBe(200);
    await timer("withdraw_driver_offers", "trp_s3_e", at(-30_000));
    let res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.json().jobs).toEqual([{ kind: "dispatch", state: "late", lateSeconds: 30, overdue: 2 }]);
    await timer("trip_eta", "trp_s3_f", at(-125_000));
    res = await get();
    expect(res.json().jobs).toEqual([
      { kind: "trip_timers", state: "late", lateSeconds: 125, overdue: 1 },
      { kind: "dispatch", state: "late", lateSeconds: 30, overdue: 2 },
    ]);
  });

  it("a parked ('infinity') or future trip timer is never late; a dispatch round 29 s late does not count as a trip timer", async () => {
    await timer("trip_eta", "trp_s3_g", "infinity");
    await timer("near_dropoff", "trp_s3_h", at(120_000));
    await timer("dispatch_round", "trp_s3_i", at(-29_000));
    expect((await get()).statusCode).toBe(200);
  });

  it("another kind (incident_escalate) far past due never makes a group late", async () => {
    await timer("incident_escalate", "inc_s3", at(-3_600_000));
    expect((await get()).statusCode).toBe(200);
  });
});
