import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { schemaProblem } from "../../src/contract/schemas.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { readEnv } from "../../src/env.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { fixedRouter } from "../support/world.js";
import { callHandlers } from "../../src/calls/service.js";
import { callTripPeer } from "../../src/trips/call.js";
import type { TelephonyProvider } from "../../src/telephony/provider.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * v0.18.38 §62 (fix job 8, owner G15 2026-11-05: "In-app calls only", "Both rider and driver", "Just 'Call failed'"):
 * in-app calls between the trip's rider and driver. The server keeps the call in trip_calls and relays the WebRTC
 * signalling on the trip stream; the window runs until 60 min after drop-off. Rule 33: a second server copy on the same
 * database answers any step of a call another copy started.
 */

let database: TestDatabase;
let app: FastifyInstance;
let copy2: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-05T12:00:00Z") };
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const SPOT = { lat: 59.3335, lng: 18.0655 };
const driver: { id: string; headers: Record<string, string> } = { id: "", headers: {} };
let rider: Record<string, string>;
let stranger: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  // Rule 33: a second server copy on the same database, with its own memory.
  copy2 = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "world-test-secret".padEnd(48, "w") }), logger: false, db: database.db, clock: () => clock.now, router: fixedRouter });
  await database.db.insertInto("config_live").values([
    { doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null },
    { doc: "rider_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("rider_app_config")), published_at: clock.now, published_by: null },
  ]).execute();
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers, ...callHandlers }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver C", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "CALL001", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  driver.id = made.driverId;
});
afterAll(async () => {
  await copy2.close();
  await app.close();
  await database.drop();
});

const fix = (at: { lat: number; lng: number }) => ({ fixes: [{ ...at, accuracy: 5, measuredAt: clock.now.toISOString() }] });
const moveTo = async (at: { lat: number; lng: number }) => expect((await call(app, "POST", "/driver/location", driver.headers, fix(at))).statusCode).toBe(200);

beforeEach(() => fresh());
/** A free driver at SPOT, fresh sign-ins (tokens outlive no long clock jump), no open trips. */
async function fresh() {
  clock.now = new Date(clock.now.getTime() + 3 * 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  stranger = (await signIn(app, TEST_PHONES[3]!, "rider")).headers;
  driver.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now, rating_sum: 0, rating_count: 0 }).where("driver_id", "=", driver.id).execute();
  await moveTo(SPOT);
}
async function signInAgain() {
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driver.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
}

async function accepted() {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  await worker.runDue();
  const [offer] = (await call(app, "GET", "/driver/offers", driver.headers)).json().items;
  expect(offer?.tripId).toBe(trip.tripId);
  const res = await call(app, "POST", `/offers/${offer.offerId}/accept`, driver.headers, { expectedVersion: offer.version });
  expect(res.statusCode).toBe(200);
  return { tripId: trip.tripId as string, version: res.json().version as number };
}

async function completed() {
  const { tripId, version } = await accepted();
  let v = version;
  for (const path of ["head-to-pickup", "arrive", "board", "start"]) {
    if (path === "board") await advance(60);
    expect((await call(app, "POST", `/trips/${tripId}/${path}`, driver.headers, { expectedVersion: v++ })).statusCode).toBe(200);
  }
  clock.now = new Date(clock.now.getTime() + 1000);
  await moveTo(SODERMALM);
  const done = await call(app, "POST", `/trips/${tripId}/complete`, driver.headers, { expectedVersion: v });
  expect(done.json()).toMatchObject({ status: "completed" });
  return { tripId };
}

const startCall = (tripId: string, who: Record<string, string>, server = app) => call(server, "POST", `/trips/${tripId}/call`, who, {});
const eventsOf = async (tripId: string, who: Record<string, string>) => (await call(app, "GET", `/trips/${tripId}/events?after=0&limit=500`, who)).json().items as Array<Record<string, unknown>>;
const setCalls = (calls: Record<string, unknown>) =>
  database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "Z001", version: 1, document: JSON.stringify({ calls }), published_at: clock.now, published_by: null }).execute();

describe("in-app calls (v0.18.38 §62)", () => {
  it("C1 the rider calls: 200 TripCall mode in_app with callId and ICE servers; the driver's stream carries call_ringing; no number", async () => {
    const { tripId } = await accepted();
    const res = await startCall(tripId, rider);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(schemaProblem("TripCall", body)).toBeNull();
    expect(body).toMatchObject({ tripId, mode: "in_app", ringSeconds: 30, maxCallMin: 15 });
    expect(body.callId).toBeTruthy();
    expect(body.ice.servers.length).toBeGreaterThan(0);
    expect(body.proxyNumber).toBeUndefined();
    const ringing = (await eventsOf(tripId, driver.headers)).filter((e) => e.kind === "call_ringing");
    expect(ringing).toHaveLength(1);
    expect(ringing[0]!.call).toMatchObject({ callId: body.callId, from: "rider", to: "driver", state: "ringing" });
    expect(schemaProblem("RealtimeEvent", ringing[0])).toBeNull();
  });

  it("C2 the driver may call too (owner: both sides); a second call while one is live is 409 call_busy; a stranger gets 404", async () => {
    const { tripId } = await accepted();
    const first = await startCall(tripId, driver.headers);
    expect(first.statusCode).toBe(200);
    expect((await eventsOf(tripId, rider)).find((e) => e.kind === "call_ringing")!.call).toMatchObject({ from: "driver", to: "rider" });
    const busy = await startCall(tripId, rider);
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ code: "invalid_transition", reason: "call_busy" });
    expect((await startCall(tripId, stranger)).statusCode).toBe(404);
  });

  it("C3 answer, signal and end run on ANY server copy (rule 33): start on copy 1, answer and signal on copy 2, end on copy 1", async () => {
    const { tripId } = await accepted();
    const { callId } = (await startCall(tripId, rider, app)).json();
    const offer = await call(copy2, "POST", `/calls/${callId}/signal`, rider, { type: "offer", sdp: "v=0 offer" });
    expect(offer.statusCode).toBe(202);
    const answered = await call(copy2, "POST", `/calls/${callId}/answer`, driver.headers, {});
    expect(answered.statusCode).toBe(200);
    expect(schemaProblem("CallView", answered.json())).toBeNull();
    expect(answered.json()).toMatchObject({ callId, state: "answered" });
    // The callee gets its own ICE servers with the answer.
    expect(answered.json().ice.servers.length).toBeGreaterThan(0);
    expect((await call(copy2, "POST", `/calls/${callId}/signal`, driver.headers, { type: "answer", sdp: "v=0 answer" })).statusCode).toBe(202);
    expect((await call(app, "POST", `/calls/${callId}/signal`, driver.headers, { type: "ice", candidate: { candidate: "candidate:1 1 udp 1 10.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 } })).statusCode).toBe(202);
    await advance(42);
    const ended = await call(app, "POST", `/calls/${callId}/end`, rider, { reason: "hangup" });
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({ state: "ended", endedReason: "hangup", seconds: 42 });
    // A second end gives the same answer.
    expect((await call(copy2, "POST", `/calls/${callId}/end`, driver.headers, { reason: "hangup" })).json()).toMatchObject({ state: "ended", endedReason: "hangup", seconds: 42 });
    const kinds = (await eventsOf(tripId, driver.headers)).map((e) => e.kind).filter((k) => String(k).startsWith("call_"));
    expect(kinds).toEqual(["call_ringing", "call_signal", "call_answered", "call_signal", "call_signal", "call_ended"]);
    const signals = (await eventsOf(tripId, rider)).filter((e) => e.kind === "call_signal");
    expect(signals.map((e) => (e.signal as { from: string; type: string }))).toEqual([{ callId, from: "rider", type: "offer", sdp: "v=0 offer" }, { callId, from: "driver", type: "answer", sdp: "v=0 answer" }, expect.objectContaining({ from: "driver", type: "ice" })]);
    // Only the callee answers; a signal on an ended call is 409 call_not_live.
    expect((await call(app, "POST", `/calls/${callId}/signal`, rider, { type: "ice", candidate: { candidate: "x" } })).json()).toMatchObject({ reason: "call_not_live" });
  });

  it("C4 not answered in ringSeconds (30): the server ends it as missed (database timer), event call_missed", async () => {
    const { tripId } = await accepted();
    const { callId } = (await startCall(tripId, driver.headers)).json();
    await advance(29);
    expect((await eventsOf(tripId, rider)).some((e) => e.kind === "call_missed")).toBe(false);
    await advance(2);
    const missed = (await eventsOf(tripId, rider)).filter((e) => e.kind === "call_missed");
    expect(missed).toHaveLength(1);
    expect(missed[0]!.call).toMatchObject({ callId, state: "missed", endedReason: "missed", seconds: 0 });
    // The line is free again.
    expect((await startCall(tripId, rider)).statusCode).toBe(200);
  });

  it("C5 the window: drop-off + 59 min → 200; drop-off + 61 min → 409 call_window_closed (today 409 chat_closed)", async () => {
    const { tripId } = await completed();
    await advance(59 * 60);
    await signInAgain();
    const inside = await startCall(tripId, rider);
    expect(inside.statusCode).toBe(200);
    expect((await call(app, "POST", `/calls/${inside.json().callId}/end`, rider, { reason: "hangup" })).statusCode).toBe(200);
    await advance(2 * 60);
    await signInAgain();
    const late = await startCall(tripId, driver.headers);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: "invalid_transition", reason: "call_window_closed" });
  });

  it("C6 admin settings per country: calls off → 403 calls_off; window 10 min → closed at +11; mode phone with a provider → proxyNumber, without → in_app", async () => {
    await setCalls({ on: false });
    const off = await accepted();
    const res = await startCall(off.tripId, rider);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "forbidden", reason: "calls_off" });
    await fresh();
    await setCalls({ on: true, callWindowAfterTripMin: 10 });
    const done = await completed();
    await advance(11 * 60);
    await signInAgain();
    expect((await startCall(done.tripId, rider)).json()).toMatchObject({ reason: "call_window_closed" });
    await fresh();
    await setCalls({ mode: "phone" });
    const phone = await accepted();
    const trip = await database.db.selectFrom("trips").select(["rider_id"]).where("trip_id", "=", phone.tripId).executeTakeFirstOrThrow();
    const provider: TelephonyProvider = { name: "fake", maskedCall: () => Promise.resolve({ proxyNumber: "+46700000999", expiresAt: new Date(clock.now.getTime() + 600_000) }) };
    const viaPhone = await database.db.transaction().execute((trx) => callTripPeer(trx, { actor: "rider", subjectId: trip.rider_id }, phone.tripId, provider, clock.now));
    expect(viaPhone).toMatchObject({ mode: "phone", proxyNumber: "+46700000999" });
    // Mode phone but no provider configured (the server default): in-app.
    expect((await startCall(phone.tripId, rider)).json()).toMatchObject({ mode: "in_app" });
  });

  it("C7 Admin › Trip details › Calls: GET /admin/trips/{tripId}/calls lists who, when, how long and how it ended (trips.read, zones)", async () => {
    const { tripId } = await accepted();
    const { callId } = (await startCall(tripId, rider)).json();
    await call(app, "POST", `/calls/${callId}/answer`, driver.headers, {});
    await advance(65);
    await call(app, "POST", `/calls/${callId}/end`, driver.headers, { reason: "hangup" });
    const admin = await adminSession(app, database.db, "support", { now: clock.now });
    const log = await call(app, "GET", `/admin/trips/${tripId}/calls`, admin.headers);
    expect(log.statusCode).toBe(200);
    expect(schemaProblem("CallLog", log.json())).toBeNull();
    expect(log.json().items).toEqual([expect.objectContaining({ callId, from: "rider", to: "driver", state: "ended", endedReason: "hangup", seconds: 65 })]);
    const elsewhere = await adminSession(app, database.db, "support", { zoneIds: ["FR-PC"], now: clock.now });
    expect((await call(app, "GET", `/admin/trips/${tripId}/calls`, elsewhere.headers)).json()).toMatchObject({ reason: "zone_out_of_scope" });
    // A rider cannot read the admin log.
    expect((await call(app, "GET", `/admin/trips/${tripId}/calls`, rider)).statusCode).toBe(403);
  });

  it("C8 no phone number in any call payload or call event (scan)", async () => {
    const { tripId } = await accepted();
    const started = (await startCall(tripId, rider)).json();
    const answered = (await call(app, "POST", `/calls/${started.callId}/answer`, driver.headers, {})).json();
    await call(app, "POST", `/calls/${started.callId}/signal`, rider, { type: "offer", sdp: "v=0" });
    const ended = (await call(app, "POST", `/calls/${started.callId}/end`, rider, { reason: "hangup" })).json();
    const admin = await adminSession(app, database.db, "support", { now: clock.now });
    const bodies = JSON.stringify([started, answered, ended, await eventsOf(tripId, rider), await eventsOf(tripId, driver.headers), (await call(app, "GET", `/admin/trips/${tripId}/calls`, admin.headers)).json()]);
    for (const phone of [TEST_PHONES[0]!, TEST_PHONES[1]!]) expect(bodies).not.toContain(phone.slice(3));
  });

  // v0.18.66 §87 (contract.json#callConnect.connectTimeout, owner 2026-11-11: an admin setting, Rule 16). Fail-before: no field.
  it("C9 connectTimeoutSeconds (default 25) rides on TripCall, call_ringing, the answer, the end and the admin log; the zone's country rules set it", async () => {
    const { tripId } = await accepted();
    const started = await startCall(tripId, rider);
    expect(started.json()).toMatchObject({ ringSeconds: 30, maxCallMin: 15, connectTimeoutSeconds: 25 });
    expect(schemaProblem("TripCall", started.json())).toBeNull();
    const answered = await call(app, "POST", `/calls/${started.json().callId}/answer`, driver.headers, {});
    expect(answered.json()).toMatchObject({ state: "answered", connectTimeoutSeconds: 25 });
    expect(schemaProblem("CallView", answered.json())).toBeNull();
    const ended = await call(app, "POST", `/calls/${started.json().callId}/end`, rider, { reason: "failed" });
    expect(ended.json()).toMatchObject({ state: "ended", endedReason: "failed", connectTimeoutSeconds: 25 });
    const calls = (await eventsOf(tripId, driver.headers)).filter((e) => String(e.kind).startsWith("call_") && e.kind !== "call_signal");
    expect(calls.map((e) => [e.kind, (e.call as { connectTimeoutSeconds?: number }).connectTimeoutSeconds])).toEqual([["call_ringing", 25], ["call_answered", 25], ["call_ended", 25]]);
    for (const e of calls) expect(schemaProblem("RealtimeEvent", e)).toBeNull();
    const admin = await adminSession(app, database.db, "support", { now: clock.now });
    expect((await call(app, "GET", `/admin/trips/${tripId}/calls`, admin.headers)).json().items[0]).toMatchObject({ connectTimeoutSeconds: 25 });

    await fresh();
    await setCalls({ connectTimeoutSeconds: 40 });
    const own = await accepted();
    const second = await startCall(own.tripId, driver.headers);
    expect(second.json()).toMatchObject({ connectTimeoutSeconds: 40 });
    await advance(31);
    const missed = (await eventsOf(own.tripId, rider)).find((e) => e.kind === "call_missed");
    expect(missed!.call).toMatchObject({ state: "missed", connectTimeoutSeconds: 40 });

    // A stored value outside 10–60 reads as the default.
    await fresh();
    await setCalls({ connectTimeoutSeconds: 5 });
    const bad = await accepted();
    expect((await startCall(bad.tripId, rider)).json()).toMatchObject({ connectTimeoutSeconds: 25 });
  });

  it("C10 Admin › Tips & limits › Calls: connectTimeoutSeconds outside 10–60 → 400 invalid_document; inside → saved (fail-before: 5 and 61 were saved)", async () => {
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const r = sample("rider_app_config"), d = sample("driver_app_config");
    const rules = (connectTimeoutSeconds: number) => ({ version: 1, publishedAt: clock.now.toISOString(), country: "SE", currency: "SEK", tips: r.tips ?? [], raiseSteps: r.raiseSteps ?? [], driverBonus: d.driverBonus ?? {}, calls: { on: true, ringSeconds: 30, maxCallMin: 15, connectTimeoutSeconds } });
    for (const bad of [5, 9, 61]) {
      const res = await call(app, "PUT", "/admin/config/country_rules", admin.headers, { expectedVersion: 1, zoneId: "Z001", document: rules(bad) });
      expect([res.statusCode, res.json().reason], String(bad)).toEqual([400, "invalid_document"]);
    }
    const ok = await call(app, "PUT", "/admin/config/country_rules", admin.headers, { expectedVersion: 1, zoneId: "Z001", document: rules(40) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().document.calls.connectTimeoutSeconds).toBe(40);
  });
});

describe("call open until (v0.18.113 BQ-S13, owner 2026-11-01 \"Keep call open for 1 hour but not chat\")", () => {
  const endedAt = async (tripId: string) => (await database.db.selectFrom("trips").select("ended_at").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).ended_at!;
  const readTrip = async (tripId: string, who: Record<string, string>) => (await call(app, "GET", `/trips/${tripId}`, who)).json() as Record<string, unknown>;
  const historyItem = async (tripId: string) => ((await call(app, "GET", "/rider/trips?limit=20", rider)).json().items as Array<Record<string, unknown>>).find((t) => t.tripId === tripId)!;

  it("S13-1 a completed trip carries callOpenUntil = drop-off + 60 min on GET /trips/{tripId} (rider, driver) and GET /rider/trips; the server allows a call at that instant, not after", async () => {
    const { tripId } = await completed();
    const until = new Date((await endedAt(tripId)).getTime() + 60 * 60_000).toISOString();
    const asRider = await readTrip(tripId, rider);
    expect(asRider.callOpenUntil).toBe(until);
    expect(schemaProblem("TripProjection", asRider)).toBeNull();
    expect((await readTrip(tripId, driver.headers)).callOpenUntil).toBe(until);
    expect((await historyItem(tripId)).callOpenUntil).toBe(until);
    clock.now = new Date(until);
    await signInAgain();
    const atEnd = await startCall(tripId, rider);
    expect(atEnd.statusCode).toBe(200);
    expect((await call(app, "POST", `/calls/${atEnd.json().callId}/end`, rider, { reason: "hangup" })).statusCode).toBe(200);
    clock.now = new Date(Date.parse(until) + 1000);
    expect((await startCall(tripId, driver.headers)).json()).toMatchObject({ reason: "call_window_closed" });
  });

  it("S13-2 the admin's window is read when the trip is served (10 min → drop-off + 10 min); calls off → no callOpenUntil", async () => {
    const { tripId } = await completed();
    const ended = (await endedAt(tripId)).getTime();
    await setCalls({ on: true, callWindowAfterTripMin: 10 });
    expect((await readTrip(tripId, driver.headers)).callOpenUntil).toBe(new Date(ended + 10 * 60_000).toISOString());
    expect((await historyItem(tripId)).callOpenUntil).toBe(new Date(ended + 10 * 60_000).toISOString());
    await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
    await setCalls({ on: false });
    expect((await readTrip(tripId, rider)).callOpenUntil).toBeUndefined();
    expect((await historyItem(tripId)).callOpenUntil).toBeUndefined();
  });

  it("S13-3 no callOpenUntil on a trip still under way or a cancelled trip", async () => {
    const live = await accepted();
    expect((await readTrip(live.tripId, rider)).callOpenUntil).toBeUndefined();
    const cancel = await call(app, "POST", `/trips/${live.tripId}/cancel`, rider, { expectedVersion: live.version, reasonCode: "plans_changed" });
    expect(cancel.statusCode).toBe(200);
    expect((await readTrip(live.tripId, rider)).callOpenUntil).toBeUndefined();
    expect((await historyItem(live.tripId)).callOpenUntil).toBeUndefined();
  });
});
