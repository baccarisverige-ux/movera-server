import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { cacheLiveDocuments } from "../../src/config/service.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Fix job 9 "airport queue" (v0.18.39 §63, R27, owner G15 Q5 + job 9 answers 2026-11-05). Each test fails on main
 * before the job: there is no queue, so an airport pickup goes to the nearest driver (A) and the routes are 404.
 */
let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-10-24T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
// A is nearest the pickup (NORRMALM), C farthest; all three stand inside the queue area.
const SPOTS = { A: { lat: 59.3335, lng: 18.0655 }, B: { lat: 59.336, lng: 18.07 }, C: { lat: 59.34, lng: 18.075 } };
const OUTSIDE = { lat: 59.36, lng: 18.2 };
// Bromma airport (BMA) is moved over the test spots for this file, with a queue area around them.
const AIRPORT: Array<[number, number]> = [[59.325, 18.05], [59.325, 18.09], [59.345, 18.09], [59.345, 18.05]];
const AREA: Array<[number, number]> = [[59.33, 18.06], [59.33, 18.08], [59.342, 18.08], [59.342, 18.06]];
const KEYS = ["A", "B", "C"] as const;
type Key = (typeof KEYS)[number];
const drivers: Record<Key, { id: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;
let admin: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null }).execute();
  await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("driver_app_config")), published_at: clock.now, published_by: null }).execute();
  await database.db.updateTable("zones").set({ polygon: JSON.stringify(AIRPORT), south: 59.325, west: 18.05, north: 59.345, east: 18.09 }).where("zone_id", "=", "BMA").execute();
  worker = new TimerWorker(database.db, { handlers: dispatchHandlers, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const phones = { A: TEST_PHONES[1]!, B: TEST_PHONES[2]!, C: TEST_PHONES[3]! };
  for (const key of KEYS) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `TAQ00${key}`, categoryIds: ["economy"], zoneIds: ["Z001", "Z002"] }, clock.now),
    );
    drivers[key] = { id: made.driverId, headers: {} };
  }
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
});
afterAll(async () => {
  cacheLiveDocuments(0);
  await app.close();
  await database.drop();
});

const at = (key: Key, spot: { lat: number; lng: number }) =>
  call(app, "POST", "/driver/location", drivers[key].headers, { fixes: [{ ...spot, accuracy: 5, measuredAt: clock.now.toISOString() }] });
const tick = (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
};
const putArea = (body: Record<string, unknown>) => call(app, "PUT", "/admin/zones/BMA/queue-area", admin, body);
const place = async (key: Key) => (await call(app, "GET", "/driver/airport-queue", drivers[key].headers)).json();

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  for (const key of KEYS) {
    drivers[key].headers = (await signIn(app, phones()[key], "driver")).headers;
    // Off and back online: a new online session never keeps an old queue place.
    await database.db.updateTable("drivers").set({ online_status: "online", online_since: clock.now, last_free_at: clock.now }).where("driver_id", "=", drivers[key].id).execute();
  }
});
const phones = () => ({ A: TEST_PHONES[1]!, B: TEST_PHONES[2]!, C: TEST_PHONES[3]! });

/** The queue area on; then the drivers come into it in `order`, one minute apart. */
async function queueUp(order: Key[], extra: Record<string, unknown> = {}) {
  expect((await putArea({ polygon: AREA, on: true, ...extra })).statusCode).toBe(200);
  for (const key of order) {
    tick(60);
    await at(key, SPOTS[key]);
  }
  // The apps keep sending positions while they wait: staying inside keeps the place (and the fix fresh for dispatch).
  tick(5);
  for (const key of order) await at(key, SPOTS[key]);
}

async function book(): Promise<string> {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" }));
  expect(trip.statusCode).toBe(201);
  return trip.json().tripId as string;
}
const openOffers = (tripId: string) => database.db.selectFrom("offers").select(["offer_id", "driver_id", "kind", "status", "reason_code", "version", "sent_at", "expires_at"]).where("trip_id", "=", tripId).where("status", "=", "open").execute();
const keyOf = (driverId: string) => KEYS.find((k) => drivers[k].id === driverId);
async function decline(tripId: string): Promise<Key> {
  const [offer] = await openOffers(tripId);
  const key = keyOf(offer!.driver_id)!;
  expect((await call(app, "POST", `/offers/${offer!.offer_id}/decline`, drivers[key].headers, { expectedVersion: offer!.version })).statusCode).toBe(200);
  await worker.runDue();
  return key;
}

describe("airport queue — fix job 9 (v0.18.39 §63)", () => {
  it("3 drivers join in order C, B, A: the airport pickup is offered to C first (Exclusive airport-queue), not to the nearest A", async () => {
    await queueUp(["C", "B", "A"]);
    expect(await place("C")).toMatchObject({ status: "in_queue", position: 1, ahead: 0 });
    expect(await place("B")).toMatchObject({ status: "in_queue", position: 2, ahead: 1 });
    expect(await place("A")).toMatchObject({ status: "in_queue", position: 3, ahead: 2 });
    const tripId = await book();
    await worker.runDue();
    const open = await openOffers(tripId);
    expect(open.map((o) => [keyOf(o.driver_id), o.kind, o.reason_code])).toEqual([["C", "exclusive", "airport-queue"]]);
    // offerSeconds 30 (the area's default), not the zone's 15 s Exclusive.
    expect(open[0]!.expires_at.getTime() - open[0]!.sent_at.getTime()).toBe(30_000);
  });

  it("C declines → B gets it and C keeps his place (owner Q4); after maxQueueOffers the normal search goes on", async () => {
    await queueUp(["C", "B", "A"], { maxQueueOffers: 2 });
    const tripId = await book();
    await worker.runDue();
    expect(await decline(tripId)).toBe("C");
    const second = await openOffers(tripId);
    expect(second.map((o) => [keyOf(o.driver_id), o.reason_code])).toEqual([["B", "airport-queue"]]);
    expect(await place("C")).toMatchObject({ status: "in_queue", position: 1 });
    expect(await decline(tripId)).toBe("B");
    // Two queue offers sent: the normal search (Exclusive to the nearest not yet asked = A), no airport-queue reason.
    const third = await openOffers(tripId);
    expect(third.length).toBeGreaterThan(0);
    expect(third.every((o) => o.reason_code !== "airport-queue")).toBe(true);
    expect(third.map((o) => keyOf(o.driver_id))).toContain("A");
  });

  it("keepPlaceAfterDecline false: a decline sends him to the back", async () => {
    await queueUp(["C", "B", "A"], { keepPlaceAfterDecline: false });
    const tripId = await book();
    await worker.runDue();
    expect(await decline(tripId)).toBe("C");
    expect(await place("C")).toMatchObject({ status: "in_queue", position: 3 });
    expect(await place("B")).toMatchObject({ position: 1 });
  });

  it("queue off (or empty) → the nearest driver, unchanged", async () => {
    await queueUp(["C", "B", "A"], { on: false });
    expect(await place("C")).toMatchObject({ status: "off" });
    const tripId = await book();
    await worker.runDue();
    const open = await openOffers(tripId);
    expect(open.every((o) => o.reason_code !== "airport-queue")).toBe(true);
  });

  it("a driver outside the area for more than leaveGraceMin (3) leaves; the others move up", async () => {
    await queueUp(["C", "B", "A"]);
    tick(10);
    await at("C", OUTSIDE);
    tick(120);
    await at("C", OUTSIDE);
    expect(await place("C")).toMatchObject({ status: "in_queue", position: 1 });
    tick(70);
    await at("C", OUTSIDE);
    expect((await place("C")).status).toBe("not_in_area");
    expect(await place("B")).toMatchObject({ status: "in_queue", position: 1, ahead: 0 });
    expect(await place("A")).toMatchObject({ position: 2 });
    // Coming back in: he joins at the back.
    tick(10);
    await at("C", SPOTS.C);
    expect(await place("C")).toMatchObject({ status: "in_queue", position: 3 });
  });

  it("going offline (a new online session) or accepting a trip leaves the queue", async () => {
    await queueUp(["C", "B", "A"]);
    await database.db.updateTable("drivers").set({ online_since: new Date(clock.now.getTime() + 1000) }).where("driver_id", "=", drivers.C.id).execute();
    tick(5);
    expect((await place("C")).status).not.toBe("in_queue");
    expect(await place("B")).toMatchObject({ position: 1 });
    const tripId = await book();
    await worker.runDue();
    const [offer] = await openOffers(tripId);
    expect(keyOf(offer!.driver_id)).toBe("B");
    expect((await call(app, "POST", `/offers/${offer!.offer_id}/accept`, drivers.B.headers, { expectedVersion: offer!.version })).statusCode).toBe(200);
    expect(await place("A")).toMatchObject({ position: 1, ahead: 0 });
    expect((await place("B")).status).not.toBe("in_queue");
  });

  it("admin: only an airport zone takes an area; it reads back; the feed counts the waiting drivers", async () => {
    expect((await call(app, "PUT", "/admin/zones/Z001/queue-area", admin, { polygon: AREA, on: true })).statusCode).toBe(400);
    await queueUp(["A", "B"], { leaveGraceMin: 5 });
    const area = (await call(app, "GET", "/admin/zones/BMA/queue-area", admin)).json();
    expect(area).toMatchObject({ airportZoneId: "BMA", on: true, polygon: AREA, leaveGraceMin: 5, offerSeconds: 30, maxQueueOffers: 3, keepPlaceAfterDecline: true });
    const feed = (await call(app, "GET", "/admin/airport-queues", admin)).json();
    expect(feed.items).toEqual([expect.objectContaining({ airportZoneId: "BMA", on: true, waiting: 2, longestWaitMin: 1, pickupsLastHour: 0 })]);
  });

  it("riders see nothing: the rider's trip carries no queue field", async () => {
    await queueUp(["C"]);
    const tripId = await book();
    const view = (await call(app, "GET", `/trips/${tripId}`, rider)).json();
    expect(JSON.stringify(view)).not.toMatch(/queue/i);
  });

  it("rule 33: two server copies taking two position batches of one driver at once keep ONE queue row", async () => {
    expect((await putArea({ polygon: AREA, on: true })).statusCode).toBe(200);
    tick(60);
    await Promise.all([at("A", SPOTS.A), at("A", { lat: SPOTS.A.lat + 0.0001, lng: SPOTS.A.lng })]);
    const rows = await database.db.selectFrom("airport_queue_entries").select("entry_id").where("driver_id", "=", drivers.A.id).where("left_at", "is", null).execute();
    expect(rows).toHaveLength(1);
  });
});
