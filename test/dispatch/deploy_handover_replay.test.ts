import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { cacheLiveDocuments } from "../../src/config/service.js";
import { dispatchHandlers, ROUND } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Replay of the staging stall of 2026-11-15 14:28–14:30 UTC (Rules audits/impact/deploy-dispatch-stall.md).
 * A guard, not a fix: it passes on 7b5889f. It pins the two facts the investigation rests on:
 *  1. Dispatch survives a copy handover. The trip is booked and its first round runs on copy A; copy A stops (the
 *     SIGTERM path: worker.stop()); copy B's worker carries on from the durable dispatch_round timer. There is no
 *     lease to wait for, one round timer per trip, and never two open Exclusives for one driver.
 *  2. The 2-minute gap was the blocked pair, not the deploy. The only driver online is one this rider blocked
 *     (1 star + dontMatchAgain): every round runs and sends nothing. The unblocked driver goes online and the very
 *     next round (at most one radar.seconds later) sends him the Exclusive — as 14:30:09 online → 14:30:11.9 offer.
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-15T14:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const quiet = { warn: () => undefined, error: (d: object, m: string) => console.error(m, d) };
const copy = () => new TimerWorker(database.db, { handlers: dispatchHandlers, logger: quiet, clock: () => clock.now });
const SPOT = { lat: 59.3335, lng: 18.0655 };
const drivers: Record<"blocked" | "free", { id: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  for (const doc of ["dispatch_document", "driver_app_config", "rider_app_config"] as const) {
    const name = doc === "dispatch_document" ? "dispatch" : doc;
    await database.db.insertInto("config_live").values({ doc: name, zone_id: "Z001", version: 1, document: JSON.stringify(sample(doc)), published_at: clock.now, published_by: null }).execute();
  }
  const phones = { blocked: TEST_PHONES[1]!, free: TEST_PHONES[2]! };
  for (const key of ["blocked", "free"] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: phones[key], firstName: key, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `TDH0${key === "free" ? 1 : 2}`, categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
    );
    drivers[key] = { id: made.driverId, headers: (await signIn(app, phones[key], "driver")).headers };
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", made.driverId).execute();
  }
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
});
afterAll(async () => {
  cacheLiveDocuments(0);
  await app.close();
  await database.drop();
});

const tick = (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
};
async function online(key: "blocked" | "free") {
  await database.db.updateTable("drivers").set({ online_status: "online", online_since: clock.now, last_free_at: clock.now }).where("driver_id", "=", drivers[key].id).execute();
  expect((await call(app, "POST", "/driver/location", drivers[key].headers, { fixes: [{ ...SPOT, accuracy: 5, measuredAt: clock.now.toISOString() }] })).statusCode).toBe(200);
}
async function book(): Promise<string> {
  const asked = await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] });
  const quote = asked.json().quotes?.[0];
  if (quote === undefined) throw new Error(`quote: ${asked.statusCode} ${asked.body}`);
  const trip = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
  expect(trip.statusCode).toBe(201);
  return trip.json().tripId as string;
}
const offersOf = (tripId: string) => database.db.selectFrom("offers").select(["driver_id", "kind", "status", "sent_at"]).where("trip_id", "=", tripId).orderBy("sent_at").execute();
const roundTimers = (tripId: string) => database.db.selectFrom("timers").select(["due_at"]).where("kind", "=", ROUND).where("ref_id", "=", tripId).execute();
const roundsOf = async (tripId: string) => Number((await database.db.selectFrom("searches").select("rounds").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).rounds);

describe("deploy handover replay (staging 2026-11-15 14:28–14:30)", () => {
  it("copy A books and stops, copy B carries the search; a blocked driver gets nothing, the unblocked one gets the Exclusive at the next round", async () => {
    // The rider blocked driver "blocked" earlier (1 star + dontMatchAgain), as on staging 2026-11-08.
    const done = await book();
    await database.db.updateTable("trips").set({ status: "completed", driver_id: drivers.blocked.id, ended_at: clock.now, accepted_at: clock.now, rating_status: "pending", driver_rating_status: "pending" }).where("trip_id", "=", done).execute();
    await database.db.deleteFrom("timers").execute();
    await database.db.deleteFrom("offers").execute();
    expect((await call(app, "POST", `/trips/${done}/rating`, rider, { stars: 1, dontMatchAgain: true })).statusCode).toBe(201);
    tick(60);

    // 14:28:01 on copy A: the trip is booked; copy A's worker runs the first round (nobody online yet).
    const oldCopy = copy();
    const tripId = await book();
    expect(await oldCopy.runDue()).toBeGreaterThan(0);
    expect(await roundsOf(tripId)).toBe(1);
    // The deploy: copy A gets SIGTERM (main.ts close → worker.stop()); copy B starts its own worker.
    await oldCopy.stop();
    const newCopy = copy();

    // 14:28:05–14:29:54: only the blocked driver is online. Every round runs (on copy B) and sends nothing.
    await online("blocked");
    for (let i = 0; i < 6; i++) {
      tick(20);
      await newCopy.runDue();
    }
    expect(await roundsOf(tripId)).toBeGreaterThanOrEqual(7);
    expect(await offersOf(tripId)).toEqual([]);
    expect(await roundTimers(tripId)).toHaveLength(1);
    await database.db.updateTable("drivers").set({ online_status: "offline", online_since: null }).where("driver_id", "=", drivers.blocked.id).execute();

    // 14:30:09: the unblocked driver goes online; the next round (at most one wait later) sends him the Exclusive.
    await online("free");
    const due = (await roundTimers(tripId))[0]!.due_at.getTime();
    const wait = due - clock.now.getTime();
    expect(wait).toBeLessThanOrEqual(Number(sample("dispatch_document").radar.seconds) * 1000);
    clock.now = new Date(Math.max(due, clock.now.getTime()));
    await newCopy.runDue();
    const offers = await offersOf(tripId);
    expect(offers.map((o) => [o.driver_id, o.kind, o.status])).toEqual([[drivers.free.id, "exclusive", "open"]]);
    // Safety: one round timer for the trip, and the driver holds one open Exclusive at most.
    expect(await roundTimers(tripId)).toHaveLength(1);
    const open = await database.db.selectFrom("offers").select("offer_id").where("driver_id", "=", drivers.free.id).where("status", "=", "open").where("kind", "=", "exclusive").execute();
    expect(open).toHaveLength(1);
    await newCopy.stop();
  });
});
