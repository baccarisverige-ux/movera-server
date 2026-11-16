import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TimerBusy, TimerWorker, type TimerHandler } from "../../src/jobs/timers.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Q120 follow-ups round 2, SF-B (Rules audits/impact/s7-q120-followups-supervisor.md): the leave check's give-up rule
 * (reservations/service.ts leaveRouteGivenUp) reads Timer.busyTries, the worker's count of busy runs in a row. That
 * count must start again at 0 once a run of the timer ends without being busy (src/jobs/timers.ts runOne: the line
 * that forgets the timer after a run). A timer row keeps its id only while it is retried (busy, or a failure that is
 * recorded and run again); a timer written anew gets a new id. So the case where a stale count would bite is: busy
 * runs, then a failure (the row is kept, same id), then the retry: it must start at 0, not at the old count.
 * Mutation M14 (the worker never forgets the count after a run) fails this test.
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

const NOW = new Date("2026-11-16T10:00:00Z");
const logger = { warn: () => undefined, error: () => undefined };
const KIND = "q120_busy_count_probe";

describe("Q120 SF-B: the worker's busy count starts again after a run that was not busy", () => {
  it("3 busy runs, a failed run (row kept, same id), then the retry sees no busy count; 1 busy run later it sees 1", async () => {
    const script: ("busy" | "fail" | "ok")[] = ["busy", "busy", "busy", "fail", "busy", "ok"];
    const seen: (number | undefined)[] = [];
    const ids: string[] = [];
    const handler: TimerHandler = async (_trx, timer) => {
      seen.push(timer.busyTries);
      ids.push(timer.timerId);
      const step = script[seen.length - 1];
      if (step === "busy") throw new TimerBusy("probe: busy");
      if (step === "fail") throw new Error("probe: failed");
    };
    const clock = { now: NOW };
    const worker = new TimerWorker(database.db, { handlers: { [KIND]: handler }, logger, clock: () => clock.now, pollMs: 20 });
    await database.db.insertInto("timers").values({ kind: KIND, ref_id: "sfb", due_at: NOW }).execute();
    // Steps of 10 s: past every busy wait (at most 2 s) and the first failure's backoff (1 s), well inside the 60 s a
    // stale entry is kept for.
    for (let i = 0; i < script.length; i++) {
      await worker.runOne();
      clock.now = new Date(clock.now.getTime() + 10_000);
    }
    console.log(`SF-B proof: busyTries per run ${JSON.stringify(seen)}; one timer id ${new Set(ids).size === 1}`);
    expect(new Set(ids).size).toBe(1);
    expect(seen).toEqual([undefined, 1, 2, 3, undefined, 1]);
    expect(await database.db.selectFrom("timers").select("timer_id").where("kind", "=", KIND).execute()).toEqual([]);
  });
});
