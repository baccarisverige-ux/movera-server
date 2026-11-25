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
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

import { encodePolyline } from "../../src/maps/polyline.js";

/**
 * v0.18.163 (contract.json#liveTraffic.calls; owner 2026-11-25 "the cheapest method, about 2 Google calls per trip"):
 * one Google call after accept for the drive to the pickup, then the ETA follows the stored route with no call; a new
 * call only once the driver is off the route for more than 30 s. (Setup copied from eta_fresh_live5x5.test.ts.)
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
let googleCalls = 0;
/** Google with live traffic: a straight road at 5 m/s (slower than the estimate) with its polyline. */
const traffic: Router = {
  route: async (points) => {
    googleCalls += 1;
    const meters = Math.round(haversineKm(points[0]!, points[points.length - 1]!) * 1000);
    return { distanceMeters: meters, durationSeconds: Math.round(meters / 5), source: "google", polyline: encodePolyline(points), points };
  },
};
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
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers, [TRIP_ETA]: etaHandler(followRouter, traffic), [PICKUP_GEOFENCE]: async () => undefined }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
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

describe("ETA along the stored Google route (v0.18.163)", () => {
  it("one call after accept; on the route no call; off the route for more than 30 s one more call", async () => {
    googleCalls = 0;
    const { tripId, version } = await accepted();
    expect(googleCalls).toBe(1);
    const first = (await riderView(tripId)).eta;
    expect(first).toMatchObject({ target: "pickup", source: "google" });
    await step(tripId, "head-to-pickup", version);
    const mid = { lat: (FAR.lat + NORRMALM.lat) / 2, lng: FAR.lng };
    await moveTo(mid);
    await advance(30);
    await advance(30);
    expect(googleCalls).toBe(1);
    const half = (await riderView(tripId)).eta;
    expect(half.source).toBe("google");
    expect(half.distanceMeters).toBeLessThan(first.distanceMeters * 0.6);
    // 1.3 km east of the route: off it. The first tick off it starts the 30 s; the next one after that calls Google.
    await moveTo(FARTHER);
    await advance(30);
    expect(googleCalls).toBe(1);
    await moveTo(FARTHER);
    await advance(31);
    expect(googleCalls).toBe(2);
  });
});
