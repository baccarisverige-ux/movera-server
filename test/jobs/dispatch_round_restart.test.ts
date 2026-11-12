import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sweepAlerts } from "../../src/alerts/detector.js";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { ROUND } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { MAX_ATTEMPTS, RESTART_ONCE_AFTER_MS, TimerWorker, type TimerHandler } from "../../src/jobs/timers.js";
import { buildWorkerConfig } from "../../src/jobs/workerConfig.js";
import { EstimateRouter } from "../../src/maps/routing.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * B1.14 (stage S4 wave B1; owner W1 Q75 "A stopped dispatch round restarts once after 1 min, with an alert?" = Yes).
 * A dispatch_round that failed MAX_ATTEMPTS times used to be parked at 'infinity' for good: nothing ever woke it, so a
 * live ride silently stopped getting offers. Now it uses the B1.6b restart-once (RESTART_ONCE_KINDS): it runs once more
 * 60 s later, the critical system_health alert names it at once, and a second parking is for good (no loop).
 * Fails before: the round is parked at 'infinity' on its first parking (RESTART_ONCE_KINDS has no dispatch_round).
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-12T10:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const SPOT = { lat: 59.3335, lng: 18.0655 };
let driver: { id: string; headers: Record<string, string> };
let rider: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null }).execute();
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver R", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "TST114", categoryIds: ["economy"], zoneIds: ["Z001", "Z002"] }, clock.now),
  );
  driver = { id: made.driverId, headers: {} };
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.deleteFrom("admin_alerts_live").execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driver.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driver.id).execute();
  await call(app, "POST", "/driver/location", driver.headers, { fixes: [{ ...SPOT, accuracy: 5, measuredAt: clock.now.toISOString() }] });
});

const at = (start: Date, ms: number) => new Date(start.getTime() + ms);
const roundRow = (tripId: string) => database.db.selectFrom("timers").selectAll().where("kind", "=", ROUND).where("ref_id", "=", tripId).executeTakeFirst();
const offersOf = (tripId: string) => database.db.selectFrom("offers").select(["driver_id", "status"]).where("trip_id", "=", tripId).execute();
const tripStatus = async (tripId: string) => (await database.db.selectFrom("trips").select("status").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).status;
const roundAlerts = () => database.db.selectFrom("admin_alerts_live").selectAll().where("kind", "=", "system_health").where("detail", "like", `${ROUND}:%`).execute();

/** A worker set up as main.ts sets it up (buildWorkerConfig), its dispatch_round failing while `broken.on`. */
function worker(broken: { on: boolean; runs: number }) {
  const config = buildWorkerConfig(new EstimateRouter(), { timerLanes: 1, dispatchLanes: 1 });
  const real = config.handlers[ROUND]!;
  const round: TimerHandler = async (trx, timer) => {
    broken.runs += 1;
    if (broken.on) throw new Error("round boom");
    await real(trx, timer);
  };
  return new TimerWorker(database.db, { ...config.parked, handlers: { ...config.handlers, [ROUND]: round }, logger: { warn: () => undefined, error: () => undefined }, clock: () => clock.now, pollMs: 20 });
}

/** A live ride whose first dispatch round is about to fail for the MAX_ATTEMPTS-th time (it parks on this run). */
async function rideWithFailingRound(w: TimerWorker) {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  const tripId = trip.tripId as string;
  expect(await roundRow(tripId)).toBeDefined();
  await database.db.updateTable("timers").set({ attempts: MAX_ATTEMPTS - 1, due_at: clock.now }).where("kind", "=", ROUND).where("ref_id", "=", tripId).execute();
  await w.runDue();
  return tripId;
}

describe("B1.14: a parked dispatch round restarts once after 1 min, with an alert (Q75)", () => {
  it("a live (searching) ride's parked round runs once more after 60 s, the critical alert names it, and the ride gets its offer", async () => {
    const broken = { on: true, runs: 0 };
    const w = worker(broken);
    const parkedAt = clock.now;
    const tripId = await rideWithFailingRound(w);
    expect(await tripStatus(tripId)).toBe("searching");
    // Parked on its one restart: due 60 s later (not 'infinity'), attempts at the limit.
    const row = await roundRow(tripId);
    expect(row && [Number(row.due_at) === Infinity ? "infinity" : row.due_at.toISOString(), row.attempts]).toEqual([at(parkedAt, RESTART_ONCE_AFTER_MS).toISOString(), MAX_ATTEMPTS]);
    // The worker raised the alert at once (no sweep): critical, naming the kind and the trip.
    const alerts = await roundAlerts();
    expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) {
      expect([a.state, a.level]).toEqual(["open", "critical"]);
      expect(a.detail).toContain(tripId);
    }
    // Not before the minute is up.
    broken.on = false;
    const runs = broken.runs;
    clock.now = at(parkedAt, RESTART_ONCE_AFTER_MS - 1000);
    await w.runDue();
    expect(broken.runs).toBe(runs);
    expect(await offersOf(tripId)).toEqual([]);
    // After 60 s it runs once more and this time works: the driver gets the offer.
    clock.now = at(parkedAt, RESTART_ONCE_AFTER_MS);
    await w.runDue();
    expect(broken.runs).toBe(runs + 1);
    expect(await offersOf(tripId)).toEqual([{ driver_id: driver.id, status: "open" }]);
    expect(await tripStatus(tripId)).toBe("offered");
    // The round carries on normally (fresh attempts), and the next sweep turns the alert green (solved).
    expect((await roundRow(tripId))?.attempts).toBe(0);
    await database.db.transaction().execute((trx) => sweepAlerts(trx, clock.now));
    expect((await roundAlerts()).map((a) => a.state)).toEqual(alerts.map(() => "solved"));
  });

  it("a round that fails again on its restart stays parked for good (no loop), and its alert stays open and critical", async () => {
    const broken = { on: true, runs: 0 };
    const w = worker(broken);
    const parkedAt = clock.now;
    const tripId = await rideWithFailingRound(w);
    clock.now = at(parkedAt, RESTART_ONCE_AFTER_MS);
    await w.runDue();
    expect(broken.runs).toBe(2);
    const row = await roundRow(tripId);
    expect(row && [Number(row.due_at), row.attempts]).toEqual([Infinity, MAX_ATTEMPTS + 1]);
    for (const minutes of [1, 10, 60]) {
      clock.now = at(parkedAt, RESTART_ONCE_AFTER_MS + minutes * 60_000);
      await w.runDue();
    }
    expect(broken.runs).toBe(2);
    await database.db.transaction().execute((trx) => sweepAlerts(trx, clock.now));
    const alerts = await roundAlerts();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.every((a) => a.state === "open" && a.level === "critical" && a.detail.includes(tripId))).toBe(true);
  });
});
