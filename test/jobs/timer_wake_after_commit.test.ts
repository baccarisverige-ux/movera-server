import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { ROUND } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import * as timers from "../../src/jobs/timers.js";
import { TimerWorker, scheduleTimer, type TimerHandler } from "../../src/jobs/timers.js";
import { buildWorkerConfig } from "../../src/jobs/workerConfig.js";
import { EstimateRouter } from "../../src/maps/routing.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * S7 0.16 (owner W2 Q120 part 2 "Yes, all three", 2026-11-15): TimerWorker.kick() existed but only stop() called it, so
 * a new search's first dispatch round (written "due now" in the booking's transaction) waited for the worker's next
 * poll. Now that write also sends a NOTIFY in the same transaction; PostgreSQL delivers it only when the transaction
 * COMMITS, and the worker is woken then: never inside the transaction, never for a rolled-back write.
 * The worker here polls only every 60 s, so anything that happens in time was the wake, not the poll.
 * Real PostgreSQL, real hub (LISTEN), real worker.
 */

// Read through the module object so this file also loads on the code before the fix (where they do not exist).
const TIMER_DUE_CHANNEL = (timers as unknown as { TIMER_DUE_CHANNEL?: string }).TIMER_DUE_CHANNEL ?? "movera_timer_due";
const wakeTimersOn = (timers as unknown as { wakeTimersOn?: (hub: NotificationHub, worker: TimerWorker) => () => void }).wakeTimersOn ?? (() => () => undefined);
const scheduleWaking = scheduleTimer as unknown as (ex: unknown, timer: { kind: string; refId: string; dueAt: Date; payload?: unknown }, options: { wake: boolean }) => Promise<void>;

const POLL_MS = 60_000;
let database: TestDatabase;
let app: FastifyInstance;
let hub: NotificationHub;
const clock = { now: new Date("2026-11-16T10:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const SPOT = { lat: 59.3335, lng: 18.0655 };
let driver: { id: string; headers: Record<string, string> };
let rider: Record<string, string>;
let worker: TimerWorker | undefined;
const quiet = { warn: () => undefined, error: () => undefined };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits (real time) until `read` gives something, at most `maxMs`; returns it with how long it took. */
async function until<T>(read: () => Promise<T | undefined> | T | undefined, maxMs: number): Promise<{ value: T | undefined; ms: number }> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined || Date.now() - start >= maxMs) return { value, ms: Date.now() - start };
    await sleep(10);
  }
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null }).execute();
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver W", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "TST016", categoryIds: ["economy"], zoneIds: ["Z001", "Z002"] }, clock.now),
  );
  driver = { id: made.driverId, headers: {} };
  hub = new NotificationHub(database.url, [TIMER_DUE_CHANNEL]);
  await hub.start();
});
afterAll(async () => {
  await hub.stop();
  await app.close();
  await database.drop();
});

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driver.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driver.id).execute();
  await call(app, "POST", "/driver/location", driver.headers, { fixes: [{ ...SPOT, accuracy: 5, measuredAt: clock.now.toISOString() }] });
  await database.db.deleteFrom("timers").execute();
});
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});

/** The worker as main.ts builds it (dispatch, trip, general, housekeeping lanes), but polling only every 60 s. */
function startWorker(extra: Record<string, TimerHandler> = {}): { worker: TimerWorker; unwake: () => void } {
  const config = buildWorkerConfig(new EstimateRouter(), { timerLanes: 3, dispatchLanes: 2 });
  const w = new TimerWorker(database.db, { ...config.parked, handlers: { ...config.handlers, ...extra }, logger: quiet, clock: () => clock.now, pollMs: POLL_MS, lanes: config.lanes });
  worker = w;
  w.start();
  return { worker: w, unwake: wakeTimersOn(hub, w) };
}

const offersOf = (tripId: string) => database.db.selectFrom("offers").select(["driver_id", "status"]).where("trip_id", "=", tripId).execute();
async function book(): Promise<string> {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
  expect(res.statusCode).toBe(201);
  return res.json().tripId as string;
}

describe("S7 0.16: the timer worker is woken when a booking commits", () => {
  it("the first offer goes out right after the booking commit, without waiting for the poll (the poll is 60 s away)", async () => {
    const { unwake } = startWorker();
    // Every lane has done its first look and now sleeps for 60 s.
    await sleep(500);
    const start = Date.now();
    const tripId = await book();
    const booked = Date.now() - start;
    const first = await until(async () => ((await offersOf(tripId)).length > 0 ? true : undefined), 3_000);
    console.log(`0.16 proof: worker poll ${POLL_MS} ms; booking answered after ${booked} ms; first offer ${first.value ? `${first.ms} ms after the answer` : `NOT sent within ${first.ms} ms`}`);
    expect(first.value).toBe(true);
    expect(await offersOf(tripId)).toEqual([{ driver_id: driver.id, status: "open" }]);
    unwake();
  });

  it("the next round after a decline goes out without the poll too (the driver is asked again at once)", async () => {
    const { unwake } = startWorker();
    await sleep(500);
    const tripId = await book();
    const offer = await until(async () => database.db.selectFrom("offers").select(["offer_id", "version"]).where("trip_id", "=", tripId).where("status", "=", "open").executeTakeFirst(), 3_000);
    expect(offer.value).toBeDefined();
    const rounds = async () => Number((await database.db.selectFrom("searches").select("rounds").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).rounds);
    const before = await rounds();
    const declined = await call(app, "POST", `/offers/${offer.value!.offer_id}/decline`, driver.headers, { expectedVersion: offer.value!.version });
    expect(declined.statusCode).toBe(200);
    const next = await until(async () => ((await rounds()) > before ? true : undefined), 3_000);
    console.log(`0.16 proof (decline): next round ${next.value ? `ran ${next.ms} ms after the decline` : `did NOT run within ${next.ms} ms`}`);
    expect(next.value).toBe(true);
    unwake();
  });
});

describe("S7 0.16: never inside the transaction, never for a rolled-back write", () => {
  it("no kick while the transaction is open; a rolled-back booking write kicks nothing; a committed one kicks once", async () => {
    const ran: string[] = [];
    const { worker: w, unwake } = startWorker({ [ROUND]: async (_trx, timer) => void ran.push(timer.refId) });
    await sleep(500);
    const kick = vi.spyOn(w, "kick");
    const boom = new Error("rolled back on purpose");

    // 1. Rolled back: the write and its wake are both undone.
    await expect(
      database.db.transaction().execute(async (trx) => {
        await scheduleWaking(trx, { kind: ROUND, refId: "trp_rolled_back", dueAt: clock.now, payload: {} }, { wake: true });
        // Still inside the transaction, 300 ms later: nobody was kicked, nothing ran.
        await sleep(300);
        expect(kick).toHaveBeenCalledTimes(0);
        expect(ran).toEqual([]);
        throw boom;
      }),
    ).rejects.toBe(boom);
    await sleep(700);
    console.log(`0.16 proof (rollback): kicks after a rolled-back write: ${kick.mock.calls.length}; rounds run: ${ran.length}`);
    expect(kick).toHaveBeenCalledTimes(0);
    expect(ran).toEqual([]);
    expect(await database.db.selectFrom("timers").select("timer_id").where("ref_id", "=", "trp_rolled_back").execute()).toEqual([]);

    // 2. Committed: not kicked while the transaction is open; kicked once it committed, for the dispatch kind.
    let inside = -1;
    await database.db.transaction().execute(async (trx) => {
      await scheduleWaking(trx, { kind: ROUND, refId: "trp_committed", dueAt: clock.now, payload: {} }, { wake: true });
      await scheduleWaking(trx, { kind: ROUND, refId: "trp_committed_2", dueAt: clock.now, payload: {} }, { wake: true });
      await sleep(300);
      inside = kick.mock.calls.length;
    });
    const woke = await until(() => (ran.length >= 2 ? true : undefined), 3_000);
    console.log(`0.16 proof (commit): kicks while the transaction was open: ${inside}; after the commit: ${kick.mock.calls.length} (${JSON.stringify(kick.mock.calls)}); both rounds ran after ${woke.ms} ms`);
    expect(inside).toBe(0);
    expect(woke.value).toBe(true);
    expect([...ran].sort()).toEqual(["trp_committed", "trp_committed_2"]);
    // Two due timers of one kind in one transaction = one wake (PostgreSQL folds equal NOTIFYs).
    expect(kick.mock.calls).toEqual([[ROUND]]);
    unwake();
  });

  it("a timer written without `wake` (every other timer) sends nothing: it waits for the poll, as before", async () => {
    const ran: string[] = [];
    const { worker: w, unwake } = startWorker({ plain_kind: async (_trx, timer) => void ran.push(timer.refId) });
    await sleep(500);
    const kick = vi.spyOn(w, "kick");
    await database.db.transaction().execute((trx) => scheduleTimer(trx, { kind: "plain_kind", refId: "p1", dueAt: clock.now, payload: {} }));
    await sleep(700);
    expect(kick).toHaveBeenCalledTimes(0);
    expect(ran).toEqual([]);
    unwake();
  });
});

describe("S7 0.16: kick(kind) wakes the lanes for that kind, and a kick during a round is not lost", () => {
  it("a dispatch kick wakes the dispatch lane only; a kick without a kind wakes every lane", async () => {
    const ran: string[] = [];
    const handlers: Record<string, TimerHandler> = { a_kind: async () => void ran.push("a"), b_kind: async () => void ran.push("b"), c_kind: async () => void ran.push("c") };
    const lanes = [{ kinds: ["a_kind"] }, { kinds: ["b_kind"] }, { exclude: ["b_kind"] }];
    const w = new TimerWorker(database.db, { handlers, logger: quiet, clock: () => clock.now, pollMs: POLL_MS, lanes });
    worker = w;
    w.start();
    await sleep(500);
    const looks = vi.spyOn(w, "runDue");
    await scheduleTimer(database.db, { kind: "b_kind", refId: "b1", dueAt: clock.now });
    (w.kick as (kind?: string) => void)("a_kind");
    await sleep(500);
    // Only lane 1 (a_kind) looked; the b timer is still waiting for its own lane.
    expect(looks.mock.calls.map((c) => c[1])).toEqual([lanes[0]]);
    expect(ran).toEqual([]);
    // A kind no lane names goes to the lanes that take any kind (here lane 3).
    looks.mockClear();
    await scheduleTimer(database.db, { kind: "c_kind", refId: "c1", dueAt: clock.now });
    (w.kick as (kind?: string) => void)("c_kind");
    expect((await until(() => (ran.includes("c") ? true : undefined), 3_000)).value).toBe(true);
    expect(looks.mock.calls.map((c) => c[1])).toEqual([lanes[2]]);
    expect(ran).toEqual(["c"]);
    // No kind: every lane.
    w.kick();
    expect((await until(() => (ran.includes("b") ? true : undefined), 3_000)).value).toBe(true);
  });

  it("a kick that comes while the lane is in the middle of a round makes it look once more right after", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    const handlers: Record<string, TimerHandler> = {
      slow_kind: async () => {
        started = true;
        await gate;
      },
    };
    const w = new TimerWorker(database.db, { handlers, logger: quiet, clock: () => clock.now, pollMs: POLL_MS, lanes: [{ kinds: ["slow_kind"] }] });
    worker = w;
    await scheduleTimer(database.db, { kind: "slow_kind", refId: "s1", dueAt: clock.now });
    const looks = vi.spyOn(w, "runDue");
    w.start();
    expect((await until(() => (started ? true : undefined), 3_000)).value).toBe(true);
    expect(looks).toHaveBeenCalledTimes(1);
    // The lane is busy inside its round: nobody is waiting, so the old kick() did nothing here.
    w.kick();
    release();
    const again = await until(() => (looks.mock.calls.length >= 2 ? true : undefined), 3_000);
    console.log(`0.16 proof (kick during a round): second look ${again.value ? `after ${again.ms} ms` : `NOT within ${again.ms} ms (poll ${POLL_MS} ms)`}`);
    expect(again.value).toBe(true);
    // And only once more: then it sleeps until the poll or the next kick (no busy loop).
    await sleep(500);
    expect(looks).toHaveBeenCalledTimes(2);
  });
});
