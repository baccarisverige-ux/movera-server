import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { termsMoney } from "../../src/legal/waitingTerms.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { stopWaitSeconds } from "../../src/trips/stops.js";
import { effectiveWaiting, waitingExtrasOf } from "../../src/trips/waitingRules.js";
import { etaHandler, TRIP_ETA } from "../../src/trips/eta.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, fixedRouter, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Driver group 6 "Arrived and waiting" (contract v0.18.8 §34, contract.json#arrivedWaiting; Rules decisions/driver-g6.md):
 * every admin waiting rule enforced by the server (far pickup, airport, event, scheduled ride, overrides, free wait at each
 * stop), rider PIN before Start, admin Reverse no-show, paid minutes, the rules in the Terms and the island alerts.
 * Sweden (Z001, SEK) and France (FR-PC, EUR).
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-01T10:00:00Z") };
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const inParis = (doc: unknown) => JSON.parse(JSON.stringify(doc).replace(/"SEK"/g, '"EUR"').replace(/"Z001"/g, '"FR-PC"').replace(/"SE"/g, '"FR"').replace(/Europe\/Stockholm/g, "Europe/Paris"));
const PARIS = { address: "Châtelet", lat: 48.8584, lng: 2.3472 };
const PARIS_DROP = { address: "Gare de Lyon", lat: 48.8443, lng: 2.3744 };
const SPOT_A = { lat: 59.3335, lng: 18.0655 };

type Doc = Record<string, unknown>;
const driverA = { id: "", headers: {} as Record<string, string> };
let rider: Record<string, string>;

async function publish(doc: "rider_app_config" | "driver_app_config" | "pricing" | "dispatch", zoneId: string, document: Doc) {
  const current = await database.db.selectFrom("config_live").select("version").where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  const version = (current?.version ?? 0) + 1;
  await database.db.deleteFrom("config_live").where("doc", "=", doc).where("zone_id", "=", zoneId).execute();
  await database.db.insertInto("config_live").values({ doc, zone_id: zoneId, version, document: JSON.stringify({ ...document, version }), published_at: clock.now, published_by: null }).execute();
  await database.db.insertInto("config_history").values({ doc, zone_id: zoneId, version, document: JSON.stringify({ ...document, version }), published_at: clock.now, published_by: null, approved_by: null, note: null }).onConflict((c) => c.doNothing()).execute();
}
/** The sample driver document with changes to waiting (deep for farPickup / rideTypes) and pickupPin. */
function driverDoc(change: { waiting?: Doc; pickupPin?: Doc; paris?: boolean } = {}): Doc {
  const doc = change.paris ? inParis(sample("driver_app_config")) : sample("driver_app_config");
  const waiting = doc.waiting as Doc;
  for (const [k, v] of Object.entries(change.waiting ?? {})) {
    if (v === undefined) delete waiting[k];
    else if (k === "rideTypes") waiting[k] = { ...(waiting[k] as Doc), ...(v as Doc) };
    else waiting[k] = v;
  }
  if (change.pickupPin) doc.pickupPin = { ...(doc.pickupPin as Doc), ...change.pickupPin };
  return doc;
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await publish("dispatch", "Z001", sample("dispatch_document"));
  await publish("rider_app_config", "Z001", sample("rider_app_config"));
  await publish("pricing", "FR-PC", inParis(sample("pricing_document")));
  await publish("rider_app_config", "FR-PC", inParis(sample("rider_app_config")));
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers, [TRIP_ETA]: etaHandler(fixedRouter) }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver A", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "AW00A", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  driverA.id = made.driverId;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

const fix = (at: { lat: number; lng: number }) => ({ fixes: [{ ...at, accuracy: 5, measuredAt: clock.now.toISOString() }] });
async function moveTo(at: { lat: number; lng: number }) {
  clock.now = new Date(clock.now.getTime() + 1000);
  expect((await call(app, "POST", "/driver/location", driverA.headers, fix(at))).statusCode).toBe(200);
}

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.deleteFrom("area_events").execute();
  await database.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
  await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_currency: null, outstanding_source_trip_id: null, wallet_minor: 0 }).execute();
  await publish("driver_app_config", "Z001", driverDoc());
  await publish("driver_app_config", "FR-PC", driverDoc({ paris: true }));
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driverA.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driverA.id).execute();
  await moveTo(SPOT_A);
});

/** The rider books in Stockholm and driver A accepts (dispatch). */
async function accepted(pickup = NORRMALM, dropoff = SODERMALM) {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup, dropoff, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup, dropoff, stops: [], kind: "live", paymentMethod: "cash" });
  expect(res.statusCode, res.body).toBe(201);
  await worker.runDue();
  const [offer] = (await call(app, "GET", "/driver/offers", driverA.headers)).json().items;
  expect(offer?.tripId).toBe(res.json().tripId);
  const acc = await call(app, "POST", `/offers/${offer.offerId}/accept`, driverA.headers, { expectedVersion: offer.version });
  expect(acc.statusCode, acc.body).toBe(200);
  return { tripId: res.json().tripId as string, version: acc.json().version as number };
}
/** A trip booked anywhere (Paris, a reservation) given to driver A on his way (the dispatch of that zone is not under test). */
async function forced(input: { pickup: typeof PARIS; dropoff: typeof PARIS; kind?: "live" | "scheduled"; scheduledAt?: Date }) {
  const extra = input.kind === "scheduled" ? { kind: "scheduled", scheduledAt: input.scheduledAt!.toISOString() } : {};
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: input.pickup, dropoff: input.dropoff, stops: [], categoryIds: ["economy"], ...extra })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: input.pickup, dropoff: input.dropoff, stops: [], kind: input.kind ?? "live", paymentMethod: "cash", ...extra });
  expect(res.statusCode, res.body).toBe(201);
  const trip = res.json();
  await database.db.updateTable("offers").set({ status: "withdrawn" }).where("trip_id", "=", trip.tripId).execute();
  await database.db.updateTable("trips").set({ status: "driver_to_pickup", driver_id: driverA.id, accepted_at: clock.now, version: trip.version + 1 }).where("trip_id", "=", trip.tripId).execute();
  return { tripId: trip.tripId as string, version: (trip.version as number) + 1 };
}
/** A 0.18.8 driver app (it reports its contract, so the server asks it for the PIN). */
const NEW_APP = { "x-contract-version": "0.18.8" };
const step = (tripId: string, path: string, version: number, body: Doc = {}, appHeaders: Record<string, string> = NEW_APP) => call(app, "POST", `/trips/${tripId}/${path}`, { ...driverA.headers, ...appHeaders }, { expectedVersion: version, ...body });
const riderView = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}`, rider)).json();
const driverView = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}`, driverA.headers)).json();
const events = async (tripId: string, who = rider) => (await call(app, "GET", `/trips/${tripId}/events?after=0`, { ...who, accept: "application/json" })).json().items as Doc[];
async function arriveAt(tripId: string, version: number, at = NORRMALM) {
  let v = version;
  const trip = await database.db.selectFrom("trips").select("status").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  if (trip.status === "accepted") {
    expect((await step(tripId, "head-to-pickup", v)).statusCode).toBe(200);
    v += 1;
  }
  await moveTo(at);
  const res = await step(tripId, "arrive", v);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Doc & { version: number; waiting: Doc; terms: Doc };
}
/** A test that books twice: the first trip goes, the driver is free again. */
async function drop(tripId: string) {
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", tripId).execute();
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driverA.id).execute();
  await database.db.deleteFrom("offers").execute();
  await moveTo(SPOT_A);
}
/** Tokens live 15 minutes: sign in again after a long wait. */
async function relogin() {
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driverA.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
}
const minutesAfter = (iso: unknown, from: unknown) => (Date.parse(iso as string) - Date.parse(from as string)) / 60_000;

describe("item 1: every admin waiting rule, picked by the server at arrive (contract.json#arrivedWaiting.rules)", () => {
  it("no rule matches: the category's terms; waiting.rules [] and terms.waitingRules []", async () => {
    const { tripId, version } = await accepted();
    const arrived = await arriveAt(tripId, version);
    expect(arrived.waiting).toMatchObject({ rules: [], freeWaitMin: 5, noShowAfterMin: 5, perMin: { amountMinor: 1226, currency: "SEK" }, noShowFee: { amountMinor: 6500, currency: "SEK" } });
    expect(arrived.terms).toMatchObject({ freeWaitMin: 5, waitingRules: [], stopFreeWaitMin: 0 });
  });

  it("far pickup (> 5 km at accept): 1 free min, no-show at 1 min with 85 kr (80 % = 68 kr to the driver); the server charges it", async () => {
    const { tripId, version } = await accepted();
    await database.db.updateTable("trips").set({ accept_pickup_meters: 5600 }).where("trip_id", "=", tripId).execute();
    const arrived = await arriveAt(tripId, version);
    expect(arrived.waiting).toMatchObject({ rules: ["far_pickup"], freeWaitMin: 1, noShowAfterMin: 1, noShowFee: { amountMinor: 8500, currency: "SEK" }, noShowDriverShare: { amountMinor: 6800, currency: "SEK" } });
    expect(minutesAfter(arrived.waiting["noShowAt"], arrived.waiting["arrivedAt"])).toBe(1);
    expect((await riderView(tripId)).terms).toMatchObject({ freeWaitMin: 1, noShowAfterMin: 1, noShowFee: { amountMinor: 8500 }, waitingRules: ["far_pickup"] });
    await advance(61);
    const noShow = await call(app, "POST", `/trips/${tripId}/no-show`, driverA.headers, { expectedVersion: arrived.version });
    expect(noShow.statusCode, noShow.body).toBe(200);
    expect(noShow.json()).toMatchObject({ fare: { amountMinor: 8500 }, cancellation: { fee: { amountMinor: 8500, currency: "SEK" }, driverShare: { amountMinor: 6800 } } });
    expect(await database.db.selectFrom("earnings_entries").select(["kind", "amount_minor"]).where("trip_id", "=", tripId).execute()).toEqual([{ kind: "fee_share", amount_minor: "6800" }]);
  });

  it("exactly 5 km is not far; the admin switch off disables the rule", async () => {
    const first = await accepted();
    await database.db.updateTable("trips").set({ accept_pickup_meters: 5000 }).where("trip_id", "=", first.tripId).execute();
    expect((await arriveAt(first.tripId, first.version)).waiting["rules"]).toEqual([]);
    await drop(first.tripId);
    await publish("driver_app_config", "Z001", driverDoc({ waiting: { farPickup: { on: false, km: 5, freeWaitMin: 1, perMin: null, noShowAfterMin: null, noShowFee: { amountMinor: 8500, currency: "SEK" } } } }));
    const second = await accepted();
    await database.db.updateTable("trips").set({ accept_pickup_meters: 9000 }).where("trip_id", "=", second.tripId).execute();
    expect((await arriveAt(second.tripId, second.version)).waiting["rules"]).toEqual([]);
  });

  it("airport pickup: 15 free min, no-show only after 20 min; the paid minute is charged at the category price", async () => {
    const { tripId, version } = await accepted();
    // The airport flag is the server's own price extra (pickup in an airport zone, set at booking).
    await database.db.updateTable("trips").set({ price_extras: JSON.stringify({ pickupInAirportZone: true }) }).where("trip_id", "=", tripId).execute();
    const arrived = await arriveAt(tripId, version);
    expect(arrived.waiting).toMatchObject({ rules: ["airport"], freeWaitMin: 15, noShowAfterMin: 20 });
    await advance(19 * 60);
    await relogin();
    const early = await call(app, "POST", `/trips/${tripId}/no-show`, driverA.headers, { expectedVersion: arrived.version });
    expect(early.statusCode).toBe(409);
    expect(early.json().reason).toBe("no_show_too_early");
    clock.now = new Date(Date.parse(arrived.waiting["arrivedAt"] as string) + 16 * 60_000);
    const boarded = (await step(tripId, "board", arrived.version)).json();
    expect(boarded.waiting.chargedSeconds).toBe(60);
    expect(boarded.fareLines).toEqual(expect.arrayContaining([{ code: "waiting", amount: { amountMinor: 1226, currency: "SEK" } }]));
  });

  it("event pickup: a running admin event around the pickup gives 3 free min; an event that is off or over does not", async () => {
    const event = (on: boolean, endsInMin: number) => ({
      event_id: `evt_${Math.random().toString(36).slice(2, 10)}`, country: "SE", name: "Concert", lat: NORRMALM.lat + 0.001, lng: NORRMALM.lng, polygon: null,
      starts_at: new Date(clock.now.getTime() - 3600_000), ends_at: new Date(clock.now.getTime() + endsInMin * 60_000), is_on: on, details: JSON.stringify({}), created_by: null, created_at: clock.now, updated_by: null, updated_at: clock.now,
    });
    await database.db.insertInto("area_events").values([event(false, 120), event(true, -10)]).execute();
    const none = await accepted();
    expect((await arriveAt(none.tripId, none.version)).waiting["rules"]).toEqual([]);
    await drop(none.tripId);
    await database.db.insertInto("area_events").values(event(true, 120)).execute();
    const running = await accepted();
    const arrived = await arriveAt(running.tripId, running.version);
    expect(arrived.waiting).toMatchObject({ rules: ["event"], freeWaitMin: 3, noShowAfterMin: 3 });
  });

  it("a rule's own per-minute price (override) is what the rider pays and what the running total shows", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ waiting: { rideTypes: { event: { on: true, freeWaitMin: 3, perMin: { amountMinor: 2000, currency: "SEK" }, noShowAfterMin: null, noShowFee: null } } } }));
    await database.db.insertInto("area_events").values({ event_id: "evt_over", country: "SE", name: "Match", lat: NORRMALM.lat, lng: NORRMALM.lng, polygon: null, starts_at: new Date(clock.now.getTime() - 60_000), ends_at: new Date(clock.now.getTime() + 7200_000), is_on: true, details: JSON.stringify({}), created_by: null, created_at: clock.now, updated_by: null, updated_at: clock.now }).execute();
    const { tripId, version } = await accepted();
    const arrived = await arriveAt(tripId, version);
    expect(arrived.waiting).toMatchObject({ rules: ["event"], perMin: { amountMinor: 2000, currency: "SEK" } });
    await advance(4 * 60);
    expect((await riderView(tripId)).waiting).toMatchObject({ chargedSecondsNow: 60, chargedSoFar: { amountMinor: 2000, currency: "SEK" }, paidMinutes: 1 });
    expect((await riderView(tripId)).terms.waitPerMin).toEqual({ amountMinor: 2000, currency: "SEK" });
    const boarded = (await step(tripId, "board", arrived.version)).json();
    expect(boarded.fareLines).toEqual(expect.arrayContaining([{ code: "waiting", amount: { amountMinor: 2000, currency: "SEK" } }]));
  });

  it("scheduled ride: the free wait is the reservation's included waiting, counted from the booked time", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ waiting: { rideTypes: { scheduled: { on: true, freeWaitMin: 10, perMin: null, noShowAfterMin: null, noShowFee: null } } } }));
    const at = new Date(clock.now.getTime() + 3 * 3600_000);
    const { tripId, version } = await forced({ pickup: NORRMALM, dropoff: SODERMALM, kind: "scheduled", scheduledAt: at });
    const soon = new Date(clock.now.getTime() + 10 * 60_000);
    await database.db.updateTable("trips").set({ scheduled_at: soon }).where("trip_id", "=", tripId).execute();
    const arrived = await arriveAt(tripId, version);
    expect(arrived.waiting).toMatchObject({ rules: ["scheduled"], freeWaitMin: 10, noShowAfterMin: 10 });
    expect(minutesAfter(arrived.waiting["freeUntil"], soon.toISOString())).toBe(10);
  });

  it("the rules of booking time stay with the trip: a later publish does not change it", async () => {
    const { tripId, version } = await accepted();
    await publish("driver_app_config", "Z001", driverDoc({ waiting: { farPickup: { on: true, km: 1, freeWaitMin: 0, perMin: null, noShowAfterMin: null, noShowFee: null } } }));
    await database.db.updateTable("trips").set({ accept_pickup_meters: 3000 }).where("trip_id", "=", tripId).execute();
    expect((await arriveAt(tripId, version)).waiting["rules"]).toEqual([]);
  });

  it("free wait at each stop: only the seconds after the zone's free stop minutes are charged (0 before v0.18.8)", () => {
    const visits = JSON.stringify([{ stopIndex: 0, arrivedAt: "2026-11-01T10:00:00Z", leftAt: "2026-11-01T10:06:40Z" }, { stopIndex: 1, arrivedAt: "2026-11-01T10:10:00Z", leftAt: "2026-11-01T10:12:00Z" }]);
    const trip = { stops: [{}, {}], stop_visits: JSON.parse(visits) };
    expect(stopWaitSeconds(trip, new Date())).toEqual([400, 120]);
    expect(stopWaitSeconds({ ...trip, booking_rules: { stopFreeWaitMin: 3 } }, new Date())).toEqual([220, 0]);
  });

  it("the cases of fixtures/arrived_waiting.json#ruleSelection give the same numbers (SE + FR)", () => {
    const fixtures = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/arrived_waiting.json`, "utf8"));
    for (const c of fixtures.ruleSelection) {
      const got = effectiveWaiting(c.base, waitingExtrasOf(c.rules, c.currency), c.trip);
      expect({ ...got }, c.id).toEqual(c.expect);
    }
    for (const c of fixtures.termsMoney) expect(termsMoney(c.amount, c.lang)).toBe(c.text);
  });

  it("France: euro terms from the Paris documents; a far pickup without its own fee takes the default 8,10 €", async () => {
    await publish("driver_app_config", "FR-PC", driverDoc({ paris: true, waiting: { farPickup: undefined } }));
    const { tripId, version } = await forced({ pickup: PARIS, dropoff: PARIS_DROP });
    await database.db.updateTable("trips").set({ accept_pickup_meters: 7000 }).where("trip_id", "=", tripId).execute();
    const arrived = await arriveAt(tripId, version, PARIS);
    expect(arrived.waiting).toMatchObject({ rules: ["far_pickup"], freeWaitMin: 1, noShowFee: { amountMinor: 810, currency: "EUR" }, perMin: { amountMinor: 1226, currency: "EUR" } });
    expect(arrived.terms).toMatchObject({ currency: "EUR", noShowFee: { amountMinor: 810, currency: "EUR" }, waitingRules: ["far_pickup"] });
  });

  it("France: airport pickup 15 / 20 min in euro", async () => {
    const { tripId, version } = await forced({ pickup: PARIS, dropoff: PARIS_DROP });
    await database.db.updateTable("trips").set({ price_extras: JSON.stringify({ pickupInAirportZone: true }) }).where("trip_id", "=", tripId).execute();
    const arrived = await arriveAt(tripId, version, PARIS);
    expect(arrived.waiting).toMatchObject({ rules: ["airport"], freeWaitMin: 15, noShowAfterMin: 20, noShowFee: { currency: "EUR" } });
  });

  it("the rider document is served with the zone's extra rules (for the rider's terms)", async () => {
    const cfg = (await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json();
    expect(cfg.waiting).toMatchObject({ farPickup: { on: true, km: 5 }, rideTypes: { airport: { freeWaitMin: 15, noShowAfterMin: 20 } }, stopFreeWaitMin: 0 });
  });
});

describe("item 2: rider PIN before Start (per-zone admin switch, default off)", () => {
  it("switch off (default): no PIN anywhere, the driver starts as before", async () => {
    const { tripId, version } = await accepted();
    const arrived = await arriveAt(tripId, version);
    expect(arrived["pinRequired"]).toBe(false);
    expect(await riderView(tripId)).not.toHaveProperty("pickupPin");
    expect((await call(app, "GET", `/trips/${tripId}/pin`, rider)).json().reason).toBe("pin_not_required");
    expect((await step(tripId, "board", arrived.version)).statusCode).toBe(200);
  });

  it("switch on: the rider (and the admin) see a 4-digit PIN, the driver never; no PIN → 409, wrong → 400 with tries left, right → started", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ pickupPin: { required: true } }));
    const { tripId, version } = await accepted();
    const arrived = await arriveAt(tripId, version);
    const pin = (await riderView(tripId)).pickupPin as string;
    expect(pin).toMatch(/^\d{4}$/);
    expect((await call(app, "GET", `/trips/${tripId}/pin`, rider)).json()).toMatchObject({ tripId, pin });
    expect(arrived).not.toHaveProperty("pickupPin");
    expect(await driverView(tripId)).toMatchObject({ pinRequired: true, pinVerified: false });
    expect(await driverView(tripId)).not.toHaveProperty("pickupPin");
    for (const e of await events(tripId, driverA.headers)) expect(JSON.stringify(e)).not.toContain(`"pickupPin"`);
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    expect((await call(app, "GET", `/admin/trips/${tripId}`, admin.headers)).json()).toMatchObject({ pickupPin: pin, pinVerified: false, pinAttempts: 0 });
    const none = await step(tripId, "board", arrived.version);
    expect(none.statusCode).toBe(409);
    expect(none.json().reason).toBe("pin_required");
    const wrongPin = pin === "0000" ? "1111" : "0000";
    const wrong = await step(tripId, "board", arrived.version, { pin: wrongPin });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ reason: "pin_wrong", details: ["attemptsLeft=4"] });
    expect((await call(app, "GET", `/admin/trips/${tripId}`, admin.headers)).json().pinAttempts).toBe(1);
    const right = await step(tripId, "board", arrived.version, { pin });
    expect(right.statusCode, right.body).toBe(200);
    expect(right.json()).toMatchObject({ status: "rider_onboard", pinVerified: true, version: arrived.version + 2 });
    // L5: the right PIN was its own version with a trip_projection, so the rider's pinVerified updates on the stream.
    const verifiedEvent = (await events(tripId)).find((e) => e["version"] === arrived.version + 1)!;
    expect((verifiedEvent["projection"] as Doc)["pinVerified"]).toBe(true);
    expect((await step(tripId, "start", right.json().version)).statusCode).toBe(200);
  });

  it("too many wrong tries lock the trip (429 pin_locked with retryAfterSeconds); after the lock /pin/verify works", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ pickupPin: { required: true, maxAttempts: 2, lockMinutes: 1 } }));
    const { tripId, version } = await accepted();
    const arrived = await arriveAt(tripId, version);
    const pin = (await riderView(tripId)).pickupPin as string;
    const wrongPin = pin === "0000" ? "1111" : "0000";
    expect((await call(app, "POST", `/trips/${tripId}/pin/verify`, driverA.headers, { pin: wrongPin })).json().details).toEqual(["attemptsLeft=1"]);
    const locked = await call(app, "POST", `/trips/${tripId}/pin/verify`, driverA.headers, { pin: wrongPin });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ reason: "pin_locked", retryable: true });
    expect((await call(app, "POST", `/trips/${tripId}/pin/verify`, driverA.headers, { pin })).statusCode).toBe(429);
    await advance(61);
    const ok = await call(app, "POST", `/trips/${tripId}/pin/verify`, driverA.headers, { pin });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().verifiedPinToken.length).toBeGreaterThanOrEqual(16);
    expect(ok.json().version).toBe(arrived.version + 1);
    expect((await step(tripId, "board", ok.json().version)).statusCode).toBe(200);
  });


  it("checker H1: a new driver gets a fresh PIN state — verified / tries / lock cleared and the PIN rotated", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ pickupPin: { required: true } }));
    const { tripId, version } = await accepted();
    const arrived = await arriveAt(tripId, version);
    const pin = (await riderView(tripId)).pickupPin as string;
    const wrongPin = pin === "0000" ? "1111" : "0000";
    await call(app, "POST", `/trips/${tripId}/pin/verify`, driverA.headers, { pin: wrongPin });
    const ok = (await call(app, "POST", `/trips/${tripId}/pin/verify`, driverA.headers, { pin })).json();
    const cancel = await call(app, "POST", `/trips/${tripId}/cancel`, driverA.headers, { expectedVersion: ok.version, reasonCode: "vehicle_issue_before_start" });
    expect(cancel.statusCode, cancel.body).toBe(200);
    void arrived;
    const row = await database.db.selectFrom("trips").select(["pin_verified_at", "pin_attempts", "pin_wrong_total", "pin_locked_until", "pickup_pin", "driver_id"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ pin_verified_at: null, pin_attempts: 0, pin_wrong_total: 0, pin_locked_until: null, driver_id: null });
    expect(row.pickup_pin).toMatch(/^\d{4}$/);
    expect((await riderView(tripId)).pickupPin).toBe(row.pickup_pin);
    expect((await riderView(tripId)).pinVerified).toBe(false);
  });

  it("checker M2: guesses only once arrived; 3 × maxAttempts wrong in all block the PIN until an admin unlocks it", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ pickupPin: { required: true, maxAttempts: 2, lockMinutes: 1 } }));
    const { tripId, version } = await accepted();
    const early = await call(app, "POST", `/trips/${tripId}/pin/verify`, driverA.headers, { pin: "1234" });
    expect(early.statusCode).toBe(409);
    expect(early.json().reason).toBe("pin_not_now");
    const arrived = await arriveAt(tripId, version);
    const pin = (await riderView(tripId)).pickupPin as string;
    const wrongPin = pin === "0000" ? "1111" : "0000";
    const reasons: string[] = [];
    for (let i = 0; i < 6; i++) {
      reasons.push((await call(app, "POST", `/trips/${tripId}/pin/verify`, driverA.headers, { pin: wrongPin })).json().reason);
      if (i % 2 === 1) await advance(61);
    }
    expect(reasons).toEqual(["pin_wrong", "pin_locked", "pin_wrong", "pin_locked", "pin_wrong", "pin_blocked"]);
    await relogin();
    // Blocked: even the right PIN, even after the lock time.
    await advance(120);
    await relogin();
    expect((await call(app, "POST", `/trips/${tripId}/pin/verify`, driverA.headers, { pin })).json().reason).toBe("pin_blocked");
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const view = (await call(app, "GET", `/admin/trips/${tripId}`, admin.headers)).json();
    expect(view).toMatchObject({ pickupPin: pin, pinBlocked: true });
    expect((await call(app, "POST", `/admin/trips/${tripId}/pin/unlock`, admin.headers, { expectedVersion: view.version, reason: "" })).statusCode).toBe(400);
    const unlocked = await call(app, "POST", `/admin/trips/${tripId}/pin/unlock`, admin.headers, { expectedVersion: view.version, reason: "Rider confirmed by phone" });
    expect(unlocked.statusCode, unlocked.body).toBe(200);
    expect(unlocked.json()).toMatchObject({ pinBlocked: false, pinAttempts: 0 });
    expect(await database.db.selectFrom("admin_audit").select("action").where("target_id", "=", tripId).where("action", "=", "trip.pin_unlock").execute()).toHaveLength(1);
    const ok = await call(app, "POST", `/trips/${tripId}/pin/verify`, driverA.headers, { pin });
    expect(ok.statusCode, ok.body).toBe(200);
    void arrived;
  });

  it("checker M4: a driver app before contract 0.18.8 (no X-Contract-Version) is not asked for the PIN", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ pickupPin: { required: true } }));
    const { tripId, version } = await accepted();
    const arrived = await arriveAt(tripId, version);
    expect((await step(tripId, "board", arrived.version, {}, { "x-contract-version": "0.18.7" })).statusCode).toBe(200);
  });

  it("checker L8: the rider's PIN is gone once the trip is over", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ pickupPin: { required: true } }));
    const { tripId, version } = await accepted();
    expect((await call(app, "GET", `/trips/${tripId}/pin`, rider)).statusCode).toBe(200);
    await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: version, reasonCode: "plans_changed" });
    const res = await call(app, "GET", `/trips/${tripId}/pin`, rider);
    expect(res.statusCode).toBe(404);
    expect(res.json().reason).toBe("pin_trip_over");
  });

  it("France: the switch works the same in a Paris zone", async () => {
    await publish("driver_app_config", "FR-PC", driverDoc({ paris: true, pickupPin: { required: true } }));
    const { tripId, version } = await forced({ pickup: PARIS, dropoff: PARIS_DROP });
    const arrived = await arriveAt(tripId, version, PARIS);
    expect((await step(tripId, "board", arrived.version)).json().reason).toBe("pin_required");
    const pin = (await riderView(tripId)).pickupPin as string;
    expect((await step(tripId, "board", arrived.version, { pin })).statusCode).toBe(200);
  });
});

describe("item 3: admin Reverse no-show (reason required, driver share kept unless taken back) and paid minutes", () => {
  async function noShowTrip(where: "SE" | "FR" = "SE") {
    const { tripId, version } = where === "SE" ? await accepted() : await forced({ pickup: PARIS, dropoff: PARIS_DROP });
    const arrived = await arriveAt(tripId, version, where === "SE" ? NORRMALM : PARIS);
    await advance(5 * 60 + 1);
    const res = await call(app, "POST", `/trips/${tripId}/no-show`, driverA.headers, { expectedVersion: arrived.version });
    expect(res.statusCode, res.body).toBe(200);
    return { tripId, version: res.json().version as number };
  }

  it("reverse: fee waived, fare 0, the driver keeps his 52 kr, audited; again changes nothing (idempotent)", async () => {
    const { tripId, version } = await noShowTrip();
    expect((await call(app, "GET", "/rider/profile", rider)).json().outstanding).toEqual({ amountMinor: 6500, currency: "SEK" });
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const res = await call(app, "POST", `/admin/trips/${tripId}/reverse-no-show`, admin.headers, { expectedVersion: version, reason: "Rider was at the other entrance" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "no_show", fare: { amountMinor: 0 }, driverEarnings: { amountMinor: 5200 }, cancellation: { feeStatus: "waived", reversal: { by: admin.adminId, reason: "Rider was at the other entrance", driverShareTakenBack: false } } });
    expect((await call(app, "GET", "/rider/profile", rider)).json().outstanding ?? null).toBeNull();
    expect(await database.db.selectFrom("earnings_entries").select(["kind", "amount_minor"]).where("trip_id", "=", tripId).execute()).toEqual([{ kind: "fee_share", amount_minor: "5200" }]);
    // The rider and the driver see that it was reversed, not the admin's reason.
    expect((await riderView(tripId)).cancellation.reversal).toEqual({ at: expect.any(String), driverShareTakenBack: false });
    expect((await driverView(tripId)).cancellation.reversal).not.toHaveProperty("reason");
    const again = await call(app, "POST", `/admin/trips/${tripId}/reverse-no-show`, admin.headers, { expectedVersion: version, reason: "twice" });
    expect(again.statusCode).toBe(200);
    expect(again.json().version).toBe(res.json().version);
    expect(again.json().cancellation.reversal.reason).toBe("Rider was at the other entrance");
    const audits = await database.db.selectFrom("admin_audit").select("action").where("target_id", "=", tripId).where("action", "=", "trip.reverse_no_show").execute();
    expect(audits).toHaveLength(1);
  });

  it("take back the driver's share: an earnings adjustment of − 52 kr; the trip's driver earnings 0", async () => {
    const { tripId, version } = await noShowTrip();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const res = await call(app, "POST", `/admin/trips/${tripId}/reverse-no-show`, admin.headers, { expectedVersion: version, reason: "Driver was at the wrong address", takeBackDriverShare: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().cancellation.reversal.driverShareTakenBack).toBe(true);
    expect(res.json().driverEarnings).toEqual({ amountMinor: 0, currency: "SEK" });
    const entries = await database.db.selectFrom("earnings_entries").select(["kind", "amount_minor"]).where("trip_id", "=", tripId).orderBy("at").execute();
    expect(entries).toEqual([{ kind: "fee_share", amount_minor: "5200" }, { kind: "adjustment", amount_minor: "-5200" }]);
  });

  it("a reason is required; only a no-show can be reversed", async () => {
    const { tripId, version } = await noShowTrip();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    expect((await call(app, "POST", `/admin/trips/${tripId}/reverse-no-show`, admin.headers, { expectedVersion: version, reason: "  " })).statusCode).toBe(400);
    await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driverA.id).execute();
    await moveTo(SPOT_A);
    const other = await accepted();
    const res = await call(app, "POST", `/admin/trips/${other.tripId}/reverse-no-show`, admin.headers, { expectedVersion: other.version, reason: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("not_a_no_show");
  });

  it("a fee already paid is refunded to the rider's wallet (feeStatus refunded) — France, in euro", async () => {
    const { tripId, version } = await noShowTrip("FR");
    await database.db.updateTable("rider_fees").set({ status: "paid" }).where("trip_id", "=", tripId).execute();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const res = await call(app, "POST", `/admin/trips/${tripId}/reverse-no-show`, admin.headers, { expectedVersion: version, reason: "Rider was there" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().cancellation).toMatchObject({ fee: { amountMinor: 6500, currency: "EUR" }, feeStatus: "waived", refundedToWallet: true, refundedAt: expect.any(String) });
    expect(await database.db.selectFrom("wallet_entries").select(["kind", "amount_minor", "currency"]).where("trip_id", "=", tripId).execute()).toEqual([{ kind: "refund", amount_minor: "6500", currency: "EUR" }]);
    expect(await database.db.selectFrom("rider_fees").select("status").where("trip_id", "=", tripId).executeTakeFirst()).toEqual({ status: "refunded" });
  });

  it("paid minutes for the admin waiting box: on the trip page and on the trips list rows", async () => {
    const { tripId, version } = await accepted();
    const arrived = await arriveAt(tripId, version);
    await advance(5 * 60 + 61);
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    expect((await call(app, "GET", `/admin/trips/${tripId}`, admin.headers)).json().waiting).toMatchObject({ chargedSecondsNow: 61, paidMinutes: 2 });
    const boarded = (await step(tripId, "board", arrived.version)).json();
    expect(boarded.waiting).toMatchObject({ chargedSeconds: 61, paidMinutes: 2 });
    const rows = (await call(app, "GET", "/admin/trips?status=rider_onboard", admin.headers)).json().items as Doc[];
    expect((rows.find((r) => r["tripId"] === tripId)!["waiting"] as Doc)["paidMinutes"]).toBe(2);
  });
});

describe("item 4: the waiting / no-show / cancel rules in the Terms (SE + FR, sv / fr / en)", () => {
  it("GET /legal/SE?zoneId=Z001 fills paragraph 3.5 with Stockholm's live numbers; without zoneId the paragraph is left out", async () => {
    const filled = (await call(app, "GET", "/legal/SE?zoneId=Z001", {})).json();
    expect(filled.terms.text.en).toContain("3.1 Waiting at pickup.");
    expect(filled.terms.text.en).toContain("free waiting 5 min, then 12.26 kr per minute; no-show after 5 min, fee 65 kr.");
    expect(filled.terms.text.en).toContain("Airport pickup: free waiting 15 min; no-show after 20 min, fee 65 kr.");
    expect(filled.terms.text.en).toContain("Pickup over 5 km away: free waiting 1 min; no-show after 1 min, fee 85 kr.");
    expect(filled.terms.text.sv).toContain("därefter 12,26 kr per minut");
    expect(filled.terms.text.fr).toContain("puis 12,26 kr par minute");
    const plain = (await call(app, "GET", "/legal/SE", {})).json();
    expect(plain.terms.text.en).toContain("3.2 No-show.");
    expect(plain.terms.text.en).not.toContain("3.5 ");
    // A zone of another country fills nothing.
    expect((await call(app, "GET", "/legal/SE?zoneId=FR-PC", {})).json().terms.text.en).not.toContain("3.5 ");
  });

  it("GET /legal/FR?zoneId=FR-PC: the Paris numbers in euro, in French", async () => {
    const filled = (await call(app, "GET", "/legal/FR?zoneId=FR-PC", {})).json();
    expect(filled.terms.text.fr).toContain("3.1 Attente à la prise en charge.");
    expect(filled.terms.text.fr).toContain("puis 12,26 € par minute ; client absent après 5 min, frais 65 €.");
    expect(filled.terms.text.en).toContain("then €12.26 per minute");
  });
});

describe("item 5: island messages when paid waiting starts and when a no-show becomes possible (no version change)", () => {
  it("airport 15 / 20: paid_waiting_started at 15 min, no_show_possible at 20 min, each once, on a trip_projection event", async () => {
    const { tripId, version } = await accepted();
    await database.db.updateTable("trips").set({ price_extras: JSON.stringify({ pickupInAirportZone: true }) }).where("trip_id", "=", tripId).execute();
    const arrived = await arriveAt(tripId, version);
    await advance(15 * 60);
    await relogin();
    let view = await driverView(tripId);
    expect(view.waiting.alerts).toEqual([{ kind: "paid_waiting_started", at: expect.any(String) }]);
    expect(view.version).toBe(arrived.version);
    const last = (await events(tripId, driverA.headers)).at(-1)!;
    expect(last["kind"]).toBe("trip_projection");
    expect(((last["projection"] as Doc)["waiting"] as Doc)["alerts"]).toHaveLength(1);
    await advance(5 * 60);
    await relogin();
    view = await riderView(tripId);
    expect((view.waiting.alerts as Doc[]).map((a) => a["kind"])).toEqual(["paid_waiting_started", "no_show_possible"]);
    await advance(60);
    expect((await riderView(tripId)).waiting.alerts).toHaveLength(2);
  });

  it("no alert once the rider is on board", async () => {
    const { tripId, version } = await accepted();
    const arrived = await arriveAt(tripId, version);
    await step(tripId, "board", arrived.version);
    await advance(6 * 60);
    expect((await riderView(tripId)).waiting.alerts).toEqual([]);
  });
});
