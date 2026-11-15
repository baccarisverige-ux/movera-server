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
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, fixedRouter, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Job C9b (contract v0.18.98 §92, contract.json#autoArrive.stops, #stopWaits; owner 2026-11-02 "At the pickup AND at
 * stops", Rules decisions/driver-g7.md:84; plan Rules handover/build-plans-2026-11-13/C9b-plan.md): at a middle stop the
 * server marks the NEXT stop arrived after 2 slow confirming fixes within the trip's autoArriveMeters, the stop wait stands
 * still while the driver is farther than leaveMeters and goes on at a new arrival (fixes, or the back tap within
 * leaveMeters, else 409 not_at_stop); the first stop tap of a driver app on contract ≥ 0.18.108 needs a fresh position
 * within 300 m. Money exact in SEK (5,00 kr/min) and TND (0.250 DT/min, 3 decimals, half-up) = fixtures/auto_arrive.json#stops.
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-20T10:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const inTunis = (doc: unknown) => JSON.parse(JSON.stringify(doc).replace(/"SEK"/g, '"TND"').replace(/"Z001"/g, '"TN-TC"').replace(/"SE"/g, '"TN"').replace(/Europe\/Stockholm/g, "Africa/Tunis"));
const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/contract-0.18.108/auto_arrive.json", import.meta.url), "utf8"));
const fixtureCase = (id: string) => FIXTURE.stops.find((c: { id: string }) => c.id === id);
const SPOT_A = { lat: 59.3335, lng: 18.0655 };
const STOP_A = { address: "Fridhemsplan", lat: 59.3326, lng: 18.03 };
const STOP_B = { address: "Odenplan", lat: 59.343, lng: 18.05 };
const TUNIS = { address: "Avenue Habib Bourguiba", lat: 36.8, lng: 10.18 };
const TUNIS_STOP = { address: "Bab Saadoun", lat: 36.81, lng: 10.16 };
const TUNIS_DROP = { address: "La Marsa", lat: 36.878, lng: 10.325 };
/** North of a place by `meters`, never a hair beyond (the server's haversine: R = 6371.0088 km, 1° = 111 195.08 m). */
const north = (at: { lat: number; lng: number }, meters: number) => ({ lat: at.lat + meters / 111_195.1, lng: at.lng });

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
function driverDoc(waiting: Doc = {}, extra: Doc = {}, tunis = false): Doc {
  const doc = tunis ? inTunis(sample("driver_app_config")) : sample("driver_app_config");
  Object.assign(doc.waiting as Doc, waiting);
  for (const [k, v] of Object.entries(extra)) doc[k] = { ...(doc[k] as Doc), ...(v as Doc) };
  return doc;
}
function pricingDoc(stopWaitPerMinor: number, tunis = false): Doc {
  const doc = tunis ? inTunis(sample("pricing_document")) : sample("pricing_document");
  (doc.categories.economy as Doc).stopWaitPerMin = { amountMinor: stopWaitPerMinor, currency: tunis ? "TND" : "SEK" };
  return doc;
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await publish("dispatch", "Z001", sample("dispatch_document"));
  await publish("rider_app_config", "Z001", sample("rider_app_config"));
  await publish("rider_app_config", "TN-TC", inTunis(sample("rider_app_config")));
  await database.db.updateTable("zones").set({ open: true }).where("zone_id", "=", "TN-TC").execute();
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers, [TRIP_ETA]: etaHandler(fixedRouter) }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver A", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "AC09B", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  driverA.id = made.driverId;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

/** The driver's phone sends one fix now (accuracy 5 m unless said; speedMps only when given). */
async function fixAt(at: { lat: number; lng: number }, accuracy = 5, speedMps?: number) {
  const res = await call(app, "POST", "/driver/location", driverA.headers, { fixes: [{ ...at, accuracy, measuredAt: clock.now.toISOString(), ...(speedMps === undefined ? {} : { speedMps }) }] });
  expect(res.statusCode, res.body).toBe(200);
}
/** The clock moves to `seconds` after `from`, the fix is sent at that moment, then the job worker runs. */
async function fixAfter(from: string, seconds: number, at: { lat: number; lng: number }, accuracy = 5, speedMps?: number) {
  clock.now = new Date(Date.parse(from) + seconds * 1000);
  await fixAt(at, accuracy, speedMps);
  await worker.runDue();
}
/** A confirming pair (contract.json#autoArrive.confirm): two fixes 5 s apart at the same place; the moment is the first. */
async function pairAfter(from: string, seconds: number, at: { lat: number; lng: number }) {
  await fixAfter(from, seconds, at);
  await fixAfter(from, seconds + 5, at);
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
  await publish("driver_app_config", "TN-TC", driverDoc({}, {}, true));
  await publish("pricing", "Z001", pricingDoc(500));
  await publish("pricing", "TN-TC", pricingDoc(250, true));
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driverA.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driverA.id).execute();
  clock.now = new Date(clock.now.getTime() + 1000);
  await fixAt(SPOT_A);
});

const NEW_APP = { "x-contract-version": "0.18.108" };
const step = (tripId: string, path: string, version: number, body: Doc = {}) => call(app, "POST", `/trips/${tripId}/${path}`, { ...driverA.headers, ...NEW_APP }, { expectedVersion: version, ...body });
const stopTap = (tripId: string, i: number, verb: "arrive" | "leave", version: number, body: Doc = {}, headers: Record<string, string> = NEW_APP) =>
  call(app, "POST", `/driver/trips/${tripId}/stops/${i}/${verb}`, { ...driverA.headers, ...headers }, { expectedVersion: version, ...body });
const driverView = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}`, driverA.headers)).json();
const riderView = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}`, rider)).json();
const here = (at: { lat: number; lng: number }) => ({ ...at, accuracy: 5, measuredAt: clock.now.toISOString() });
const geofenceTimers = async (tripId: string) => (await database.db.selectFrom("timers").select("kind").where("kind", "=", "pickup_geofence").where("ref_id", "=", tripId).execute()).length;

/** Booked in Stockholm with `stops`, accepted by driver A, auto-arrived at the pickup, boarded, started: in_trip. */
async function inTrip(stops: Doc[] = [STOP_A]): Promise<{ tripId: string; version: number }> {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops, categoryIds: ["economy"] })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops, kind: "live", paymentMethod: "cash" });
  expect(res.statusCode, res.body).toBe(201);
  await worker.runDue();
  const [offer] = (await call(app, "GET", "/driver/offers", driverA.headers)).json().items;
  const acc = await call(app, "POST", `/offers/${offer.offerId}/accept`, driverA.headers, { expectedVersion: offer.version });
  expect(acc.statusCode, acc.body).toBe(200);
  return toInTrip(res.json().tripId as string, acc.json().version as number, NORRMALM);
}
async function toInTrip(tripId: string, version: number, pickup: { lat: number; lng: number }) {
  let v = version;
  for (const path of ["head-to-pickup", "arrive", "board", "start"]) {
    clock.now = new Date(clock.now.getTime() + 1000);
    if (path === "arrive") await fixAt(north(pickup, 20));
    const r = await step(tripId, path, v, path === "arrive" ? { location: here(north(pickup, 20)) } : {});
    expect(r.statusCode, `${path}: ${r.body}`).toBe(200);
    v = r.json().version;
  }
  await worker.runDue();
  return { tripId, version: (await driverView(tripId)).version as number };
}
/** A Tunis trip (TND) with one stop, given to driver A (the Tunis dispatch is not under test), in_trip. */
async function inTripTunis(stops: Doc[] = [TUNIS_STOP]): Promise<{ tripId: string; version: number }> {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: TUNIS, dropoff: TUNIS_DROP, stops, categoryIds: ["economy"] })).json().quotes?.[0];
  expect(quote, "a TND quote").toBeDefined();
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: TUNIS, dropoff: TUNIS_DROP, stops, kind: "live", paymentMethod: "cash" });
  expect(res.statusCode, res.body).toBe(201);
  const tripId = res.json().tripId as string;
  await database.db.updateTable("offers").set({ status: "withdrawn" }).where("trip_id", "=", tripId).execute();
  await database.db.updateTable("trips").set({ status: "accepted", driver_id: driverA.id, accepted_at: clock.now, version: res.json().version + 1 }).where("trip_id", "=", tripId).execute();
  await database.db.updateTable("drivers").set({ online_status: "on_trip" }).where("driver_id", "=", driverA.id).execute();
  return toInTrip(tripId, res.json().version + 1, TUNIS);
}
/** The driver's phone reaches 40 m from stop `i`: the server marks it arrived (no tap). */
async function autoAtStop(tripId: string, i: number, stop: { lat: number; lng: number }) {
  await pairAfter(clock.now.toISOString(), 30, north(stop, 40));
  const trip = await driverView(tripId);
  expect(trip.stops[i].arrivedAt, `stop ${i} arrived`).toBeDefined();
  type Visited = Doc & { arrivedAt: string; leftAt?: string };
  return trip as Doc & { version: number; stops: [Visited, ...Visited[]] };
}
/** The test clock runs past the tokens' life on long waits: both sign in again. */
async function signInAgain() {
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driverA.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
}
/** Finish at the drop-off: the complete preview's stop_waiting line and the finished trip's. */
async function complete(tripId: string, dropoff: { lat: number; lng: number }) {
  clock.now = new Date(clock.now.getTime() + 60_000);
  await signInAgain();
  await fixAt(dropoff);
  await worker.runDue();
  const version = (await driverView(tripId)).version;
  const preview = (await call(app, "GET", `/driver/trips/${tripId}/complete-preview`, driverA.headers)).json();
  const done = await step(tripId, "complete", version, { previewId: preview.previewId, cashCollected: preview.cashDue });
  expect(done.statusCode, done.body).toBe(200);
  const line = (fare: { fareLines?: Array<{ code: string; amount: unknown }> }) => fare.fareLines?.find((l) => l.code === "stop_waiting")?.amount;
  return { preview: line(preview), done: line(done.json()), trip: done.json() };
}

describe("C9b (1): the server marks the NEXT stop arrived after 2 slow fixes within autoArriveMeters", () => {
  it("2 fixes 40 m from stop 0 while in_trip: stops[0].arrivedAt, arrivedBy auto, version + 1, a trip_projection event; the rider sees it", async () => {
    const { tripId, version } = await inTrip();
    const trip = await autoAtStop(tripId, 0, STOP_A);
    expect(trip.version).toBe(version + 1);
    expect(trip.stops[0]).toMatchObject({ address: "Fridhemsplan", arrivedBy: "auto", arrivedAt: clock.now.toISOString() });
    expect(trip.stopVisits).toEqual([{ stopIndex: 0, arrivedAt: clock.now.toISOString(), arrivedBy: "auto" }]);
    expect((await riderView(tripId)).stops[0]).toMatchObject({ arrivedBy: "auto" });
    const events = await database.db.selectFrom("trip_events").select(["kind", "version"]).where("trip_id", "=", tripId).where("version", "=", version + 1).execute();
    expect(events.map((e) => e.kind)).toContain("trip_projection");
    // The tap after the server's arrival: 409 stop_already_arrived (the app takes it as done).
    const late = await stopTap(tripId, 0, "arrive", trip.version, { location: here(north(STOP_A, 40)) });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ reason: "stop_already_arrived" });
  });

  it("one fix, a drive-by at 50 km/h (with speedMps, and by the straight-line speed), a fix less accurate than 50 m: nothing", async () => {
    const { tripId, version } = await inTrip();
    const t = clock.now.toISOString();
    await fixAfter(t, 30, north(STOP_A, 20));
    expect((await driverView(tripId)).stops[0].arrivedAt).toBeUndefined();
    await fixAfter(t, 60, north(STOP_A, 30), 5, 13.9);
    await fixAfter(t, 66, north(STOP_A, -30), 5, 13.9);
    expect((await driverView(tripId)).stops[0].arrivedAt).toBeUndefined();
    await fixAfter(t, 120, north(STOP_A, 90));
    await fixAfter(t, 125, north(STOP_A, -90));
    expect((await driverView(tripId)).stops[0].arrivedAt).toBeUndefined();
    await fixAfter(t, 200, north(STOP_A, 10), 80);
    await fixAfter(t, 206, north(STOP_A, 10), 80);
    const trip = await driverView(tripId);
    expect(trip.stops[0].arrivedAt).toBeUndefined();
    expect(trip.version).toBe(version);
  });

  it("order: fixes at stop 1 while stop 0 has no arrival change nothing; after stop 0, auto at stop 1 closes stop 0 (leftAt = now)", async () => {
    const { tripId } = await inTrip([STOP_A, STOP_B]);
    await pairAfter(clock.now.toISOString(), 30, north(STOP_B, 30));
    expect((await driverView(tripId)).stops.map((s: Doc) => s.arrivedAt)).toEqual([undefined, undefined]);
    await autoAtStop(tripId, 0, STOP_A);
    const trip = await autoAtStop(tripId, 1, STOP_B);
    expect(trip.stops[0].leftAt).toBe(trip.stops[1]!.arrivedAt);
    expect(trip.stops[1]).toMatchObject({ arrivedBy: "auto" });
    expect(trip.stops[1]!.leftAt).toBeUndefined();
  });
});

describe("C9b (2): away and back at an open stop", () => {
  it("2 fixes > 200 m: away.since = the first fix, no version change; 190 / 210 m jitter changes nothing", async () => {
    const { tripId } = await inTrip();
    const arrived = await autoAtStop(tripId, 0, STOP_A);
    const t0 = arrived.stops[0].arrivedAt;
    // One fix beyond 200 m between two inside it: never a confirmed pair.
    await fixAfter(t0, 60, north(STOP_A, 190));
    await fixAfter(t0, 66, north(STOP_A, 210));
    await fixAfter(t0, 72, north(STOP_A, 190));
    expect((await driverView(tripId)).stops[0].away).toBeUndefined();
    await pairAfter(t0, 120, north(STOP_A, 400));
    const away = await driverView(tripId);
    expect(away.version).toBe(arrived.version);
    expect(away.stops[0].away).toEqual({ since: new Date(Date.parse(t0) + 120_000).toISOString() });
    expect(away.stopVisits[0].away).toEqual(away.stops[0].away);
    expect((await riderView(tripId)).stops[0].away).toEqual(away.stops[0].away);
  });

  it("back by fixes: pausedSeconds / pauseCount, away goes, arrivedAt stays, no version change", async () => {
    const { tripId } = await inTrip();
    const arrived = await autoAtStop(tripId, 0, STOP_A);
    const t0 = arrived.stops[0].arrivedAt;
    await pairAfter(t0, 120, north(STOP_A, 400));
    await pairAfter(t0, 420, north(STOP_A, 50));
    const back = await driverView(tripId);
    expect(back.version).toBe(arrived.version);
    expect(back.stops[0]).toMatchObject({ arrivedAt: t0, arrivedBy: "auto", pausedSeconds: 300, pauseCount: 1 });
    expect(back.stops[0].away).toBeUndefined();
  });

  it("the back tap from 250 m (beyond leaveMeters) is 409 not_at_stop and the clock stays stopped; from 150 m it resumes (version + 1)", async () => {
    const c = fixtureCase("se_stop_back_tap_too_far_then_within_leave");
    const { tripId } = await inTrip();
    const arrived = await autoAtStop(tripId, 0, STOP_A);
    const t0 = arrived.stops[0].arrivedAt;
    await pairAfter(t0, c.events[0].at, north(STOP_A, c.events[0].meters));
    clock.now = new Date(Date.parse(t0) + c.events[1].at * 1000);
    const far = await stopTap(tripId, 0, "arrive", arrived.version, { location: here(north(STOP_A, c.events[1].meters)) });
    expect(far.statusCode, far.body).toBe(409);
    expect(far.json()).toMatchObject({ code: "invalid_transition", reason: "not_at_stop" });
    expect((await driverView(tripId)).stops[0].away).toBeDefined();
    clock.now = new Date(Date.parse(t0) + c.events[2].at * 1000);
    const ok = await stopTap(tripId, 0, "arrive", arrived.version, { location: here(north(STOP_A, c.events[2].meters)) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().version).toBe(arrived.version + 1);
    expect(ok.json().stops[0]).toMatchObject({ arrivedAt: t0, pausedSeconds: c.expect.pausedSeconds, pauseCount: 1 });
    expect(ok.json().stops[0].away).toBeUndefined();
    // Not away any more: a second arrive stays 409 stop_already_arrived.
    const again = await stopTap(tripId, 0, "arrive", ok.json().version, { location: here(north(STOP_A, 10)) });
    expect(again.json()).toMatchObject({ reason: "stop_already_arrived" });
  });
});

describe("C9b (3): money = fixtures/auto_arrive.json#stops (preview line = final line)", () => {
  /** Replays one fixture case on a real trip: auto arrival, fixes as confirming pairs, taps, then leave or complete. */
  async function replay(id: string, tunis = false) {
    const c = fixtureCase(id);
    if (c.stopFreeWaitMin) await publish("driver_app_config", tunis ? "TN-TC" : "Z001", driverDoc({ stopFreeWaitMin: c.stopFreeWaitMin }, {}, tunis));
    const stop = tunis ? TUNIS_STOP : STOP_A;
    const { tripId } = tunis ? await inTripTunis() : await inTrip();
    const arrived = await autoAtStop(tripId, 0, stop);
    const t0 = arrived.stops[0].arrivedAt;
    const taps: string[] = [];
    for (const e of c.events) {
      if (e.kind === "fix") await pairAfter(t0, e.at, north(stop, e.meters));
      else {
        clock.now = new Date(Date.parse(t0) + e.at * 1000);
        await signInAgain();
        if (e.kind === "tap") {
          const r = await stopTap(tripId, 0, "arrive", (await driverView(tripId)).version, { location: here(north(stop, e.meters)) });
          taps.push(r.statusCode === 200 ? "ok" : r.json().reason);
        } else if (e.kind === "leave") {
          const r = await stopTap(tripId, 0, "leave", (await driverView(tripId)).version);
          expect(r.statusCode, r.body).toBe(200);
        }
      }
    }
    const end = c.events[c.events.length - 1];
    const live = await driverView(tripId);
    expect({ pausedSeconds: live.stops[0].pausedSeconds ?? 0, pauseCount: live.stops[0].pauseCount ?? 0, awayAtEnd: live.stops[0].away !== undefined, taps }).toEqual({
      pausedSeconds: c.expect.pausedSeconds, pauseCount: c.expect.pauseCount, awayAtEnd: c.expect.awayAtEnd, taps: c.expect.taps,
    });
    // "complete" at end.at: the drop-off is reached later, the stop charge is frozen at away.since (or ends at leftAt).
    if (end.kind === "complete") expect(live.stops[0].leftAt).toBeUndefined();
    // The trip is completed at end.at exactly (complete() moves the clock 60 s on to the drop-off first).
    if (end.kind === "complete") clock.now = new Date(Date.parse(t0) + end.at * 1000 - 60_000);
    const lines = await complete(tripId, tunis ? TUNIS_DROP : SODERMALM);
    expect(lines.preview).toEqual(c.expect.stopLine);
    expect(lines.done).toEqual(c.expect.stopLine);
    return lines;
  }

  it("SEK one pause, free 0 → 600 s = 50,00 kr", async () => {
    await replay("se_stop_one_pause_free0");
  });
  it("SEK one pause, stopFreeWaitMin 2 → 480 s = 40,00 kr", async () => {
    await replay("se_stop_one_pause_free2");
  });
  it("SEK leave while away: the charge stops at away.since → 200 s = 16,67 kr (half-up); away stays on the left stop", async () => {
    await replay("se_stop_leave_while_away");
  });
  it("SEK back tap too far (409 not_at_stop) then within leaveMeters → 400 s = 33,33 kr", async () => {
    await replay("se_stop_back_tap_too_far_then_within_leave");
  });
  it("SEK between the distances: no flip-flop; a tap while not away = stop_already_arrived → 600 s = 50,00 kr", async () => {
    await replay("se_stop_between_distances_no_flip_flop");
  });
  it("TND one pause, free 2 min, half-up → 747 s = 3.113 DT", async () => {
    await replay("tn_stop_one_pause_free2_half_up", true);
  });
  it("TND complete while away → 400 s = 1.667 DT", async () => {
    await replay("tn_stop_complete_while_away", true);
  });
  it("TND two pauses (fix and tap), free 1 min → 320 s = 1.333 DT", async () => {
    await replay("tn_stop_two_pauses_fix_and_tap", true);
  });
});

describe("C9b (4): the first stop tap's position check (fixtures/auto_arrive.json#firstTap, round 2: sent + stored)", () => {
  type Pos = { meters: number; ageSeconds: number } | null;
  for (const c of FIXTURE.firstTap as Array<{ id: string; contractVersion: string | null; sent: Pos; stored: Pos; expect: string }>) {
    it(`${c.id} → ${c.expect}`, async () => {
      const { tripId, version } = await inTrip();
      // The server's stored fix: posted now, then the clock moves on by its age (none: the stored row is removed).
      if (c.stored === null) await database.db.deleteFrom("driver_locations").where("driver_id", "=", driverA.id).execute();
      else {
        clock.now = new Date(clock.now.getTime() + 30_000);
        await fixAt(north(STOP_A, c.stored.meters));
        clock.now = new Date(clock.now.getTime() + c.stored.ageSeconds * 1000);
        await signInAgain();
      }
      const body = c.sent === null ? {} : { location: { ...north(STOP_A, c.sent.meters), accuracy: 5, measuredAt: new Date(clock.now.getTime() - c.sent.ageSeconds * 1000).toISOString() } };
      const headers: Record<string, string> = c.contractVersion === null ? {} : { "x-contract-version": c.contractVersion };
      const r = await stopTap(tripId, 0, "arrive", version, body, headers);
      if (c.expect === "ok") {
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json().stops[0]).toMatchObject({ arrivedBy: "tap" });
      } else {
        expect(r.statusCode, r.body).toBe(409);
        expect(r.json()).toMatchObject({ code: "invalid_transition", reason: c.expect });
        expect((await driverView(tripId)).stops[0].arrivedAt).toBeUndefined();
      }
    });
  }

  it("the location sent with the tap counts when it has measuredAt: an old one (and an old stored fix) → position_stale, 400 m → not_at_stop, 50 m → ok", async () => {
    const { tripId, version } = await inTrip();
    clock.now = new Date(clock.now.getTime() + 90_000);
    const old = { ...north(STOP_A, 50), accuracy: 5, measuredAt: new Date(clock.now.getTime() - 120_000).toISOString() };
    expect((await stopTap(tripId, 0, "arrive", version, { location: old })).json()).toMatchObject({ reason: "position_stale" });
    expect((await stopTap(tripId, 0, "arrive", version, { location: here(north(STOP_A, 400)) })).json()).toMatchObject({ reason: "not_at_stop" });
    const ok = await stopTap(tripId, 0, "arrive", version, { location: here(north(STOP_A, 50)) });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe("C9b (5): the job is booked only while the trip has an unvisited or open stop", () => {
  it("a trip with no stops in_trip: no geofence job; with a stop: booked near it; after the last stop is left: none", async () => {
    const plain = await inTrip([]);
    clock.now = new Date(clock.now.getTime() + 10_000);
    await fixAt(north(STOP_A, 20));
    expect(await geofenceTimers(plain.tripId)).toBe(0);
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", plain.tripId).execute();
    await database.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", driverA.id).execute();

    const { tripId } = await inTrip();
    clock.now = new Date(clock.now.getTime() + 10_000);
    await fixAt(north(STOP_A, 20));
    expect(await geofenceTimers(tripId)).toBe(1);
    const arrived = await autoAtStop(tripId, 0, STOP_A);
    const left = await stopTap(tripId, 0, "leave", arrived.version);
    expect(left.statusCode, left.body).toBe(200);
    await worker.runDue();
    await database.db.deleteFrom("timers").where("kind", "=", "pickup_geofence").execute();
    clock.now = new Date(clock.now.getTime() + 10_000);
    await fixAt(north(STOP_A, 500));
    await fixAt(north(STOP_A, 20));
    expect(await geofenceTimers(tripId)).toBe(0);
  });
});

describe("C9b (6): a route change keeps a visited stop's away / pausedSeconds / pauseCount", () => {
  it("stop 0 paused once, the rider adds stop 1: stops[0] keeps its fields", async () => {
    await publish("driver_app_config", "Z001", driverDoc({}, { routeChange: { driverCanRefuse: false } }));
    const { tripId } = await inTrip();
    const arrived = await autoAtStop(tripId, 0, STOP_A);
    const t0 = arrived.stops[0].arrivedAt;
    await pairAfter(t0, 120, north(STOP_A, 400));
    await pairAfter(t0, 420, north(STOP_A, 50));
    await pairAfter(t0, 500, north(STOP_A, 600));
    const before = await riderView(tripId);
    const q = (await call(app, "POST", `/trips/${tripId}/route-quote`, rider, { expectedVersion: before.version, stops: [STOP_A, STOP_B] })).json();
    expect(q.routeQuoteId, JSON.stringify(q)).toBeDefined();
    const applied = await call(app, "PATCH", `/trips/${tripId}`, rider, { expectedVersion: before.version, routeQuoteId: q.routeQuoteId });
    expect(applied.statusCode, applied.body).toBe(200);
    const after = await driverView(tripId);
    expect(after.stops).toHaveLength(2);
    expect(after.stops[0]).toMatchObject({ arrivedAt: t0, arrivedBy: "auto", pausedSeconds: 300, pauseCount: 1, away: { since: new Date(Date.parse(t0) + 500_000).toISOString() } });
    expect(after.stops[1].arrivedAt).toBeUndefined();
  });
});

/* ---------------------------------------------------------------- supervisor round 1 (Rules audits/impact/c9b-middle-stops-supervisor.md) */

const PLACES = {
  SEK: { inTrip: (stops: Doc[]) => inTrip(stops), stop: STOP_A },
  TND: { inTrip: (stops: Doc[]) => inTripTunis(stops), stop: TUNIS_STOP },
} as const;

for (const currency of ["SEK", "TND"] as const) {
  const { stop } = PLACES[currency];
  const start = PLACES[currency].inTrip;
  const named = (address: string, meters: number) => ({ address, ...north(stop, meters) });

  describe(`C9b M1 (${currency}): no auto arrival at the next stop while the driver still waits at the open stop`, () => {
    it("two stops 60 m apart, parked at stop 0: another confirming pair does NOT arrive stop 1 nor close stop 0; his tap does", async () => {
      const { tripId } = await start([{ ...stop }, named("Next door", 60)]);
      const arrived = await autoAtStop(tripId, 0, stop);
      // Still parked 40 m north of stop 0 (20 m from stop 1): a fresh confirming pair.
      await pairAfter(clock.now.toISOString(), 30, north(stop, 40));
      const still = await driverView(tripId);
      expect(still.stops[0].leftAt, "stop 0 stays open").toBeUndefined();
      expect(still.stops[1].arrivedAt, "stop 1 not auto-arrived").toBeUndefined();
      expect(still.version).toBe(arrived.version);
      clock.now = new Date(clock.now.getTime() + 5000);
      const tap = await stopTap(tripId, 1, "arrive", still.version, { location: here(north(stop, 60)) });
      expect(tap.statusCode, tap.body).toBe(200);
      expect(tap.json().stops[1]).toMatchObject({ arrivedBy: "tap" });
      expect(tap.json().stops[0].leftAt).toBe(tap.json().stops[1].arrivedAt);
    });

    it("two stops 150 m apart: driving on to stop 1 (both fixes > 100 m from stop 0) still arrives it automatically", async () => {
      const { tripId } = await start([{ ...stop }, named("Down the road", 150)]);
      await autoAtStop(tripId, 0, stop);
      const trip = await autoAtStop(tripId, 1, north(stop, 150 - 40));
      expect(trip.stops[1]).toMatchObject({ arrivedBy: "auto" });
      expect(trip.stops[0].leftAt).toBe(trip.stops[1]!.arrivedAt);
    });
  });

  describe(`C9b M2 (${currency}): the ride check's long_stop counts an open stop as "at the stop" only while not away`, () => {
    /** The car stands still at `at` for `seconds` (a fix every 30 s, the job worker after each). */
    async function standStill(at: { lat: number; lng: number }, seconds: number) {
      const from = clock.now.toISOString();
      for (let s = 30; s <= seconds; s += 30) await fixAfter(from, s, at);
    }
    it("open stop, driver away (400 m) and still for 3 min → long_stop is asked", async () => {
      const { tripId } = await start([{ ...stop }]);
      const arrived = await autoAtStop(tripId, 0, stop);
      await pairAfter(arrived.stops[0].arrivedAt, 60, north(stop, 400));
      expect((await driverView(tripId)).stops[0].away).toBeDefined();
      await standStill(north(stop, 400), 180);
      const seen = await riderView(tripId);
      expect(seen.stops[0].away).toBeDefined();
      expect(seen.rideCheck?.trigger).toBe("long_stop");
    });
    it("open stop, driver waiting at it (not away) for 3 min → no long_stop", async () => {
      const { tripId } = await start([{ ...stop }]);
      await autoAtStop(tripId, 0, stop);
      await standStill(north(stop, 40), 180);
      const seen = await riderView(tripId);
      expect(seen.stops[0].away).toBeUndefined();
      expect(seen.rideCheck?.trigger).not.toBe("long_stop");
    });
  });
}

for (const currency of ["SEK", "TND"] as const) {
  const { stop } = PLACES[currency];
  const start = PLACES[currency].inTrip;
  describe(`C9b S1 (${currency}): an older app's first stop tap is checked against the server's stored fix (300 m, any age)`, () => {
    const tapOld = async (meters: number | null, ageSeconds: number, headers: Record<string, string>) => {
      const { tripId, version } = await start([{ ...stop }]);
      if (meters === null) await database.db.deleteFrom("driver_locations").where("driver_id", "=", driverA.id).execute();
      else {
        clock.now = new Date(clock.now.getTime() + 30_000);
        await fixAt(north(stop, meters));
        clock.now = new Date(clock.now.getTime() + ageSeconds * 1000);
      }
      return { tripId, res: await stopTap(tripId, 0, "arrive", version, {}, headers) };
    };
    it("no header, stored fix 400 m → 409 not_at_stop (nothing arrived)", async () => {
      const { tripId, res } = await tapOld(400, 10, {});
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: "invalid_transition", reason: "not_at_stop" });
      expect((await driverView(tripId)).stops[0].arrivedAt).toBeUndefined();
    });
    it("X-Contract-Version 0.18.97, stored fix 400 m → 409 not_at_stop", async () => {
      const { res } = await tapOld(400, 10, { "x-contract-version": "0.18.97" });
      expect(res.json()).toMatchObject({ reason: "not_at_stop" });
    });
    it("no header, stored fix 250 m and 10 min old → ok (no age for an older app, as the pickup's old path)", async () => {
      const { res } = await tapOld(250, 600, {});
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().stops[0]).toMatchObject({ arrivedBy: "tap" });
    });
    it("no header and no stored fix at all → ok (an older app is never stuck)", async () => {
      const { res } = await tapOld(null, 0, {});
      expect(res.statusCode, res.body).toBe(200);
    });
  });
}
