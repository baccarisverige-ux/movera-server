import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { eventEnvelope } from "../../src/realtime/events.js";
import { rideHandlers } from "../../src/trips/ride.js";
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
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `REV00${key}`, categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
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
  await database.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
  await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_source_trip_id: null }).execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
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

async function accepted() {
  await database.db.deleteFrom("offers").where("status", "!=", "open").execute();
  await database.db.updateTable("drivers").set({ last_free_at: clock.now, rating_sum: 0, rating_count: 0 }).execute();
  for (const key of ["A", "B"] as const) await moveTo(key, SPOTS[key]);
  const { tripId, quote } = await book();
  const [offer] = (await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items;
  expect(offer?.tripId).toBe(tripId);
  const res = await call(app, "POST", `/offers/${offer.offerId}/accept`, drivers.A.headers, { expectedVersion: offer.version });
  expect(res.statusCode).toBe(200);
  return { tripId, quote, version: res.json().version as number };
}

const step = async (tripId: string, path: string, version: number, body: Record<string, unknown> = {}, who = drivers.A.headers) => call(app, "POST", `/trips/${tripId}/${path}`, who, { expectedVersion: version, ...body });
const riderView = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}`, rider)).json();
const lastEvent = async (tripId: string, kind: string) =>
  database.db.selectFrom("trip_events").selectAll().where("trip_id", "=", tripId).where("kind", "=", kind).orderBy("sequence", "desc").executeTakeFirstOrThrow();

async function completed() {
  const { tripId, version } = await accepted();
  let v = version;
  await step(tripId, "head-to-pickup", v++);
  await step(tripId, "arrive", v++);
  await advance(60);
  await step(tripId, "board", v++);
  await step(tripId, "start", v++);
  const done = await step(tripId, "complete", v);
  expect(done.json().status).toBe("completed");
  return tripId;
}

describe("review: realtime", () => {
  it("R1 each side's event stream carries its own ratingStatus", async () => {
    const tripId = await completed();
    // The driver skips; the rider has not rated yet.
    expect((await call(app, "POST", `/trips/${tripId}/rating`, drivers.A.headers, { skip: true })).statusCode).toBe(204);
    expect((await call(app, "GET", `/trips/${tripId}`, drivers.A.headers)).json().ratingStatus).toBe("skipped");
    const row = await lastEvent(tripId, "rating_updated");
    const asDriver = eventEnvelope(row, "driver", clock.now) as { projection: { ratingStatus: string } };
    expect(asDriver.projection.ratingStatus).toBe("skipped");
    expect((eventEnvelope(row, "rider", clock.now) as { projection: Record<string, unknown> }).projection).not.toHaveProperty("driverRatingStatus");
    // When the rider rates, the driver's stream still says the driver's own "pending".
    await call(app, "POST", `/trips/${tripId}/rating`, rider, { stars: 5 });
    const tripId2 = await completed();
    await call(app, "POST", `/trips/${tripId2}/rating`, rider, { stars: 4 });
    const asDriver2 = eventEnvelope(await lastEvent(tripId2, "rating_updated"), "driver", clock.now) as { projection: { ratingStatus: string } };
    expect(asDriver2.projection.ratingStatus).toBe("pending");
    expect((await call(app, "GET", `/trips/${tripId2}`, drivers.A.headers)).json().ratingStatus).toBe("pending");
  });

  it("R2 a rider cancel with a fee: the terminal trip_projection event shows the fee and the driver's share", async () => {
    const { tripId } = await accepted();
    await advance(150);
    await moveTo("A", NORRMALM);
    const trip = await riderView(tripId);
    const res = await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: trip.version, reasonCode: "plans_changed" });
    expect(res.json()).toMatchObject({ status: "cancelled_by_rider", fare: { amountMinor: 3500 } });
    const ev = await lastEvent(tripId, "trip_projection");
    const toRider = eventEnvelope(ev, "rider", clock.now) as { projection: { status: string; fare: { amountMinor: number }; fareLines: Array<{ code: string }> } };
    const toDriver = eventEnvelope(ev, "driver", clock.now) as { projection: { driverEarnings: { amountMinor: number } } };
    expect(toRider.projection.status).toBe("cancelled_by_rider");
    expect(toRider.projection.fare.amountMinor).toBe(3500);
    expect(toRider.projection.fareLines.map((l) => l.code)).toEqual(["cancel_fee"]);
    expect(toDriver.projection.driverEarnings.amountMinor).toBe(3500);
    expect(trip.fare.amountMinor).toBe(21700);
  });
});

describe("review: money", () => {
  it("R3 a short cash count leaves the carried fee owed", async () => {
    const first = await accepted();
    await step(first.tripId, "head-to-pickup", first.version);
    await step(first.tripId, "arrive", first.version + 1);
    await advance(5 * 60);
    expect((await step(first.tripId, "no-show", first.version + 2)).json().status).toBe("no_show");
    const next = await accepted();
    expect(next.quote.total.amountMinor).toBe(28200);
    let v = next.version;
    await step(next.tripId, "head-to-pickup", v++);
    await step(next.tripId, "arrive", v++);
    await advance(60);
    await step(next.tripId, "board", v++);
    await step(next.tripId, "start", v++);
    // The driver only took the ride's 217 kr, not the 65 kr owed.
    const done = await step(next.tripId, "complete", v, { cashCollected: { amountMinor: 21700, currency: "SEK" } });
    expect(done.json()).toMatchObject({ status: "completed", paymentStatus: "captured", fare: { amountMinor: 28200 } });
    expect((await call(app, "GET", "/rider/profile", rider)).json().outstanding).toEqual({ amountMinor: 6500, currency: "SEK" });
    expect((await riderView(first.tripId)).cancellation.feeStatus).toBe("owed");
  });

  it("R4 arrive is refused 3 km from the pickup", async () => {
    const { tripId, version } = await accepted();
    await step(tripId, "head-to-pickup", version);
    await moveTo("A", { lat: 59.36, lng: 18.0649 }); // ~3 km north of Sergels torg
    const arrive = await step(tripId, "arrive", version + 1, { location: { lat: 59.36, lng: 18.0649, accuracy: 5 } });
    expect(arrive.json()).toMatchObject({ code: "invalid_transition", reason: "not_at_pickup" });
    await moveTo("A", NORRMALM);
    expect((await step(tripId, "arrive", version + 1)).json().status).toBe("arrived");
  });
});

describe("review: what the rider sees", () => {
  it("R5 the driver's free-text cancel note stays with Movera", async () => {
    const { tripId, version } = await accepted();
    let v = version;
    await step(tripId, "head-to-pickup", v++);
    await step(tripId, "arrive", v++);
    await advance(60);
    await step(tripId, "board", v++);
    await step(tripId, "start", v++);
    const res = await call(app, "POST", `/trips/${tripId}/cancel`, drivers.A.headers, { expectedVersion: v, reasonCode: "rider_behavior", note: "Rider was drunk and abusive, reported to support" });
    expect(res.json().status).toBe("cancelled_by_driver");
    expect((await riderView(tripId)).cancellation).not.toHaveProperty("note");
    expect((await database.db.selectFrom("driver_cancels").select("note").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).note).toBe("Rider was drunk and abusive, reported to support");
  });
});
