import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { cleanTrace, thin } from "../../src/trips/path.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-10-24T12:00:00Z") };
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));

const SPOTS = { A: { lat: 59.3335, lng: 18.0655 }, B: { lat: 59.3360, lng: 18.07 } };
const drivers: Record<"A" | "B", { id: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values([
    { doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null },
    { doc: "rider_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("rider_app_config")), published_at: clock.now, published_by: null },
  ]).execute();
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const phones = { A: TEST_PHONES[1]!, B: TEST_PHONES[2]! };
  for (const key of ["A", "B"] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `RID00${key}`, categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
    );
    drivers[key] = { id: made.driverId, headers: {} };
  }
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

const fix = (at: { lat: number; lng: number }) => ({ fixes: [{ ...at, accuracy: 5, measuredAt: clock.now.toISOString() }] });
async function moveTo(key: "A" | "B", at: { lat: number; lng: number }) {
  const res = await call(app, "POST", "/driver/location", drivers[key].headers, fix(at));
  expect(res.statusCode).toBe(200);
}

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  const signedIn = await signIn(app, TEST_PHONES[0]!, "rider");
  rider = signedIn.headers;
  await call(app, "GET", "/rider/profile", rider);
  for (const key of ["A", "B"] as const) {
    drivers[key].headers = (await signIn(app, { A: TEST_PHONES[1], B: TEST_PHONES[2] }[key]!, "driver")).headers;
    await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", drivers[key].id).execute();
    await moveTo(key, SPOTS[key]);
  }
});

async function book() {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  await worker.runDue();
  return { tripId: trip.tripId as string, quote };
}

/** A books, the best driver (A, nearest) accepts. */
async function accepted() {
  // Same idle time, no ratings and no offer history, so A (the nearest) ranks first.
  await database.db.deleteFrom("offers").where("status", "!=", "open").execute();
  await database.db.updateTable("drivers").set({ last_free_at: clock.now, rating_sum: 0, rating_count: 0 }).execute();
  // The apps send fixes all the time; a fix older than 2 minutes counts as gone.
  for (const key of ["A", "B"] as const) await moveTo(key, SPOTS[key]);
  const { tripId, quote } = await book();
  const [offer] = (await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items;
  expect(offer?.tripId).toBe(tripId);
  const res = await call(app, "POST", `/offers/${offer.offerId}/accept`, drivers.A.headers, { expectedVersion: offer.version });
  expect(res.statusCode).toBe(200);
  return { tripId, quote, version: res.json().version as number };
}

const step = async (tripId: string, path: string, version: number, body: Record<string, unknown> = {}, who = drivers.A.headers) => {
  // A finished trip was driven to the drop-off; what is paid when a driver completes before it is its own test.
  // A fix carries the test clock and only a newer fix counts, so the clock ticks a second each way, and the
  // driver is back where they were afterwards.
  if (path === "complete" && body["location"] === undefined) {
    const key = who === drivers.B.headers ? "B" : "A";
    const before = await database.db.selectFrom("driver_locations").select(["lat", "lng"]).where("driver_id", "=", drivers[key].id).executeTakeFirst();
    clock.now = new Date(clock.now.getTime() + 1000);
    await moveTo(key, SODERMALM);
    const res = await call(app, "POST", `/trips/${tripId}/${path}`, who, { expectedVersion: version, ...body });
    if (before) {
      clock.now = new Date(clock.now.getTime() + 1000);
      await moveTo(key, { lat: Number(before.lat), lng: Number(before.lng) });
    }
    return res;
  }
  return call(app, "POST", `/trips/${tripId}/${path}`, who, { expectedVersion: version, ...body });
};

/** Drives an accepted trip to the pickup and waits `waitSeconds` before boarding. */
async function toBoard(tripId: string, version: number, waitSeconds: number) {
  let v = version;
  let res = await step(tripId, "head-to-pickup", v);
  expect(res.json().status).toBe("driver_to_pickup");
  res = await step(tripId, "arrive", ++v);
  expect(res.json()).toMatchObject({ status: "arrived", waiting: { arrivedAt: clock.now.toISOString(), chargedSeconds: 0 } });
  await advance(waitSeconds);
  res = await step(tripId, "board", ++v);
  expect(res.json().status).toBe("rider_onboard");
  return { version: ++v, boarded: res.json() };
}

/** A trip driven from the pickup to the drop-off with fixes every 30 s, completed. */
async function drivenTrip() {
  const { tripId, version } = await accepted();
  const { version: v } = await toBoard(tripId, version, 60);
  const started = (await step(tripId, "start", v)).json();
  for (let i = 1; i <= 8; i++) {
    clock.now = new Date(clock.now.getTime() + 30_000);
    await moveTo("A", { lat: NORRMALM.lat + ((SODERMALM.lat - NORRMALM.lat) * i) / 8, lng: NORRMALM.lng + ((SODERMALM.lng - NORRMALM.lng) * i) / 8 });
  }
  const current = (await call(app, "GET", `/trips/${tripId}`, drivers.A.headers)).json();
  const done = await step(tripId, "complete", current.version ?? started.version, { cashCollected: { amountMinor: 10000, currency: "SEK" } });
  expect(done.json()).toMatchObject({ status: "completed" });
  return tripId;
}

describe("GET /trips/{tripId}/path (contract v0.17.0 §25)", () => {
  it("an ended trip: the driven path from the trip's trace, for its driver and its rider", async () => {
    const tripId = await drivenTrip();
    const res = await call(app, "GET", `/trips/${tripId}/path`, drivers.A.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ tripId, source: "driven", pickup: { lat: NORRMALM.lat, lng: NORRMALM.lng }, dropoff: { lat: SODERMALM.lat, lng: SODERMALM.lng }, stops: [] });
    expect(body.points.length).toBeGreaterThanOrEqual(8);
    expect(body.points.at(-1)).toEqual({ lat: SODERMALM.lat, lng: SODERMALM.lng });
    expect(Date.parse(body.keptUntil)).toBeGreaterThan(clock.now.getTime() + 29 * 24 * 3600_000);
    // The trip's rider sees the same line; another driver does not see the trip at all.
    expect((await call(app, "GET", `/trips/${tripId}/path`, rider)).json().points).toEqual(body.points);
    expect((await call(app, "GET", `/trips/${tripId}/path`, drivers.B.headers)).statusCode).toBe(404);
  });

  it("an older trip whose trace was deleted: the planned road route through pickup and drop-off", async () => {
    const tripId = await drivenTrip();
    await database.db.deleteFrom("trip_locations").where("trip_id", "=", tripId).execute();
    const body = (await call(app, "GET", `/trips/${tripId}/path`, drivers.A.headers)).json();
    expect(body.source).toBe("planned");
    expect(body).not.toHaveProperty("keptUntil");
    expect(body.points[0]).toEqual({ lat: NORRMALM.lat, lng: NORRMALM.lng });
    expect(body.points.at(-1)).toEqual({ lat: SODERMALM.lat, lng: SODERMALM.lng });
  });

  it("a trip that has not ended is refused", async () => {
    const { tripId } = await accepted();
    const res = await call(app, "GET", `/trips/${tripId}/path`, drivers.A.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "invalid_transition", reason: "trip_not_ended" });
  });
});

describe("path thinning", () => {
  const at = (i: number, lat: number) => ({ lat, lng: 18, measured_at: new Date(Date.UTC(2026, 9, 29, 12, 0, i * 10)) });
  it("drops parked jitter and wild jumps", () => {
    const fixes = [at(0, 59.3), at(1, 59.30001), at(2, 59.301), at(3, 60.5), at(4, 59.302)];
    expect(cleanTrace(fixes).map((f) => f.lat)).toEqual([59.3, 59.301, 59.302]);
    expect(cleanTrace([])).toEqual([]);
  });
  it("caps the line at maxPoints, keeping the ends", () => {
    const many = Array.from({ length: 1000 }, (_, i) => i);
    const out = thin(many);
    expect(out).toHaveLength(300);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(999);
    expect(thin([1, 2, 3])).toEqual([1, 2, 3]);
  });
});
