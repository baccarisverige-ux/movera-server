import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { sampleForZone } from "../../src/config/seedConfig.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { readEnv } from "../../src/env.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { EstimateRouter } from "../../src/maps/routing.js";
import { redactProjection } from "../../src/realtime/events.js";
import { commissionOf } from "../../src/rules/commission.js";
import { adminMethodsOf, paymentOptionsOf } from "../../src/trips/finish.js";
import { earlyEndSettingsOf, rideHandlers } from "../../src/trips/ride.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, signIn, SODERMALM } from "../support/world.js";

/**
 * Driver group 8 "Finish & cash" (contract v0.18.10 §36, contract.json#finish; Rules decisions/driver-g8.md): payment
 * methods (cash "Pay in car", card, Apple Pay; no Google Pay; admin per country / zone; the server says what it takes),
 * tips per country 100 % to the driver, the rider's early end gives the driver the finish (Q1), the driver's early end keeps
 * stop waiting and re-prices only over the admin's km / minutes (Q2), one driver money number (Q3), SOS only with a driver
 * (Q4), receipts + resend, driver pay change, the rider's old debt never Movera's commission. Sweden (Z001, SEK) and
 * France (FR-PC, EUR).
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-03T10:00:00Z") };
const router = new EstimateRouter();
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
/** The Swedish sample as a Paris document, with the French defaults for tips (as the seed now writes them). */
const inParis = (doc: unknown) => JSON.parse(JSON.stringify(doc).replace(/"SEK"/g, '"EUR"').replace(/"Z001"/g, '"FR-PC"').replace(/"SE"/g, '"FR"').replace(/Europe\/Stockholm/g, "Europe/Paris"));
const PARIS = { address: "Châtelet", lat: 48.8584, lng: 2.3472 };
const PARIS_DROP = { address: "Gare de Lyon", lat: 48.8443, lng: 2.3744 };
const SPOT_A = { lat: 59.3335, lng: 18.0655 };
const BROMMA = { address: "Brommaplan", lat: 59.3383, lng: 17.9393 };
const NEAR_SODER = { lat: 59.3182, lng: 18.0718 }; // ~450 m before Medborgarplatsen
const FR_TIPS = [100, 200, 500].map((amountMinor) => ({ amount: { amountMinor, currency: "EUR" }, enabled: true }));

type Doc = Record<string, unknown>;
const driverA = { id: "", headers: {} as Record<string, string> };
let rider: Record<string, string>;
let riderId = "";

async function publish(doc: "rider_app_config" | "driver_app_config" | "pricing" | "dispatch", zoneId: string, document: Doc) {
  const current = await database.db.selectFrom("config_live").select("version").where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  const version = (current?.version ?? 0) + 1;
  await database.db.deleteFrom("config_live").where("doc", "=", doc).where("zone_id", "=", zoneId).execute();
  await database.db.insertInto("config_live").values({ doc, zone_id: zoneId, version, document: JSON.stringify({ ...document, version }), published_at: clock.now, published_by: null }).execute();
  await database.db.insertInto("config_history").values({ doc, zone_id: zoneId, version, document: JSON.stringify({ ...document, version }), published_at: clock.now, published_by: null, approved_by: null, note: null }).onConflict((c) => c.doNothing()).execute();
}
const merged = (base: Doc, change: Doc): Doc => {
  for (const [k, v] of Object.entries(change)) base[k] = typeof v === "object" && v !== null && !Array.isArray(v) ? { ...(base[k] as Doc), ...(v as Doc) } : v;
  return base;
};
const driverDoc = (change: Doc = {}, paris = false): Doc => merged(paris ? inParis(sample("driver_app_config")) : sample("driver_app_config"), change);
const riderDoc = (change: Doc = {}, paris = false): Doc => merged(paris ? { ...inParis(sample("rider_app_config")), tips: FR_TIPS, tipRules: { ...sample("rider_app_config").tipRules, customMax: { amountMinor: 2000, currency: "EUR" } } } : sample("rider_app_config"), change);

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 1, document: JSON.stringify(sample("pricing_document")), published_at: clock.now, published_by: null }).execute();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "g8-test-secret".padEnd(48, "g") }), logger: false, db: database.db, clock: () => clock.now, router });
  await publish("dispatch", "Z001", sample("dispatch_document"));
  await publish("pricing", "FR-PC", inParis(sample("pricing_document")));
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver A", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "G8A00", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  driverA.id = made.driverId;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

const fix = (at: { lat: number; lng: number }) => ({ fixes: [{ ...at, accuracy: 5, measuredAt: clock.now.toISOString() }] });
async function moveTo(at: { lat: number; lng: number }, seconds = 1) {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  expect((await call(app, "POST", "/driver/location", driverA.headers, fix(at))).statusCode).toBe(200);
}

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
  await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_currency: null, outstanding_source_trip_id: null, wallet_minor: 0 }).execute();
  await publish("driver_app_config", "Z001", driverDoc());
  await publish("driver_app_config", "FR-PC", driverDoc({}, true));
  await publish("rider_app_config", "Z001", riderDoc());
  await publish("rider_app_config", "FR-PC", riderDoc({}, true));
  const signed = await signIn(app, TEST_PHONES[0]!, "rider");
  rider = signed.headers;
  riderId = (await database.db.selectFrom("riders").select("rider_id").executeTakeFirstOrThrow()).rider_id;
  driverA.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driverA.id).execute();
  await moveTo(SPOT_A);
});

const step = (tripId: string, path: string, version: number, body: Doc = {}) => call(app, "POST", `/trips/${tripId}/${path}`, driverA.headers, { expectedVersion: version, ...body });
const view = async (tripId: string, who: Record<string, string>) => (await call(app, "GET", `/trips/${tripId}`, who)).json();
const book = async (pickup: Doc, dropoff: Doc, paymentMethod = "cash", stops: Doc[] = []) => {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup, dropoff, stops, categoryIds: ["economy"] })).json().quotes[0];
  return call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup, dropoff, stops, kind: "live", paymentMethod });
};

/** Booked in Stockholm, accepted by driver A through dispatch. */
async function accepted(pickup: Doc = NORRMALM, dropoff: Doc = SODERMALM, stops: Doc[] = []) {
  const res = await book(pickup, dropoff, "cash", stops);
  expect(res.statusCode, res.body).toBe(201);
  await worker.runDue();
  const [offer] = (await call(app, "GET", "/driver/offers", driverA.headers)).json().items;
  const acc = await call(app, "POST", `/offers/${offer.offerId}/accept`, driverA.headers, { expectedVersion: offer.version });
  expect(acc.statusCode, acc.body).toBe(200);
  return { tripId: res.json().tripId as string, version: acc.json().version as number };
}
/** A Paris trip given to driver A (the Paris dispatch is not under test). */
async function forcedParis() {
  const res = await book(PARIS, PARIS_DROP);
  expect(res.statusCode, res.body).toBe(201);
  const trip = res.json();
  await database.db.updateTable("offers").set({ status: "withdrawn" }).where("trip_id", "=", trip.tripId).execute();
  await database.db.updateTable("trips").set({ status: "accepted", driver_id: driverA.id, accepted_at: clock.now, version: trip.version + 1 }).where("trip_id", "=", trip.tripId).execute();
  await database.db.updateTable("drivers").set({ online_status: "on_trip" }).where("driver_id", "=", driverA.id).execute();
  return { tripId: trip.tripId as string, version: (trip.version as number) + 1 };
}
/** To in_trip: head to pickup, arrive at the pickup, board, start. */
async function onBoard(trip: { tripId: string; version: number }, pickup: { lat: number; lng: number } = NORRMALM) {
  let v = trip.version;
  for (const [path, at] of [["head-to-pickup", null], ["arrive", pickup], ["board", null], ["start", null]] as const) {
    if (at) await moveTo(at);
    const res = await step(trip.tripId, path, v);
    expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
    v = res.json().version;
  }
  return v;
}
/** The driver completes through the preview (the app's Collect cash). */
async function complete(tripId: string, version: number) {
  const preview = (await call(app, "GET", `/driver/trips/${tripId}/complete-preview`, driverA.headers)).json();
  const done = await step(tripId, "complete", version, { previewId: preview.previewId, cashCollected: preview.cashDue });
  expect(done.statusCode, done.body).toBe(200);
  return { preview, done: done.json() };
}
/** A finished Stockholm trip (Norrmalm → Södermalm, completed at the drop-off). */
async function finished() {
  const trip = await accepted();
  const v = await onBoard(trip);
  await moveTo(SODERMALM, 600);
  return { tripId: trip.tripId, ...(await complete(trip.tripId, v)) };
}

describe("payment methods: cash 'Pay in car', card, Apple Pay; no Google Pay (owner item 2)", () => {
  it("the contract and the served documents carry no google_pay; options say what the server takes (SE and FR)", async () => {
    const contract = JSON.parse(readFileSync(`${CONTRACTS_DIR}/contract.json`, "utf8"));
    expect(contract.zonePaymentMethods.values).toEqual(["cash", "card", "apple_pay"]);
    expect(contract.paymentMethods).not.toContain("google_pay");
    expect(contract.finish.paymentMethods.texts.cash).toEqual({ sv: "Betala i bilen", fr: "Payer dans la voiture", en: "Pay in car" });
    // A document still listing google_pay (published before the change) is served without it.
    await publish("rider_app_config", "Z001", riderDoc({ paymentMethods: ["cash", "google_pay", "apple_pay", "card"] }));
    const se = (await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json();
    expect(se.paymentMethods).toEqual(["cash", "apple_pay", "card"]);
    expect(se.paymentOptions).toEqual([{ method: "cash", status: "available" }, { method: "apple_pay", status: "coming_soon" }, { method: "card", status: "coming_soon" }]);
    const fr = (await call(app, "GET", "/driver/config?zoneId=FR-PC", driverA.headers)).json();
    expect(fr.paymentOptions.map((o: { method: string }) => o.method)).toEqual(["cash", "card", "apple_pay"]);
    expect(adminMethodsOf(undefined)).toEqual(["cash", "card", "apple_pay"]);
    expect(paymentOptionsOf({ paymentMethods: ["card"] }, ["cash", "card"])).toEqual([{ method: "card", status: "available" }]);
  });

  it("booking: Apple Pay → coming soon, Google Pay → not available, cash off in admin → off; never a silent fail (SE and FR)", async () => {
    const apple = await book(NORRMALM, SODERMALM, "apple_pay");
    expect(apple.statusCode).toBe(400);
    expect(apple.json()).toMatchObject({ code: "invalid_request", reason: "payment_method_coming_soon" });
    const google = await book(NORRMALM, SODERMALM, "google_pay");
    expect(google.statusCode).toBe(400);
    expect(google.json()).toMatchObject({ reason: "payment_method_not_available" });
    await publish("rider_app_config", "FR-PC", riderDoc({ paymentMethods: ["card"] }, true));
    const offInParis = await book(PARIS, PARIS_DROP, "cash");
    expect(offInParis.statusCode).toBe(400);
    expect(offInParis.json()).toMatchObject({ reason: "payment_method_off" });
    expect((await book(PARIS, PARIS_DROP, "card")).json()).toMatchObject({ reason: "payment_method_coming_soon" });
    expect((await book(NORRMALM, SODERMALM, "cash")).statusCode).toBe(201);
  });
});

describe("tips per country, 100 % to the driver (owner item 1)", () => {
  it("Stockholm: 20 kr in cash after the trip → on the trip for both, in the driver's earnings and his one number; once only", async () => {
    const { tripId } = await finished();
    const before = await view(tripId, driverA.headers);
    const tip = await call(app, "POST", `/trips/${tripId}/tip`, rider, { amount: { amountMinor: 2000, currency: "SEK" }, method: "cash" });
    expect(tip.statusCode, tip.body).toBe(201);
    expect(tip.json()).toMatchObject({ amount: { amountMinor: 2000, currency: "SEK" }, method: "cash", driverShare: { amountMinor: 2000 } });
    const forDriver = await view(tripId, driverA.headers);
    expect(forDriver.tip).toMatchObject({ amount: { amountMinor: 2000 }, method: "cash", driverShare: { amountMinor: 2000 } });
    expect(forDriver.driverTotal.amountMinor).toBe(before.driverTotal.amountMinor + 2000);
    expect(forDriver.earningsBreakdown).toContainEqual({ code: "tip", amount: { amountMinor: 2000, currency: "SEK" } });
    const forRider = await view(tripId, rider);
    expect(forRider.tip).toEqual({ amount: { amountMinor: 2000, currency: "SEK" }, method: "cash", at: clock.now.toISOString() });
    const entry = await database.db.selectFrom("earnings_entries").selectAll().where("trip_id", "=", tripId).where("kind", "=", "tip").executeTakeFirstOrThrow();
    expect([Number(entry.amount_minor), Number(entry.cash_minor)]).toEqual([2000, 2000]);
    const earnings = (await call(app, "GET", "/driver/earnings?period=day", driverA.headers)).json();
    expect(earnings.periods.at(-1).tips.amountMinor).toBeGreaterThanOrEqual(2000);
    const again = await call(app, "POST", `/trips/${tripId}/tip`, rider, { amount: { amountMinor: 1000, currency: "SEK" }, method: "cash" });
    expect([again.statusCode, again.json().reason]).toEqual([409, "tip_already_given"]);
  });

  it("only the admin's amounts; card is coming soon; no tip before the end; tips off when no amount is on", async () => {
    const trip = await accepted();
    const early = await call(app, "POST", `/trips/${trip.tripId}/tip`, rider, { amount: { amountMinor: 1000, currency: "SEK" }, method: "cash" });
    expect([early.statusCode, early.json().reason]).toEqual([409, "tip_not_allowed"]);
    const v = await onBoard(trip);
    await moveTo(SODERMALM, 600);
    await complete(trip.tripId, v);
    const odd = await call(app, "POST", `/trips/${trip.tripId}/tip`, rider, { amount: { amountMinor: 1500, currency: "SEK" }, method: "cash" });
    expect([odd.statusCode, odd.json().reason]).toEqual([400, "tip_amount_not_allowed"]);
    const card = await call(app, "POST", `/trips/${trip.tripId}/tip`, rider, { amount: { amountMinor: 1000, currency: "SEK" }, method: "card" });
    expect([card.statusCode, card.json().reason]).toEqual([400, "payment_method_coming_soon"]);
    await publish("rider_app_config", "Z001", riderDoc({ tips: sample("rider_app_config").tips.map((t: Doc) => ({ ...t, enabled: false })) }));
    const off = await call(app, "POST", `/trips/${trip.tripId}/tip`, rider, { amount: { amountMinor: 1000, currency: "SEK" }, method: "cash" });
    expect([off.statusCode, off.json().reason]).toEqual([400, "tips_not_available"]);
  });

  it("Paris: 1 / 2 / 5 € (never 0,90 €); a tip with the rating", async () => {
    const trip = await forcedParis();
    const v = await onBoard(trip, PARIS);
    await moveTo(PARIS_DROP, 600);
    await complete(trip.tripId, v);
    const converted = await call(app, "POST", `/trips/${trip.tripId}/tip`, rider, { amount: { amountMinor: 90, currency: "EUR" }, method: "cash" });
    expect(converted.json().reason).toBe("tip_amount_not_allowed");
    const rated = await call(app, "POST", `/trips/${trip.tripId}/rating`, rider, { stars: 5, tip: { amountMinor: 500, currency: "EUR" } });
    expect(rated.statusCode, rated.body).toBe(201);
    expect((await view(trip.tripId, driverA.headers)).tip).toMatchObject({ amount: { amountMinor: 500, currency: "EUR" }, method: "cash" });
    // The seed writes the country's own amounts for a euro zone.
    const seeded = sampleForZone(sample("rider_app_config"), { zoneId: "standard-FR", currency: "EUR", country: "FR", timeZone: "Europe/Paris" });
    expect((seeded["tipRules"] as Doc)["customMax"]).toEqual({ amountMinor: 2000, currency: "EUR" });
    expect((seeded["tips"] as Array<{ amount: { amountMinor: number } }>).map((t) => t.amount.amountMinor)).toEqual([100, 200, 500]);
  });
});

describe("builder questions resolved: tip rules and one early-end rule", () => {
  it("cash tip only in the car (5 min) unless the admin allows it after; custom amounts up to the country max (SE and FR)", async () => {
    const { tripId } = await finished();
    clock.now = new Date(clock.now.getTime() + 6 * 60_000);
    rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    driverA.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    const late = await call(app, "POST", `/trips/${tripId}/tip`, rider, { amount: { amountMinor: 1000, currency: "SEK" }, method: "cash" });
    expect([late.statusCode, late.json().reason]).toEqual([409, "tip_cash_after_trip_off"]);
    await publish("rider_app_config", "Z001", riderDoc({ tipRules: { cashAfterTrip: true, customAmount: true } }));
    const tooMuch = await call(app, "POST", `/trips/${tripId}/tip`, rider, { amount: { amountMinor: 20100, currency: "SEK" }, method: "cash" });
    expect([tooMuch.statusCode, tooMuch.json().reason]).toEqual([400, "tip_above_max"]);
    expect((await call(app, "POST", `/trips/${tripId}/tip`, rider, { amount: { amountMinor: 4500, currency: "SEK" }, method: "cash" })).statusCode).toBe(201);
    const trip = await forcedParis();
    const v = await onBoard(trip, PARIS);
    await moveTo(PARIS_DROP, 600);
    await complete(trip.tripId, v);
    const custom = await call(app, "POST", `/trips/${trip.tripId}/tip`, rider, { amount: { amountMinor: 300, currency: "EUR" }, method: "cash" });
    expect([custom.statusCode, custom.json().reason]).toEqual([400, "tip_amount_not_allowed"]);
    await publish("rider_app_config", "FR-PC", riderDoc({ tipRules: { customAmount: true } }, true));
    expect((await call(app, "POST", `/trips/${trip.tripId}/tip`, rider, { amount: { amountMinor: 2100, currency: "EUR" }, method: "cash" })).json().reason).toBe("tip_above_max");
    expect((await call(app, "POST", `/trips/${trip.tripId}/tip`, rider, { amount: { amountMinor: 300, currency: "EUR" }, method: "cash" })).statusCode).toBe(201);
  });

  it("driver cancel with the rider on board, 450 m short after the booked time → booked price (same 2 km / 8 min rule)", async () => {
    const trip = await accepted();
    const booked = (await view(trip.tripId, rider)).fare.amountMinor;
    const v = await onBoard(trip);
    await moveTo(NEAR_SODER, 600);
    const res = await call(app, "POST", `/trips/${trip.tripId}/cancel`, driverA.headers, { expectedVersion: v, reasonCode: "rider_behavior" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().fare.amountMinor).toBe(booked);
    expect(res.json().finish).toMatchObject({ endedEarly: true, endedBy: "driver", repriced: false });
  });
});

describe("Q1: the rider ends early → the driver gets the finish (amount driven, cash, rating)", () => {
  it("Stockholm: finish on the driver's view with the cash to collect and his one number; the driver rates", async () => {
    const trip = await accepted();
    const v = await onBoard(trip);
    await moveTo(NEAR_SODER, 300);
    const ended = await call(app, "POST", `/trips/${trip.tripId}/end-early`, rider, { expectedVersion: v, reasonCode: "plans_changed" });
    expect(ended.statusCode, ended.body).toBe(200);
    const d = await view(trip.tripId, driverA.headers);
    expect(d.status).toBe("cancelled_by_rider");
    expect(d.finish).toMatchObject({ endedEarly: true, endedBy: "rider", reasonCode: "plans_changed", ratingAllowed: true });
    expect(d.finish.total).toEqual(d.fare);
    expect(d.finish.cashToCollect.amountMinor).toBe(d.fare.amountMinor);
    expect(d.finish.driverTotal).toEqual(d.driverTotal);
    expect(d.ratingStatus).toBe("pending");
    const r = await view(trip.tripId, rider);
    expect(r.finish).toMatchObject({ endedEarly: true, endedBy: "rider", ratingAllowed: true });
    expect(r.finish.driverTotal).toBeUndefined();
    const rate = await call(app, "POST", `/trips/${trip.tripId}/rating`, driverA.headers, { stars: 4 });
    expect(rate.statusCode, rate.body).toBe(201);
    // Fail-before: the trip ended by the rider can be tipped too.
    expect((await call(app, "POST", `/trips/${trip.tripId}/tip`, rider, { amount: { amountMinor: 1000, currency: "SEK" }, method: "cash" })).statusCode).toBe(201);
  });
});

describe("Q2: the driver ends early → stop waiting kept; a new price only over the admin's km / minutes", () => {
  it("defaults 2 km / 8 min; out of range reads as the default", () => {
    expect(earlyEndSettingsOf(undefined)).toEqual({ repriceOverKm: 2, repriceOverMin: 8 });
    expect(earlyEndSettingsOf({ cancelFees: { earlyEnd: { repriceOverKm: 99, repriceOverMin: 3 } } })).toEqual({ repriceOverKm: 2, repriceOverMin: 3 });
  });

  it("Stockholm: 450 m short of the drop-off after the booked time → the booked price stands, marked ended early", async () => {
    const trip = await accepted();
    const booked = (await view(trip.tripId, rider)).fare.amountMinor;
    const v = await onBoard(trip);
    await moveTo(NEAR_SODER, 600);
    const { preview, done } = await complete(trip.tripId, v);
    expect(preview).toMatchObject({ earlyEnd: true, repriced: false });
    expect(preview.shortKm).toBeLessThanOrEqual(2);
    expect(done.fare.amountMinor).toBe(booked);
    expect(done.finish).toMatchObject({ endedEarly: true, endedBy: "driver", repriced: false });
  });

  it("ended right after boarding on a long trip → re-priced (what was driven); with the admin's 50 km the booked price stands", async () => {
    const trip = await accepted(NORRMALM, BROMMA);
    const booked = (await view(trip.tripId, rider)).fare.amountMinor;
    const v = await onBoard(trip);
    const { preview, done } = await complete(trip.tripId, v);
    expect(preview).toMatchObject({ earlyEnd: true, repriced: true });
    expect(preview.shortKm).toBeGreaterThan(2);
    expect(done.fare.amountMinor).toBeLessThan(booked);
    // Admin › Cancellation: 50 km / 120 min → a trip booked after it keeps its booked price (snapshot at booking).
    await publish("driver_app_config", "Z001", driverDoc({ cancelFees: { earlyEnd: { repriceOverKm: 50, repriceOverMin: 120 } } }));
    const kept = await accepted(NORRMALM, BROMMA);
    const keptBooked = (await view(kept.tripId, rider)).fare.amountMinor;
    const kv = await onBoard(kept);
    const second = await complete(kept.tripId, kv);
    expect(second.preview).toMatchObject({ earlyEnd: true, repriced: false });
    expect(second.done.fare.amountMinor).toBe(keptBooked);
  });

  it("paid stop waiting is kept when the driver ends early (fail-before: it was dropped)", async () => {
    const stop = { address: "Hötorget", lat: 59.3346, lng: 18.0632 };
    const trip = await accepted(NORRMALM, SODERMALM, [stop]);
    const booked = (await view(trip.tripId, rider)).fare.amountMinor;
    let v = await onBoard(trip);
    await moveTo(stop, 60);
    const arrived = await call(app, "POST", `/driver/trips/${trip.tripId}/stops/0/arrive`, driverA.headers, { expectedVersion: v });
    expect(arrived.statusCode, arrived.body).toBe(200);
    v = arrived.json().version;
    clock.now = new Date(clock.now.getTime() + 4 * 60_000);
    const left = await call(app, "POST", `/driver/trips/${trip.tripId}/stops/0/leave`, driverA.headers, { expectedVersion: v });
    v = left.json().version;
    await moveTo(NEAR_SODER, 400);
    const { done } = await complete(trip.tripId, v);
    expect(done.finish.endedEarly).toBe(true);
    const stopLine = done.fareLines.find((l: { code: string }) => l.code === "stop_waiting");
    expect(stopLine?.amount.amountMinor).toBeGreaterThan(0);
    expect(done.fare.amountMinor).toBeGreaterThan(booked);
  });
});

describe("Q3: one driver money number incl. pickup pay", () => {
  it("the cash sheet (preview) and the finished trip show the same driverTotal = earnings + pickup pay + bonus", async () => {
    const trip = await accepted();
    await database.db.updateTable("trips").set({ pickup_pay_minor: 360 }).where("trip_id", "=", trip.tripId).execute();
    const v = await onBoard(trip);
    await moveTo(SODERMALM, 600);
    const { preview, done } = await complete(trip.tripId, v);
    expect(preview.driverTotal.amountMinor).toBe(preview.driverEarnings.amountMinor + 360);
    expect(preview.earningsBreakdown).toContainEqual({ code: "pickup_pay", amount: { amountMinor: 360, currency: "SEK" } });
    expect(done.driverTotal).toEqual(preview.driverTotal);
    expect(done.finish.driverTotal).toEqual(preview.driverTotal);
  });
});

describe("the rider's old debt is not Movera's commission (live bug 2026-11-01)", () => {
  it("a cash trip carrying a 240 kr old fee: commission without it, debtCollected and who gets what add up", async () => {
    const old = await accepted();
    await database.db.updateTable("trips").set({ status: "cancelled_by_rider" }).where("trip_id", "=", old.tripId).execute();
    await database.db.insertInto("rider_fees").values({ trip_id: old.tripId, rider_id: riderId, kind: "cancel", currency: "SEK", amount_minor: 24000, status: "owed", created_at: clock.now }).execute();
    await database.db.updateTable("riders").set({ outstanding_minor: 24000, outstanding_currency: "SEK", outstanding_source_trip_id: old.tripId }).where("rider_id", "=", riderId).execute();
    await database.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", driverA.id).execute();
    const { tripId, done } = await finished();
    expect(done.fareLines).toContainEqual(expect.objectContaining({ code: "outstanding_fee", amount: { amountMinor: 24000, currency: "SEK" } }));
    expect(done.debtCollected).toEqual({ amountMinor: 24000, currency: "SEK" });
    expect(done.commission.amountMinor).toBe(done.fare.amountMinor - 24000 - done.driverEarnings.amountMinor - (done.pickupPay?.amountMinor ?? 0));
    expect(done.commission.amountMinor).toBeGreaterThanOrEqual(0);
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const a = (await call(app, "GET", `/admin/trips/${tripId}`, admin.headers)).json();
    expect(a.moneySplit.driverTotal.amountMinor + a.moneySplit.movera.amountMinor + a.moneySplit.debtCollected.amountMinor).toBe(a.fare.amountMinor);
    expect(commissionOf(31800, [{ code: "outstanding_fee", amount: { amountMinor: 24000 } }], 6005, 0, 0)).toBe(1795);
    const receipt = (await call(app, "GET", `/trips/${tripId}/receipt`, rider)).json();
    expect(receipt.debtIncluded).toEqual({ amountMinor: 24000, currency: "SEK" });
  });
});

describe("receipts, resend, driver pay change, refund from the driver (admin, live)", () => {
  it("receipt: not before the end; after the rider's early end it says ended early and why", async () => {
    const trip = await accepted();
    const early = await call(app, "GET", `/trips/${trip.tripId}/receipt`, rider);
    expect([early.statusCode, early.json().reason]).toEqual([409, "receipt_not_ready"]);
    const v = await onBoard(trip);
    await moveTo(NEAR_SODER, 300);
    await call(app, "POST", `/trips/${trip.tripId}/end-early`, rider, { expectedVersion: v, reasonCode: "plans_changed" });
    const receipt = (await call(app, "GET", `/trips/${trip.tripId}/receipt`, rider)).json();
    expect(receipt).toMatchObject({ tripId: trip.tripId, country: "SE", currency: "SEK", paymentMethod: "cash", endedEarly: true, endedBy: "rider", endedEarlyReason: "plans_changed", refunded: { amountMinor: 0 } });
    expect(receipt.cashPaid).toEqual(receipt.total);
    const forDriver = (await call(app, "GET", `/driver/trips/${trip.tripId}/receipt`, driverA.headers)).json();
    expect(forDriver.walletPaid).toBeUndefined();
  });

  it("resend: a bell notice 'Ditt kvitto' to the rider, audited with the reason", async () => {
    const { tripId } = await finished();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const sent = await call(app, "POST", `/admin/trips/${tripId}/receipt/resend`, admin.headers, { reason: "Rider asked by phone" });
    expect(sent.statusCode, sent.body).toBe(200);
    const notice = await database.db.selectFrom("notifications").selectAll().where("notification_id", "=", sent.json().notificationId).executeTakeFirstOrThrow();
    expect(notice).toMatchObject({ audience: "rider", subject_id: riderId, kind: "receipt", title: "Ditt kvitto", trip_id: tripId });
    const log = await database.db.selectFrom("admin_audit").selectAll().where("action", "=", "trip.receipt_resend").where("target_id", "=", tripId).executeTakeFirstOrThrow();
    expect(JSON.stringify(log.detail)).toContain("Rider asked by phone");
    expect((await call(app, "GET", `/admin/trips/${tripId}/receipt`, admin.headers)).json().tripId).toBe(tripId);
  });

  it("driver pay: +50 kr after the end moves his one number, an earnings entry, audit and a notice; never below 0; not before the end", async () => {
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const live = await accepted();
    const notEnded = await call(app, "POST", `/admin/trips/${live.tripId}/driver-pay`, admin.headers, { change: { amountMinor: 5000, currency: "SEK" }, reason: "x" });
    expect([notEnded.statusCode, notEnded.json().reason]).toEqual([409, "driver_pay_not_ended"]);
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", live.tripId).execute();
    await database.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", driverA.id).execute();
    const { tripId, done } = await finished();
    const paid = await call(app, "POST", `/admin/trips/${tripId}/driver-pay`, admin.headers, { change: { amountMinor: 5000, currency: "SEK" }, reason: "Long wait at the airport" });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().driverTotal.amountMinor).toBe(done.driverTotal.amountMinor + 5000);
    expect(paid.json().driverAdjustments).toEqual({ amountMinor: 5000, currency: "SEK" });
    expect((await view(tripId, driverA.headers)).earningsBreakdown).toContainEqual({ code: "adjustment", amount: { amountMinor: 5000, currency: "SEK" } });
    const entries = await database.db.selectFrom("earnings_entries").select("amount_minor").where("trip_id", "=", tripId).where("kind", "=", "adjustment").execute();
    expect(entries.map((e) => Number(e.amount_minor))).toEqual([5000]);
    expect(await database.db.selectFrom("admin_audit").select("action").where("action", "=", "trip.driver_pay").where("target_id", "=", tripId).executeTakeFirst()).toBeDefined();
    expect(await database.db.selectFrom("notifications").select("kind").where("kind", "=", "driver_pay_changed").where("trip_id", "=", tripId).executeTakeFirst()).toBeDefined();
    const below = await call(app, "POST", `/admin/trips/${tripId}/driver-pay`, admin.headers, { change: { amountMinor: -10_000_000, currency: "SEK" }, reason: "x" });
    expect([below.statusCode, below.json().reason]).toEqual([400, "driver_pay_below_zero"]);
  });

  it("refund taken from the driver: his share comes off his one number; moneySplit shows the refund (France)", async () => {
    const trip = await forcedParis();
    const v = await onBoard(trip, PARIS);
    await moveTo(PARIS_DROP, 600);
    const { done } = await complete(trip.tripId, v);
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const refund = await call(app, "POST", `/admin/trips/${trip.tripId}/refund`, admin.headers, { expectedVersion: done.version, amount: { amountMinor: 200, currency: "EUR" }, reason: "Detour", fromDriver: true });
    expect(refund.statusCode, refund.body).toBe(201);
    const a = (await call(app, "GET", `/admin/trips/${trip.tripId}`, admin.headers)).json();
    expect(a.moneySplit.refunded).toEqual({ amountMinor: 200, currency: "EUR" });
    expect(a.moneySplit.riderPaid.amountMinor).toBe(done.fare.amountMinor - 200);
    expect(a.driverAdjustments.amountMinor).toBeLessThan(0);
    expect(a.driverTotal.amountMinor).toBe(done.driverTotal.amountMinor + a.driverAdjustments.amountMinor);
  });
});

describe("realtime: the stored admin projection never gives the rider the driver's money", () => {
  it("rider stream: no driverTotal / breakdown / debt / moneySplit / tip share; driver stream: no moneySplit, his own ratingAllowed; both get sosAvailable", async () => {
    const { tripId } = await finished();
    await call(app, "POST", `/trips/${tripId}/tip`, rider, { amount: { amountMinor: 1000, currency: "SEK" }, method: "cash" });
    const event = await database.db.selectFrom("trip_events").select("projection").where("trip_id", "=", tripId).orderBy("sequence", "desc").executeTakeFirstOrThrow();
    const stored = event.projection as Record<string, unknown>;
    expect(stored["moneySplit"]).toBeDefined();
    const forRider = redactProjection(stored, "rider");
    for (const key of ["driverTotal", "earningsBreakdown", "driverAdjustments", "debtCollected", "moneySplit", "driverEarnings", "commission"]) expect(forRider[key]).toBeUndefined();
    expect((forRider["finish"] as Doc)["driverTotal"]).toBeUndefined();
    expect((forRider["tip"] as Doc)["driverShare"]).toBeUndefined();
    expect(forRider["sosAvailable"]).toBe(false);
    const forDriver = redactProjection(stored, "driver");
    expect(forDriver["moneySplit"]).toBeUndefined();
    expect(forDriver["driverTotal"]).toBeDefined();
    expect((forDriver["finish"] as Doc)["ratingAllowed"]).toBe(true);
  });
});

describe("Q4: SOS only once a driver is assigned", () => {
  it("sosAvailable is false while searching and true once accepted", async () => {
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", driverA.id).execute();
    const res = await book(NORRMALM, SODERMALM);
    expect((await view(res.json().tripId, rider)).sosAvailable).toBe(false);
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", res.json().tripId).execute();
    await database.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", driverA.id).execute();
    const trip = await accepted();
    expect((await view(trip.tripId, rider)).sosAvailable).toBe(true);
    expect((await view(trip.tripId, driverA.headers)).sosAvailable).toBe(true);
  });
});

describe("migration 0045: stored documents lose google_pay; French converted tips become 1 / 2 / 5 €; commission fixed", () => {
  it("runs again safely on old documents and trips", async () => {
    await publish("rider_app_config", "FR-PC", { ...riderDoc({}, true), paymentMethods: ["cash", "google_pay"], tips: [90, 180, 270].map((amountMinor) => ({ amount: { amountMinor, currency: "EUR" }, enabled: true })) });
    const { tripId } = await finished();
    await database.db.updateTable("trips").set({ fare_lines: JSON.stringify([{ code: "base", amount: { amountMinor: 7800, currency: "SEK" } }, { code: "outstanding_fee", amount: { amountMinor: 24000, currency: "SEK" } }]), fare_minor: 31800, driver_earnings_minor: 6005, pickup_pay_minor: 0, driver_bonus_minor: 0, commission_minor: 25795 }).where("trip_id", "=", tripId).execute();
    await sql.raw(readFileSync("migrations/0045_finish.sql", "utf8")).execute(database.db);
    const live = await database.db.selectFrom("config_live").select(["document", "version"]).where("doc", "=", "rider_app_config").where("zone_id", "=", "FR-PC").executeTakeFirstOrThrow();
    const doc = live.document as { paymentMethods: string[]; tips: Array<{ amount: { amountMinor: number } }> };
    expect(doc.paymentMethods).toEqual(["cash"]);
    expect(doc.tips.map((t) => t.amount.amountMinor)).toEqual([100, 200, 500]);
    const row = await database.db.selectFrom("trips").select("commission_minor").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(Number(row.commission_minor)).toBe(1795);
  });
});
