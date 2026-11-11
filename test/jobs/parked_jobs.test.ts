import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { raiseParkedAlert, sweepAlerts } from "../../src/alerts/detector.js";
import pg from "pg";
import * as timers from "../../src/jobs/timers.js";
import { MAX_ATTEMPTS, TimerWorker, type TimerHandler, type TimerWorkerOptions } from "../../src/jobs/timers.js";
import { buildWorkerConfig } from "../../src/jobs/workerConfig.js";
import { EstimateRouter } from "../../src/maps/routing.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * B1.6b (stage S4 wave B1; owner W1 Q70 "Re-arm every stopped job at start, a loud alarm for stopped trip and safety
 * jobs, and an admin 'Retry job' button?" = Yes, 2026-11-11), server part:
 *   1. the alert NAMES the parked job (kind and ref), critical for trip and safety kinds;
 *   2. a parked alert_sweep still raises it (the worker that parks a timer refreshes the system alert itself);
 *   3. a parked trip or safety timer runs once more after 60 s, once overall (several copies of the server), then
 *      stays parked; other one-off kinds stay parked at once (as before);
 *   4. at start, a trip or safety timer parked before this code runs once more, once overall.
 * Fails before: one "{n} background jobs failed" alert with no kind (detector.ts systemCauses), nothing when
 * alert_sweep is parked, and every one-off timer parked at 'infinity' for good.
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

const NOW = new Date("2026-11-11T10:00:00Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const logger = { warn: () => undefined, error: () => undefined };
const db = () => database.db;
const live = () => db().selectFrom("admin_alerts_live").selectAll().where("kind", "=", "system_health").where("state", "=", "open").orderBy("cause_key").execute();
const row = (kind: string) => db().selectFrom("timers").selectAll().where("kind", "=", kind).executeTakeFirstOrThrow();
const failing: TimerHandler = async () => {
  throw new Error("boom");
};

/** A worker set up as main.ts sets it up (buildWorkerConfig), with some handlers replaced. */
function worker(clock: { now: Date }, replace: Record<string, TimerHandler>) {
  const config = buildWorkerConfig(new EstimateRouter(), { timerLanes: 1, dispatchLanes: 1 }) as ReturnType<typeof buildWorkerConfig> & { parked?: Partial<TimerWorkerOptions> };
  return new TimerWorker(db(), { ...(config.parked ?? {}), handlers: { ...config.handlers, ...replace }, logger, clock: () => clock.now, pollMs: 20 });
}

describe("B1.6b: the parked-job alert names the job", () => {
  it("a parked incident_escalate gives a critical system alert that names the kind and the ref", async () => {
    await db().insertInto("timers").values({ kind: "incident_escalate", ref_id: "inc_b16", due_at: sql<Date>`'infinity'::timestamptz`, attempts: MAX_ATTEMPTS, last_error: "boom" }).execute();
    await db().transaction().execute((trx) => sweepAlerts(trx, NOW));
    const rows = await live();
    expect(rows.length).toBeGreaterThan(0);
    for (const alert of rows) {
      expect(alert.level).toBe("critical");
      expect(`${alert.title} ${alert.detail}`).toContain("incident_escalate");
      expect(alert.detail).toContain("inc_b16");
    }
  });

  it("each parked kind has its own alert; a non-trip kind keeps the book's level", async () => {
    await db().insertInto("timers").values([
      { kind: "incident_escalate", ref_id: "inc_1", due_at: sql<Date>`'infinity'::timestamptz`, attempts: MAX_ATTEMPTS },
      { kind: "x_test", ref_id: "x_1", due_at: sql<Date>`'infinity'::timestamptz`, attempts: MAX_ATTEMPTS },
    ]).execute();
    await db().transaction().execute((trx) => sweepAlerts(trx, NOW));
    const se = (await live()).filter((a) => a.country === "SE");
    expect(se.map((a) => [a.detail.split(":")[0], a.level])).toEqual([["incident_escalate", "critical"], ["x_test", "important"]]);
  });

  it("a parked alert_sweep still raises an alert naming it (no sweep has to run)", async () => {
    const clock = { now: NOW };
    await db().insertInto("timers").values({ kind: "alert_sweep", ref_id: "all", due_at: NOW, attempts: MAX_ATTEMPTS - 1 }).execute();
    await worker(clock, { alert_sweep: failing }).runDue();
    expect(Number((await row("alert_sweep")).due_at)).toBe(Infinity);
    const rows = await live();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => a.detail.includes("alert_sweep"))).toBe(true);
  });
});

describe("B1.6b: a parked trip or safety timer restarts once", () => {
  it("near_dropoff runs once more after 60 s, once across two copies of the server, then stays parked", async () => {
    const clock = { now: NOW };
    let runs = 0;
    const counting: TimerHandler = async () => {
      runs += 1;
      throw new Error("still failing");
    };
    const a = worker(clock, { near_dropoff: counting });
    const b = worker(clock, { near_dropoff: counting });
    await db().insertInto("timers").values({ kind: "near_dropoff", ref_id: "trp_b16", due_at: NOW, attempts: MAX_ATTEMPTS - 1 }).execute();
    await a.runDue();
    expect(runs).toBe(1);
    const parked = await row("near_dropoff");
    expect([parked.due_at.toISOString(), parked.attempts]).toEqual([at(60).toISOString(), MAX_ATTEMPTS]);
    expect((await live()).some((x) => x.level === "critical" && x.detail.includes("near_dropoff"))).toBe(true);
    clock.now = at(60);
    await Promise.all([a.runDue(), b.runDue()]);
    expect(runs).toBe(2);
    const final = await row("near_dropoff");
    expect([Number(final.due_at), final.attempts]).toEqual([Infinity, MAX_ATTEMPTS + 1]);
    clock.now = at(3600);
    await Promise.all([a.runDue(), b.runDue()]);
    expect(runs).toBe(2);
  });

  it("a restarted timer that works this time is gone; a one-off kind outside the list is parked at once, as before", async () => {
    const clock = { now: NOW };
    let ok = false;
    const w = worker(clock, { incident_escalate: async () => { if (!ok) throw new Error("boom"); }, offer_expiry: failing });
    await db().insertInto("timers").values([
      { kind: "incident_escalate", ref_id: "inc_ok", due_at: NOW, attempts: MAX_ATTEMPTS - 1 },
      { kind: "offer_expiry", ref_id: "ofr_1", due_at: NOW, attempts: MAX_ATTEMPTS - 1 },
    ]).execute();
    await w.runDue();
    expect(Number((await row("offer_expiry")).due_at)).toBe(Infinity);
    ok = true;
    clock.now = at(60);
    await w.runDue();
    expect(await db().selectFrom("timers").select("kind").where("kind", "=", "incident_escalate").execute()).toEqual([]);
  });

  it("at start, a trip timer parked before this code runs once more, once overall (two copies starting)", async () => {
    const restart = (timers as Record<string, unknown>)["restartParkedOnce"] as undefined | ((ex: unknown, kinds: readonly string[], log: unknown, now: Date) => Promise<number>);
    expect(typeof restart).toBe("function");
    const { RESTART_ONCE_KINDS } = (await import("../../src/jobs/workerConfig.js")) as unknown as { RESTART_ONCE_KINDS: readonly string[] };
    await db().insertInto("timers").values([
      { kind: "driver_silence", ref_id: "trp_old", due_at: sql<Date>`'infinity'::timestamptz`, attempts: MAX_ATTEMPTS },
      { kind: "driver_silence", ref_id: "trp_twice", due_at: sql<Date>`'infinity'::timestamptz`, attempts: MAX_ATTEMPTS + 1 },
      { kind: "offer_expiry", ref_id: "ofr_old", due_at: sql<Date>`'infinity'::timestamptz`, attempts: MAX_ATTEMPTS },
    ]).execute();
    const counts = await Promise.all([restart!(db(), RESTART_ONCE_KINDS, logger, NOW), restart!(db(), RESTART_ONCE_KINDS, logger, NOW)]);
    expect(counts.sort()).toEqual([0, 1]);
    const rows = await db().selectFrom("timers").select(["ref_id", "due_at", "attempts"]).orderBy("ref_id").execute();
    expect(rows.map((r) => [r.ref_id, Number(r.due_at) === Infinity ? "parked" : r.due_at.toISOString(), r.attempts])).toEqual([
      ["ofr_old", "parked", MAX_ATTEMPTS],
      ["trp_old", NOW.toISOString(), MAX_ATTEMPTS],
      ["trp_twice", "parked", MAX_ATTEMPTS + 1],
    ]);
    expect(await restart!(db(), RESTART_ONCE_KINDS, logger, at(60))).toBe(0);
  });
});

describe("B1.6b: the worker never waits on a running alert sweep (supervisor F2)", () => {
  it("raiseParkedAlert skips at once when another sweep holds the sweep lock (that sweep sees the row on its next run)", async () => {
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('movera_alert_sweep'))");
      const started = Date.now();
      await raiseParkedAlert(db(), {}, NOW);
      expect(Date.now() - started).toBeLessThan(1000);
      await holder.query("ROLLBACK");
    } finally {
      await holder.end();
    }
  }, 20_000);

  it("G10: a skipped parked-job alert pokes a sweep, so the alert appears right after the lock holder finishes", async () => {
    const holder = new pg.Client({ connectionString: database.url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('movera_alert_sweep'))");
      await db().insertInto("timers").values({ kind: "incident_escalate", ref_id: "inc_g10", due_at: sql<Date>`'infinity'::timestamptz`, attempts: MAX_ATTEMPTS + 1, last_error: "boom" }).execute();
      await raiseParkedAlert(db(), {}, NOW);
      expect(await live()).toHaveLength(0);
      await holder.query("ROLLBACK");
    } finally {
      await holder.end();
    }
    // A one-off sweep (alert_sweep "poke") is due now, and running it raises the alert naming the parked job.
    const poke = await db().selectFrom("timers").selectAll().where("kind", "=", "alert_sweep").where("ref_id", "=", "poke").executeTakeFirst();
    expect(poke?.due_at.getTime()).toBeLessThanOrEqual(NOW.getTime());
    await worker({ now: NOW }, {}).runDue();
    const rows = await live();
    expect(rows.map((r) => `${r.title} ${r.detail}`).join(" ")).toContain("inc_g10");
  }, 20_000);
});

