import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { schemaProblem } from "../../src/contract/schemas.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { purgeOldMessages } from "../../src/trips/messages.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/** v0.18.56 §78 (G9 part 2): chat settings, options, quick replies, auto messages, spam/length, translate, admin chats + Message, call push. */

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
let stranger: Record<string, string>;

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
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `MSG00${key}`, categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
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
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
  await database.db.updateTable("riders").set({ language: null }).execute();
  await database.db.updateTable("drivers").set({ language: null }).execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  stranger = (await signIn(app, TEST_PHONES[3]!, "rider")).headers;
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

const step = async (tripId: string, path: string, version: number, body: Record<string, unknown> = {}) => {
  // A finished trip was driven to the drop-off (the clock ticks a second each way, as in ride.test.ts).
  if (path === "complete") {
    clock.now = new Date(clock.now.getTime() + 1000);
    await moveTo("A", SODERMALM);
    const res = await call(app, "POST", `/trips/${tripId}/${path}`, drivers.A.headers, { expectedVersion: version, ...body });
    clock.now = new Date(clock.now.getTime() + 1000);
    await moveTo("A", SPOTS.A);
    return res;
  }
  return call(app, "POST", `/trips/${tripId}/${path}`, drivers.A.headers, { expectedVersion: version, ...body });
};

const send = (tripId: string, who: Record<string, string>, text: unknown, key?: string) => call(app, "POST", `/trips/${tripId}/messages`, who, { text }, key);
const list = async (tripId: string, who: Record<string, string>, query = "") => (await call(app, "GET", `/trips/${tripId}/messages${query}`, who)).json();
const tripView = async (tripId: string, who: Record<string, string>) => (await call(app, "GET", `/trips/${tripId}`, who)).json();
const noticesOf = async (who: Record<string, string>, kind: string) => (await call(app, "GET", "/notifications?limit=200", who)).json().items.filter((n: { kind: string }) => n.kind === kind);


const setChat = (chat: Record<string, unknown>) =>
  database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "Z001", version: 1, document: JSON.stringify({ chat }), published_at: clock.now, published_by: null }).execute();
const sendBody = (tripId: string, who: Record<string, string>, body: Record<string, unknown>) => call(app, "POST", `/trips/${tripId}/messages`, who, body);
const riderId = async () => (await database.db.selectFrom("riders").select("rider_id").where("phone", "=", TEST_PHONES[0]!).executeTakeFirstOrThrow()).rider_id;

describe("v0.18.56 §78 chat settings and options", () => {
  it("G1 options: defaults of configDefaults.chat for the caller's side, the header line; 404 for a stranger", async () => {
    const { tripId } = await accepted();
    const r = await call(app, "GET", `/trips/${tripId}/messages/options`, rider);
    expect(r.statusCode).toBe(200);
    expect(schemaProblem("ChatOptions", r.json())).toBeNull();
    expect(r.json()).toMatchObject({ maxLength: 2000, sound: true, sheetAutoOpen: "new_message", readAloudDefault: false, translation: true, quickRepliesOn: true, headerLine: { en: "Problem? Use Support or SOS" } });
    expect(r.json().quickReplies.map((q: { id: string }) => q.id)).toEqual(["coming_now", "two_min", "where_parked", "thanks"]);
    const d = (await call(app, "GET", `/trips/${tripId}/messages/options`, drivers.A.headers)).json();
    expect(d.quickReplies).toHaveLength(5);
    expect((await call(app, "GET", `/trips/${tripId}/messages/options`, stranger)).statusCode).toBe(404);
  });

  it("G2 options follow CountryRules.chat; a value out of range reads as the default", async () => {
    const { tripId } = await accepted();
    await setChat({ maxLength: 300, sound: false, sheetAutoOpen: "off", spamPerMin: 999, quickReplies: { rider: [{ id: "yo", text: { sv: "Hej", fr: "Salut", en: "Hi" } }], driver: [] } });
    const r = (await call(app, "GET", `/trips/${tripId}/messages/options`, rider)).json();
    expect(r).toMatchObject({ maxLength: 300, sound: false, sheetAutoOpen: "off", quickReplies: [{ id: "yo" }] });
    expect((await call(app, "GET", `/trips/${tripId}/messages/options`, drivers.A.headers)).json().quickReplies).toEqual([]);
  });
});

describe("v0.18.56 §78 sending", () => {
  it("G3 a quick reply is written in the READER's language; an unknown id is 400 unknown_quick_reply", async () => {
    const { tripId } = await accepted();
    await database.db.updateTable("drivers").set({ language: "fr" }).where("driver_id", "=", drivers.A.id).execute();
    const sent = await sendBody(tripId, rider, { text: "x", quickReplyId: "two_min" });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ text: "Je sors dans 2 minutes", quickReplyId: "two_min", from: "rider" });
    expect((await list(tripId, drivers.A.headers)).items[0]).toMatchObject({ quickReplyId: "two_min" });
    const bad = await sendBody(tripId, rider, { text: "x", quickReplyId: "five_min" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ reason: "unknown_quick_reply" });
  });

  it("G4 maxLength: longer is 400 message_too_long; spamPerMin: the next one is 429 too_many_requests, support is not limited", async () => {
    const { tripId } = await accepted();
    await setChat({ maxLength: 100, spamPerMin: 2 });
    const long = await send(tripId, rider, "x".repeat(101));
    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({ code: "invalid_request", reason: "message_too_long" });
    expect((await send(tripId, rider, "one")).statusCode).toBe(201);
    expect((await send(tripId, rider, "two")).statusCode).toBe(201);
    const third = await send(tripId, rider, "three");
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ code: "rate_limited", reason: "too_many_requests" });
    expect((await send(tripId, drivers.A.headers, "driver is separate")).statusCode).toBe(201);
    const support = await adminSession(app, database.db, "support", { zoneIds: ["Z001"], now: clock.now });
    for (const t of ["a", "b", "c"]) expect((await send(tripId, support.headers, t)).statusCode).toBe(201);
    clock.now = new Date(clock.now.getTime() + 61_000);
    expect((await send(tripId, rider, "later")).statusCode).toBe(201);
  });
});

describe("v0.18.56 §78 automatic messages", () => {
  it("G5 arrive writes ONE message from the driver in the rider's language (Message.auto arrived)", async () => {
    const { tripId, version } = await accepted();
    await database.db.updateTable("riders").set({ language: "sv" }).where("rider_id", "=", await riderId()).execute();
    let v = (await step(tripId, "head-to-pickup", version)).json().version;
    const arrived = await step(tripId, "arrive", v);
    expect(arrived.statusCode).toBe(200);
    v = arrived.json().version;
    const items = (await list(tripId, rider)).items;
    expect(items).toEqual([expect.objectContaining({ from: "driver", auto: "arrived", text: "Jag är framme vid upphämtningsplatsen." })]);
    expect((await step(tripId, "arrive", v)).statusCode).not.toBe(500);
    expect((await list(tripId, rider)).items).toHaveLength(1);
  });

  it("G6 autoArrived.on false: no message", async () => {
    const { tripId, version } = await accepted();
    await setChat({ autoArrived: { on: false, text: { sv: "a", fr: "b", en: "c" } } });
    const v = (await step(tripId, "head-to-pickup", version)).json().version;
    expect((await step(tripId, "arrive", v)).statusCode).toBe(200);
    expect((await list(tripId, rider)).items).toHaveLength(0);
  });

  it("G7 on-the-way writes ONE message from the rider in the driver's language (auto on_my_way), however often it is tapped", async () => {
    const { tripId } = await accepted();
    await database.db.updateTable("drivers").set({ language: "fr" }).where("driver_id", "=", drivers.A.id).execute();
    for (let i = 0; i < 2; i++) expect((await call(app, "POST", `/trips/${tripId}/on-the-way`, rider, {})).statusCode).toBe(200);
    const items = (await list(tripId, drivers.A.headers)).items;
    expect(items).toEqual([expect.objectContaining({ from: "rider", auto: "on_my_way", text: "Je suis en route vers la voiture." })]);
    const events = (await call(app, "GET", `/trips/${tripId}/events?after=0&limit=500`, drivers.A.headers)).json().items;
    expect(events.filter((e: { kind: string }) => e.kind === "rider_on_the_way")).toHaveLength(2);
    expect(events.filter((e: { kind: string }) => e.kind === "message")).toHaveLength(1);
  });
});

describe("v0.18.56 §78 translate", () => {
  it("G8 503 coming_soon until a provider is set; another target 400; translation off 403; unknown message 404", async () => {
    const { tripId } = await accepted();
    const msg = (await send(tripId, drivers.A.headers, "Hej")).json();
    const tr = (body: Record<string, unknown>) => call(app, "POST", `/trips/${tripId}/messages/translate`, rider, body);
    // The rider has no language; the zone is Swedish → sv.
    const soon = await tr({ messageId: msg.messageId, to: "sv" });
    expect(soon.statusCode).toBe(503);
    expect(soon.json()).toMatchObject({ code: "unavailable", reason: "coming_soon" });
    expect((await tr({ messageId: msg.messageId, to: "fr" })).json()).toMatchObject({ reason: "translate_target_not_allowed" });
    expect((await tr({ messageId: "msg_nope", to: "sv" })).statusCode).toBe(404);
    await setChat({ translation: false });
    const off = await tr({ messageId: msg.messageId, to: "sv" });
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ reason: "translation_off" });
  });
});

describe("v0.18.56 §78 admin", () => {
  it("G9 GET /admin/chats: open trips with messages only, newest first, paging, no text; support.reply and zones", async () => {
    const { tripId } = await accepted();
    const support = await adminSession(app, database.db, "support", { zoneIds: ["Z001"], now: clock.now });
    expect((await call(app, "GET", "/admin/chats", support.headers)).json().items.map((i: { tripId: string }) => i.tripId)).not.toContain(tripId);
    await send(tripId, rider, "first");
    clock.now = new Date(clock.now.getTime() + 1000);
    await send(tripId, drivers.A.headers, "secret words");
    const page = await call(app, "GET", "/admin/chats?limit=1", support.headers);
    expect(page.statusCode).toBe(200);
    expect(schemaProblem("AdminChatPage", page.json())).toBeNull();
    expect(page.json().items).toEqual([expect.objectContaining({ tripId, zoneId: "Z001", messageCount: 2, lastFrom: "driver", driverFirstName: "Driver A" })]);
    expect(JSON.stringify(page.json())).not.toContain("secret");
    const viewer = await adminSession(app, database.db, "viewer", { now: clock.now });
    expect((await call(app, "GET", "/admin/chats", viewer.headers)).statusCode).toBe(403);
    const fr = await adminSession(app, database.db, "support", { zoneIds: ["FR-PC"], now: clock.now });
    expect((await call(app, "GET", "/admin/chats", fr.headers)).json().items).toEqual([]);
    expect((await call(app, "GET", "/admin/chats?zoneId=Z001", fr.headers)).json()).toMatchObject({ reason: "zone_out_of_scope" });
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", tripId).execute();
    expect((await call(app, "GET", "/admin/chats", support.headers)).json().items.map((i: { tripId: string }) => i.tripId)).not.toContain(tripId);
  });

  it("G10 admin Message → 201 SupportTicket in the driver's Support inbox; audited without the text; zones checked", async () => {
    const support = await adminSession(app, database.db, "support", { zoneIds: ["Z001"], now: clock.now });
    const res = await call(app, "POST", `/admin/drivers/${drivers.B.id}/message`, support.headers, { text: "Please update your photo" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ openedBy: "admin", category: "help", driverId: drivers.B.id, visibleToPerson: true });
    const inbox = (await call(app, "GET", "/support/tickets", drivers.B.headers)).json().items;
    expect(inbox.map((t: { ticketId: string }) => t.ticketId)).toContain(res.json().ticketId);
    const row = await database.db.selectFrom("admin_audit").selectAll().where("action", "=", "driver.message").where("target_id", "=", drivers.B.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(row.detail)).not.toContain("photo");
    const fr = await adminSession(app, database.db, "support", { zoneIds: ["FR-PC"], now: clock.now });
    expect((await call(app, "POST", `/admin/drivers/${drivers.B.id}/message`, fr.headers, { text: "hi" })).json()).toMatchObject({ reason: "zone_out_of_scope" });
    const viewer = await adminSession(app, database.db, "viewer", { now: clock.now });
    expect((await call(app, "POST", `/admin/drivers/${drivers.B.id}/message`, viewer.headers, { text: "hi" })).statusCode).toBe(403);
  });

  it("G11 admin Message to a rider: zone from the rider's trips", async () => {
    await accepted();
    const support = await adminSession(app, database.db, "support", { zoneIds: ["Z001"], now: clock.now });
    const res = await call(app, "POST", `/admin/riders/${await riderId()}/message`, support.headers, { text: "Hello from support" });
    expect(res.statusCode).toBe(201);
    const inbox = (await call(app, "GET", "/support/tickets", rider)).json().items;
    expect(inbox.map((t: { ticketId: string }) => t.ticketId)).toContain(res.json().ticketId);
  });
});

describe("v0.18.56 §78 incoming-call push", () => {
  it("G12 call_ringing: a push-only row for a callee with no open stream (not in GET /notifications); none when the callee's stream is open", async () => {
    const { tripId } = await accepted();
    await database.db.deleteFrom("notifications").where("kind", "=", "call_ringing").execute();
    expect((await call(app, "POST", `/trips/${tripId}/call`, drivers.A.headers, {})).statusCode).toBe(200);
    const rows = await database.db.selectFrom("notifications").selectAll().where("kind", "=", "call_ringing").execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ audience: "rider", bell: false, body: "Inkommande samtal från din förare – öppna Movera" });
    expect(rows[0]!.data).toMatchObject({ tripId });
    expect(await noticesOf(rider, "call_ringing")).toEqual([]);
    // End it; the rider "has the stream open"; a new call writes no push.
    const callId = (rows[0]!.data as { callId: string }).callId;
    expect((await call(app, "POST", `/calls/${callId}/end`, drivers.A.headers, { reason: "hangup" })).statusCode).toBe(200);
    await database.db.insertInto("trip_stream_presence").values({ stream_id: "sse_test", trip_id: tripId, actor: "rider", subject_id: await riderId(), seen_at: clock.now }).execute();
    expect((await call(app, "POST", `/trips/${tripId}/call`, drivers.A.headers, {})).statusCode).toBe(200);
    expect(await database.db.selectFrom("notifications").select("notification_id").where("kind", "=", "call_ringing").execute()).toHaveLength(1);
  });

  it("G13 the call push goes even with rideUpdates false", async () => {
    const { riderPushAlwaysSent } = await import("../../src/notifications/tripPush.js");
    expect(riderPushAlwaysSent("call_ringing", {})).toBe(true);
  });
});

describe("v0.18.56 §78 keep days", () => {
  it("G14 the purge reads CountryRules.chat.keepDays", async () => {
    const { tripId } = await accepted();
    await send(tripId, rider, "old enough");
    await setChat({ keepDays: 2 });
    const later = new Date(clock.now.getTime() + 3 * 24 * 3600_000);
    expect(await database.db.transaction().execute((trx) => purgeOldMessages(trx, later))).toBeGreaterThanOrEqual(1);
    expect(await database.db.selectFrom("trip_messages").select("message_id").where("trip_id", "=", tripId).execute()).toEqual([]);
  });
});
