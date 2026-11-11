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
import { RECURRING_JOBS } from "../../src/jobs/heartbeat.js";
import { PAYOUT_CLOSE, PAYOUT_DRIVER } from "../../src/jobs/payouts.js";
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
    const rearmed = [SWEEP_IDEMPOTENCY_KEYS, NIGHTLY, NO_FIX_OFFLINE, NO_FIX_SWEEP, SMART_SURGE_CHECK, ALERT_SWEEP, ...HOUSEKEEPING_KINDS, PAYOUT_CLOSE, PAYOUT_DRIVER];
    expect(RECURRING_JOBS.map((job) => job.kind).sort()).toEqual(rearmed.filter((kind) => kind !== NO_FIX_SWEEP && kind !== PAYOUT_DRIVER).sort());
    expect(new Set(RECURRING_JOBS.map((job) => job.kind)).size).toBe(RECURRING_JOBS.length);
    for (const job of RECURRING_JOBS) expect(job.everyMs).toBeGreaterThan(0);
  });
});
