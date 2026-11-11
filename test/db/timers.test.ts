import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, TimerWorker, rearmParkedRecurringTimers, timerLanes, backoffMs, cancelTimer, scheduleTimer, type TimerHandler } from "../../src/jobs/timers.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});
beforeEach(async () => {
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("riders").execute();
});

const T0 = new Date("2026-10-23T10:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const logs: Array<{ level: string; message: string; data: object }> = [];
const logger = {
  warn: (data: object, message: string) => logs.push({ level: "warn", message, data }),
  error: (data: object, message: string) => logs.push({ level: "error", message, data }),
};

function worker(handlers: Record<string, TimerHandler>, clock: { now: Date }) {
  return new TimerWorker(database.db, { handlers, logger, clock: () => clock.now, pollMs: 20 });
}
async function pending() {
  return database.db.selectFrom("timers").selectAll().orderBy("timer_id").execute();
}

describe("timers", () => {
  it("a timer runs once it is due, not before, and is then gone", async () => {
    const seen: unknown[] = [];
    const clock = { now: at(0) };
    const w = worker({ offer_expiry: async (_trx, timer) => void seen.push([timer.refId, timer.payload]) }, clock);
    await scheduleTimer(database.db, { kind: "offer_expiry", refId: "ofr_1", dueAt: at(15), payload: { tripId: "trp_1" } });
    expect(await w.runDue()).toBe(0);
    clock.now = at(15);
    expect(await w.runDue()).toBe(1);
    expect(seen).toEqual([["ofr_1", { tripId: "trp_1" }]]);
    expect(await pending()).toEqual([]);
  });

  it("due timers run oldest first", async () => {
    const seen: string[] = [];
    const clock = { now: at(100) };
    const w = worker({ step: async (_trx, timer) => void seen.push(timer.refId) }, clock);
    await scheduleTimer(database.db, { kind: "step", refId: "c", dueAt: at(30) });
    await scheduleTimer(database.db, { kind: "step", refId: "a", dueAt: at(10) });
    await scheduleTimer(database.db, { kind: "step", refId: "b", dueAt: at(20) });
    await w.runDue();
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("scheduling the same kind and id again moves it; cancel removes it", async () => {
    await scheduleTimer(database.db, { kind: "search_expiry", refId: "trp_1", dueAt: at(60) });
    await scheduleTimer(database.db, { kind: "search_expiry", refId: "trp_1", dueAt: at(90), payload: { n: 2 } });
    const rows = await pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ due_at: at(90), payload: { n: 2 }, attempts: 0 });
    expect(await cancelTimer(database.db, "search_expiry", "trp_1")).toBe(true);
    expect(await cancelTimer(database.db, "search_expiry", "trp_1")).toBe(false);
    expect(await pending()).toEqual([]);
  });

  it("a handler's writes and its follow-up timer commit together with the timer's removal", async () => {
    const clock = { now: at(0) };
    const w = worker(
      {
        dispatch_step: async (trx, timer) => {
          const step = (timer.payload as { step: number }).step;
          await trx.insertInto("riders").values({ rider_id: `rdr_step${step}`, phone: `+4670000000${step}`, email: null, language: null }).execute();
          if (step < 3) await scheduleTimer(trx, { kind: "dispatch_step", refId: timer.refId, dueAt: at(10 * step), payload: { step: step + 1 } });
        },
      },
      clock,
    );
    await scheduleTimer(database.db, { kind: "dispatch_step", refId: "trp_9", dueAt: at(0), payload: { step: 1 } });
    for (const second of [0, 10, 20]) {
      clock.now = at(second);
      expect(await w.runDue()).toBe(1);
    }
    const riders = await database.db.selectFrom("riders").select("rider_id").orderBy("rider_id").execute();
    expect(riders.map((row) => row.rider_id)).toEqual(["rdr_step1", "rdr_step2", "rdr_step3"]);
    expect(await pending()).toEqual([]);
  });

  it("a failing handler is undone, then retried later with a growing delay", async () => {
    logs.length = 0;
    const clock = { now: at(0) };
    let calls = 0;
    const w = worker(
      {
        flaky: async (trx) => {
          calls++;
          await trx.insertInto("riders").values({ rider_id: `rdr_flaky${calls}`, phone: `+4670100000${calls}`, email: null, language: null }).execute();
          if (calls < 3) throw new Error(`boom ${calls}`);
        },
      },
      clock,
    );
    await scheduleTimer(database.db, { kind: "flaky", refId: "x", dueAt: at(0) });
    expect(await w.runOne()).toBe(true);
    expect(await pending()).toMatchObject([{ attempts: 1, last_error: "boom 1", due_at: at(1) }]);
    expect(await w.runOne()).toBe(false);
    clock.now = at(1);
    await w.runOne();
    expect(await pending()).toMatchObject([{ attempts: 2, last_error: "boom 2", due_at: at(3) }]);
    clock.now = at(3);
    await w.runOne();
    expect(await pending()).toEqual([]);
    const riders = await database.db.selectFrom("riders").select("rider_id").execute();
    expect(riders.map((row) => row.rider_id)).toEqual(["rdr_flaky3"]);
    expect(logs.map((entry) => entry.level)).toEqual(["warn", "warn"]);
  });

  it("after repeated failures a timer is parked and reported, not retried forever", async () => {
    logs.length = 0;
    const clock = { now: at(0) };
    const w = worker({}, clock);
    await scheduleTimer(database.db, { kind: "nobody_handles_this", refId: "x", dueAt: at(0) });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      clock.now = at(3600 * (i + 1));
      await w.runOne();
    }
    const [row] = await database.pool.query("SELECT attempts, due_at = 'infinity' AS parked, last_error FROM timers").then((r) => r.rows);
    expect(row).toEqual({ attempts: MAX_ATTEMPTS, parked: true, last_error: "No handler for timer kind nobody_handles_this" });
    clock.now = at(10 ** 7);
    expect(await w.runOne()).toBe(false);
    expect(logs.at(-1)).toMatchObject({ level: "error", message: "timer parked after repeated failures" });
  });

  it("backoff doubles from 1 s and stops at 5 minutes", () => {
    expect([1, 2, 3, 4, 10, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 300_000, 300_000]);
  });

  it("several workers share the due timers: each runs exactly once", async () => {
    const clock = { now: at(0) };
    const runs = new Map<string, number>();
    const handler: TimerHandler = async (_trx, timer) => {
      runs.set(timer.refId, (runs.get(timer.refId) ?? 0) + 1);
      await sleep(5);
    };
    for (let i = 0; i < 40; i++) await scheduleTimer(database.db, { kind: "offer_expiry", refId: `ofr_${i}`, dueAt: at(0) });
    const workers = Array.from({ length: 4 }, () => worker({ offer_expiry: handler }, clock));
    const counts = await Promise.all(workers.map((w) => w.runDue()));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(40);
    expect(counts.filter((count) => count > 0).length).toBeGreaterThan(1);
    expect(runs.size).toBe(40);
    expect([...runs.values()].every((count) => count === 1)).toBe(true);
  });

  it("the background loop picks up timers and stops cleanly", async () => {
    const clock = { now: at(0) };
    const seen: string[] = [];
    const w = worker({ ping: async (_trx, timer) => void seen.push(timer.refId) }, clock);
    w.start();
    await scheduleTimer(database.db, { kind: "ping", refId: "p1", dueAt: at(0) });
    for (let i = 0; i < 50 && seen.length === 0; i++) await sleep(20);
    await w.stop();
    expect(seen).toEqual(["p1"]);
  });
});

describe("timers — Job 1 (fast dispatch)", () => {
  it("a busy timer keeps its place: it runs before a backlog of later timers once its short retry is over", async () => {
    const { TimerBusy } = await import("../../src/jobs/timers.js");
    const seen: string[] = [];
    let busyOnce = true;
    const clock = { now: at(500) };
    const w = worker({
      round: async (_trx, timer) => {
        if (timer.refId === "first" && busyOnce) {
          busyOnce = false;
          throw new TimerBusy("trip busy");
        }
        seen.push(timer.refId);
      },
    }, clock);
    await scheduleTimer(database.db, { kind: "round", refId: "first", dueAt: at(0) });
    for (let i = 1; i <= 20; i++) await scheduleTimer(database.db, { kind: "round", refId: `later${i}`, dueAt: at(i) });
    expect(await w.runOne()).toBe(true); // "first" was busy
    for (let i = 0; i < 3; i++) await w.runOne();
    clock.now = at(501); // the 250 ms retry is over
    await w.runDue();
    // Before Job 1 the busy timer was moved to now + 250 ms, behind all 20 overdue ones (it ran last).
    expect(seen.indexOf("first")).toBe(3);
    expect(seen).toHaveLength(21);
  });

  it("a lane takes only its kinds; another lane leaves them alone", async () => {
    const seen: string[] = [];
    const clock = { now: at(100) };
    const w = worker({ dispatch_round: async (_t, timer) => void seen.push(timer.kind), trip_eta: async (_t, timer) => void seen.push(timer.kind) }, clock);
    await scheduleTimer(database.db, { kind: "trip_eta", refId: "t1", dueAt: at(0) });
    await scheduleTimer(database.db, { kind: "dispatch_round", refId: "t2", dueAt: at(5) });
    await w.runDue(100, { kinds: ["dispatch_round"] });
    expect(seen).toEqual(["dispatch_round"]);
    await w.runDue(100, { exclude: ["trip_eta"] });
    expect(seen).toEqual(["dispatch_round"]);
    await w.runDue(100, { kinds: ["trip_eta"] });
    expect(seen).toEqual(["dispatch_round", "trip_eta"]);
  });

  it("prepare runs outside the transaction (no row lock held) and its result reaches the handler", async () => {
    const clock = { now: at(100) };
    const got: unknown[] = [];
    const handler: TimerHandler = async (_trx, timer) => void got.push(timer.prepared);
    handler.prepare = async (db) => {
      // The timer row is not locked while preparing: another connection can lock it without waiting.
      const row = await db.transaction().execute((trx) => trx.selectFrom("timers").select("timer_id").forUpdate().noWait().executeTakeFirst());
      return { locked: row === undefined ? "gone" : "free" };
    };
    const w = worker({ slow: handler }, clock);
    await scheduleTimer(database.db, { kind: "slow", refId: "x", dueAt: at(0) });
    await w.runDue();
    expect(got).toEqual([{ locked: "free" }]);
    expect(await pending()).toEqual([]);
  });

  it("several lanes run at once and never run one timer twice", async () => {
    const seen: string[] = [];
    const clock = { now: at(100) };
    const w = new TimerWorker(database.db, { handlers: { step: async (_t, timer) => { await sleep(5); seen.push(timer.refId); } }, logger, clock: () => clock.now, pollMs: 10, lanes: [{}, {}, {}, {}] });
    for (let i = 0; i < 40; i++) await scheduleTimer(database.db, { kind: "step", refId: `s${i}`, dueAt: at(0) });
    w.start();
    for (let i = 0; i < 200 && seen.length < 40; i++) await sleep(20);
    await w.stop();
    expect(seen.length).toBe(40);
    expect(new Set(seen).size).toBe(40);
  });
  it("stress T-A part 4: several dispatch-only lanes; two slow dispatch rounds run side by side", async () => {
    const lanes = timerLanes({ dispatchKinds: ["dispatch_round", "withdraw_driver_offers"], tripKinds: ["trip_eta"], timerLanes: 4, dispatchLanes: 3 });
    expect(lanes.filter((l) => l.kinds?.includes("dispatch_round")).length).toBe(3);
    expect(lanes.filter((l) => l.exclude !== undefined).length).toBe(2);
    const clock = { now: at(100) };
    let running = 0;
    let most = 0;
    const slow: TimerHandler = async () => { running++; most = Math.max(most, running); await sleep(150); running--; };
    const w = new TimerWorker(database.db, { handlers: { dispatch_round: slow }, logger, clock: () => clock.now, pollMs: 10, lanes: lanes.slice(0, 3) });
    await scheduleTimer(database.db, { kind: "dispatch_round", refId: "trp_a", dueAt: at(0) });
    await scheduleTimer(database.db, { kind: "dispatch_round", refId: "trp_b", dueAt: at(0) });
    w.start();
    for (let i = 0; i < 100 && (await pending()).length > 0; i++) await sleep(20);
    await sleep(200);
    await w.stop();
    expect(most).toBe(2);
  });

  it("stress T-A part 4: a deadlock (40P01) is a busy timer: kept, retried soon, no failed attempt", async () => {
    const clock = { now: at(100) };
    let calls = 0;
    const w = worker({ dispatch_round: async () => { calls++; if (calls === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" }); } }, clock);
    await scheduleTimer(database.db, { kind: "dispatch_round", refId: "trp_d", dueAt: at(0) });
    await w.runOne();
    const [row] = await pending();
    expect(row?.attempts).toBe(0);
    expect(row?.due_at.getTime()).toBe(at(0).getTime());
    clock.now = at(103);
    await w.runOne();
    expect(calls).toBe(2);
    expect(await pending()).toEqual([]);
  });
});

describe("S05 A1: parked recurring timers at start", () => {
  it("re-arms a parked recurring timer (due now, attempts 0, one warning) and leaves parked one-off timers alone", async () => {
    await database.db
      .insertInto("timers")
      .values([
        { kind: "nightly_summary", ref_id: "all", due_at: sql<Date>`'infinity'::timestamptz`, attempts: MAX_ATTEMPTS, last_error: "boom" },
        { kind: "offer_expiry", ref_id: "ofr_1", due_at: sql<Date>`'infinity'::timestamptz`, attempts: MAX_ATTEMPTS, last_error: "boom" },
      ])
      .execute();
    logs.length = 0;
    const count = await rearmParkedRecurringTimers(database.db, ["nightly_summary", "sweep_idempotency_keys"], logger, T0);
    expect(count).toBe(1);
    const rows = await pending();
    const nightly = rows.find((row) => row.kind === "nightly_summary")!;
    expect(nightly.due_at.getTime()).toBe(T0.getTime());
    expect(nightly.attempts).toBe(0);
    expect(Number(rows.find((row) => row.kind === "offer_expiry")!.due_at)).toBe(Infinity);
    expect(logs.filter((entry) => entry.level === "warn" && entry.message.includes("re-armed"))).toHaveLength(1);
  });
});
