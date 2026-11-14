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
  // S5 J8 (debtModel.riderWallet): the unpaid fee is a negative wallet balance; the reset clears it too.
  await database.db.updateTable("rider_wallets").set({ balance_minor: 0 }).where("balance_minor", "<", "0").execute();
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
    // S5 J8 (debtModel.readAtPayment): the quote is the ride's 217 kr; the 65 kr is read when it is paid.
    expect(next.quote.total.amountMinor).toBe(21700);
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

describe("the driver's position for the rider (TripProjection.driverLocation, etaSeconds)", () => {
  it("P1 a read of the trip carries the driver's last fix and an ETA to the pickup, then to the drop-off; none without a driver", async () => {
    const { tripId: searching } = await book();
    expect(await riderView(searching)).not.toHaveProperty("driverLocation");
    await call(app, "POST", `/trips/${searching}/cancel`, rider, { expectedVersion: (await riderView(searching)).version, reasonCode: "plans_changed" });

    const { tripId, version } = await accepted();
    const atAccept = await riderView(tripId);
    expect(atAccept.driverLocation).toMatchObject({ lat: SPOTS.A.lat, lng: SPOTS.A.lng, accuracy: 5, measuredAt: clock.now.toISOString() });
    // Driver A stands about a hundred metres from the pickup: the ETA is the one-minute floor.
    expect(atAccept.etaSeconds).toBe(60);
    let v = version;
    await step(tripId, "head-to-pickup", v++);
    await step(tripId, "arrive", v++);
    expect(await riderView(tripId)).toMatchObject({ driverLocation: { lat: SPOTS.A.lat } });
    expect(await riderView(tripId)).not.toHaveProperty("etaSeconds");
    await advance(60);
    await step(tripId, "board", v++);
    // On board the ETA counts to the drop-off, a couple of kilometres away.
    expect((await riderView(tripId)).etaSeconds).toBeGreaterThan(60);
    const asDriver = (await call(app, "GET", `/trips/${tripId}`, drivers.A.headers)).json();
    expect(asDriver.driverLocation).toMatchObject({ lat: SPOTS.A.lat, lng: SPOTS.A.lng });
  });

  it("P2 after the driver ends the trip on board, the rider reads where the car stopped, never where the driver went next", async () => {
    const { tripId, version } = await accepted();
    let v = version;
    await step(tripId, "head-to-pickup", v++);
    await step(tripId, "arrive", v++);
    await advance(60);
    await step(tripId, "board", v++);
    await step(tripId, "start", v++);
    // A kilometre into the trip the driver ends it there.
    const midway = { lat: 59.3245, lng: 18.069 };
    clock.now = new Date(clock.now.getTime() + 60_000);
    await moveTo("A", midway);
    clock.now = new Date(clock.now.getTime() + 1000);
    const ended = await step(tripId, "cancel", v, { reasonCode: "rider_requested_early_end" });
    expect(ended.json().status).toBe("cancelled_by_driver");
    const view = await riderView(tripId);
    expect(view.driverLocation).toMatchObject({ lat: midway.lat, lng: midway.lng });
    expect(view).not.toHaveProperty("etaSeconds");
    // Ten seconds on, the driver has driven away: the ended trip no longer shows the car.
    clock.now = new Date(clock.now.getTime() + 10_000);
    await moveTo("A", SPOTS.B);
    expect(await riderView(tripId)).not.toHaveProperty("driverLocation");
  });
});

describe("raise the offer while searching (contract v0.5.5, owner decision 25)", () => {
  async function declinedByA() {
    await database.db.deleteFrom("offers").where("status", "!=", "open").execute();
    await database.db.updateTable("drivers").set({ last_free_at: clock.now, rating_sum: 0, rating_count: 0 }).execute();
    for (const key of ["A", "B"] as const) await moveTo(key, SPOTS[key]);
    const { tripId } = await book();
    const [offer] = (await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items;
    expect(offer?.tripId).toBe(tripId);
    expect((await call(app, "POST", `/offers/${offer.offerId}/decline`, drivers.A.headers, { expectedVersion: offer.version, reasonCode: "too_far" })).statusCode).toBe(200);
    return { tripId, offer };
  }
  const openOffers = (tripId: string) => database.db.selectFrom("offers").select(["offer_id", "driver_id", "fare_minor", "driver_earnings_minor", "version"]).where("trip_id", "=", tripId).where("status", "=", "open").execute();

  it("B1 the fare grows by the raise, the whole raise goes to the driver, and the driver who declined is asked again at the new price", async () => {
    const { tripId, offer } = await declinedByA();
    const before = await riderView(tripId);
    const raised = await call(app, "POST", `/trips/${tripId}/raise-price`, rider, { expectedVersion: before.version, increase: { amountMinor: 20000, currency: "SEK" } });
    expect(raised.statusCode).toBe(200);
    expect(raised.json()).toMatchObject({ status: "searching", version: before.version + 1, fare: { amountMinor: before.fare.amountMinor + 20000, currency: "SEK" } });
    expect(raised.json().fareLines.at(-1)).toEqual({ code: "rider_raise", amount: { amountMinor: 20000, currency: "SEK" } });
    expect(raised.json()).not.toHaveProperty("driverEarnings");
    // The quote stays what was quoted; the rider's fare says what they offer now.
    expect(raised.json().quote.total.amountMinor).toBe(before.fare.amountMinor);
    // The new search offers the new price; a driver who said no to the old one is asked again (A's refusal
    // lowers A's score, so B may be first now).
    await worker.runDue();
    let open = await openOffers(tripId);
    expect(open).toHaveLength(1);
    if (open[0]!.driver_id !== drivers.A.id) {
      const [b] = (await call(app, "GET", "/driver/offers", drivers.B.headers)).json().items;
      expect(b.fare.amountMinor).toBe(offer.fare.amountMinor + 20000);
      await call(app, "POST", `/offers/${b.offerId}/decline`, drivers.B.headers, { expectedVersion: b.version, reasonCode: "too_far" });
      await worker.runDue();
      open = await openOffers(tripId);
    }
    expect(open).toHaveLength(1);
    expect(open[0]!.driver_id).toBe(drivers.A.id);
    expect(open[0]!.offer_id).not.toBe(offer.offerId);
    const [again] = (await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items;
    expect(again.tripId).toBe(tripId);
    expect(again.fare.amountMinor).toBe(offer.fare.amountMinor + 20000);
    expect(again.driverEarnings.amountMinor).toBe(offer.driverEarnings.amountMinor + 20000);
    // The same key raises once.
    const key = "raise-once-key-000001";
    // The trip is `offered` now (a later version): a raise is allowed there too.
    const current = await riderView(tripId);
    expect(current.status).toBe("offered");
    const first = await call(app, "POST", `/trips/${tripId}/raise-price`, rider, { expectedVersion: current.version, increase: { amountMinor: 1000, currency: "SEK" } }, key);
    const twice = await call(app, "POST", `/trips/${tripId}/raise-price`, rider, { expectedVersion: current.version, increase: { amountMinor: 1000, currency: "SEK" } }, key);
    expect(first.statusCode).toBe(200);
    expect(twice.json()).toEqual(first.json());
    expect((await riderView(tripId)).fare.amountMinor).toBe(before.fare.amountMinor + 21000);
    // The offer at the first raise is gone; the next round carries the second.
    expect(await openOffers(tripId)).toHaveLength(0);
  });

  it("B2 a stale version, another currency, nothing, too much, another rider, or a trip with a driver are refused", async () => {
    const { tripId } = await declinedByA();
    const { version, fare } = await riderView(tripId);
    expect((await call(app, "POST", `/trips/${tripId}/raise-price`, rider, { expectedVersion: version - 1, increase: { amountMinor: 1000, currency: "SEK" } })).json().code).toBe("version_mismatch");
    expect((await call(app, "POST", `/trips/${tripId}/raise-price`, rider, { expectedVersion: version, increase: { amountMinor: 1000, currency: "EUR" } })).json()).toMatchObject({ code: "invalid_request", reason: "currency_mismatch" });
    expect((await call(app, "POST", `/trips/${tripId}/raise-price`, rider, { expectedVersion: version, increase: { amountMinor: 0, currency: "SEK" } })).json()).toMatchObject({ code: "invalid_request" });
    expect((await call(app, "POST", `/trips/${tripId}/raise-price`, rider, { expectedVersion: version, increase: { amountMinor: fare.amountMinor + 100, currency: "SEK" } })).json()).toMatchObject({ code: "invalid_request", reason: "raise_too_high" });
    const other = (await signIn(app, TEST_PHONES[3]!, "rider")).headers;
    expect((await call(app, "POST", `/trips/${tripId}/raise-price`, other, { expectedVersion: version, increase: { amountMinor: 1000, currency: "SEK" } })).statusCode).toBe(404);
    expect((await riderView(tripId)).version).toBe(version);
    // Once a driver has it, the price is settled.
    expect((await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: version, reasonCode: "plans_changed" })).statusCode).toBe(200);
    const { tripId: taken, version: v } = await accepted();
    const late = await call(app, "POST", `/trips/${taken}/raise-price`, rider, { expectedVersion: v, increase: { amountMinor: 1000, currency: "SEK" } });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: "invalid_transition", projection: { status: "accepted" } });
  });
});
