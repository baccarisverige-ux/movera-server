import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { encodePolyline } from "../../src/maps/polyline.js";
import { haversineKm, type LatLng, type Router } from "../../src/maps/routing.js";
import { etaHandler, TRIP_ETA } from "../../src/trips/eta.js";
import { PICKUP_GEOFENCE, rideHandlers } from "../../src/trips/ride.js";
import type { NotificationHub } from "../../src/realtime/hub.js";
import { freshDatabase, type TestDatabase } from "./db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "./world.js";

/**
 * v0.18.171 (contract.json#googleRoadLines) test world: Z001 with live traffic on (SE default), a Google stub that
 * answers the straight road through the asked points with its polyline and counts its calls, given to BOTH the app
 * (quotes, GET /routes/driving) and the ETA tick. Setup as test/trips/eta_google_route163.test.ts.
 */
export const FAR = { lat: 59.3443, lng: 18.0649 };
/** Metres → degrees of longitude at Stockholm. */
export const eastDeg = (meters: number) => meters / (111_320 * Math.cos((FAR.lat * Math.PI) / 180));
export const MID = { lat: (FAR.lat + NORRMALM.lat) / 2, lng: FAR.lng };

export type RoadWorld = Awaited<ReturnType<typeof roadWorld>>;

export async function roadWorld(options: { hub?: NotificationHub; database?: TestDatabase } = {}) {
  const database: TestDatabase = options.database ?? (await freshDatabase());
  const clock = { now: new Date("2026-11-08T12:00:00Z") };
  const google = { calls: 0, fail: false as false | "error" | "quota", asked: [] as LatLng[][], during: undefined as undefined | (() => Promise<void>) };
  const traffic: Router = {
    route: async (points) => {
      google.calls += 1;
      google.asked.push(points);
      if (google.during) await google.during();
      const meters = Math.round(haversineKm(points[0]!, points[points.length - 1]!) * 1000);
      if (google.fail) return { distanceMeters: meters, durationSeconds: Math.round(meters / 7), source: "estimate" };
      return { distanceMeters: meters, durationSeconds: Math.round(meters / 5), source: "google", polyline: encodePolyline(points), points };
    },
  };
  const app: FastifyInstance = await testWorld(database.db, database.url, clock, { traffic, ...(options.hub ? { hub: options.hub } : {}) });
  const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
  const dispatchDoc = sample("dispatch_document");
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(dispatchDoc), published_at: clock.now, published_by: null }).execute();
  for (const doc of ["rider_app_config", "driver_app_config"] as const) {
    await database.db.insertInto("config_live").values({ doc, zone_id: "Z001", version: 1, document: JSON.stringify({ ...sample(doc), version: 1 }), published_at: clock.now, published_by: null }).execute();
  }
  const followRouter: Router = {
    route: async (points) => {
      const meters = Math.round(haversineKm(points[0]!, points[points.length - 1]!) * 1000);
      return { distanceMeters: meters, durationSeconds: Math.round(meters / 10), source: "osrm" };
    },
  };
  const worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers, [TRIP_ETA]: etaHandler(followRouter, traffic), [PICKUP_GEOFENCE]: async () => undefined }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "RL0171", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  const driver = { id: made.driverId, headers: {} as Record<string, string> };
  let rider: Record<string, string> = {};

  const moveTo = async (at: LatLng) => {
    clock.now = new Date(clock.now.getTime() + 1000);
    const res = await call(app, "POST", "/driver/location", driver.headers, { fixes: [{ ...at, accuracy: 5, measuredAt: clock.now.toISOString() }] });
    expect(res.statusCode).toBe(200);
  };
  const advance = async (seconds: number) => {
    clock.now = new Date(clock.now.getTime() + seconds * 1000);
    await worker.runDue();
  };
  /** Clock forward without running the ETA tick. */
  const wait = (seconds: number) => {
    clock.now = new Date(clock.now.getTime() + seconds * 1000);
  };
  const reset = async () => {
    clock.now = new Date(clock.now.getTime() + 3600_000);
    google.fail = false;
    google.during = undefined;
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
    await database.db.deleteFrom("timers").execute();
    await database.db.deleteFrom("offers").execute();
    rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    driver.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driver.id).execute();
    await moveTo(FAR);
    google.calls = 0;
    google.asked = [];
  };
  /** The rider books Norrmalm → Södermalm (a Google quote), the driver 1.3 km north takes it, the first ETA tick runs. */
  const accepted = async () => {
    const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
    expect(res.statusCode, res.body).toBe(201);
    await worker.runDue();
    const [offer] = (await call(app, "GET", "/driver/offers", driver.headers)).json().items;
    const accept = await call(app, "POST", `/offers/${offer.offerId}/accept`, driver.headers, { expectedVersion: offer.version });
    expect(accept.statusCode, accept.body).toBe(200);
    await worker.runDue();
    return { tripId: res.json().tripId as string, version: accept.json().version as number };
  };
  const nav = async (from: LatLng, to: LatLng = NORRMALM) => {
    const res = await call(app, "GET", `/routes/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`, driver.headers);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { code: string; source: string; routes: Array<{ distance: number; duration: number; geometry: { coordinates: number[][] } }> };
  };
  const trip = (tripId: string) => database.db.selectFrom("trips").select(["eta_route", "eta", "google_route_calls", "driver_id"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  const setRoadLines = async (roadLines: Record<string, unknown>) => {
    await database.db.updateTable("config_live").set({ document: JSON.stringify({ ...dispatchDoc, liveTraffic: { on: true, roadLines } }) }).where("doc", "=", "dispatch").where("zone_id", "=", "Z001").execute();
  };
  const step = (tripId: string, path: string, version: number) => call(app, "POST", `/trips/${tripId}/${path}`, driver.headers, { expectedVersion: version });
  const close = async () => {
    await app.close();
    await database.drop();
  };
  return { database, app, worker, clock, google, driver, rider: () => rider, moveTo, advance, wait, reset, accepted, nav, trip, setRoadLines, step, close, NORRMALM, SODERMALM };
}
