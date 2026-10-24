import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-24T10:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
let rider: Record<string, string>;
let other: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  advance(3600);
  // Fresh tokens each test (the clock jumps), and no trip left going from the previous test.
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired"]).execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  other = (await signIn(app, TEST_PHONES[2]!, "rider")).headers;
});

async function economyQuote(headers = rider, extra: Record<string, unknown> = {}) {
  const res = await call(app, "POST", "/quotes", headers, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"], ...extra });
  return res.json().quotes[0];
}
const book = (quote: { quoteId: string }, headers = rider, extra: Record<string, unknown> = {}) =>
  call(app, "POST", "/trips", headers, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash", ...extra });

describe("booking a ride", () => {
  it("a live trip from a quote goes requested → searching, at the quoted price, with one event per change", async () => {
    const quote = await economyQuote();
    const res = await book(quote);
    expect(res.statusCode).toBe(201);
    const trip = res.json();
    expect(trip).toMatchObject({
      tripId: expect.stringMatching(/^trp_/),
      status: "searching",
      version: 3,
      sequence: 2,
      kind: "live",
      zoneId: "Z001",
      categoryId: "economy",
      fare: { amountMinor: 21700, currency: "SEK" },
      paymentMethod: "cash",
      ratingStatus: "not_requested",
      pinRequired: false,
      acceptedAt: null,
      quote: { quoteId: quote.quoteId, total: { amountMinor: 21700, currency: "SEK" }, expiresAt: quote.expiresAt },
    });
    expect(trip.rideId).toBe(trip.tripId);
    expect(trip).not.toHaveProperty("driverEarnings");
    expect(trip).not.toHaveProperty("commission");

    const events = (await call(app, "GET", `/trips/${trip.tripId}/events?after=0`, rider)).json();
    expect(events.items.map((e: { sequence: number; projection: { status: string } }) => [e.sequence, e.projection.status])).toEqual([[1, "requested"], [2, "searching"]]);
    expect(events.items[1].projection).not.toHaveProperty("driverEarnings");
    expect((await call(app, "GET", `/trips/${trip.tripId}/events?after=1`, rider)).json().items).toHaveLength(1);
  });

  it("the same key books once", async () => {
    const quote = await economyQuote();
    const first = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" }, "book-once-key-0000001");
    const again = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" }, "book-once-key-0000001");
    expect(again.json()).toEqual(first.json());
  });

  it("a used, expired, other rider's or changed quote is refused; so is a card", async () => {
    const used = await economyQuote();
    await book(used);
    await call(app, "POST", `/trips/${(await call(app, "GET", "/rider/trips/active", rider)).json().tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
    expect((await book(used)).json()).toMatchObject({ code: "conflict", reason: "quote_used" });

    const late = await economyQuote();
    advance(301);
    rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    expect((await book(late)).json()).toMatchObject({ code: "conflict", reason: "quote_expired" });

    const mine = await economyQuote();
    expect((await book(mine, other)).json()).toMatchObject({ code: "not_found", reason: "quote_not_found" });
    expect((await book(mine, rider, { dropoff: NORRMALM })).json()).toMatchObject({ code: "invalid_request", reason: "quote_mismatch" });
    expect((await book(mine, rider, { paymentMethod: "card" })).json()).toMatchObject({ reason: "payment_method_not_available" });
  });

  it("one live ride at a time", async () => {
    await book(await economyQuote());
    const second = await book(await economyQuote());
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "conflict", reason: "active_trip_exists" });
  });

  it("a scheduled ride stays requested until its time", async () => {
    const at = new Date(clock.now.getTime() + 3 * 3600_000).toISOString();
    const quote = await economyQuote(rider, { kind: "scheduled", scheduledAt: at });
    const res = await book(quote, rider, { kind: "scheduled", scheduledAt: at });
    expect(res.json()).toMatchObject({ status: "requested", version: 2, kind: "scheduled", scheduledAt: at });
    expect(res.json().fareLines.map((l: { code: string }) => l.code)).toContain("reservation_fee");
  });
});

describe("reading a trip", () => {
  it("the rider sees their own trip (also at /rides/{id}); others get 404; an admin sees the money split", async () => {
    const trip = (await book(await economyQuote())).json();
    const mine = await call(app, "GET", `/trips/${trip.tripId}`, rider);
    expect(mine.json()).toEqual(trip);
    expect((await call(app, "GET", `/rides/${trip.tripId}`, rider)).json()).toEqual(trip);
    expect((await call(app, "GET", `/trips/${trip.tripId}`, other)).json()).toMatchObject({ code: "not_found", reason: "trip_not_found" });
    const driver = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    expect((await call(app, "GET", `/trips/${trip.tripId}`, driver)).statusCode).toBe(404);
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const seen = (await call(app, "GET", `/trips/${trip.tripId}`, admin.headers)).json();
    expect(seen).toMatchObject({ driverEarnings: { amountMinor: 15760, currency: "SEK" }, commission: { amountMinor: 5940, currency: "SEK" } });
  });

  it("active trip: the live one, or 204; history newest first with a cursor", async () => {
    expect((await call(app, "GET", "/rider/trips/active", other)).statusCode).toBe(204);
    const trip = (await book(await economyQuote(other), other)).json();
    expect((await call(app, "GET", "/rider/trips/active", other)).json()).toMatchObject({ tripId: trip.tripId });
    const page = (await call(app, "GET", "/rider/trips?limit=1", other)).json();
    expect(page.items[0].tripId).toBe(trip.tripId);
    if (page.nextCursor) {
      const next = (await call(app, "GET", `/rider/trips?limit=1&cursor=${page.nextCursor}`, other)).json();
      expect(next.items[0]?.tripId).not.toBe(trip.tripId);
    }
  });
});

describe("cancelling", () => {
  it("before a driver: free; a stale version is 409 with the projection; a second cancel is 409 invalid_transition", async () => {
    const trip = (await book(await economyQuote())).json();
    const stale = await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 2, reasonCode: "plans_changed" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "version_mismatch", projection: { tripId: trip.tripId, version: 3 } });
    const bad = await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "driver_late" });
    expect(bad.json()).toMatchObject({ code: "invalid_request", reason: "invalid_reason_code" });

    const done = await call(app, "POST", `/rides/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "cancelled_by_rider", version: 4, cancellation: { actor: "rider", reasonCode: "plans_changed", at: clock.now.toISOString(), fee: null } });
    const again = await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 4, reasonCode: "plans_changed" });
    expect(again.json()).toMatchObject({ code: "invalid_transition", projection: { status: "cancelled_by_rider" } });
  });

  it("cancel first, tell the reason after: no version change, once only", async () => {
    const trip = (await book(await economyQuote())).json();
    await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "something_else" });
    const told = await call(app, "POST", `/trips/${trip.tripId}/cancel-reason`, rider, { reasonCode: "wait_too_long", note: "took long" });
    expect(told.json()).toMatchObject({ version: 4, cancellation: { reasonCode: "wait_too_long", note: "took long" } });
    const events = (await call(app, "GET", `/trips/${trip.tripId}/events`, rider)).json().items;
    expect(events).toHaveLength(3);
    expect((await call(app, "POST", `/trips/${trip.tripId}/cancel-reason`, rider, { reasonCode: "plans_changed" })).json()).toMatchObject({ code: "invalid_transition" });
  });
});

describe("rider account", () => {
  it("profile read and change with expectedVersion", async () => {
    const profile = (await call(app, "GET", "/rider/profile", rider)).json();
    expect(profile).toMatchObject({ riderId: expect.stringMatching(/^rdr_/), phone: TEST_PHONES[0], status: "active", outstanding: null });
    const changed = await call(app, "PATCH", "/rider/profile", rider, { expectedVersion: profile.version, firstName: "Sara", language: "sv", consents: { rideUpdates: true } });
    expect(changed.json()).toMatchObject({ firstName: "Sara", language: "sv", version: profile.version + 1, consents: { rideUpdates: true } });
    const stale = await call(app, "PATCH", "/rider/profile", rider, { expectedVersion: profile.version, firstName: "X" });
    expect(stale.json()).toMatchObject({ code: "version_mismatch", projection: { firstName: "Sara" } });
  });

  it("payment methods: cash only in the test week", async () => {
    expect((await call(app, "GET", "/payment-methods", rider)).json()).toEqual({ items: [{ paymentMethodId: "cash", method: "cash", isDefault: true }], nextCursor: null });
    expect((await call(app, "POST", "/payment-methods/default", rider, { method: "card" })).json()).toMatchObject({ reason: "payment_method_not_available" });
    expect((await call(app, "POST", "/payment-methods", rider, { method: "card", pspToken: "tok" })).json()).toMatchObject({ reason: "payment_method_not_available" });
  });

  it("an unpaid fee shows on the profile and rides along on the next price", async () => {
    const riderId = (await call(app, "GET", "/rider/profile", other)).json().riderId;
    await database.db.updateTable("riders").set({ outstanding_minor: 6500, outstanding_source_trip_id: "trp_previous" }).where("rider_id", "=", riderId).execute();
    expect((await call(app, "GET", "/rider/profile", other)).json().outstanding).toEqual({ amountMinor: 6500, currency: "SEK" });
    const quote = await economyQuote(other);
    expect(quote.total).toEqual({ amountMinor: 28200, currency: "SEK" });
    expect(quote.fareLines.at(-1)).toEqual({ code: "outstanding_fee", amount: { amountMinor: 6500, currency: "SEK" }, sourceTripId: "trp_previous" });
    await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_source_trip_id: null }).where("rider_id", "=", riderId).execute();
  });

  it("account deletion is recorded (202)", async () => {
    const res = await call(app, "POST", "/account/deletion", other);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "requested" });
  });
});
