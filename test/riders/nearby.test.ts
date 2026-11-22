import { haversineKm } from "../../src/maps/routing.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { seedDriver } from "../../src/drivers/service.js";
import { readEnv } from "../../src/env.js";
import { NearbyCache, nearbyCell, nearbyVehicles } from "../../src/riders/nearby.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/** contract v0.5.2 §13: GET /rider/nearby-vehicles, the free cars around the rider's map. */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-24T10:00:00Z") };
let rider: Record<string, string>;
const ids: string[] = [];

/** About [meters] north of Sergels torg. */
const north = (meters: number) => ({ lat: NORRMALM.lat + meters / 111_320, lng: NORRMALM.lng });

async function place(driverId: string, at: { lat: number; lng: number }, opts: { online?: boolean; secondsAgo?: number; heading?: number | null } = {}) {
  const db = database.db;
  await db.updateTable("drivers").set({ online_status: opts.online === false ? "offline" : "online" }).where("driver_id", "=", driverId).execute();
  const received = new Date(clock.now.getTime() - (opts.secondsAgo ?? 5) * 1000);
  const row = { lat: at.lat, lng: at.lng, accuracy: 8, heading: opts.heading === undefined ? 90 : opts.heading, measured_at: received, received_at: received, moving: true };
  await db.insertInto("driver_locations").values({ driver_id: driverId, ...row }).onConflict((c) => c.column("driver_id").doUpdateSet(row)).execute();
}

/** v0.18.4 (G3-D4): a shown car is 100–200 m from the real one (plus ~10 m rounding). */
const near = (shown: { lat: number; lng: number }, real: { lat: number; lng: number }) => {
  const m = haversineKm(shown, real) * 1000;
  return m > 88 && m < 212;
};
const nearby = async (query = `lat=${NORRMALM.lat}&lng=${NORRMALM.lng}`, headers = rider) => call(app, "GET", `/rider/nearby-vehicles?${query}`, headers);

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  for (let i = 0; i < 18; i++) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: `+467000010${String(i).padStart(2, "0")}`, firstName: `Driver${i}`, make: "Volvo", model: "V60", year: 2021, color: "White", plate: `NRB ${String(100 + i)}`, categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
    );
    ids.push(made.driverId);
  }
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.deleteFrom("driver_locations").execute();
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider"]).execute();
  await database.db.updateTable("drivers").set({ online_status: "offline", account_status: "active" }).execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
});

describe("nearby cars", () => {
  it("lists free online cars nearest first, rounded, with nothing that tells who drives", async () => {
    await place(ids[0]!, north(900), { heading: 271.6 });
    await place(ids[1]!, north(300), { heading: null });
    const res = await nearby();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ refreshSeconds: 5, radiusMeters: 3000 });
    expect(body.items).toHaveLength(2);
    const [first, second] = body.items;
    expect(first.key).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(first.key).not.toBe(second.key);
    expect(Object.keys(first).sort()).toEqual(["key", "lat", "lng"]);
    expect(Object.keys(second).sort()).toEqual(["heading", "key", "lat", "lng"]);
    expect(second.heading).toBe(272);
    // Nearest first, positions moved 100–200 m (v0.18.4, G3-D4) and at 4 decimals.
    expect(near(first, north(300))).toBe(true);
    expect(first.lat).toBe(Math.round(first.lat * 1e4) / 1e4);
    expect(first.lng).toBe(Math.round(first.lng * 1e4) / 1e4);
    const text = res.body;
    for (const id of ids) expect(text).not.toContain(id);
    expect(text).not.toMatch(/Driver\d|NRB|Volvo|plate|driverId|vehicleId/);
  });

  it("leaves out offline, suspended, stale, far and busy drivers", async () => {
    await place(ids[0]!, north(100));
    await place(ids[1]!, north(200), { online: false });
    await place(ids[2]!, north(300), { secondsAgo: 121 });
    await place(ids[3]!, north(3100));
    await place(ids[4]!, north(400));
    await database.db.updateTable("drivers").set({ account_status: "suspended" }).where("driver_id", "=", ids[4]!).execute();
    await place(ids[5]!, north(500));
    await busy(ids[5]!);
    const body = (await nearby()).json();
    expect(body.items).toHaveLength(1);
    expect(near(body.items[0], north(100))).toBe(true);
  });

  it("gives at most 15 cars, the nearest ones", async () => {
    for (let i = 0; i < 18; i++) await place(ids[i]!, north(100 + i * 100));
    const body = (await nearby()).json();
    expect(body.items).toHaveLength(15);
    expect(near(body.items.at(-1), north(1500))).toBe(true);
  });

  it("keeps one car's key through the day and changes it the next day", async () => {
    await place(ids[0]!, north(100));
    const first = (await nearby()).json().items[0].key;
    clock.now = new Date(clock.now.getTime() + 3600_000);
    rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    await place(ids[0]!, north(150));
    const later = (await nearby()).json().items[0].key;
    expect(later).toBe(first);
    clock.now = new Date(clock.now.getTime() + 24 * 3600_000);
    rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    await place(ids[0]!, north(150));
    const tomorrow = (await nearby()).json().items[0].key;
    expect(tomorrow).not.toBe(first);
    expect(tomorrow).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it("is for riders, with a valid point; an empty area is a normal empty list", async () => {
    expect((await nearby()).json()).toMatchObject({ items: [] });
    expect((await nearby("lat=91&lng=18")).statusCode).toBe(400);
    expect((await nearby("lng=18")).statusCode).toBe(400);
    const driver = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    expect((await nearby(undefined, driver)).statusCode).toBe(403);
    expect((await call(app, "GET", `/rider/nearby-vehicles?lat=59&lng=18`, {})).statusCode).toBe(401);
  });
});

/** Puts an accepted trip on [driverId] straight in the database. */
async function busy(driverId: string) {
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider"]).execute();
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  await database.db.updateTable("trips").set({ status: "driver_to_pickup", driver_id: driverId, accepted_at: clock.now }).where("trip_id", "=", trip.tripId).execute();
}

/**
 * v0.18.145 (contract.json#loadCut.nearbyCache, S4c load cut): each server copy keeps the cars of a grid cell (0.005°)
 * for at most NEARBY_CACHE_MS (default 2500, 0 = off): only blurred, rounded positions, keys and headings.
 */
describe("nearby cars cache per grid cell (v0.18.145 loadCut.nearbyCache)", () => {
  const ENV = { MOVERA_ENV: "staging", DATABASE_URL: "postgres://localhost/movera", JWT_SECRET: "nearby-cache-secret".padEnd(48, "s") };
  const RIDER_A = { lat: 59.3326, lng: 18.0649 };
  // Same 0.005° cell as RIDER_A (59.330–59.335, 18.060–18.065), about 250 m south.
  const RIDER_B = { lat: 59.3304, lng: 18.0645 };

  it("NEARBY_CACHE_MS defaults to 2500; 0 turns the cache off", () => {
    expect(readEnv({ ...ENV }).NEARBY_CACHE_MS).toBe(2500);
    expect(readEnv({ ...ENV, NEARBY_CACHE_MS: "0" }).NEARBY_CACHE_MS).toBe(0);
    expect(nearbyCell(RIDER_A)).toBe(nearbyCell(RIDER_B));
    expect(nearbyCell(RIDER_A)).not.toBe(nearbyCell({ lat: 59.3376, lng: 18.0649 }));
  });

  it("a second rider of the same cell within NEARBY_CACHE_MS gets the kept cars (a car may show up that long late)", async () => {
    const cache = new NearbyCache(2500);
    await place(ids[0]!, north(300));
    const first = await nearbyVehicles(database.db, RIDER_A, "s".repeat(48), clock.now, cache);
    expect(first.items).toHaveLength(1);
    await place(ids[1]!, north(600));
    const soon = new Date(clock.now.getTime() + 2000);
    expect((await nearbyVehicles(database.db, RIDER_B, "s".repeat(48), soon, cache)).items).toHaveLength(1);
    const later = new Date(clock.now.getTime() + 2600);
    expect((await nearbyVehicles(database.db, RIDER_B, "s".repeat(48), later, cache)).items).toHaveLength(2);
    // Off: every read goes to the database.
    const off = new NearbyCache(0);
    await nearbyVehicles(database.db, RIDER_A, "s".repeat(48), clock.now, off);
    await place(ids[2]!, north(900));
    expect((await nearbyVehicles(database.db, RIDER_A, "s".repeat(48), clock.now, off)).items).toHaveLength(3);
  });

  it("keeps blurred, rounded cars only: no driver id and no true position", async () => {
    const cache = new NearbyCache(2500);
    const real = [north(300), north(700)];
    await place(ids[0]!, real[0]!);
    await place(ids[1]!, real[1]!);
    const answer = await nearbyVehicles(database.db, RIDER_A, "s".repeat(48), clock.now, cache);
    const kept = cache.keptCars();
    expect(kept.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(kept);
    for (const id of ids) expect(text).not.toContain(id);
    for (const p of real) expect(text).not.toContain(String(p.lat));
    for (const car of kept) {
      expect(Object.keys(car).every((k) => ["key", "lat", "lng", "heading"].includes(k))).toBe(true);
      expect(car.lat).toBe(Math.round(car.lat * 1e4) / 1e4);
    }
    expect(answer.items.every((i) => kept.some((k) => k.key === i.key && k.lat === i.lat && k.lng === i.lng))).toBe(true);
  });

  it("each rider gets only the cars within radiusMeters of his own point, nearest first, at most maxVehicles", async () => {
    const cache = new NearbyCache(2500);
    // About 2.9 km north of RIDER_A, so about 3.15 km from RIDER_B (the blur moves it at most 200 m).
    await place(ids[0]!, north(2900 + 300));
    for (let i = 1; i < 18; i++) await place(ids[i]!, north(-200 + i * 20));
    const a = await nearbyVehicles(database.db, { lat: RIDER_A.lat + 0.0015, lng: RIDER_A.lng }, "s".repeat(48), clock.now, cache);
    const b = await nearbyVehicles(database.db, RIDER_B, "s".repeat(48), clock.now, cache);
    expect(a.items).toHaveLength(15);
    expect(b.items).toHaveLength(15);
    for (const [point, answer] of [[{ lat: RIDER_A.lat + 0.0015, lng: RIDER_A.lng }, a], [RIDER_B, b]] as const) {
      const meters = answer.items.map((i) => haversineKm(point, i) * 1000);
      expect(meters.every((m) => m <= 3000)).toBe(true);
      expect([...meters].sort((x, y) => x - y)).toEqual(meters);
    }
    const far = cache.keptCars().find((c) => haversineKm(RIDER_B, c) * 1000 > 3000);
    if (far) expect(b.items.map((i) => i.key)).not.toContain(far.key);
  });

  it("different cells are kept apart", async () => {
    const cache = new NearbyCache(2500);
    await place(ids[0]!, north(300));
    expect((await nearbyVehicles(database.db, RIDER_A, "s".repeat(48), clock.now, cache)).items).toHaveLength(1);
    await place(ids[1]!, north(400));
    const other = { lat: RIDER_A.lat + 0.006, lng: RIDER_A.lng };
    expect((await nearbyVehicles(database.db, other, "s".repeat(48), clock.now, cache)).items).toHaveLength(2);
  });
});
