import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { seedDriver } from "../../src/drivers/service.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-24T10:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
let driver: Record<string, string>;
let driverId: string;

const fix = (lat: number, lng: number, secondsAgo = 0, extra: Record<string, unknown> = {}) => ({ lat, lng, accuracy: 8, measuredAt: new Date(clock.now.getTime() - secondsAgo * 1000).toISOString(), ...extra });
const profile = async () => (await call(app, "GET", "/driver/profile", driver)).json();

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Sara", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "abc 123", categoryIds: ["economy", "comfort"], zoneIds: ["Z001", "Z002"] }, clock.now),
  );
  driverId = made.driverId;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  advance(3600);
  driver = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
});

describe("a seeded test driver", () => {
  it("signs in as an existing, active driver with an approved car", async () => {
    const me = await profile();
    expect(me).toMatchObject({ driverId, accountStatus: "active", onlineStatus: "offline", firstName: "Sara", zoneIds: ["Z001", "Z002"], categoryIds: ["economy", "comfort"], documents: [] });
    const cars = (await call(app, "GET", "/driver/vehicles", driver)).json();
    expect(cars.items).toEqual([expect.objectContaining({ make: "Volvo", model: "V60", plate: "ABC 123", status: "approved", categoryIds: ["economy", "comfort"] })]);
    expect(me).not.toHaveProperty("location");
  });
});

describe("going online and offline", () => {
  it("online, then offline, each with expectedVersion; a stale version is 409 with the Driver", async () => {
    const me = await profile();
    const online = await call(app, "POST", "/driver/availability", driver, { expectedVersion: me.version, onlineStatus: "online", location: fix(59.3326, 18.0649) });
    expect(online.statusCode).toBe(200);
    expect(online.json()).toMatchObject({ onlineStatus: "online", version: me.version + 1, moving: false });
    const stale = await call(app, "POST", "/driver/availability", driver, { expectedVersion: me.version, onlineStatus: "offline" });
    expect(stale.json()).toMatchObject({ code: "version_mismatch", projection: { onlineStatus: "online" } });
    const offline = await call(app, "POST", "/driver/availability", driver, { expectedVersion: me.version + 1, onlineStatus: "offline" });
    expect(offline.json()).toMatchObject({ onlineStatus: "offline" });
  });

  it("a new driver without an active account or car cannot go online", async () => {
    const fresh = (await signIn(app, TEST_PHONES[5]!, "driver")).headers;
    const me = (await call(app, "GET", "/driver/profile", fresh)).json();
    expect(me.accountStatus).toBe("pending");
    const res = await call(app, "POST", "/driver/availability", fresh, { expectedVersion: me.version, onlineStatus: "online" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "invalid_transition", reason: "account_not_active", projection: { onlineStatus: "offline" } });
  });

  it("a driver on a trip cannot go offline", async () => {
    const me = await profile();
    await call(app, "POST", "/driver/availability", driver, { expectedVersion: me.version, onlineStatus: "online" });
    const tripId = await assignedTrip();
    const res = await call(app, "POST", "/driver/availability", driver, { expectedVersion: me.version + 1, onlineStatus: "offline" });
    expect(res.json()).toMatchObject({ code: "invalid_transition", reason: "on_trip", projection: { activeTripId: tripId } });
    await database.db.updateTable("trips").set({ status: "completed" }).where("trip_id", "=", tripId).execute();
  });
});

/** Until dispatch lands, put a fresh trip on this driver directly. */
async function assignedTrip(): Promise<string> {
  const rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider"]).execute();
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  await database.db.updateTable("trips").set({ status: "driver_to_pickup", driver_id: driverId, accepted_at: clock.now }).where("trip_id", "=", trip.tripId).execute();
  return trip.tripId;
}

describe("location", () => {
  it("keeps the newest fix and its zone; old and future fixes are dropped; an older batch never replaces a newer one", async () => {
    const res = await call(app, "POST", "/driver/location", driver, { fixes: [fix(59.33, 18.06, 20), fix(59.3326, 18.0649, 5, { speedMps: 9, moving: true, heading: 90 }), fix(59.0, 18.0, 3600), fix(59.0, 18.0, -600)] });
    expect(res.json()).toEqual({ accepted: 2, serverTime: clock.now.toISOString() });
    const stored = await database.db.selectFrom("driver_locations").selectAll().where("driver_id", "=", driverId).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ lat: 59.3326, lng: 18.0649, moving: true, speed_mps: 9, zone_id: "Z001" });
    await call(app, "POST", "/driver/location", driver, { fixes: [fix(59.2, 17.6, 30)] });
    expect((await database.db.selectFrom("driver_locations").select("lat").where("driver_id", "=", driverId).executeTakeFirstOrThrow()).lat).toBe(59.3326);
    expect((await profile()).moving).toBe(true);
    expect((await call(app, "POST", "/driver/location", driver, { fixes: [] })).json()).toMatchObject({ reason: "invalid_body" });
  });

  it("on a trip, fixes go to the trace and the trip stream as location events, without changing the version", async () => {
    const tripId = await assignedTrip();
    const before = await database.db.selectFrom("trips").select(["version", "sequence"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    await call(app, "POST", "/driver/location", driver, { fixes: [fix(59.331, 18.063, 4), fix(59.330, 18.064, 1)], tripId: "trp_someone_else" });
    const events = await database.db.selectFrom("trip_events").selectAll().where("trip_id", "=", tripId).orderBy("sequence").execute();
    const last = events.at(-1)!;
    expect(last).toMatchObject({ kind: "location", version: before.version, location: { lat: 59.33, lng: 18.064 } });
    const after = await database.db.selectFrom("trips").select(["version"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(after.version).toBe(before.version);

    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const trace = (await call(app, "GET", `/admin/trips/${tripId}/trace`, admin.headers)).json();
    expect(trace.fixes.map((f: { lat: number }) => f.lat)).toEqual([59.331, 59.33]);
    await database.db.updateTable("trips").set({ status: "completed" }).where("trip_id", "=", tripId).execute();
  });
});

describe("admin live map", () => {
  it("lists online drivers with their position; stale after 120 s; limited to the admin's zones", async () => {
    const me = await profile();
    if (me.onlineStatus !== "online") await call(app, "POST", "/driver/availability", driver, { expectedVersion: me.version, onlineStatus: "online" });
    await call(app, "POST", "/driver/location", driver, { fixes: [fix(59.3326, 18.0649)] });
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const live = (await call(app, "GET", "/admin/live/drivers?zoneId=Z001", admin.headers)).json();
    expect(live).toMatchObject({ staleAfterSeconds: 120, serverTime: clock.now.toISOString() });
    expect(live.items).toEqual([expect.objectContaining({ driverId, firstName: "Sara", onlineStatus: "online", stale: false, plate: "ABC 123", zoneId: "Z001", location: expect.objectContaining({ lat: 59.3326 }) })]);
    advance(121);
    const later = await adminSession(app, database.db, "super", { now: clock.now });
    expect((await call(app, "GET", "/admin/live/drivers", later.headers)).json().items[0].stale).toBe(true);
    const south = await adminSession(app, database.db, "dispatcher", { zoneIds: ["Z002"], now: clock.now });
    expect((await call(app, "GET", "/admin/live/drivers", south.headers)).json().items).toEqual([]);
    expect((await call(app, "GET", "/admin/live/drivers?zoneId=Z001", south.headers)).json()).toMatchObject({ reason: "zone_out_of_scope" });
  });
});

describe("profile and cars", () => {
  it("a car type the car is not approved for is refused; a new car waits for review", async () => {
    const me = await profile();
    const bad = await call(app, "PATCH", "/driver/profile", driver, { expectedVersion: me.version, categoryIds: ["premium"] });
    expect(bad.json()).toMatchObject({ reason: "category_not_allowed" });
    const ok = await call(app, "PATCH", "/driver/profile", driver, { expectedVersion: me.version, categoryIds: ["economy"] });
    expect(ok.json()).toMatchObject({ categoryIds: ["economy"], version: me.version + 1 });
    const car = await call(app, "POST", "/driver/vehicles", driver, { make: "Kia", model: "Niro", year: 2022, color: "White", plate: "xyz 789", seats: 4, categoryIds: ["electric"] });
    expect(car.statusCode).toBe(201);
    expect(car.json()).toMatchObject({ status: "pending", plate: "XYZ 789" });
    const taken = await call(app, "POST", "/driver/vehicles", driver, { make: "Kia", model: "Niro", year: 2022, color: "White", plate: "XYZ789", seats: 4 });
    expect(taken.json()).toMatchObject({ reason: "plate_taken" });
  });
});
