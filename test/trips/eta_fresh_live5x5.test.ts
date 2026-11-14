import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { haversineKm, type Router } from "../../src/maps/routing.js";
import { PICKUP_GEOFENCE, rideHandlers } from "../../src/trips/ride.js";
import { etaHandler, TRIP_ETA } from "../../src/trips/eta.js";
import { ETA_NOW_GAP_MS } from "../../src/trips/etaNow.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Live 5+5 test 2026-11-08 (Rules audits/screens-2026-11-08/live-5x5/REPORT.md, problems 4 and 5; contract.json#
 * pickupWaiting.eta: the server's ONE ETA, to the pickup until boarding, then to the drop-off; neither app computes its own).
 * 4: the driver at the pickup while the rider still saw "4 min · 1,3 km" (the tick runs only every 30 s).
 * 5: the boarding / start event carried the old 60 s pickup ETA ("there at 01:00" at a 01:00 start) until the next tick.
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-08T12:00:00Z") };
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));

/** A road router that answers the straight-line distance at 10 m/s, so the ETA follows the driver's position. */
const followRouter: Router = {
  route: async (points) => {
    const meters = Math.round(haversineKm(points[0]!, points[points.length - 1]!) * 1000);
    return { distanceMeters: meters, durationSeconds: Math.round(meters / 10), source: "osrm" };
  },
};

/** About 1.3 km north of the pickup (as in the live run's "1,3 km"), and another place more than 1 km from it. */
const FAR = { lat: 59.3443, lng: 18.0649 };
const FARTHER = { lat: 59.3443, lng: 18.0849 };
let driver: { id: string; headers: Record<string, string> };
let rider: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null }).execute();
  for (const doc of ["rider_app_config", "driver_app_config"] as const) {
    const document = { ...sample(doc), version: 1 };
    await database.db.insertInto("config_live").values({ doc, zone_id: "Z001", version: 1, document: JSON.stringify(document), published_at: clock.now, published_by: null }).execute();
  }
  // v0.18.93 (job C9): these cases are about the pickup ETA of a driver who stands at the pickup without being arrived;
  // the server's automatic arrival within 100 m (contract.json#autoArrive) is tested in auto_arrive_c9.test.ts, so it
  // does nothing here.
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers, [TRIP_ETA]: etaHandler(followRouter), [PICKUP_GEOFENCE]: async () => undefined }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "ETA001", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  driver = { id: made.driverId, headers: {} };
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

async function moveTo(at: { lat: number; lng: number }) {
  clock.now = new Date(clock.now.getTime() + 1000);
  const res = await call(app, "POST", "/driver/location", driver.headers, { fixes: [{ ...at, accuracy: 5, measuredAt: clock.now.toISOString() }] });
  expect(res.statusCode).toBe(200);
}

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driver.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driver.id).execute();
  await moveTo(FAR);
});

/** The rider books Norrmalm → Södermalm; the driver, 1.3 km away, takes it; the first ETA tick runs. */
async function accepted() {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
  expect(res.statusCode).toBe(201);
  await worker.runDue();
  const [offer] = (await call(app, "GET", "/driver/offers", driver.headers)).json().items;
  const accept = await call(app, "POST", `/offers/${offer.offerId}/accept`, driver.headers, { expectedVersion: offer.version });
  expect(accept.statusCode).toBe(200);
  await worker.runDue();
  return { tripId: res.json().tripId as string, version: accept.json().version as number };
}
const step = (tripId: string, path: string, version: number) => call(app, "POST", `/trips/${tripId}/${path}`, driver.headers, { expectedVersion: version });
const riderView = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}`, rider)).json();
const events = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}/events?after=0`, { ...rider, accept: "application/json" })).json().items as Array<Record<string, unknown>>;
const etaEvents = async (tripId: string) => (await events(tripId)).filter((e) => e["kind"] === "location" && e["eta"]).map((e) => e["eta"] as Record<string, unknown>);
const etaTimer = (tripId: string) => database.db.selectFrom("timers").select("due_at").where("kind", "=", TRIP_ETA).where("ref_id", "=", tripId).executeTakeFirst();

describe("problem 4: the driver at the pickup gets a fresh ETA at once, not up to 30 s later", () => {
  it("a position inside the arrive radius runs the ETA tick now: the rider sees metres, not 1.3 km", async () => {
    const { tripId, version } = await accepted();
    expect((await riderView(tripId)).eta).toMatchObject({ target: "pickup", distanceMeters: expect.any(Number) });
    expect((await riderView(tripId)).eta.distanceMeters).toBeGreaterThan(1200);
    await step(tripId, "head-to-pickup", version);
    await advance(10);
    await moveTo(NORRMALM);
    await worker.runDue();
    const latest = (await etaEvents(tripId)).at(-1)!;
    expect(latest).toMatchObject({ target: "pickup", at: clock.now.toISOString() });
    expect(latest["distanceMeters"]).toBeLessThan(300);
    expect((await riderView(tripId)).eta).toEqual(latest);
    // The regular 30 s tick goes on from here: no second timer, no polling.
    expect((await etaTimer(tripId))?.due_at.getTime()).toBe(clock.now.getTime() + 30_000);
  });

  it("one extra tick per event: more positions at the pickup add none; entering right after a tick waits ETA_NOW_GAP_MS", async () => {
    const { tripId } = await accepted();
    const tickAt = clock.now.getTime();
    await moveTo(NORRMALM);
    // The stored ETA is 1 s old: the tick is moved to 5 s after it, not run at once (the rate limit).
    expect((await etaTimer(tripId))?.due_at.getTime()).toBe(tickAt + ETA_NOW_GAP_MS);
    await advance(3);
    const count = (await etaEvents(tripId)).length;
    expect((await etaEvents(tripId)).at(-1)!["distanceMeters"]).toBeGreaterThan(1200);
    await advance(1);
    const fresh = await etaEvents(tripId);
    expect(fresh).toHaveLength(count + 1);
    expect(fresh.at(-1)).toMatchObject({ at: new Date(tickAt + ETA_NOW_GAP_MS).toISOString() });
    expect(fresh.at(-1)!["distanceMeters"]).toBeLessThan(300);
    // Still inside the radius: no further extra tick; the regular one 30 s after.
    await advance(3);
    await moveTo({ lat: NORRMALM.lat + 0.0001, lng: NORRMALM.lng });
    await worker.runDue();
    expect(await etaEvents(tripId)).toHaveLength(count + 1);
    expect((await etaTimer(tripId))?.due_at.getTime()).toBe(tickAt + ETA_NOW_GAP_MS + 30_000);
  });

  it("a position more than 1 km from the previous one (a gap in the fixes) also runs the tick now; a normal move does not", async () => {
    const { tripId } = await accepted();
    await advance(10);
    const count = (await etaEvents(tripId)).length;
    await moveTo({ lat: FAR.lat + 0.001, lng: FAR.lng });
    await worker.runDue();
    expect(await etaEvents(tripId)).toHaveLength(count);
    await moveTo(FARTHER);
    await worker.runDue();
    expect(await etaEvents(tripId)).toHaveLength(count + 1);
    expect((await etaEvents(tripId)).at(-1)).toMatchObject({ at: clock.now.toISOString() });
  });
});

describe("problem 5: boarding and start carry no pickup ETA; the first drop-off ETA comes at once", () => {
  async function arrived() {
    const { tripId, version } = await accepted();
    let v = (await step(tripId, "head-to-pickup", version)).json().version;
    await moveTo(NORRMALM);
    await worker.runDue();
    v = (await step(tripId, "arrive", v)).json().version;
    await advance(20);
    return { tripId, version: v as number };
  }

  it("board: the projection (answer, event, read) has no pickup ETA, and the drop-off ETA is computed right away", async () => {
    const { tripId, version } = await arrived();
    const board = await step(tripId, "board", version);
    expect(board.statusCode).toBe(200);
    expect(board.json().status).toBe("rider_onboard");
    expect(board.json()).not.toHaveProperty("eta");
    const boardEvent = (await events(tripId)).filter((e) => e["kind"] === "trip_projection").at(-1)!;
    expect((boardEvent["projection"] as Record<string, unknown>)["status"]).toBe("rider_onboard");
    expect(boardEvent["projection"]).not.toHaveProperty("eta");
    // A read before the tick: at most the straight-line estimate to the drop-off (trips/eta.ts etaForRead), never the pickup.
    expect((await riderView(tripId)).eta).toMatchObject({ target: "dropoff", source: "estimate" });
    await worker.runDue();
    const dropoff = (await etaEvents(tripId)).at(-1)!;
    expect(dropoff).toMatchObject({ target: "dropoff", at: clock.now.toISOString(), source: "osrm" });
    expect(dropoff["distanceMeters"]).toBeGreaterThan(1500);
    expect((await riderView(tripId)).eta).toEqual(dropoff);
  });

  it("start right after board (before any tick): the start event has no pickup ETA either; the drop-off one follows at once", async () => {
    const { tripId, version } = await arrived();
    const v = (await step(tripId, "board", version)).json().version;
    // An older stored pickup ETA left on the trip (as on main before this fix): the read never shows it on board.
    const kept = await database.db.selectFrom("trips").select("eta").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(kept.eta).toBeNull();
    await database.db.updateTable("trips").set({ eta: JSON.stringify({ etaSeconds: 60, distanceMeters: 50, target: "pickup", at: clock.now.toISOString(), source: "osrm" }) }).where("trip_id", "=", tripId).execute();
    expect((await riderView(tripId)).eta).toMatchObject({ target: "dropoff", source: "estimate" });
    const start = await step(tripId, "start", v);
    expect(start.statusCode).toBe(200);
    expect(start.json().status).toBe("in_trip");
    expect(start.json()).not.toHaveProperty("eta");
    const startEvent = (await events(tripId)).filter((e) => e["kind"] === "trip_projection").at(-1)!;
    expect((startEvent["projection"] as Record<string, unknown>)["status"]).toBe("in_trip");
    expect(startEvent["projection"]).not.toHaveProperty("eta");
    await worker.runDue();
    expect((await riderView(tripId)).eta).toMatchObject({ target: "dropoff", at: clock.now.toISOString() });
  });
});
