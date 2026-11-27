import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { tripProjection } from "../../src/trips/projection.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

// v0.18.169 (contract.json#riderTripRouteLine, owner 2026-11-27 "App rider blocked here", "Oui, corriger"): the rider's
// own trip reads carry the trip's stored Google route (trips.route_polyline, from its quote; no new call) while the
// trip has not ended. Never to the driver or the admin, never in realtime events, never once the trip ended.
const LINE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-27T10:00:00Z") };
let rider: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
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

/** Books a live economy trip from a quote that holds a stored Google route (as the quote's one Google call leaves it). */
async function bookWithRoute(polyline: string | null = LINE): Promise<string> {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  await database.db.updateTable("quotes").set({ route_polyline: polyline }).where("quote_id", "=", quote.quoteId).execute();
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
  expect(res.statusCode).toBe(201);
  return res.json().tripId as string;
}

describe("TripProjection.routePolyline (v0.18.169)", () => {
  it("the rider's GET /rides/{id}, GET /trips/{id} and GET /rider/trips/active carry the stored route while the trip has not ended", async () => {
    const tripId = await bookWithRoute();
    expect((await call(app, "GET", `/rides/${tripId}`, rider)).json()).toMatchObject({ tripId, status: "searching", routePolyline: LINE });
    expect((await call(app, "GET", `/trips/${tripId}`, rider)).json()).toMatchObject({ tripId, routePolyline: LINE });
    expect((await call(app, "GET", "/rider/trips/active", rider)).json()).toMatchObject({ tripId, routePolyline: LINE });
  });

  it("absent once the trip ended (every terminal status) and when the trip has no stored route", async () => {
    const tripId = await bookWithRoute();
    for (const status of ["completed", "cancelled_by_rider", "expired", "no_show"] as const) {
      await database.db.updateTable("trips").set({ status }).where("trip_id", "=", tripId).execute();
      expect((await call(app, "GET", `/rides/${tripId}`, rider)).json()).not.toHaveProperty("routePolyline");
    }
    const none = await bookWithRoute(null);
    expect((await call(app, "GET", `/rides/${none}`, rider)).json()).not.toHaveProperty("routePolyline");
    expect((await call(app, "GET", "/rider/trips/active", rider)).json()).not.toHaveProperty("routePolyline");
  });

  it("never in realtime events, the history list or the booking answer", async () => {
    const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    await database.db.updateTable("quotes").set({ route_polyline: LINE }).where("quote_id", "=", quote.quoteId).execute();
    const booked = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
    expect(booked.json()).not.toHaveProperty("routePolyline");
    const tripId = booked.json().tripId as string;
    const events = (await call(app, "GET", `/trips/${tripId}/events?after=0`, rider)).json().items as Array<{ projection: Record<string, unknown> }>;
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.projection).not.toHaveProperty("routePolyline");
    const stored = await database.db.selectFrom("trip_events").select("projection").where("trip_id", "=", tripId).execute();
    for (const e of stored) expect(e.projection).not.toHaveProperty("routePolyline");
    const list = (await call(app, "GET", "/rider/trips", rider)).json().items as Array<Record<string, unknown>>;
    expect(list.find((t) => t["tripId"] === tripId)).toBeDefined();
    for (const t of list) expect(t).not.toHaveProperty("routePolyline");
  });

  it("never in the driver's or the admin's projection", async () => {
    const tripId = await bookWithRoute();
    const row = await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(row.route_polyline).toBe(LINE);
    for (const viewer of ["driver", "admin"] as const) {
      expect(tripProjection(row, viewer)).not.toHaveProperty("routePolyline");
      expect(tripProjection(row, viewer, { routeLine: true })).not.toHaveProperty("routePolyline");
    }
    expect(tripProjection(row, "rider", { routeLine: true })).toMatchObject({ routePolyline: LINE });
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const read = await call(app, "GET", `/admin/trips/${tripId}`, admin.headers);
    expect(read.statusCode).toBe(200);
    expect(read.json()).not.toHaveProperty("routePolyline");
  });
});
