import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { etaHandler, TRIP_ETA } from "../../src/trips/eta.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, fixedRouter, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Driver group 5 (contract v0.18.7 §33, contract.json#pickupWaiting; Rules decisions/driver-g5.md, driver-g6.md):
 * debt only in the same currency (Q3), prices from the server (served config + TripProjection.terms), cancel after
 * the driver arrived counts as a no-show (Q2, admin switch), fee amounts shown (Q6), the rider for the driver (Q1),
 * the total incl. waiting (Q5), one road-route ETA every 30 s (Q4), the pickup move limit (status item 4) and the
 * admin live rows. Sweden (Z001, SEK) and France (FR-PC, EUR).
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-10-31T12:00:00Z") };
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
/** The sample document moved to Paris: every SEK amount becomes EUR (the numbers do not matter, the currency does). */
const inParis = (doc: unknown) => JSON.parse(JSON.stringify(doc).replace(/"SEK"/g, '"EUR"').replace(/"Z001"/g, '"FR-PC"').replace(/"SE"/g, '"FR"').replace(/Europe\/Stockholm/g, "Europe/Paris"));

const PARIS = { address: "Châtelet", lat: 48.8584, lng: 2.3472 };
const PARIS_DROP = { address: "Gare de Lyon", lat: 48.8443, lng: 2.3744 };
const SPOTS = { A: { lat: 59.3335, lng: 18.0655 }, B: { lat: 59.336, lng: 18.07 } };
const drivers: Record<"A" | "B", { id: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;
let riderId: string;

type Doc = Record<string, unknown>;
async function publish(doc: "rider_app_config" | "driver_app_config" | "pricing", zoneId: string, document: Doc) {
  const current = await database.db.selectFrom("config_live").select("version").where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  const version = (current?.version ?? 0) + 1;
  await database.db.deleteFrom("config_live").where("doc", "=", doc).where("zone_id", "=", zoneId).execute();
  await database.db.insertInto("config_live").values({ doc, zone_id: zoneId, version, document: JSON.stringify({ ...document, version }), published_at: clock.now, published_by: null }).execute();
  await database.db.insertInto("config_history").values({ doc, zone_id: zoneId, version, document: JSON.stringify({ ...document, version }), published_at: clock.now, published_by: null, approved_by: null, note: null }).onConflict((c) => c.doNothing()).execute();
}
const driverDoc = (): Doc => sample("driver_app_config");
const riderDoc = (): Doc => sample("rider_app_config");

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null }).execute();
  await publish("rider_app_config", "Z001", riderDoc());
  await publish("driver_app_config", "Z001", driverDoc());
  // The ETA tick routes with the server's router (main.ts); here the test world's fixed 8 km / 18 min route.
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers, [TRIP_ETA]: etaHandler(fixedRouter) }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const phones = { A: TEST_PHONES[1]!, B: TEST_PHONES[2]! };
  for (const key of ["A", "B"] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `PW00${key}`, categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
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
  clock.now = new Date(clock.now.getTime() + 1000);
  const res = await call(app, "POST", "/driver/location", drivers[key].headers, fix(at));
  expect(res.statusCode).toBe(200);
}

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.deleteFrom("rider_fees").execute();
  await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_currency: null, outstanding_source_trip_id: null }).execute();
  // Back to the defaults between tests (a test may publish other settings).
  await publish("driver_app_config", "Z001", driverDoc());
  const signedIn = await signIn(app, TEST_PHONES[0]!, "rider");
  rider = signedIn.headers;
  riderId = (await call(app, "GET", "/rider/profile", rider)).json().riderId;
  for (const key of ["A", "B"] as const) {
    drivers[key].headers = (await signIn(app, { A: TEST_PHONES[1], B: TEST_PHONES[2] }[key]!, "driver")).headers;
    await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now, rating_sum: 0, rating_count: 0 }).where("driver_id", "=", drivers[key].id).execute();
    await moveTo(key, SPOTS[key]);
  }
});

async function book(pickup = NORRMALM, dropoff = SODERMALM) {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup, dropoff, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup, dropoff, stops: [], kind: "live", paymentMethod: "cash" });
  expect(res.statusCode).toBe(201);
  await worker.runDue();
  return { tripId: res.json().tripId as string, quote, version: res.json().version as number };
}

/** The rider books, driver A (nearest) takes the trip. */
async function accepted() {
  const booked = await book();
  const [offer] = (await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items;
  expect(offer?.tripId).toBe(booked.tripId);
  const res = await call(app, "POST", `/offers/${offer.offerId}/accept`, drivers.A.headers, { expectedVersion: offer.version });
  expect(res.statusCode).toBe(200);
  return { tripId: booked.tripId, quote: booked.quote, version: res.json().version as number };
}
const step = (tripId: string, path: string, version: number, body: Record<string, unknown> = {}) => call(app, "POST", `/trips/${tripId}/${path}`, drivers.A.headers, { expectedVersion: version, ...body });
const riderView = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}`, rider)).json();
const driverView = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}`, drivers.A.headers)).json();
const events = async (tripId: string, who = rider) => (await call(app, "GET", `/trips/${tripId}/events?after=0`, { ...who, accept: "application/json" })).json().items as Array<Record<string, unknown>>;

/** Driver A arrives at the pickup (the trip is accepted). */
async function arrived(tripId: string, version: number) {
  let v = version;
  expect((await step(tripId, "head-to-pickup", v)).json().status).toBe("driver_to_pickup");
  await moveTo("A", NORRMALM);
  const res = await step(tripId, "arrive", ++v);
  expect(res.json().status).toBe("arrived");
  return res.json().version as number;
}

describe("Q3: an owed fee is charged only in its own currency (contract.json#pickupWaiting.debtByCurrency)", () => {
  beforeAll(async () => {
    await publish("pricing", "FR-PC", inParis(sample("pricing_document")));
    await publish("rider_app_config", "FR-PC", inParis(riderDoc()));
    await publish("driver_app_config", "FR-PC", inParis(driverDoc()));
  });

  it("100 kr owed from Stockholm: the Paris quote carries nothing, the Stockholm quote carries 100 kr; the profile shows SEK", async () => {
    // The debt: a Swedish trip the rider cancelled late (the fee row is what the server reads).
    const { tripId, version } = await accepted();
    await advance(180);
    const cancelled = await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: version, reasonCode: "plans_changed" });
    expect(cancelled.json().cancellation.fee).toEqual({ amountMinor: 3500, currency: "SEK" });
    await database.db.updateTable("rider_fees").set({ amount_minor: 10000 }).where("trip_id", "=", tripId).execute();
    await database.db.updateTable("riders").set({ outstanding_minor: 10000 }).where("rider_id", "=", riderId).execute();

    const profile = (await call(app, "GET", "/rider/profile", rider)).json();
    expect(profile.outstanding).toEqual({ amountMinor: 10000, currency: "SEK" });
    expect(profile.outstandingByCurrency).toEqual([{ amountMinor: 10000, currency: "SEK" }]);

    const paris = (await call(app, "POST", "/quotes", rider, { pickup: PARIS, dropoff: PARIS_DROP, stops: [], categoryIds: ["economy"] })).json();
    expect(paris.zoneId).toBe("FR-PC");
    expect(paris.quotes[0].total.currency).toBe("EUR");
    expect(paris.quotes[0].fareLines.map((l: { code: string }) => l.code)).not.toContain("outstanding_fee");

    const stockholm = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json();
    expect(stockholm.quotes[0].fareLines).toEqual(expect.arrayContaining([{ code: "outstanding_fee", amount: { amountMinor: 10000, currency: "SEK" }, sourceTripId: tripId }]));
  });

  it("two currencies owed: each quote carries only its own; the profile lists both, oldest first", async () => {
    const { tripId, version } = await accepted();
    await advance(180);
    expect((await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: version, reasonCode: "plans_changed" })).json().cancellation.fee).toMatchObject({ currency: "SEK" });
    // A French debt (a fee row of a Paris trip the rider owes), younger than the Swedish one.
    const parisQuote = (await call(app, "POST", "/quotes", rider, { pickup: PARIS, dropoff: PARIS_DROP, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    const parisTrip = (await call(app, "POST", "/trips", rider, { quoteId: parisQuote.quoteId, categoryId: "economy", pickup: PARIS, dropoff: PARIS_DROP, stops: [], kind: "live", paymentMethod: "cash" })).json();
    await database.db.updateTable("trips").set({ status: "cancelled_by_rider" }).where("trip_id", "=", parisTrip.tripId).execute();
    clock.now = new Date(clock.now.getTime() + 1000);
    await database.db.insertInto("rider_fees").values({ trip_id: parisTrip.tripId, rider_id: riderId, kind: "cancel", currency: "EUR", amount_minor: 500, status: "owed", created_at: clock.now }).execute();

    const profile = (await call(app, "GET", "/rider/profile", rider)).json();
    expect(profile.outstanding).toEqual({ amountMinor: 3500, currency: "SEK" });
    expect(profile.outstandingByCurrency).toEqual([{ amountMinor: 3500, currency: "SEK" }, { amountMinor: 500, currency: "EUR" }]);
    const paris = (await call(app, "POST", "/quotes", rider, { pickup: PARIS, dropoff: PARIS_DROP, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    expect(paris.fareLines).toEqual(expect.arrayContaining([{ code: "outstanding_fee", amount: { amountMinor: 500, currency: "EUR" }, sourceTripId: parisTrip.tripId }]));
    const stockholm = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    expect(stockholm.fareLines).toEqual(expect.arrayContaining([{ code: "outstanding_fee", amount: { amountMinor: 3500, currency: "SEK" }, sourceTripId: tripId }]));
  });

  it("a paid Swedish cash trip settles only Swedish fees; the euro debt stays", async () => {
    const { tripId, version } = await accepted();
    await advance(180);
    const cancelled = await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: version, reasonCode: "plans_changed" });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    // A euro debt from a Paris trip.
    const parisQuote = (await call(app, "POST", "/quotes", rider, { pickup: PARIS, dropoff: PARIS_DROP, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    const frTrip = (await call(app, "POST", "/trips", rider, { quoteId: parisQuote.quoteId, categoryId: "economy", pickup: PARIS, dropoff: PARIS_DROP, stops: [], kind: "live", paymentMethod: "cash" })).json().tripId as string;
    await database.db.updateTable("trips").set({ status: "cancelled_by_rider" }).where("trip_id", "=", frTrip).execute();
    await database.db.deleteFrom("timers").execute();
    clock.now = new Date(clock.now.getTime() + 1000);
    await database.db.insertInto("rider_fees").values({ trip_id: frTrip, rider_id: riderId, kind: "cancel", currency: "EUR", amount_minor: 500, status: "owed", created_at: clock.now }).execute();
    // The next Swedish ride carries the 35 kr and is paid in full in cash.
    // Three minutes passed: the drivers send fresh positions (a fix older than 2 minutes counts as gone).
    for (const key of ["A", "B"] as const) await moveTo(key, SPOTS[key]);
    const next = await accepted();
    expect(next.quote.fareLines).toEqual(expect.arrayContaining([{ code: "outstanding_fee", amount: { amountMinor: 3500, currency: "SEK" }, sourceTripId: tripId }]));
    let v = await arrived(next.tripId, next.version);
    v = (await step(next.tripId, "board", v)).json().version;
    v = (await step(next.tripId, "start", v)).json().version;
    await moveTo("A", SODERMALM);
    const done = await step(next.tripId, "complete", v, { cashCollected: { amountMinor: next.quote.total.amountMinor, currency: "SEK" } });
    expect(done.json().status).toBe("completed");
    const fees = await database.db.selectFrom("rider_fees").select(["currency", "status"]).where("rider_id", "=", riderId).orderBy("created_at").execute();
    expect(fees).toEqual([{ currency: "SEK", status: "paid" }, { currency: "EUR", status: "owed" }]);
    expect((await call(app, "GET", "/rider/profile", rider)).json().outstanding).toEqual({ amountMinor: 500, currency: "EUR" });
  });
});

describe("prices from the server: served config and TripProjection.terms (contract.json#pickupWaiting.servedConfig, .terms)", () => {
  it("GET /driver/config and /rider/config carry the zone's LIVE pricing waiting terms, whatever the app document says", async () => {
    const stale = driverDoc();
    (stale["waiting"] as Doc)["perMin"] = { amountMinor: 500, currency: "SEK" };
    (stale["waiting"] as Doc)["noShowFee"] = { amountMinor: 5000, currency: "SEK" };
    await publish("driver_app_config", "Z001", stale);
    const driverCfg = (await call(app, "GET", "/driver/config?zoneId=Z001", drivers.A.headers)).json();
    expect(driverCfg.waiting).toMatchObject({ freeWaitMin: 5, perMin: { amountMinor: 1226, currency: "SEK" }, noShowAfterMin: 5, noShowFee: { amountMinor: 6500, currency: "SEK" }, cancelAfterArrivedIsNoShow: true });
    expect(driverCfg.waiting.byCategory.economy).toMatchObject({ perMin: { amountMinor: 1226, currency: "SEK" } });
    const riderCfg = (await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json();
    expect(riderCfg.waiting).toMatchObject({ perMin: { amountMinor: 1226, currency: "SEK" }, noShowFee: { amountMinor: 6500, currency: "SEK" }, cancelAfterArrivedIsNoShow: true });
    expect(riderCfg.booking.maxPickupMoveMeters).toBe(200);
  });

  it("the rider config copies the zone's cancel-after-arrival switch from the driver document", async () => {
    const doc = driverDoc();
    (doc["waiting"] as Doc)["cancelAfterArrivedIsNoShow"] = false;
    await publish("driver_app_config", "Z001", doc);
    expect((await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json().waiting.cancelAfterArrivedIsNoShow).toBe(false);
  });

  it("a driver in Paris gets French waiting terms in euro (zone-based, not hard-coded)", async () => {
    const paris = (await call(app, "GET", "/driver/config?zoneId=FR-PC", drivers.A.headers)).json();
    expect(paris.currency).toBe("EUR");
    expect(paris.waiting.perMin.currency).toBe("EUR");
    expect(paris.waiting.noShowFee.currency).toBe("EUR");
    expect(paris.waiting.byCategory.economy.perMin.currency).toBe("EUR");
  });

  it("every trip carries terms (the booking snapshot) in both views, and the driver app never needs its own numbers", async () => {
    const { tripId } = await accepted();
    const terms = {
      currency: "SEK",
      freeWaitMin: 5,
      waitPerMin: { amountMinor: 1226, currency: "SEK" },
      noShowAfterMin: 5,
      noShowFee: { amountMinor: 6500, currency: "SEK" },
      noShowDriverSharePct: 80,
      cancelRule: { freeMin: 2, type: "fixed", value: 3500, min: null, max: null },
      cancelDriverSharePct: 100,
      cancelAfterArrivedIsNoShow: true,
      maxPickupMoveMeters: 200,
      // v0.18.8 (G6, additive): the applied waiting rules (none before arrive) and the free minutes at each stop.
      waitingRules: [],
      stopFreeWaitMin: 0,
      // v0.18.9 (G7, additive): the price per minute at a middle stop.
      stopWaitPerMin: { amountMinor: 500, currency: "SEK" },
    };
    expect((await driverView(tripId)).terms).toEqual(terms);
    // Contract §2: the rider never sees the driver's shares.
    const { noShowDriverSharePct: _n, cancelDriverSharePct: _c, ...riderTerms } = terms;
    void _n;
    void _c;
    expect((await riderView(tripId)).terms).toEqual(riderTerms);
  });
});

describe("Q2: cancel after the driver arrived counts as a no-show (admin switch, default on)", () => {
  it("the free waiting over (5 min after arrival), driver at the pickup: the no-show fee (65 kr), 80 % to the driver, feeKind no_show", async () => {
    const { tripId, version } = await accepted();
    const v = await arrived(tripId, version);
    await advance(301);
    const res = await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: v, reasonCode: "plans_changed" });
    expect(res.json()).toMatchObject({ status: "cancelled_by_rider", fare: { amountMinor: 6500 }, cancellation: { fee: { amountMinor: 6500, currency: "SEK" }, feeKind: "no_show", feeStatus: "owed" } });
    // The rider never sees the driver's part (contract §2); the driver does.
    expect(res.json().cancellation).not.toHaveProperty("driverShare");
    expect((await driverView(tripId)).cancellation).toMatchObject({ driverShare: { amountMinor: 5200, currency: "SEK" } });
    expect(await database.db.selectFrom("rider_fees").select(["kind", "amount_minor"]).where("trip_id", "=", tripId).executeTakeFirst()).toEqual({ kind: "no_show", amount_minor: "6500" });
    expect(await database.db.selectFrom("earnings_entries").select(["kind", "amount_minor"]).where("trip_id", "=", tripId).execute()).toEqual([{ kind: "fee_share", amount_minor: "5200" }]);
    // The driver's stream event carries the fee too (island "Rider cancelled · You get 52 kr").
    const last = (await events(tripId, drivers.A.headers)).at(-1)!;
    expect(last["kind"]).toBe("trip_projection");
    expect((last["projection"] as Doc)["cancellation"]).toMatchObject({ fee: { amountMinor: 6500 }, driverShare: { amountMinor: 5200 } });
  });

  it("after the free cancel minutes but seconds after arrival (free waiting not over): the normal cancel fee, not a no-show (checker M1)", async () => {
    const { tripId, version } = await accepted();
    await advance(150);
    const v = await arrived(tripId, version);
    await advance(5);
    const res = await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: v, reasonCode: "plans_changed" });
    expect(res.json().cancellation).toMatchObject({ fee: { amountMinor: 3500, currency: "SEK" }, feeKind: "cancel" });
    expect(await database.db.selectFrom("rider_fees").select("kind").where("trip_id", "=", tripId).executeTakeFirst()).toEqual({ kind: "cancel" });
  });

  it("a reservation: the driver arrived early, the rider cancels before the booked time → the reservation late-cancel fee, not a no-show", async () => {
    const at = new Date(clock.now.getTime() + 3 * 3600_000);
    const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"], kind: "scheduled", scheduledAt: at.toISOString() })).json().quotes[0];
    const booked = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "scheduled", scheduledAt: at.toISOString(), paymentMethod: "cash" })).json();
    expect(booked.status).toBe("requested");
    // The driver claimed it and is at the pickup 10 minutes early (the waiting clock runs from the booked time; the
    // booked time is moved to 10 minutes from now so the test token stays valid).
    const soon = new Date(clock.now.getTime() + 10 * 60_000);
    const freeUntil = new Date(soon.getTime() + 5 * 60_000).toISOString();
    await database.db.updateTable("trips").set({
      // v0.18.49 §71 (owner Q10 update): booked an hour ago, like the accept, so the 5-min booking grace is long over.
      created_at: new Date(clock.now.getTime() - 3600_000),
      scheduled_at: soon, status: "arrived", driver_id: drivers.A.id, accepted_at: new Date(clock.now.getTime() - 3600_000), arrived_at: clock.now, version: booked.version + 1,
      waiting: JSON.stringify({ arrivedAt: clock.now.toISOString(), freeUntil, noShowAt: freeUntil, chargedSeconds: 0 }),
    }).where("trip_id", "=", booked.tripId).execute();
    const res = await call(app, "POST", `/trips/${booked.tripId}/cancel`, rider, { expectedVersion: booked.version + 1, reasonCode: "plans_changed" });
    expect(res.statusCode, res.body).toBe(200);
    // RiderAppConfig.cancelFees.reservation.economy: 50 kr inside 60 minutes before pickup.
    expect(res.json().cancellation).toMatchObject({ fee: { amountMinor: 5000, currency: "SEK" }, feeKind: "cancel" });
  });

  it("inside the free minutes the rider always cancels free, even with the driver at the pickup", async () => {
    const { tripId, version } = await accepted();
    const v = await arrived(tripId, version);
    // Arrival took 2 s; still inside the 2 free minutes after accept.
    const res = await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: v, reasonCode: "plans_changed" });
    expect(res.json().cancellation).toMatchObject({ fee: null });
    expect(res.json().cancellation).not.toHaveProperty("feeKind");
    expect(await database.db.selectFrom("rider_fees").selectAll().where("trip_id", "=", tripId).executeTakeFirst()).toBeUndefined();
  });

  it("switch off in the zone: the normal cancel fee (35 kr) with the cancel share", async () => {
    const doc = driverDoc();
    (doc["waiting"] as Doc)["cancelAfterArrivedIsNoShow"] = false;
    await publish("driver_app_config", "Z001", doc);
    const { tripId, version } = await accepted();
    const v = await arrived(tripId, version);
    await advance(301);
    const res = await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: v, reasonCode: "plans_changed" });
    expect(res.json().cancellation).toMatchObject({ fee: { amountMinor: 3500, currency: "SEK" }, feeKind: "cancel" });
    expect((await driverView(tripId)).cancellation).toMatchObject({ driverShare: { amountMinor: 3500, currency: "SEK" } });
    expect(await database.db.selectFrom("rider_fees").select("kind").where("trip_id", "=", tripId).executeTakeFirst()).toEqual({ kind: "cancel" });
  });

  it("on the way (not arrived) the switch changes nothing: the cancel fee with the came-closer check", async () => {
    const { tripId, version } = await accepted();
    let v = version;
    v = (await step(tripId, "head-to-pickup", v)).json().version;
    await advance(180);
    await moveTo("A", NORRMALM);
    const res = await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: v, reasonCode: "plans_changed" });
    expect(res.json().cancellation).toMatchObject({ fee: { amountMinor: 3500, currency: "SEK" }, feeKind: "cancel" });
  });
});

describe("Q6 / Q5: the amounts the apps show while waiting", () => {
  it("arrive puts the no-show fee and the driver's part on the trip; the no-show carries driverShare", async () => {
    const { tripId, version } = await accepted();
    const v = await arrived(tripId, version);
    const view = await driverView(tripId);
    expect(view.waiting).toMatchObject({ chargedSeconds: 0, noShowFee: { amountMinor: 6500, currency: "SEK" }, noShowDriverShare: { amountMinor: 5200, currency: "SEK" } });
    expect((await riderView(tripId)).waiting).toMatchObject({ noShowFee: { amountMinor: 6500, currency: "SEK" } });
    expect((await riderView(tripId)).waiting).not.toHaveProperty("noShowDriverShare");
    expect((await events(tripId)).at(-1)!["projection"]).not.toHaveProperty("rider");
    expect(((await events(tripId)).at(-1)!["projection"] as Doc)["waiting"]).not.toHaveProperty("noShowDriverShare");
    await advance(5 * 60 + 1);
    const noShow = await call(app, "POST", `/trips/${tripId}/no-show`, drivers.A.headers, { expectedVersion: v });
    expect(noShow.json().cancellation).toMatchObject({ fee: { amountMinor: 6500, currency: "SEK" }, feeKind: "no_show", driverShare: { amountMinor: 5200, currency: "SEK" } });
  });

  it("while the driver waits past the free minutes a read shows the seconds and cost so far; from boarding the fare holds the waiting", async () => {
    const { tripId, version } = await accepted();
    const v = await arrived(tripId, version);
    await advance(7 * 60);
    const waiting = (await riderView(tripId)).waiting;
    expect(waiting.chargedSecondsNow).toBe(120);
    expect(waiting.chargedSoFar).toEqual({ amountMinor: 2452, currency: "SEK" });
    const boarded = (await step(tripId, "board", v)).json();
    expect(boarded.waiting.chargedSeconds).toBe(120);
    expect(boarded.waiting).not.toHaveProperty("chargedSecondsNow");
    expect(boarded.fareLines).toEqual(expect.arrayContaining([{ code: "waiting", amount: { amountMinor: 2452, currency: "SEK" } }]));
    const started = (await step(tripId, "start", boarded.version)).json();
    // The rider's total from Start trip = the booked price + the waiting (what the driver asks for).
    expect(started.fare.amountMinor).toBe(boarded.fare.amountMinor);
    expect((await riderView(tripId)).fare).toEqual(started.fare);
  });
});

describe("Q1: the rider's first name (and rating when the zone shows it) for the driver", () => {
  it("the driver and the admin see rider { firstName }, the rider does not; no rating without ratings", async () => {
    const { tripId } = await accepted();
    // A rider who never typed a name is "Rider" to the driver.
    const firstName = ((await call(app, "GET", "/rider/profile", rider)).json().firstName as string) || "Rider";
    const view = await driverView(tripId);
    expect(view.rider).toEqual({ firstName });
    expect(await riderView(tripId)).not.toHaveProperty("rider");
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    expect((await call(app, "GET", `/admin/trips/${tripId}`, admin.headers)).json().rider).toEqual({ firstName });
    // The driver's stream events carry it; the rider's do not.
    expect(((await events(tripId, drivers.A.headers)).at(-1)!["projection"] as Doc)["rider"]).toEqual({ firstName });
    expect((await events(tripId)).at(-1)!["projection"]).not.toHaveProperty("rider");
  });

  it("the rating rides along when the rider has one and the zone's offer-card switch is on; not when it is off", async () => {
    await database.db.updateTable("riders").set({ rating_sum: 9, rating_count: 2 }).where("rider_id", "=", riderId).execute();
    const first = await accepted();
    expect((await driverView(first.tripId)).rider).toMatchObject({ rating: 4.5 });
    await call(app, "POST", `/trips/${first.tripId}/cancel`, rider, { expectedVersion: first.version, reasonCode: "plans_changed" });
    const doc = driverDoc();
    ((doc["offers"] as Doc)["offerCard"] as Doc)["riderRating"] = false;
    await publish("driver_app_config", "Z001", doc);
    const second = await accepted();
    expect((await driverView(second.tripId)).rider).not.toHaveProperty("rating");
    await database.db.updateTable("riders").set({ rating_sum: 0, rating_count: 0 }).where("rider_id", "=", riderId).execute();
  });
});

describe("Q4 / status item 2: one road-route ETA every 30 s for both apps (contract.json#pickupWaiting.eta)", () => {
  it("from accept the server ticks: a location event with eta, the same on every read, to the drop-off once on board, gone at the pickup", async () => {
    const { tripId, version } = await accepted();
    expect(await database.db.selectFrom("timers").select("kind").where("kind", "=", TRIP_ETA).where("ref_id", "=", tripId).executeTakeFirst()).toEqual({ kind: TRIP_ETA });
    await worker.runDue();
    const first = (await events(tripId)).filter((e) => e["kind"] === "location" && e["eta"]);
    expect(first).toHaveLength(1);
    // The test router answers 8 km / 18 min for every route.
    expect(first[0]!["eta"]).toEqual({ etaSeconds: 1080, distanceMeters: 8000, target: "pickup", at: clock.now.toISOString(), source: "osrm" });
    expect(first[0]!["etaSeconds"]).toBe(1080);
    const riderSees = await riderView(tripId);
    const driverSees = await driverView(tripId);
    expect(riderSees.eta).toEqual(first[0]!["eta"]);
    expect(driverSees.eta).toEqual(first[0]!["eta"]);
    expect(riderSees.etaSeconds).toBe(1080);
    // Not before 30 s; then again.
    await advance(29);
    expect((await events(tripId)).filter((e) => e["kind"] === "location" && e["eta"])).toHaveLength(1);
    await advance(1);
    expect((await events(tripId)).filter((e) => e["kind"] === "location" && e["eta"])).toHaveLength(2);
    let v = (await step(tripId, "head-to-pickup", version)).json().version;
    await moveTo("A", NORRMALM);
    v = (await step(tripId, "arrive", v)).json().version;
    await advance(30);
    expect(await riderView(tripId)).not.toHaveProperty("eta");
    expect(await riderView(tripId)).not.toHaveProperty("etaSeconds");
    v = (await step(tripId, "board", v)).json().version;
    await advance(30);
    const onBoard = await riderView(tripId);
    expect(onBoard.eta).toMatchObject({ target: "dropoff", source: "osrm" });
    v = (await step(tripId, "start", v)).json().version;
    await moveTo("A", SODERMALM);
    await step(tripId, "complete", v, { cashCollected: { amountMinor: onBoard.fare.amountMinor, currency: "SEK" } });
    await advance(30);
    expect(await riderView(tripId)).not.toHaveProperty("eta");
    expect(await database.db.selectFrom("timers").select("kind").where("kind", "=", TRIP_ETA).where("ref_id", "=", tripId).executeTakeFirst()).toBeUndefined();
  });

  it("no driver position for more than 2 minutes: the previous ETA is kept as source stale, nothing new is routed (checker L5)", async () => {
    const { tripId } = await accepted();
    await worker.runDue();
    expect((await riderView(tripId)).eta).toMatchObject({ source: "osrm" });
    await advance(150);
    const stale = (await riderView(tripId)).eta;
    expect(stale).toMatchObject({ etaSeconds: 1080, distanceMeters: 8000, target: "pickup", source: "stale", at: clock.now.toISOString() });
    const last = (await events(tripId)).filter((e) => e["kind"] === "location").at(-1)!;
    expect(last["eta"]).toMatchObject({ source: "stale", etaSeconds: 1080 });
    // A fresh position: routed again.
    await moveTo("A", SPOTS.A);
    await advance(30);
    expect((await riderView(tripId)).eta).toMatchObject({ source: "osrm" });
  });

  it("the admin's live trip rows carry the driver's position and the ETA", async () => {
    const { tripId } = await accepted();
    await worker.runDue();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const rows = (await call(app, "GET", "/admin/trips?status=accepted", admin.headers)).json().items as Doc[];
    const row = rows.find((r) => r["tripId"] === tripId)!;
    expect(row["eta"]).toMatchObject({ target: "pickup", etaSeconds: 1080, distanceMeters: 8000 });
    expect(row["driverLocation"]).toMatchObject({ lat: SPOTS.A.lat, lng: SPOTS.A.lng });
    expect((await call(app, "GET", `/admin/trips/${tripId}`, admin.headers)).json()).toMatchObject({ eta: { target: "pickup" }, driverLocation: { lat: SPOTS.A.lat } });
  });
});

describe("status item 4: the pickup move limit is an admin setting the server checks (PATCH /trips/{tripId})", () => {
  // About 150 m and 250 m north of Sergels torg.
  const NEAR = { address: "Near Sergels torg", lat: NORRMALM.lat + 0.00135, lng: NORRMALM.lng };
  const FAR = { address: "Farther up", lat: NORRMALM.lat + 0.00225, lng: NORRMALM.lng };
  const FARTHER = { address: "Kungsträdgården", lat: NORRMALM.lat + 0.004, lng: NORRMALM.lng };

  it("within 200 m: the pickup moves, version + 1, one pickup_moved event for the driver; the fare stays", async () => {
    const { tripId, version } = await accepted();
    const before = await riderView(tripId);
    const res = await call(app, "PATCH", `/trips/${tripId}`, rider, { expectedVersion: version, pickup: NEAR });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: version + 1, status: "accepted", pickup: NEAR, fare: before.fare });
    const last = (await events(tripId, drivers.A.headers)).at(-1)!;
    expect(last).toMatchObject({ kind: "pickup_moved", version: version + 1 });
    expect((last["projection"] as Doc)["pickup"]).toEqual(NEAR);
    expect((await driverView(tripId)).pickup).toEqual(NEAR);
    // A second move is measured from the BOOKED pickup, not from the last move.
    const again = await call(app, "PATCH", `/trips/${tripId}`, rider, { expectedVersion: version + 1, pickup: FAR });
    expect(again.json()).toMatchObject({ code: "invalid_request", reason: "pickup_move_too_far", details: ["maxMeters=200", expect.stringMatching(/^meters=2[45]\d$/)] });
  });

  it("over the limit: 400 pickup_move_too_far with the limit; a bigger admin limit lets it through", async () => {
    // While searching (the dispatch round made offers: the version moved on).
    const { tripId } = await book();
    const version = (await riderView(tripId)).version as number;
    expect((await call(app, "PATCH", `/trips/${tripId}`, rider, { expectedVersion: version, pickup: FAR })).json()).toMatchObject({ reason: "pickup_move_too_far", details: ["maxMeters=200", expect.stringMatching(/^meters=2[45]\d$/)] });
    expect((await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: version, reasonCode: "plans_changed" })).statusCode).toBe(200);
    const doc = driverDoc();
    (doc["booking"] as Doc)["maxPickupMoveMeters"] = 500;
    await publish("driver_app_config", "Z001", doc);
    const wide = await book();
    const wideView = await riderView(wide.tripId);
    expect(wideView.terms.maxPickupMoveMeters).toBe(500);
    const moved = await call(app, "PATCH", `/trips/${wide.tripId}`, rider, { expectedVersion: wideView.version, pickup: FARTHER });
    expect(moved.statusCode, moved.body).toBe(200);
  });

  it("after the driver arrived: 409 pickup_fixed_after_arrival; a destination change is not available yet", async () => {
    const { tripId, version } = await accepted();
    const v = await arrived(tripId, version);
    expect((await call(app, "PATCH", `/trips/${tripId}`, rider, { expectedVersion: v, pickup: NEAR })).json()).toMatchObject({ code: "invalid_transition", reason: "pickup_fixed_after_arrival" });
    expect((await call(app, "PATCH", `/trips/${tripId}`, rider, { expectedVersion: v, dropoff: SODERMALM })).json()).toMatchObject({ code: "invalid_request", reason: "route_change_not_available" });
    expect((await call(app, "PATCH", `/trips/${tripId}`, rider, { expectedVersion: v })).json()).toMatchObject({ code: "invalid_request", reason: "nothing_to_change" });
  });
});
