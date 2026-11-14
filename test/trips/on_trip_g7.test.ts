import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { readEnv } from "../../src/env.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { EstimateRouter } from "../../src/maps/routing.js";
import { isLongStop, kmFromRoute, measuredFields, stoppedMinutes, RIDE_CHECK_SCAN, rideCheckScanHandler } from "../../src/safety/rideCheckServer.js";
import { MAX_STOPS_DEFAULT, rideCheckSettingsOf, routeChangeSettingsOf } from "../../src/trips/onTripSettings.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, signIn, SODERMALM } from "../support/world.js";

/**
 * Driver group 7 "On trip" (contract v0.18.9 §35, contract.json#onTrip; Rules decisions/driver-g7.md, plan/g7-job-list.md):
 * the server's ride check from GPS asked to both sides, route change during the trip (rider proposes, driver accepts or
 * refuses), stop waiting price, max stops enforced, and the admin's trip tools. Sweden (Z001, SEK) and France (FR-PC, EUR).
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-02T10:00:00Z") };
const router = new EstimateRouter();
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const inParis = (doc: unknown) => JSON.parse(JSON.stringify(doc).replace(/"SEK"/g, '"EUR"').replace(/"Z001"/g, '"FR-PC"').replace(/"SE"/g, '"FR"').replace(/Europe\/Stockholm/g, "Europe/Paris"));
const PARIS = { address: "Châtelet", lat: 48.8584, lng: 2.3472 };
const PARIS_DROP = { address: "Gare de Lyon", lat: 48.8443, lng: 2.3744 };
const SPOT_A = { lat: 59.3335, lng: 18.0655 };
const FAR_EAST = { lat: 59.33, lng: 18.16 }; // ~5 km east of the Norrmalm → Södermalm line
const KUNGSHOLMEN = { address: "Fridhemsplan", lat: 59.3326, lng: 18.0296 };
const BROMMA = { address: "Brommaplan", lat: 59.3383, lng: 17.9393 };
const GAMLA_STAN = { address: "Stortorget", lat: 59.325, lng: 18.0707 };

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
const driverDoc = (change: Doc = {}, paris = false): Doc => {
  const doc = paris ? inParis(sample("driver_app_config")) : sample("driver_app_config");
  for (const [k, v] of Object.entries(change)) doc[k] = typeof v === "object" && v !== null && !Array.isArray(v) ? { ...(doc[k] as Doc), ...(v as Doc) } : v;
  return doc;
};
const riderDoc = (change: Doc = {}, paris = false): Doc => {
  const doc = paris ? inParis(sample("rider_app_config")) : sample("rider_app_config");
  for (const [k, v] of Object.entries(change)) doc[k] = typeof v === "object" && v !== null && !Array.isArray(v) ? { ...(doc[k] as Doc), ...(v as Doc) } : v;
  return doc;
};

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 1, document: JSON.stringify(sample("pricing_document")), published_at: clock.now, published_by: null }).execute();
  // A road router that follows the points (the off-route check and the route price use real distances).
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "g7-test-secret".padEnd(48, "g") }), logger: false, db: database.db, clock: () => clock.now, router });
  await publish("dispatch", "Z001", sample("dispatch_document"));
  await publish("pricing", "FR-PC", inParis(sample("pricing_document")));
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers, [RIDE_CHECK_SCAN]: rideCheckScanHandler(router) }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver A", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "G7A00", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
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
  await database.db.updateTable("rider_fees").set({ status: "waived", settled_in_wallet: true }).where("status", "=", "owed").execute();
  // S5 J8 (debtModel.riderWallet): the unpaid fee is a negative wallet balance; the reset clears it too.
  await database.db.updateTable("rider_wallets").set({ balance_minor: 0 }).where("balance_minor", "<", "0").execute();
  await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_currency: null, outstanding_source_trip_id: null, wallet_minor: 0 }).execute();
  await database.db.deleteFrom("rider_wallets").execute();
  await publish("driver_app_config", "Z001", driverDoc());
  await publish("driver_app_config", "FR-PC", driverDoc({}, true));
  await publish("rider_app_config", "Z001", riderDoc());
  await publish("rider_app_config", "FR-PC", riderDoc({}, true));
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driverA.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driverA.id).execute();
  await moveTo(SPOT_A);
});

const step = (tripId: string, path: string, version: number, body: Doc = {}) => call(app, "POST", `/trips/${tripId}/${path}`, driverA.headers, { expectedVersion: version, ...body });
const view = async (tripId: string, who: Record<string, string>) => (await call(app, "GET", `/trips/${tripId}`, who)).json();

/** Booked in Stockholm, accepted by driver A through dispatch. */
async function accepted(pickup = NORRMALM, dropoff = SODERMALM, stops: Doc[] = []) {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup, dropoff, stops, categoryIds: ["economy"] })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup, dropoff, stops, kind: "live", paymentMethod: "cash" });
  expect(res.statusCode, res.body).toBe(201);
  await worker.runDue();
  const [offer] = (await call(app, "GET", "/driver/offers", driverA.headers)).json().items;
  const acc = await call(app, "POST", `/offers/${offer.offerId}/accept`, driverA.headers, { expectedVersion: offer.version });
  expect(acc.statusCode, acc.body).toBe(200);
  return { tripId: res.json().tripId as string, version: acc.json().version as number };
}
/** A Paris trip given to driver A (the Paris dispatch is not under test). */
async function forcedParis() {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: PARIS, dropoff: PARIS_DROP, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: PARIS, dropoff: PARIS_DROP, stops: [], kind: "live", paymentMethod: "cash" });
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
const report = (tripId: string, who: "rider" | "driver", checkId: string, trigger: string, answer: "ok" | "need_help") =>
  call(app, "POST", `/${who}/trips/${tripId}/ride-check`, who === "rider" ? rider : driverA.headers, { checkId, trigger, at: clock.now.toISOString(), answer });

describe("settings with defaults (owner rule 16, decision 2: 2 km)", () => {
  it("ride check and route change defaults; a value outside its range reads as the default", () => {
    expect(rideCheckSettingsOf(undefined)).toEqual({ on: true, stopMinutes: 2, offRouteKm: 2, endFarMeters: 500, noAnswerSeconds: 120, repeatMinutes: 10, noAnswerAlarm: false });
    expect(rideCheckSettingsOf({ rideCheck: { offRouteKm: 99, stopMinutes: 5, on: "yes" } })).toMatchObject({ offRouteKm: 2, stopMinutes: 5, on: true });
    expect(routeChangeSettingsOf({ routeChange: { answerSeconds: 5, driverCanRefuse: false } })).toEqual({ on: true, driverCanRefuse: false, answerSeconds: 60, beforePickup: true, fixedPriceTrips: "block" });
    expect(MAX_STOPS_DEFAULT).toBe(3);
  });

  it("geometry: distance to the route and a long stop", () => {
    const line = [NORRMALM, SODERMALM];
    expect(kmFromRoute({ lat: 59.323, lng: 18.069 }, line)).toBeLessThan(0.3);
    expect(kmFromRoute(FAR_EAST, line)).toBeGreaterThan(4);
    const t0 = Date.parse("2026-11-02T10:00:00Z");
    const at = (s: number, d = 0) => ({ lat: 59.32 + d, lng: 18.07, measured_at: new Date(t0 + s * 1000) });
    expect(isLongStop([at(0), at(60), at(125)], 2)).toBe(true);
    expect(isLongStop([at(10), at(60), at(125)], 2)).toBe(false); // the fixes do not cover 2 minutes
    expect(isLongStop([at(0), at(60, 0.001), at(125)], 2)).toBe(false); // moved 110 m
  });

  it("the rider gets the driver document's rideCheck and routeChange (both apps show the same numbers)", async () => {
    await publish("driver_app_config", "FR-PC", driverDoc({ rideCheck: { offRouteKm: 4 }, routeChange: { driverCanRefuse: false } }, true));
    const served = (await call(app, "GET", "/rider/config?zoneId=FR-PC", rider)).json();
    expect(served.rideCheck).toMatchObject({ offRouteKm: 4, stopMinutes: 2 });
    expect(served.routeChange).toMatchObject({ driverCanRefuse: false, answerSeconds: 60 });
  });

  it("G7 live fix: the old finishFarFromDropoffKm is never served; endFarMeters is (driver and rider, SE and FR)", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ rideCheck: { endFarMeters: 800, finishFarFromDropoffKm: 3 } }));
    await publish("driver_app_config", "FR-PC", driverDoc({ rideCheck: { finishFarFromDropoffKm: 3 } }, true));
    for (const [zone, meters, path, who] of [["Z001", 800, "/driver/config", driverA.headers], ["Z001", 800, "/rider/config", rider], ["FR-PC", 500, "/rider/config", rider]] as const) {
      {
        const served = (await call(app, "GET", `${path}?zoneId=${zone}`, who)).json();
        expect(served.rideCheck.finishFarFromDropoffKm, `${path} ${zone}`).toBeUndefined();
        expect(served.rideCheck.endFarMeters, `${path} ${zone}`).toBe(meters);
      }
    }
  });

  it("G7 live fix: the measured value of each trigger", () => {
    expect(measuredFields("long_stop", 2.4)).toEqual({ measured: { value: 2, unit: "min" } });
    expect(measuredFields("off_route", 3.04)).toEqual({ measured: { value: 3, unit: "km" } });
    expect(measuredFields("dropped_far", 812.6)).toEqual({ measured: { value: 813, unit: "m" } });
    expect(measuredFields("possible_crash", 1)).toEqual({});
    const t0 = Date.parse("2026-11-02T10:00:00Z");
    const at = (s: number, d = 0) => ({ lat: 59.32 + d, lng: 18.07, measured_at: new Date(t0 + s * 1000) });
    expect(stoppedMinutes([at(0, 0.01), at(30), at(90), at(210)])).toBe(3);
  });
});

describe("item 5: max stops, enforced by the server (default 3, per zone)", () => {
  const stop = (i: number) => ({ address: `Stop ${i}`, lat: 59.326 + i * 0.001, lng: 18.07 });
  it("Stockholm: 4 stops refused at the quote with maxStops=3; 3 are fine", async () => {
    const res = await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [stop(1), stop(2), stop(3), stop(4)], categoryIds: ["economy"] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_request", reason: "too_many_stops", details: ["maxStops=3"] });
    expect((await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [stop(1), stop(2), stop(3)], categoryIds: ["economy"] })).statusCode).toBe(201);
  });

  it("the admin lowers it: a quote made before is refused at booking; Paris has its own number", async () => {
    const stops = [stop(1), stop(2)];
    const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops, categoryIds: ["economy"] })).json().quotes[0];
    await publish("rider_app_config", "Z001", riderDoc({ booking: { maxStops: 1 } }));
    const booked = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops, kind: "live", paymentMethod: "cash" });
    expect(booked.statusCode).toBe(400);
    expect(booked.json()).toMatchObject({ reason: "too_many_stops", details: ["maxStops=1"] });
    await publish("rider_app_config", "FR-PC", riderDoc({ booking: { maxStops: 0 } }, true));
    const paris = await call(app, "POST", "/quotes", rider, { pickup: PARIS, dropoff: PARIS_DROP, stops: [{ lat: 48.85, lng: 2.36 }], categoryIds: ["economy"] });
    expect(paris.json()).toMatchObject({ reason: "too_many_stops", details: ["maxStops=0"] });
  });
});

describe("item 4: stop waiting price on the trip (free minutes default 0, price per zone)", () => {
  it("terms carry stopFreeWaitMin 0 and stopWaitPerMin in the zone's currency (SE and FR)", async () => {
    const se = await accepted();
    const pricing = sample("pricing_document");
    expect((await view(se.tripId, rider)).terms).toMatchObject({ stopFreeWaitMin: 0, stopWaitPerMin: { amountMinor: pricing.categories.economy.stopWaitPerMin.amountMinor, currency: "SEK" } });
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", se.tripId).execute();
    const fr = await forcedParis();
    expect((await view(fr.tripId, driverA.headers)).terms).toMatchObject({ stopFreeWaitMin: 0, stopWaitPerMin: { currency: "EUR" } });
  });
});

describe("items 1 + 2: the server's ride check, asked to the rider AND the driver", () => {
  it("off route (> 2 km): both views carry rideCheck; each side answers for itself; no answer → the safety team is alerted", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ rideCheck: { noAnswerSeconds: 60 } }));
    const trip = await accepted();
    await onBoard(trip);
    await moveTo({ lat: 59.326, lng: 18.068 }, 20); // on the way: nothing
    await worker.runDue();
    expect((await view(trip.tripId, rider)).rideCheck).toBeUndefined();
    await moveTo(FAR_EAST, 20);
    await worker.runDue();
    const riderSide = await view(trip.tripId, rider);
    const driverSide = await view(trip.tripId, driverA.headers);
    expect(riderSide.rideCheck).toMatchObject({ trigger: "off_route", answers: {} });
    expect(driverSide.rideCheck.checkId).toBe(riderSide.rideCheck.checkId);
    expect(Date.parse(riderSide.rideCheck.answerBy) - Date.parse(riderSide.rideCheck.askedAt)).toBe(60_000);
    const rows = await database.db.selectFrom("ride_checks").select(["side", "origin", "shown_at"]).where("trip_id", "=", trip.tripId).orderBy("side").execute();
    expect(rows.map((r) => [r.side, r.origin, r.shown_at !== null])).toEqual([["driver", "server", true], ["rider", "server", true]]);
    // The rider says OK: only the rider's side is answered.
    const ok = await report(trip.tripId, "rider", riderSide.rideCheck.checkId, "off_route", "ok");
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await view(trip.tripId, driverA.headers)).rideCheck.answers).toEqual({ rider: "ok" });
    // The driver says nothing for 60 s: a ride_check case for the safety team (no alarm by default).
    await advance(61);
    const incidents = await database.db.selectFrom("incidents").selectAll().where("trip_id", "=", trip.tripId).execute();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ kind: "ride_check", raised_by: "system", alarm: false });
    expect(incidents[0]!.ride_check).toMatchObject({ by: "driver", answer: "no_answer", trigger: "off_route", answerSeconds: 60 });
    expect((await view(trip.tripId, rider)).rideCheck.alertedAt).toBeDefined();
    // The same reason does not ask again within repeatMinutes.
    await moveTo({ lat: 59.33, lng: 18.165 }, 30);
    await worker.runDue();
    expect((await view(trip.tripId, rider)).rideCheck.checkId).toBe(riderSide.rideCheck.checkId);
  });

  it("need_help from the rider alarms at once; noAnswerAlarm on makes a no-answer case ring too", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ rideCheck: { noAnswerAlarm: true, noAnswerSeconds: 30 } }));
    const trip = await accepted();
    await onBoard(trip);
    await moveTo(FAR_EAST, 20);
    await worker.runDue();
    const check = (await view(trip.tripId, rider)).rideCheck;
    await advance(31);
    const incident = await database.db.selectFrom("incidents").selectAll().where("trip_id", "=", trip.tripId).executeTakeFirstOrThrow();
    expect(incident.alarm).toBe(true);
    const help = await report(trip.tripId, "driver", check.checkId, "off_route", "need_help");
    expect(help.statusCode, help.body).toBe(200);
    expect((await view(trip.tripId, rider)).rideCheck.answers).toMatchObject({ driver: "need_help" });
  });

  it("Paris long stop: the car stands still for stopMinutes with the rider on board → long_stop", async () => {
    const trip = await forcedParis();
    await onBoard(trip, PARIS);
    const still = { lat: 48.853, lng: 2.356 };
    for (let i = 0; i < 6; i++) {
      await moveTo(still, 30);
      await worker.runDue();
    }
    const rc = (await view(trip.tripId, rider)).rideCheck;
    expect(rc).toMatchObject({ trigger: "long_stop" });
    const row = await database.db.selectFrom("ride_checks").select("position").where("trip_id", "=", trip.tripId).where("side", "=", "rider").executeTakeFirstOrThrow();
    const pos = (typeof row.position === "string" ? JSON.parse(row.position) : row.position) as { measured: { value: number; unit: string } };
    expect(pos.measured.unit).toBe("min");
    expect(pos.measured.value).toBeGreaterThanOrEqual(2);
  });

  it("the admin switch off: no server checks in that zone", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ rideCheck: { on: false } }));
    const trip = await accepted();
    await onBoard(trip);
    await moveTo(FAR_EAST, 20);
    await worker.runDue();
    expect((await view(trip.tripId, rider)).rideCheck).toBeUndefined();
  });

  it("unexpected end: the driver completes far from the drop-off → dropped_far, and the rider can still answer", async () => {
    const trip = await accepted();
    const v = await onBoard(trip);
    await moveTo(KUNGSHOLMEN, 20);
    await database.db.updateTable("trips").set({ ride_check_log: JSON.stringify({ off_route: clock.now.toISOString() }) }).where("trip_id", "=", trip.tripId).execute();
    const done = await step(trip.tripId, "complete", v);
    expect(done.statusCode, done.body).toBe(200);
    const rc = (await view(trip.tripId, rider)).rideCheck;
    expect(rc).toMatchObject({ trigger: "dropped_far" });
    const far = await database.db.selectFrom("ride_checks").select("position").where("trip_id", "=", trip.tripId).where("check_id", "=", rc.checkId).executeTakeFirstOrThrow();
    const farPos = (typeof far.position === "string" ? JSON.parse(far.position) : far.position) as { measured: { value: number; unit: string } };
    expect(farPos.measured.unit).toBe("m");
    expect(farPos.measured.value).toBeGreaterThan(500);
    const ok = await report(trip.tripId, "rider", rc.checkId, "dropped_far", "ok");
    expect(ok.statusCode, ok.body).toBe(200);
    // Ended trips get it as payment_updated (the apps' after-terminal gate lets it through).
    const kinds = (await database.db.selectFrom("trip_events").select("kind").where("trip_id", "=", trip.tripId).orderBy("sequence", "desc").limit(2).execute()).map((e) => e.kind);
    expect(kinds).toEqual(["payment_updated", "payment_updated"]);
  });

  it("the admin ride-check list: server rows with origin and answers, filters, zone scope", async () => {
    const trip = await accepted();
    await onBoard(trip);
    await moveTo(FAR_EAST, 20);
    await worker.runDue();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const list = (await call(app, "GET", `/admin/ride-checks?tripId=${trip.tripId}`, admin.headers)).json();
    expect(list.items.map((r: Doc) => [r.side, r.origin, r.trigger, r.zoneId])).toEqual([["rider", "server", "off_route", "Z001"], ["driver", "server", "off_route", "Z001"]].sort((a, b) => (a[0]! < b[0]! ? 1 : -1)));
    // G7 live fix: the real km off the route and the zone's answer time (not "0 km", not a fixed 2 minutes).
    for (const row of list.items as Doc[]) {
      expect(row.measured).toMatchObject({ unit: "km" });
      expect((row.measured as { value: number }).value).toBeGreaterThan(2);
      expect(row.answerSeconds).toBe(120);
    }
    expect((await call(app, "GET", `/admin/ride-checks?tripId=${trip.tripId}&answer=waiting`, admin.headers)).json().items).toHaveLength(2);
    expect((await call(app, "GET", `/admin/ride-checks?tripId=${trip.tripId}&answer=ok`, admin.headers)).json().items).toHaveLength(0);
    const paris = await adminSession(app, database.db, "safety", { zoneIds: ["FR-PC"], now: clock.now });
    expect((await call(app, "GET", `/admin/ride-checks?tripId=${trip.tripId}`, paris.headers)).json().items).toHaveLength(0);
  });
});

describe("item 3: route change during the trip (rider proposes, driver accepts or refuses)", () => {
  async function quoteNew(tripId: string, version: number, body: Doc) {
    const res = await call(app, "POST", `/trips/${tripId}/route-quote`, rider, { expectedVersion: version, ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  it("a farther destination: new price for the rider, new earnings for the driver; accept changes the trip", async () => {
    const trip = await accepted();
    const v = await onBoard(trip);
    const before = await view(trip.tripId, driverA.headers);
    const quote = await quoteNew(trip.tripId, v, { dropoff: BROMMA, stops: [] });
    expect(quote.total.amountMinor).toBeGreaterThan(before.fare.amountMinor);
    expect(quote.difference.amountMinor).toBe(quote.total.amountMinor - before.fare.amountMinor);
    expect(quote.driverEarnings).toBeUndefined();
    const asked = await call(app, "PATCH", `/trips/${trip.tripId}`, rider, { expectedVersion: v, routeQuoteId: quote.routeQuoteId });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json().routeChange).toMatchObject({ status: "pending", total: quote.total, dropoff: BROMMA });
    expect(asked.json().routeChange.driverEarnings).toBeUndefined();
    expect(asked.json().dropoff).toMatchObject(SODERMALM);
    const driverSide = await view(trip.tripId, driverA.headers);
    expect(driverSide.routeChange.earningsDifference.amountMinor).toBe(driverSide.routeChange.driverEarnings.amountMinor - before.driverEarnings.amountMinor);
    expect(driverSide.routeChange.earningsDifference.amountMinor).toBeGreaterThan(0);
    const acc = await step(trip.tripId, "route-change/accept", driverSide.version, { changeId: driverSide.routeChange.changeId });
    expect(acc.statusCode, acc.body).toBe(200);
    const after = await view(trip.tripId, driverA.headers);
    expect(after).toMatchObject({ dropoff: BROMMA, fare: quote.total, driverEarnings: driverSide.routeChange.driverEarnings, routeChange: { status: "accepted", answeredBy: "driver" } });
    const lines = after.fareLines as Array<{ amount: { amountMinor: number } }>;
    expect(lines.reduce((s, l) => s + l.amount.amountMinor, 0)).toBe(quote.total.amountMinor);
  });

  it("refuse keeps the old route and price; no answer in answerSeconds = expired; the rider may withdraw", async () => {
    const trip = await accepted();
    const v = await onBoard(trip);
    const fare = (await view(trip.tripId, rider)).fare;
    const q1 = await quoteNew(trip.tripId, v, { stops: [GAMLA_STAN] });
    const p1 = (await call(app, "PATCH", `/trips/${trip.tripId}`, rider, { expectedVersion: v, routeQuoteId: q1.routeQuoteId })).json();
    const refused = await step(trip.tripId, "route-change/refuse", p1.version, { changeId: p1.routeChange.changeId });
    expect(refused.statusCode, refused.body).toBe(200);
    expect(await view(trip.tripId, rider)).toMatchObject({ dropoff: SODERMALM, stops: [], fare, routeChange: { status: "refused", answeredBy: "driver" } });
    // Used quote cannot be sent again.
    expect((await call(app, "PATCH", `/trips/${trip.tripId}`, rider, { expectedVersion: refused.json().version, routeQuoteId: q1.routeQuoteId })).json()).toMatchObject({ reason: "route_quote_used" });
    const q2 = await quoteNew(trip.tripId, refused.json().version, { stops: [GAMLA_STAN] });
    const p2 = (await call(app, "PATCH", `/trips/${trip.tripId}`, rider, { expectedVersion: refused.json().version, routeQuoteId: q2.routeQuoteId })).json();
    // A second change while one waits.
    expect((await call(app, "POST", `/trips/${trip.tripId}/route-quote`, rider, { expectedVersion: p2.version, stops: [] })).json()).toMatchObject({ reason: "route_change_pending" });
    await advance(61);
    expect((await view(trip.tripId, rider)).routeChange).toMatchObject({ status: "expired", answeredBy: "system" });
    expect((await view(trip.tripId, rider)).stops).toEqual([]);
    const late = await step(trip.tripId, "route-change/accept", (await view(trip.tripId, driverA.headers)).version, { changeId: p2.routeChange.changeId });
    expect(late.json()).toMatchObject({ reason: "route_change_not_pending" });
    const q3 = await quoteNew(trip.tripId, late.json().projection.version, { stops: [GAMLA_STAN] });
    const p3 = (await call(app, "PATCH", `/trips/${trip.tripId}`, rider, { expectedVersion: late.json().projection.version, routeQuoteId: q3.routeQuoteId })).json();
    const withdrawn = await call(app, "POST", `/trips/${trip.tripId}/route-change/withdraw`, rider, { expectedVersion: p3.version, changeId: p3.routeChange.changeId });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(withdrawn.json().routeChange).toMatchObject({ status: "withdrawn", answeredBy: "rider" });
  });

  it("admin switches: driverCanRefuse off applies at once; the switch off refuses; max stops and visited stops apply", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ routeChange: { driverCanRefuse: false } }));
    const trip = await accepted();
    const v = await onBoard(trip);
    const q = await quoteNew(trip.tripId, v, { stops: [GAMLA_STAN] });
    const applied = (await call(app, "PATCH", `/trips/${trip.tripId}`, rider, { expectedVersion: v, routeQuoteId: q.routeQuoteId })).json();
    expect(applied).toMatchObject({ stops: [GAMLA_STAN], fare: q.total, routeChange: { status: "accepted", answeredBy: "system" } });
    // The driver arrives at the new stop: it cannot be removed any more.
    await moveTo(GAMLA_STAN, 30);
    const at = await call(app, "POST", `/driver/trips/${trip.tripId}/stops/0/arrive`, driverA.headers, { expectedVersion: applied.version });
    expect(at.statusCode, at.body).toBe(200);
    // contract.json#stopWaits: the arrival is on stops[i].arrivedAt (every view, and on reopen), stopVisits kept too.
    const arrivedAt = at.json().stopVisits[0].arrivedAt;
    expect(at.json().stops[0]).toMatchObject({ ...GAMLA_STAN, arrivedAt });
    for (const headers of [driverA.headers, rider]) {
      const reopened = await view(trip.tripId, headers);
      expect(reopened.stops[0]).toMatchObject({ arrivedAt });
      expect(reopened.stops[0].leftAt).toBeUndefined();
      expect(reopened.stopVisits).toEqual([{ stopIndex: 0, arrivedAt }]);
    }
    const removed = await call(app, "POST", `/trips/${trip.tripId}/route-quote`, rider, { expectedVersion: at.json().version, stops: [] });
    expect(removed.json()).toMatchObject({ code: "invalid_request", reason: "visited_stop_changed" });
    const tooMany = await call(app, "POST", `/trips/${trip.tripId}/route-quote`, rider, { expectedVersion: at.json().version, stops: [GAMLA_STAN, KUNGSHOLMEN, NORRMALM, SODERMALM] });
    expect(tooMany.json()).toMatchObject({ reason: "too_many_stops", details: ["maxStops=3"] });
    await publish("driver_app_config", "Z001", driverDoc({ routeChange: { on: false } }));
    const off = await call(app, "POST", `/trips/${trip.tripId}/route-quote`, rider, { expectedVersion: at.json().version, stops: [GAMLA_STAN, KUNGSHOLMEN] });
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ reason: "route_change_off" });
  });

  it("Paris: the price is in euros; a shorter destination lowers the price but never below half of booked", async () => {
    const trip = await forcedParis();
    const v = await onBoard(trip, PARIS);
    const before = await view(trip.tripId, rider);
    const q = await quoteNew(trip.tripId, v, { dropoff: { address: "Pont Neuf", lat: 48.8575, lng: 2.3413 }, stops: [] });
    expect(q.total.currency).toBe("EUR");
    expect(q.difference.amountMinor).toBeLessThanOrEqual(0);
    expect(q.total.amountMinor).toBeGreaterThanOrEqual(Math.ceil(before.quote.total.amountMinor / 2));
  });

  it("before a driver: not available (invalid_transition)", async () => {
    const quote = (await call(app, "POST", "/quotes", rider, { pickup: PARIS, dropoff: PARIS_DROP, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: PARIS, dropoff: PARIS_DROP, stops: [], kind: "live", paymentMethod: "cash" });
    const r = await call(app, "POST", `/trips/${res.json().tripId}/route-quote`, rider, { expectedVersion: res.json().version, stops: [] });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("invalid_transition");
  });
});

describe("items 6 + 7: the admin's trip tools", () => {
  it("flag (admin only, list filter), notes, internal case, reveal contact with reason, incident level", async () => {
    const trip = await accepted();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const flag = await call(app, "POST", `/admin/trips/${trip.tripId}/flag`, admin.headers, { flagged: true, reason: "Check the route" });
    expect(flag.statusCode, flag.body).toBe(200);
    expect(flag.json()).toMatchObject({ flagged: true, reason: "Check the route", by: admin.adminId });
    expect((await call(app, "GET", `/admin/trips/${trip.tripId}`, admin.headers)).json().adminFlag).toMatchObject({ flagged: true });
    expect((await view(trip.tripId, rider)).adminFlag).toBeUndefined();
    expect((await view(trip.tripId, driverA.headers)).adminFlag).toBeUndefined();
    expect((await call(app, "GET", `/admin/trips?flagged=true`, admin.headers)).json().items.map((t: Doc) => t.tripId)).toEqual([trip.tripId]);
    expect((await view(trip.tripId, rider)).version).toBe(trip.version);

    expect((await call(app, "POST", `/admin/trips/${trip.tripId}/notes`, admin.headers, { text: "Rider called about the car" })).statusCode).toBe(201);
    expect((await call(app, "GET", `/admin/trips/${trip.tripId}/notes`, admin.headers)).json().items).toMatchObject([{ text: "Rider called about the car", adminId: admin.adminId }]);

    const opened = await call(app, "POST", `/admin/trips/${trip.tripId}/case`, admin.headers, { about: "rider", category: "safety", subject: "Ride check follow-up", text: "Call the rider back." });
    expect(opened.statusCode, opened.body).toBe(201);
    expect(opened.json()).toMatchObject({ openedBy: "admin", tripId: trip.tripId, priority: "high", status: "open" });
    expect((await call(app, "GET", "/support/tickets", rider)).json().items.map((t: Doc) => t.ticketId)).not.toContain(opened.json().ticketId);
    expect((await call(app, "GET", `/admin/tickets?tripId=${trip.tripId}`, admin.headers)).json().items.map((t: Doc) => t.ticketId)).toContain(opened.json().ticketId);

    const noReason = await call(app, "POST", `/admin/trips/${trip.tripId}/reveal-contact`, admin.headers, { who: "rider", reason: " " });
    expect(noReason.statusCode).toBe(400);
    const shown = await call(app, "POST", `/admin/trips/${trip.tripId}/reveal-contact`, admin.headers, { who: "driver", reason: "Driver not answering in the app" });
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json()).toMatchObject({ who: "driver", phone: TEST_PHONES[1] });
    const line = await database.db.selectFrom("admin_audit").selectAll().where("action", "=", "trip.reveal_contact").where("target_id", "=", trip.tripId).executeTakeFirstOrThrow();
    expect(JSON.stringify(line.detail)).not.toContain(TEST_PHONES[1]!);
    const support = await adminSession(app, database.db, "support", { now: clock.now });
    expect((await call(app, "POST", `/admin/trips/${trip.tripId}/reveal-contact`, support.headers, { who: "driver", reason: "x" })).statusCode).toBe(403);
    expect((await call(app, "POST", `/admin/trips/${trip.tripId}/reveal-contact`, support.headers, { who: "rider", reason: "Rider asked for a call" })).statusCode).toBe(200);

    const sos = await call(app, "POST", `/rider/trips/${trip.tripId}/sos`, rider, { at: clock.now.toISOString() });
    expect(sos.statusCode, sos.body).toBe(200);
    const incident = (await call(app, "GET", `/admin/incidents?tripId=${trip.tripId}`, admin.headers)).json().items[0];
    const level = await call(app, "POST", `/admin/incidents/${incident.incidentId}/level`, admin.headers, { expectedVersion: incident.version, severity: "medium", note: "False alarm likely" });
    expect(level.statusCode, level.body).toBe(200);
    expect(level.json()).toMatchObject({ severity: "medium", version: incident.version + 1 });
  });

  it("existing admin trip commands still work for G7: adjust the driver's pay (S5 J6: the rider's price stays), complete", async () => {
    const trip = await accepted();
    const v = await onBoard(trip);
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const before = await view(trip.tripId, rider);
    const adjust = await call(app, "POST", `/admin/trips/${trip.tripId}/adjust`, admin.headers, { expectedVersion: v, driverPay: { amountMinor: 20000, currency: "SEK" }, reason: "Traffic" });
    expect(adjust.statusCode, adjust.body).toBe(200);
    expect(adjust.json().driverTotal).toEqual({ amountMinor: 20000, currency: "SEK" });
    const after = await view(trip.tripId, rider);
    expect(after.fare).toEqual(before.fare);
    const done = await call(app, "POST", `/admin/trips/${trip.tripId}/complete`, admin.headers, { expectedVersion: after.version, note: "Finished by support" });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().status).toBe("completed");
  });
});

describe("owner rule 16 (2026-11-01): the four G7 open questions as admin settings", () => {
  it("settings: beforePickup (default true) and fixedPriceTrips (default block); a bad value reads as the default", () => {
    expect(routeChangeSettingsOf(undefined)).toMatchObject({ beforePickup: true, fixedPriceTrips: "block" });
    expect(routeChangeSettingsOf({ routeChange: { beforePickup: false, fixedPriceTrips: "switch_to_normal" } })).toMatchObject({ beforePickup: false, fixedPriceTrips: "switch_to_normal" });
    expect(routeChangeSettingsOf({ routeChange: { beforePickup: "no", fixedPriceTrips: "meter" } })).toMatchObject({ beforePickup: true, fixedPriceTrips: "block" });
  });

  it("route change before pickup: allowed by default (driver on the way); beforePickup off → only once on board (SE and FR)", async () => {
    const trip = await accepted();
    const early = await call(app, "POST", `/trips/${trip.tripId}/route-quote`, rider, { expectedVersion: trip.version, stops: [GAMLA_STAN] });
    expect(early.statusCode, early.body).toBe(201);
    await publish("driver_app_config", "Z001", driverDoc({ routeChange: { beforePickup: false } }));
    const blocked = await call(app, "POST", `/trips/${trip.tripId}/route-quote`, rider, { expectedVersion: trip.version, stops: [GAMLA_STAN] });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ reason: "route_change_before_pickup_off" });
    // A price made while it was allowed cannot be confirmed after the admin switched it off.
    const late = await call(app, "PATCH", `/trips/${trip.tripId}`, rider, { expectedVersion: trip.version, routeQuoteId: early.json().routeQuoteId });
    expect(late.json()).toMatchObject({ reason: "route_change_before_pickup_off" });
    const v = await onBoard(trip);
    expect((await call(app, "POST", `/trips/${trip.tripId}/route-quote`, rider, { expectedVersion: v, stops: [GAMLA_STAN] })).statusCode).toBe(201);
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", trip.tripId).execute();
    await publish("driver_app_config", "FR-PC", driverDoc({ routeChange: { beforePickup: false } }, true));
    const paris = await forcedParis();
    expect((await call(app, "POST", `/trips/${paris.tripId}/route-quote`, rider, { expectedVersion: paris.version, stops: [] })).json()).toMatchObject({ reason: "route_change_before_pickup_off" });
  });

  it("fixed-price trips: block (default) refuses; switch_to_normal prices the new route normally and drops the fixed price on accept", async () => {
    const pricing = sample("pricing_document");
    await publish("pricing", "Z001", { ...pricing, fixedRoutes: [{ id: "R1", from: "Norrmalm", to: "Södermalm", categoryId: "economy", price: { amountMinor: 39900, currency: "SEK" } }] });
    try {
      const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"], fixedRouteId: "R1" })).json().quotes[0];
      const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash", fixedRouteId: "R1" });
      expect(res.statusCode, res.body).toBe(201);
      await worker.runDue();
      const [offer] = (await call(app, "GET", "/driver/offers", driverA.headers)).json().items;
      const acc = await call(app, "POST", `/offers/${offer.offerId}/accept`, driverA.headers, { expectedVersion: offer.version });
      const tripId = res.json().tripId as string;
      expect(acc.json().fareLines.map((l: Doc) => l.code)).toContain("fixed_route");
      const v = await onBoard({ tripId, version: acc.json().version });
      const blocked = await call(app, "POST", `/trips/${tripId}/route-quote`, rider, { expectedVersion: v, dropoff: BROMMA, stops: [] });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({ reason: "route_change_fixed_route" });
      await publish("driver_app_config", "Z001", driverDoc({ routeChange: { fixedPriceTrips: "switch_to_normal" } }));
      const q = await call(app, "POST", `/trips/${tripId}/route-quote`, rider, { expectedVersion: v, dropoff: BROMMA, stops: [] });
      expect(q.statusCode, q.body).toBe(201);
      expect(q.json().leavesFixedPrice).toBe(true);
      expect(q.json().fareLines.map((l: Doc) => l.code)).not.toContain("fixed_route");
      const asked = (await call(app, "PATCH", `/trips/${tripId}`, rider, { expectedVersion: v, routeQuoteId: q.json().routeQuoteId })).json();
      expect(asked.routeChange.status).toBe("pending");
      const driverSide = await view(tripId, driverA.headers);
      const done = await step(tripId, "route-change/accept", driverSide.version, { changeId: driverSide.routeChange.changeId });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({ dropoff: BROMMA, fare: q.json().total });
      const row = await database.db.selectFrom("trips").select("price_extras").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
      expect((row.price_extras as Doc)["fixedRouteId"]).toBeUndefined();
    } finally {
      await publish("pricing", "Z001", pricing);
    }
  });

  it("admin case visibility: internal by default; visibleToPerson true shows it in the person's own help list", async () => {
    const trip = await accepted();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const internal = (await call(app, "POST", `/admin/trips/${trip.tripId}/case`, admin.headers, { about: "rider", category: "safety", subject: "Internal", text: "Team only." })).json();
    expect(internal.visibleToPerson).toBe(false);
    const shown = await call(app, "POST", `/admin/trips/${trip.tripId}/case`, admin.headers, { about: "driver", category: "safety", subject: "About your trip", text: "Please tell us what happened.", visibleToPerson: true });
    expect(shown.statusCode, shown.body).toBe(201);
    expect(shown.json()).toMatchObject({ openedBy: "admin", visibleToPerson: true });
    const own = (await call(app, "GET", "/support/tickets", driverA.headers)).json().items.map((t: Doc) => t.ticketId);
    expect(own).toContain(shown.json().ticketId);
    expect(own).not.toContain(internal.ticketId);
    const one = await call(app, "GET", `/support/tickets/${shown.json().ticketId}`, driverA.headers);
    expect(one.statusCode).toBe(200);
    expect(one.json().messages).toMatchObject([{ from: "support", text: "Please tell us what happened." }]);
    expect((await call(app, "GET", `/support/tickets/${internal.ticketId}`, rider)).statusCode).toBe(404);
    expect((await call(app, "POST", `/admin/trips/${trip.tripId}/case`, admin.headers, { about: "rider", category: "safety", subject: "x", text: "y", visibleToPerson: "yes" })).statusCode).toBe(400);
  });

  it("ride-check push: every server check is also pushed to the rider and the driver, in their language, until answerBy", async () => {
    await database.db.updateTable("riders").set({ consents: JSON.stringify({ rideUpdates: false }) }).execute();
    const trip = await accepted();
    await onBoard(trip);
    await moveTo(FAR_EAST, 20);
    await worker.runDue();
    const check = (await view(trip.tripId, rider)).rideCheck;
    expect(check.trigger).toBe("off_route");
    const pushes = await database.db.selectFrom("notifications").selectAll().where("trip_id", "=", trip.tripId).where("kind", "=", "ride_check").orderBy("audience").execute();
    expect(pushes.map((n) => n.audience)).toEqual(["driver", "rider"]);
    for (const n of pushes) {
      expect(n.bell).toBe(false);
      expect(n.push_until?.toISOString()).toBe(check.answerBy);
      expect(n.data).toMatchObject({ checkId: check.checkId, trigger: "off_route", tripId: trip.tripId });
      expect(["Är allt OK?", "Is everything OK?", "Tout va bien ?"]).toContain(n.title);
    }
    // v0.18.49 §71 (owner Q9): one spelling for trip links, trips/{id}, in both apps' schemes.
    expect(pushes.find((n) => n.audience === "rider")!.deep_link).toBe(`movera-rider://trips/${trip.tripId}`);
    expect(pushes.find((n) => n.audience === "driver")!.deep_link).toBe(`movera-driver://trips/${trip.tripId}`);
    // Not a bell notice: never in the person's notification list.
    expect((await call(app, "GET", "/notifications", rider)).json().items.map((n: Doc) => n.kind)).not.toContain("ride_check");
    await database.db.updateTable("riders").set({ consents: JSON.stringify({}) }).execute();
  });
});

describe("checker round 1 (route change after the end, reveal not cached, switch off)", () => {
  async function pending() {
    const trip = await accepted();
    const v = await onBoard(trip);
    const q = (await call(app, "POST", `/trips/${trip.tripId}/route-quote`, rider, { expectedVersion: v, dropoff: BROMMA, stops: [] })).json();
    const asked = (await call(app, "PATCH", `/trips/${trip.tripId}`, rider, { expectedVersion: v, routeQuoteId: q.routeQuoteId })).json();
    return { tripId: trip.tripId, change: asked.routeChange, version: asked.version as number };
  }

  it("a pending change expires when the driver completes; accepting it then is refused and nothing moves", async () => {
    const p = await pending();
    await moveTo(SODERMALM, 30);
    const done = await step(p.tripId, "complete", p.version);
    expect(done.statusCode, done.body).toBe(200);
    const ended = await view(p.tripId, driverA.headers);
    expect(ended.routeChange).toMatchObject({ status: "expired", answeredBy: "system" });
    const late = await step(p.tripId, "route-change/accept", ended.version, { changeId: p.change.changeId });
    expect(late.statusCode).toBe(409);
    expect(late.json().reason).toBe("route_change_not_pending");
    const after = await view(p.tripId, driverA.headers);
    expect(after.fare).toEqual(ended.fare);
    expect(after.dropoff).toMatchObject(SODERMALM);
  });

  it("an admin cancel expires the pending change too (reassign: driver change, same rule)", async () => {
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const p = await pending();
    const cancel = await call(app, "POST", `/admin/trips/${p.tripId}/cancel`, admin.headers, { expectedVersion: p.version, reasonCode: "admin_other", note: "test" });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect((await view(p.tripId, rider)).routeChange.status).toBe("expired");
  });

  it("an answer after answerBy is refused even before the timer ran", async () => {
    const p = await pending();
    clock.now = new Date(clock.now.getTime() + 61_000); // no worker run: the timer has not fired
    const late = await step(p.tripId, "route-change/accept", p.version, { changeId: p.change.changeId });
    expect(late.statusCode).toBe(409);
    expect(late.json().reason).toBe("route_change_not_pending");
  });

  it("the admin switches route change off while a change waits: accept is refused, it expires at answerBy", async () => {
    const p = await pending();
    await publish("driver_app_config", "Z001", driverDoc({ routeChange: { on: false } }));
    const acc = await step(p.tripId, "route-change/accept", p.version, { changeId: p.change.changeId });
    expect(acc.statusCode).toBe(409);
    expect(acc.json().reason).toBe("route_change_off");
    await advance(61);
    expect((await view(p.tripId, rider)).routeChange.status).toBe("expired");
  });

  it("reveal contact keeps no copy of the phone number in the idempotency store", async () => {
    const trip = await accepted();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const shown = await call(app, "POST", `/admin/trips/${trip.tripId}/reveal-contact`, { ...admin.headers, "idempotency-key": "reveal-g7-1" }, { who: "driver", reason: "Driver not answering" });
    expect(shown.statusCode, shown.body).toBe(200);
    const rows = await database.db.selectFrom("idempotency_keys").selectAll().execute();
    expect(JSON.stringify(rows)).not.toContain(TEST_PHONES[1]!);
  });
});

describe("migration 0043: the old defaults move to the owner's (2 km, 0 free stop minutes)", () => {
  it("published offRouteKm 3 → 2 and stopFreeWaitMin 3 → 0; other values stay", async () => {
    await publish("driver_app_config", "Z001", driverDoc({ rideCheck: { offRouteKm: 3 }, waiting: { stopFreeWaitMin: 3 } }));
    await publish("driver_app_config", "FR-PC", driverDoc({ rideCheck: { offRouteKm: 5 } }, true));
    const sql = readFileSync(new URL("../../migrations/0043_on_trip.sql", import.meta.url), "utf8");
    const { sql: raw } = await import("kysely");
    await raw.raw(sql).execute(database.db);
    const live = await database.db.selectFrom("config_live").select(["zone_id", "document"]).where("doc", "=", "driver_app_config").execute();
    const doc = (z: string) => live.find((r) => r.zone_id === z)!.document as { rideCheck: { offRouteKm: number }; waiting: { stopFreeWaitMin: number } };
    expect(doc("Z001").rideCheck.offRouteKm).toBe(2);
    expect(doc("Z001").waiting.stopFreeWaitMin).toBe(0);
    expect(doc("FR-PC").rideCheck.offRouteKm).toBe(5);
  });
});

describe("E4 (audit S03 B2): an older batch that replaces nothing tells nobody", () => {
  it("no location event, no ride-check scan when the stored fix is newer; the older fixes still go into the trace", async () => {
    const trip = await accepted();
    await onBoard(trip);
    await moveTo({ lat: 59.326, lng: 18.068 }, 20);
    await worker.runDue();
    const events = () => database.db.selectFrom("trip_events").select("sequence").where("trip_id", "=", trip.tripId).where("kind", "=", "location").execute();
    const before = (await events()).length;
    const older = { fixes: [{ lat: 59.33, lng: 18.06, accuracy: 5, measuredAt: new Date(clock.now.getTime() - 10_000).toISOString() }] };
    expect((await call(app, "POST", "/driver/location", driverA.headers, older)).statusCode).toBe(200);
    expect((await events()).length).toBe(before);
    expect(await database.db.selectFrom("timers").select("kind").where("kind", "=", RIDE_CHECK_SCAN).where("ref_id", "=", trip.tripId).execute()).toEqual([]);
    const trace = await database.db.selectFrom("trip_locations").select("lat").where("trip_id", "=", trip.tripId).where("measured_at", "=", new Date(older.fixes[0]!.measuredAt)).execute();
    expect(trace.length).toBe(1);
  });
});

describe("E13 (audit S02 A2): a straight-line estimate is never kept as the trip's road route", () => {
  it("the ride-check scan with an estimating router (prepareLegs → preparedRouter) leaves planned_route empty", async () => {
    const trip = await accepted();
    await onBoard(trip);
    await moveTo({ lat: 59.326, lng: 18.068 }, 20);
    await worker.runDue();
    const row = await database.db.selectFrom("trips").select("planned_route").where("trip_id", "=", trip.tripId).executeTakeFirstOrThrow();
    expect(row.planned_route).toBeNull();
  });
});

/* S5 J6 round 3 (supervisor re-check round 2, must-fix 2; contract.json#moneyBase.adminFare "the pay never below 0",
 * finish.driverMoney "the same one number"): the admin's kept change is capped before the end too, so the driver never
 * sees a pay below 0 and the complete preview shows the number the end pays. */
describe("J6 round 3: a shorter route after the admin's change never shows a pay below 0", () => {
  const SEK = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
  const payOf = (p: { driverTotal?: { amountMinor: number }; tip?: { amount?: { amountMinor: number } } }) => (p.driverTotal?.amountMinor ?? 0) - (p.tip?.amount?.amountMinor ?? 0);
  const entries = (tripId: string) => database.db.selectFrom("earnings_entries").select(["kind", "amount_minor"]).where("trip_id", "=", tripId).execute();
  /** On board, the admin types pay 0, then the rider shortens the route to Stortorget and the driver accepts. */
  async function zeroThenShorter() {
    const trip = await accepted();
    const v = await onBoard(trip);
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const down = await call(app, "POST", `/admin/trips/${trip.tripId}/adjust`, admin.headers, { expectedVersion: v, driverPay: SEK(0), reason: "Wrong way" });
    expect(down.statusCode, down.body).toBe(200);
    expect(payOf(down.json())).toBe(0);
    const before = await view(trip.tripId, driverA.headers);
    const quote = await call(app, "POST", `/trips/${trip.tripId}/route-quote`, rider, { expectedVersion: before.version, dropoff: GAMLA_STAN, stops: [] });
    expect(quote.statusCode, quote.body).toBe(201);
    const asked = await call(app, "PATCH", `/trips/${trip.tripId}`, rider, { expectedVersion: before.version, routeQuoteId: quote.json().routeQuoteId });
    expect(asked.statusCode, asked.body).toBe(200);
    const pending = await view(trip.tripId, driverA.headers);
    const acc = await step(trip.tripId, "route-change/accept", pending.version, { changeId: pending.routeChange.changeId });
    expect(acc.statusCode, acc.body).toBe(200);
    const after = await view(trip.tripId, driverA.headers);
    expect(after.driverEarnings.amountMinor).toBeLessThan(before.driverEarnings.amountMinor);
    return { tripId: trip.tripId, after, admin };
  }

  it("the driver and the admin see pay 0 (never below), and the complete preview equals the completed total", async () => {
    const { tripId, after, admin } = await zeroThenShorter();
    expect(payOf(after)).toBe(0);
    expect(after.earningsBreakdown.reduce((s: number, l: { amount: { amountMinor: number } }) => s + l.amount.amountMinor, 0)).toBe(0);
    const adminSide = (await call(app, "GET", `/admin/trips/${tripId}`, admin.headers)).json();
    expect(adminSide.moneySplit.driverTotal).toEqual(SEK(0));
    await moveTo(GAMLA_STAN);
    const preview = await call(app, "GET", `/driver/trips/${tripId}/complete-preview`, driverA.headers);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().driverTotal).toEqual(SEK(0));
    const current = await view(tripId, driverA.headers);
    const done = await step(tripId, "complete", current.version, { previewId: preview.json().previewId });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().driverTotal).toEqual(preview.json().driverTotal);
  });

  it("complete after the shorter route (no preview): row, shown pay and entries agree at 0", async () => {
    const { tripId, after } = await zeroThenShorter();
    expect(payOf(after)).toBe(0);
    await moveTo(GAMLA_STAN);
    const done = await step(tripId, "complete", after.version);
    expect(done.statusCode, done.body).toBe(200);
    expect(payOf(done.json())).toBe(0);
    const paid = await entries(tripId);
    expect(paid.reduce((s, e) => s + Number(e.amount_minor), 0)).toBe(0);
    const row = await database.db.selectFrom("trips").select("driver_adjustments_minor").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(Number(row.driver_adjustments_minor)).toBe(paid.filter((e) => e.kind === "adjustment").reduce((s, e) => s + Number(e.amount_minor), 0));
  });
});
