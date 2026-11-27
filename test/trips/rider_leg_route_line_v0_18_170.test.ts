import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { tripProjection } from "../../src/trips/projection.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

// v0.18.170 (contract.json#riderLegRouteLine; owner approved "rider Waiting/on-trip road line from the stored Google
// route, 0 extra Google calls"): the rider's own trip reads carry the stored Google route of the current leg
// (trips.eta_route, the one the live ETA follows) as TripProjection.legRoute. Only when its target is the current leg;
// never to the driver or the admin, never in realtime events, never once the trip ended.
const PICKUP_LINE = "_p~iF~ps|U_ulLnnqC";
const DROPOFF_LINE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const etaRoute = (target: "pickup" | "dropoff", polyline: string) => ({ target, polyline, meters: 1200, seconds: 300, at: "2026-11-27T10:00:00Z", offSince: null, calls: 1 });

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-27T10:00:00Z") };
let rider: Record<string, string>;
let driverId: string;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await signIn(app, TEST_PHONES[1]!, "driver");
  driverId = (await database.db.selectFrom("drivers").select("driver_id").executeTakeFirstOrThrow()).driver_id;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired"]).execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
});

async function book(): Promise<string> {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
  expect(res.statusCode).toBe(201);
  return res.json().tripId as string;
}
const put = (tripId: string, status: string, route: unknown) => database.db.updateTable("trips").set({ status: status as never, driver_id: driverId, eta_route: route === null ? null : (JSON.stringify(route) as never) }).where("trip_id", "=", tripId).execute();
const reads = (tripId: string) => Promise.all([call(app, "GET", `/rides/${tripId}`, rider), call(app, "GET", `/trips/${tripId}`, rider), call(app, "GET", "/rider/trips/active", rider)]).then((rs) => rs.map((r) => r.json() as Record<string, unknown>));

describe("TripProjection.legRoute (v0.18.170)", () => {
  it("pickup leg while the driver is coming, from trips.eta_route, in every rider trip read", async () => {
    const tripId = await book();
    for (const status of ["accepted", "driver_to_pickup"]) {
      await put(tripId, status, etaRoute("pickup", PICKUP_LINE));
      for (const body of await reads(tripId)) expect(body).toMatchObject({ tripId, legRoute: { target: "pickup", polyline: PICKUP_LINE } });
    }
  });

  it("drop-off leg on trip after a re-route; a route for the other leg is not sent", async () => {
    const tripId = await book();
    for (const status of ["rider_onboard", "in_trip", "approaching_dropoff"]) {
      await put(tripId, status, etaRoute("dropoff", DROPOFF_LINE));
      for (const body of await reads(tripId)) expect(body).toMatchObject({ legRoute: { target: "dropoff", polyline: DROPOFF_LINE } });
      await put(tripId, status, etaRoute("pickup", PICKUP_LINE));
      for (const body of await reads(tripId)) expect(body).not.toHaveProperty("legRoute");
    }
    await put(tripId, "driver_to_pickup", etaRoute("dropoff", DROPOFF_LINE));
    for (const body of await reads(tripId)) expect(body).not.toHaveProperty("legRoute");
    // Waiting at the pickup: no leg is under way, no line.
    await put(tripId, "arrived", etaRoute("pickup", PICKUP_LINE));
    for (const body of await reads(tripId)) expect(body).not.toHaveProperty("legRoute");
  });

  it("absent with no stored route, while searching, and once the trip ended", async () => {
    const tripId = await book();
    expect((await call(app, "GET", `/rides/${tripId}`, rider)).json()).not.toHaveProperty("legRoute");
    await put(tripId, "driver_to_pickup", null);
    for (const body of await reads(tripId)) expect(body).not.toHaveProperty("legRoute");
    for (const status of ["completed", "cancelled_by_rider", "no_show"]) {
      await put(tripId, status, etaRoute("dropoff", DROPOFF_LINE));
      expect((await call(app, "GET", `/rides/${tripId}`, rider)).json()).not.toHaveProperty("legRoute");
    }
  });

  it("never to the driver or the admin, never in realtime events or the history list", async () => {
    const tripId = await book();
    await put(tripId, "driver_to_pickup", etaRoute("pickup", PICKUP_LINE));
    const row = await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    for (const viewer of ["driver", "admin"] as const) {
      expect(tripProjection(row, viewer)).not.toHaveProperty("legRoute");
      expect(tripProjection(row, viewer, { routeLine: true })).not.toHaveProperty("legRoute");
    }
    expect(tripProjection(row, "rider")).not.toHaveProperty("legRoute");
    expect(tripProjection(row, "rider", { routeLine: true })).toMatchObject({ legRoute: { target: "pickup", polyline: PICKUP_LINE } });
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    expect((await call(app, "GET", `/admin/trips/${tripId}`, admin.headers)).json()).not.toHaveProperty("legRoute");
    const events = (await call(app, "GET", `/trips/${tripId}/events?after=0`, rider)).json().items as Array<{ projection: Record<string, unknown> }>;
    for (const e of events) expect(e.projection).not.toHaveProperty("legRoute");
    const list = (await call(app, "GET", "/rider/trips", rider)).json().items as Array<Record<string, unknown>>;
    for (const t of list) expect(t).not.toHaveProperty("legRoute");
  });
});
