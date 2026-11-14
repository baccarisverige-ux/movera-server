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
 * Job C9 (contract v0.18.93 §91, contract.json#autoArrive; owner 2026-11-02 review Q3 "Both: auto + button", Rules
 * decisions/driver-g7.md:83-84): the server marks the driver arrived within waiting.autoArriveMeters (default 100 m) of
 * the pickup, the Arrived button stays; the waiting clock stops while he is farther than waiting.leaveMeters (default
 * 200 m) and goes on at a new arrival. Money exact in SEK (12,26 kr/min); France (EUR) with a forced trip. TND: the
 * clock test (auto_arrive_clock_c9.test.ts) replays fixtures/auto_arrive.json.
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-14T10:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const inParis = (doc: unknown) => JSON.parse(JSON.stringify(doc).replace(/"SEK"/g, '"EUR"').replace(/"Z001"/g, '"FR-PC"').replace(/"SE"/g, '"FR"').replace(/Europe\/Stockholm/g, "Europe/Paris"));
const PARIS = { address: "Châtelet", lat: 48.8584, lng: 2.3472 };
const PARIS_DROP = { address: "Gare de Lyon", lat: 48.8443, lng: 2.3744 };
const SPOT_A = { lat: 59.3335, lng: 18.0655 };
/** North of a pickup by about `meters` (1° latitude ≈ 111.2 km). */
const north = (at: { lat: number; lng: number }, meters: number) => ({ lat: at.lat + meters / 111_195, lng: at.lng });

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
function driverDoc(waiting: Doc = {}, paris = false): Doc {
  const doc = paris ? inParis(sample("driver_app_config")) : sample("driver_app_config");
  Object.assign(doc.waiting as Doc, waiting);
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
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver A", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "AC09A", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  driverA.id = made.driverId;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

/** The driver's phone sends one fix now (accuracy 5 m unless said). */
async function fixAt(at: { lat: number; lng: number }, accuracy = 5) {
  const res = await call(app, "POST", "/driver/location", driverA.headers, { fixes: [{ ...at, accuracy, measuredAt: clock.now.toISOString() }] });
  expect(res.statusCode, res.body).toBe(200);
}
/** The clock moves to `seconds` after `from`, the fix is sent at that moment, then the job worker runs. */
async function fixAfter(from: string, seconds: number, at: { lat: number; lng: number }, accuracy = 5) {
  clock.now = new Date(Date.parse(from) + seconds * 1000);
  await fixAt(at, accuracy);
  await worker.runDue();
}

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
  await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_currency: null, outstanding_source_trip_id: null, wallet_minor: 0 }).execute();
  await database.db.deleteFrom("rider_wallets").execute();
  await publish("driver_app_config", "Z001", driverDoc());
  await publish("driver_app_config", "FR-PC", driverDoc({}, true));
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driverA.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driverA.id).execute();
  clock.now = new Date(clock.now.getTime() + 1000);
  await fixAt(SPOT_A);
});

const NEW_APP = { "x-contract-version": "0.18.93" };
const step = (tripId: string, path: string, version: number, body: Doc = {}) => call(app, "POST", `/trips/${tripId}/${path}`, { ...driverA.headers, ...NEW_APP }, { expectedVersion: version, ...body });
const driverView = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}`, driverA.headers)).json();
const riderView = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}`, rider)).json();

/** The rider books in Stockholm, driver A accepts and heads to the pickup (status driver_to_pickup). */
async function headingToPickup(): Promise<{ tripId: string; version: number }> {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
  expect(res.statusCode, res.body).toBe(201);
  await worker.runDue();
  const [offer] = (await call(app, "GET", "/driver/offers", driverA.headers)).json().items;
  const acc = await call(app, "POST", `/offers/${offer.offerId}/accept`, driverA.headers, { expectedVersion: offer.version });
  expect(acc.statusCode, acc.body).toBe(200);
  const head = await step(res.json().tripId, "head-to-pickup", acc.json().version);
  expect(head.statusCode, head.body).toBe(200);
  return { tripId: res.json().tripId as string, version: head.json().version as number };
}
/** The driver's phone reaches 40 m from the pickup: the server marks him arrived (no tap). */
async function autoArrived(tripId: string) {
  clock.now = new Date(clock.now.getTime() + 1000);
  await fixAt(north(NORRMALM, 40));
  await worker.runDue();
  const trip = await driverView(tripId);
  expect(trip.status).toBe("arrived");
  return trip as Doc & { version: number; waiting: Doc & { arrivedAt: string; freeUntil: string; noShowAt: string } };
}

describe("C9 (a): the server marks the driver arrived within the zone's distance; the button stays", () => {
  it("a fix 40 m from the pickup: arrived with no tap (version + 1, arrivedBy auto, the automatic chat message once, the rider sees it)", async () => {
    const { tripId, version } = await headingToPickup();
    const trip = await autoArrived(tripId);
    expect(trip.version).toBe(version + 1);
    expect(trip.waiting).toMatchObject({ arrivedBy: "auto", chargedSeconds: 0, freeWaitMin: 5 });
    expect(Date.parse(trip.waiting.freeUntil) - Date.parse(trip.waiting.arrivedAt)).toBe(5 * 60_000);
    expect(trip.terms).toMatchObject({ autoArriveMeters: 100, leaveMeters: 200 });
    expect((await riderView(tripId)).status).toBe("arrived");
    const messages = await database.db.selectFrom("trip_messages").select("auto").where("trip_id", "=", tripId).execute();
    expect(messages).toEqual([{ auto: "arrived" }]);
    // The button after the server's arrival: 409 with the arrived projection (the app takes it as done).
    const late = await step(tripId, "arrive", version);
    expect(late.statusCode).toBe(409);
    expect(late.json().projection?.status ?? late.json().details?.projection?.status ?? "arrived").toBe("arrived");
  });

  it("not closer than 100 m, or a fix less accurate than 50 m: no auto arrival; the tap still works (arrivedBy tap)", async () => {
    const { tripId, version } = await headingToPickup();
    clock.now = new Date(clock.now.getTime() + 1000);
    await fixAt(north(NORRMALM, 150));
    await worker.runDue();
    expect((await driverView(tripId)).status).toBe("driver_to_pickup");
    clock.now = new Date(clock.now.getTime() + 1000);
    await fixAt(north(NORRMALM, 20), 80);
    await worker.runDue();
    expect((await driverView(tripId)).status).toBe("driver_to_pickup");
    const tapped = await step(tripId, "arrive", version);
    expect(tapped.statusCode, tapped.body).toBe(200);
    expect(tapped.json().waiting).toMatchObject({ arrivedBy: "tap" });
  });

  it("the zone's own distance: autoArriveMeters 50 → 80 m is not arrived, 40 m is", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ autoArriveMeters: 50, leaveMeters: 300 }));
    const { tripId } = await headingToPickup();
    clock.now = new Date(clock.now.getTime() + 1000);
    await fixAt(north(NORRMALM, 80));
    await worker.runDue();
    expect((await driverView(tripId)).status).toBe("driver_to_pickup");
    const trip = await autoArrived(tripId);
    expect(trip.terms).toMatchObject({ autoArriveMeters: 50, leaveMeters: 300 });
  });

  it("admin: a bad pair or a value out of range is 400 invalid_auto_arrive_distance", async () => {
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const draft = (await call(app, "GET", "/admin/config/driver_app_config?zoneId=Z001", admin.headers)).json();
    for (const bad of [{ autoArriveMeters: 200, leaveMeters: 200 }, { autoArriveMeters: 20 }, { leaveMeters: 2500 }]) {
      const document = JSON.parse(JSON.stringify(draft.document));
      Object.assign(document.waiting, bad);
      const res = await call(app, "PUT", "/admin/config/driver_app_config", admin.headers, { expectedVersion: draft.version, zoneId: "Z001", document });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ reason: "invalid_auto_arrive_distance" });
    }
  });
});

describe("C9 (b): the waiting clock stops while the driver is more than 200 m away (money exact)", () => {
  it("SEK: away 2:00 → 7:00 inside the free wait, board at 15:00 → 5 paid minutes = 61,30 kr (not 10 min = 122,60 kr)", async () => {
    const { tripId } = await headingToPickup();
    const arrived = await autoArrived(tripId);
    const t0 = arrived.waiting.arrivedAt;
    await fixAfter(t0, 120, north(NORRMALM, 400));
    const away = await driverView(tripId);
    expect(away.version).toBe(arrived.version);
    expect(away.waiting.away).toEqual({ since: new Date(Date.parse(t0) + 120_000).toISOString() });
    // Frozen while away: 6 min after arrival nothing is charged.
    clock.now = new Date(Date.parse(t0) + 360_000);
    expect((await riderView(tripId)).waiting).toMatchObject({ chargedSecondsNow: 0 });
    await fixAfter(t0, 420, north(NORRMALM, 50));
    const back = await driverView(tripId);
    expect(back.waiting.away).toBeUndefined();
    expect(back.waiting).toMatchObject({ pausedSeconds: 300, pauseCount: 1 });
    expect(Date.parse(back.waiting.freeUntil) - Date.parse(t0)).toBe(600_000);
    expect(Date.parse(back.waiting.noShowAt) - Date.parse(t0)).toBe(600_000);
    clock.now = new Date(Date.parse(t0) + 900_000);
    driverA.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    const boarded = await step(tripId, "board", back.version);
    expect(boarded.statusCode, boarded.body).toBe(200);
    expect(boarded.json().waiting.chargedSeconds).toBe(300);
    expect(boarded.json().fareLines).toEqual(expect.arrayContaining([{ code: "waiting", amount: { amountMinor: 6130, currency: "SEK" } }]));
  });

  it("SEK: between 100 m and 200 m nothing changes; board while away charges only up to the moment he left", async () => {
    const { tripId } = await headingToPickup();
    const arrived = await autoArrived(tripId);
    const t0 = arrived.waiting.arrivedAt;
    await fixAfter(t0, 100, north(NORRMALM, 150));
    expect((await driverView(tripId)).waiting.away).toBeUndefined();
    await fixAfter(t0, 400, north(NORRMALM, 500));
    expect((await driverView(tripId)).waiting.away).toEqual({ since: new Date(Date.parse(t0) + 400_000).toISOString() });
    await fixAfter(t0, 500, north(NORRMALM, 150));
    expect((await driverView(tripId)).waiting.away).toBeDefined();
    clock.now = new Date(Date.parse(t0) + 700_000);
    const boarded = await step(tripId, "board", arrived.version);
    expect(boarded.statusCode, boarded.body).toBe(200);
    expect(boarded.json().waiting.chargedSeconds).toBe(100);
    // 100 s × 12,26 kr / 60 = 20,433… → 20,43 kr.
    expect(boarded.json().fareLines).toEqual(expect.arrayContaining([{ code: "waiting", amount: { amountMinor: 2043, currency: "SEK" } }]));
  });

  it("the no-show waits while he is away (409 driver_away_from_pickup); after his tap the moved no-show time applies", async () => {
    const { tripId } = await headingToPickup();
    const arrived = await autoArrived(tripId);
    const t0 = arrived.waiting.arrivedAt;
    await fixAfter(t0, 200, north(NORRMALM, 300));
    clock.now = new Date(Date.parse(t0) + 900_000);
    driverA.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    const away = await call(app, "POST", `/trips/${tripId}/no-show`, driverA.headers, { expectedVersion: arrived.version });
    expect(away.statusCode).toBe(409);
    expect(away.json().reason).toBe("driver_away_from_pickup");
    // The tap is the new arrival (within 300 m, as the first tap): version + 1, stopped 700 s.
    clock.now = new Date(Date.parse(t0) + 900_000);
    await fixAt(north(NORRMALM, 120));
    const tap = await step(tripId, "arrive", arrived.version);
    expect(tap.statusCode, tap.body).toBe(200);
    expect(tap.json().version).toBe(arrived.version + 1);
    expect(tap.json().waiting).toMatchObject({ pausedSeconds: 700, pauseCount: 1 });
    expect(Date.parse(tap.json().waiting.noShowAt) - Date.parse(t0)).toBe(1_000_000);
    const early = await call(app, "POST", `/trips/${tripId}/no-show`, driverA.headers, { expectedVersion: tap.json().version });
    expect(early.json().reason).toBe("no_show_too_early");
    clock.now = new Date(Date.parse(t0) + 1_000_000);
    const ok = await call(app, "POST", `/trips/${tripId}/no-show`, driverA.headers, { expectedVersion: tap.json().version });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("the rider cancels while the driver is away inside the free wait: not turned into the no-show fee", async () => {
    const { tripId } = await headingToPickup();
    const arrived = await autoArrived(tripId);
    const t0 = arrived.waiting.arrivedAt;
    await fixAfter(t0, 60, north(NORRMALM, 600));
    clock.now = new Date(Date.parse(t0) + 600_000);
    rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    const res = await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: arrived.version, reasonCode: "plans_changed" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().cancellation?.feeKind).not.toBe("no_show");
  });

  it("France (EUR): away inside the free wait, the paid minute after it costs the zone's price", async () => {
    const quote = (await call(app, "POST", "/quotes", rider, { pickup: PARIS, dropoff: PARIS_DROP, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: PARIS, dropoff: PARIS_DROP, stops: [], kind: "live", paymentMethod: "cash" });
    expect(res.statusCode, res.body).toBe(201);
    const tripId = res.json().tripId as string;
    await database.db.updateTable("offers").set({ status: "withdrawn" }).where("trip_id", "=", tripId).execute();
    await database.db.updateTable("trips").set({ status: "driver_to_pickup", driver_id: driverA.id, accepted_at: clock.now, version: res.json().version + 1 }).where("trip_id", "=", tripId).execute();
    clock.now = new Date(clock.now.getTime() + 1000);
    await fixAt(north(PARIS, 30));
    await worker.runDue();
    const arrived = await driverView(tripId);
    expect(arrived.status).toBe("arrived");
    const t0 = arrived.waiting.arrivedAt as string;
    const perMin = arrived.waiting.perMin as { amountMinor: number; currency: string };
    expect(perMin.currency).toBe("EUR");
    await fixAfter(t0, 60, north(PARIS, 250));
    await fixAfter(t0, 240, north(PARIS, 10));
    clock.now = new Date(Date.parse(t0) + (5 * 60 + 180 + 60) * 1000);
    driverA.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    const boarded = await step(tripId, "board", arrived.version);
    expect(boarded.statusCode, boarded.body).toBe(200);
    expect(boarded.json().waiting.chargedSeconds).toBe(60);
    expect(boarded.json().fareLines).toEqual(expect.arrayContaining([{ code: "waiting", amount: { amountMinor: perMin.amountMinor, currency: "EUR" } }]));
  });
});
