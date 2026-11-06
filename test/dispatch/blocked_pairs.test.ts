import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { cacheLiveDocuments } from "../../src/config/service.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { listedDrivers } from "../../src/reservations/service.js";
import { reservationSettings } from "../../src/reservations/plan.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Fix job 10 "never match pair" (v0.18.40 §64, owner G16 Q16-4; G15 2026-11-05 "Never told", "No, only Support").
 * Rule 36: every test fails on main — there is no blocked_pairs table, no admin route, the rating ignores
 * dontMatchAgain, and the only free driver of a blocked pair still gets the offer.
 */
let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-10-24T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const SPOTS = { A: { lat: 59.3335, lng: 18.0655 }, B: { lat: 59.336, lng: 18.07 } };
const KEYS = ["A", "B"] as const;
type Key = (typeof KEYS)[number];
const drivers: Record<Key, { id: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;
let riderId: string;
let admin: Record<string, string>;
const phones = { A: TEST_PHONES[1]!, B: TEST_PHONES[2]! };

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  for (const doc of ["dispatch_document", "driver_app_config", "rider_app_config"] as const) {
    const name = doc === "dispatch_document" ? "dispatch" : doc;
    await database.db.insertInto("config_live").values({ doc: name, zone_id: "Z001", version: 1, document: JSON.stringify(sample(doc)), published_at: clock.now, published_by: null }).execute();
  }
  worker = new TimerWorker(database.db, { handlers: dispatchHandlers, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  for (const key of KEYS) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `TBP00${key}`, categoryIds: ["economy"], zoneIds: ["Z001", "Z002"] }, clock.now),
    );
    drivers[key] = { id: made.driverId, headers: {} };
  }
});
afterAll(async () => {
  cacheLiveDocuments(0);
  await app.close();
  await database.drop();
});

const tick = (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
};
const at = (key: Key) => call(app, "POST", "/driver/location", drivers[key].headers, { fixes: [{ ...SPOTS[key], accuracy: 5, measuredAt: clock.now.toISOString() }] });

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  const signed = await signIn(app, TEST_PHONES[0]!, "rider");
  rider = signed.headers;
  riderId = (await call(app, "GET", "/rider/profile", rider)).json().riderId;
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.deleteFrom("blocked_pairs" as never).execute();
  for (const key of KEYS) {
    drivers[key].headers = (await signIn(app, phones[key], "driver")).headers;
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", drivers[key].id).execute();
  }
});

/** Only these drivers online, each at his spot with a fresh fix. */
async function online(...keys: Key[]) {
  for (const key of keys) {
    await database.db.updateTable("drivers").set({ online_status: "online", online_since: clock.now, last_free_at: clock.now }).where("driver_id", "=", drivers[key].id).execute();
    await at(key);
  }
}
async function book(): Promise<string> {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
  expect(trip.statusCode).toBe(201);
  return trip.json().tripId as string;
}
const offersOf = (tripId: string) => database.db.selectFrom("offers").select(["driver_id", "kind", "status"]).where("trip_id", "=", tripId).execute();
const keyOf = (driverId: string) => KEYS.find((k) => drivers[k].id === driverId);

/** A trip of this rider with driver `key`, finished (completed, both ratings pending). */
async function finishedWith(key: Key): Promise<string> {
  const tripId = await book();
  await database.db.updateTable("trips").set({ status: "completed", driver_id: drivers[key].id, ended_at: clock.now, accepted_at: clock.now, rating_status: "pending", driver_rating_status: "pending" }).where("trip_id", "=", tripId).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  return tripId;
}
const pairs = () => database.db.selectFrom("blocked_pairs" as never).selectAll().where("removed_at" as never, "is", null).execute() as Promise<Array<Record<string, unknown>>>;

describe("never match pair — fix job 10 (v0.18.40 §64)", () => {
  it("admin blocks the pair: the only free driver of that pair gets no offer, the search goes on (today he is offered)", async () => {
    const done = await finishedWith("A");
    const blocked = await call(app, "POST", `/admin/trips/${done}/block-pair`, admin, { reason: "Rude to driver" });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({ riderId, driverId: drivers.A.id, by: "admin", reason: "Rude to driver", tripId: done });
    // A second block of the same pair answers the pair that exists (rule 33: one row).
    expect((await call(app, "POST", `/admin/trips/${done}/block-pair`, admin, {})).json().pairId).toBe(blocked.json().pairId);
    expect(await pairs()).toHaveLength(1);
    await online("A");
    const tripId = await book();
    await worker.runDue();
    expect(await offersOf(tripId)).toEqual([]);
    expect((await call(app, "GET", `/trips/${tripId}`, rider)).json().status).toBe("searching");
    // Another driver comes online: he gets it.
    await online("B");
    tick(20);
    await worker.runDue();
    expect((await offersOf(tripId)).map((o) => keyOf(o.driver_id))).toEqual(["B"]);
  });

  it("admin lists the pair on the rider and on the driver; only Support's undo makes him a candidate again", async () => {
    const done = await finishedWith("A");
    const pairId = (await call(app, "POST", `/admin/trips/${done}/block-pair`, admin, {})).json().pairId;
    expect((await call(app, "GET", `/admin/blocked-pairs?riderId=${riderId}`, admin)).json().items.map((p: { pairId: string }) => p.pairId)).toEqual([pairId]);
    expect((await call(app, "GET", `/admin/blocked-pairs?driverId=${drivers.A.id}`, admin)).json().items.map((p: { pairId: string }) => p.pairId)).toEqual([pairId]);
    const audit = await database.db.selectFrom("admin_audit").select("action").where("action", "=", "blocked_pair.add").where("target_id", "=", done).execute();
    expect(audit.length).toBe(1);
    expect((await call(app, "DELETE", `/admin/blocked-pairs/${pairId}`, admin)).statusCode).toBe(204);
    expect((await call(app, "GET", `/admin/blocked-pairs?riderId=${riderId}`, admin)).json().items).toEqual([]);
    await online("A");
    const tripId = await book();
    await worker.runDue();
    expect((await offersOf(tripId)).map((o) => keyOf(o.driver_id))).toEqual(["A"]);
  });

  it("rider rates 1 star + dontMatchAgain → pair by rider; 2 stars + dontMatchAgain → 400 dont_match_not_allowed, nothing saved", async () => {
    const two = await finishedWith("B");
    const refused = await call(app, "POST", `/trips/${two}/rating`, rider, { stars: 2, dontMatchAgain: true });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().reason).toBe("dont_match_not_allowed");
    expect(await pairs()).toHaveLength(0);
    const one = await finishedWith("A");
    const rated = await call(app, "POST", `/trips/${one}/rating`, rider, { stars: 1, dontMatchAgain: true });
    expect(rated.statusCode).toBe(201);
    // The answer is the same Rating as without the tick (never told).
    expect(rated.json()).toEqual({ tripId: one, from: "rider", stars: 1, tags: [] });
    expect((await pairs()).map((p) => [p["driver_id"], p["blocked_by"], p["trip_id"]])).toEqual([[drivers.A.id, "rider", one]]);
    await online("A");
    const tripId = await book();
    await worker.runDue();
    expect(await offersOf(tripId)).toEqual([]);
  });

  it("driver rates the rider 1 star + dontMatchAgain → pair by driver; the rider is never told", async () => {
    const one = await finishedWith("A");
    expect((await call(app, "POST", `/trips/${one}/rating`, drivers.A.headers, { stars: 1, dontMatchAgain: true })).statusCode).toBe(201);
    expect((await pairs()).map((p) => p["blocked_by"])).toEqual(["driver"]);
    const view = JSON.stringify((await call(app, "GET", `/trips/${one}`, rider)).json()) + JSON.stringify((await call(app, "GET", "/rider/profile", rider)).json());
    expect(view.toLowerCase()).not.toMatch(/block|dontmatch|pair/);
  });

  it("CountryRules.dontMatchAgain is served to both apps (default on, 1 star) and atStars 2 allows a 2-star tick", async () => {
    expect((await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json().dontMatchAgain).toEqual({ on: true, atStars: 1 });
    expect((await call(app, "GET", "/driver/config?zoneId=Z001", drivers.A.headers)).json().dontMatchAgain).toEqual({ on: true, atStars: 1 });
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "Z001", version: 1, document: JSON.stringify({ dontMatchAgain: { on: true, atStars: 2 } }), published_at: clock.now, published_by: null }).execute();
    try {
      expect((await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json().dontMatchAgain).toEqual({ on: true, atStars: 2 });
      const two = await finishedWith("B");
      expect((await call(app, "POST", `/trips/${two}/rating`, rider, { stars: 2, dontMatchAgain: true })).statusCode).toBe(201);
    } finally {
      await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").where("zone_id", "=", "Z001").execute();
    }
  });

  it("a booked ride is not listed to the blocked driver (Scheduled rides)", async () => {
    const done = await finishedWith("A");
    await call(app, "POST", `/admin/trips/${done}/block-pair`, admin, {});
    await online("A", "B");
    const row = await database.db.selectFrom("trips").selectAll().where("trip_id", "=", done).executeTakeFirstOrThrow();
    const seen = await listedDrivers(database.db, { ...row, kind: "scheduled", scheduled_at: new Date(clock.now.getTime() + 2 * 3600_000), reservation: null, cancelled_driver_ids: [] }, { ...reservationSettings(undefined), listTo: "all" }, clock.now, { openAll: true });
    const ids = seen.map((s) => s.driverId);
    expect(ids).toContain(drivers.B.id);
    expect(ids).not.toContain(drivers.A.id);
  });

  it("a trip without a driver cannot be blocked: 409 no_driver", async () => {
    const tripId = await book();
    const r = await call(app, "POST", `/admin/trips/${tripId}/block-pair`, admin, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().reason).toBe("no_driver");
  });
});
