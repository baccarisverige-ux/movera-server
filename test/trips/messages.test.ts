import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { schemaProblem } from "../../src/contract/schemas.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/** The trip chat: GET and POST /trips/{tripId}/messages, the `message` realtime event, who may write and when. */

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

const send = (tripId: string, who: Record<string, string>, text: unknown, key?: string) => call(app, "POST", `/trips/${tripId}/messages`, who, { text }, key);
const list = async (tripId: string, who: Record<string, string>, query = "") => (await call(app, "GET", `/trips/${tripId}/messages${query}`, who)).json();
const tripView = async (tripId: string, who: Record<string, string>) => (await call(app, "GET", `/trips/${tripId}`, who)).json();
const latestNotice = async (who: Record<string, string>) => (await call(app, "GET", "/notifications?limit=1", who)).json().items[0];

describe("the trip chat", () => {
  it("M1 the rider writes and the driver reads it; the driver answers and the rider's stream carries a message event with the version unchanged", async () => {
    const { tripId, version } = await accepted();
    const before = await tripView(tripId, rider);

    const sent = await send(tripId, rider, "I'm by the main entrance, blue jacket");
    expect(sent.statusCode).toBe(201);
    const message = sent.json();
    expect(schemaProblem("Message", message)).toBeNull();
    expect(message).toMatchObject({ tripId, from: "rider", text: "I'm by the main entrance, blue jacket", at: clock.now.toISOString() });

    const page = await list(tripId, drivers.A.headers);
    expect(schemaProblem("MessagePage", page)).toBeNull();
    expect(page).toEqual({ items: [message], nextCursor: null });
    // The driver hears of it in the app, with the text itself.
    expect(await latestNotice(drivers.A.headers)).toMatchObject({ kind: "trip_message", title: "Message from your rider", body: message.text, tripId, read: false });

    const reply = (await send(tripId, drivers.A.headers, "Two minutes, white Volvo")).json();
    expect(reply.from).toBe("driver");
    expect((await list(tripId, rider)).items.map((m: { messageId: string }) => m.messageId)).toEqual([message.messageId, reply.messageId]);
    expect(await latestNotice(rider)).toMatchObject({ kind: "trip_message", title: "Message from your driver", body: "Two minutes, white Volvo", tripId });

    // Both messages are on the trip's stream as `message` events: the Message in the envelope, no projection,
    // and the version the trip had, because a message changes nothing about the trip.
    const events = (await call(app, "GET", `/trips/${tripId}/events?after=${before.sequence}`, rider)).json().items;
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(["message", "message"]);
    expect(events[1]).toMatchObject({ tripId, version, kind: "message", occurredAt: clock.now.toISOString(), message: reply });
    expect(events[1]).not.toHaveProperty("projection");
    expect(events[1].sequence).toBe(before.sequence + 2);
    const after = await tripView(tripId, rider);
    expect(after.version).toBe(version);
    expect(after.sequence).toBe(before.sequence + 2);
  });

  it("M2 an admin writes as support; both sides read it", async () => {
    const { tripId } = await accepted();
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const sent = await send(tripId, admin.headers, "Movera here: your driver is held up in traffic, five more minutes.");
    expect(sent.statusCode).toBe(201);
    expect(sent.json().from).toBe("support");
    expect((await list(tripId, rider)).items).toEqual([sent.json()]);
    expect((await list(tripId, drivers.A.headers)).items).toEqual([sent.json()]);
    expect((await list(tripId, admin.headers)).items).toEqual([sent.json()]);
    expect(await latestNotice(rider)).toMatchObject({ kind: "trip_message", title: "Message from Movera", tripId });
    expect(await latestNotice(drivers.A.headers)).toMatchObject({ kind: "trip_message", title: "Message from Movera", tripId });
  });

  it("M3 another rider, or a driver who is not on the trip, finds no trip", async () => {
    const { tripId } = await accepted();
    await send(tripId, rider, "hello");
    for (const outsider of [stranger, drivers.B.headers]) {
      const sent = await send(tripId, outsider, "let me in");
      expect(sent.statusCode).toBe(404);
      expect(sent.json()).toMatchObject({ code: "not_found", reason: "trip_not_found" });
      const read = await call(app, "GET", `/trips/${tripId}/messages`, outsider);
      expect(read.statusCode).toBe(404);
    }
    expect((await list(tripId, rider)).items).toHaveLength(1);
  });

  it("M4 before a driver is on the trip there is nobody to write to: 409 invalid_transition with the projection", async () => {
    const { tripId } = await book();
    const sent = await send(tripId, rider, "anyone there?");
    expect(sent.statusCode).toBe(409);
    // Dispatch may already have offered it; what matters is that nobody accepted yet.
    expect(sent.json()).toMatchObject({ code: "invalid_transition", reason: "chat_closed", projection: { tripId, status: expect.stringMatching(/^(searching|offered)$/) } });
    expect(sent.json().projection).not.toHaveProperty("driverId");
    expect(sent.json().projection).not.toHaveProperty("driverEarnings");
    expect((await list(tripId, rider)).items).toEqual([]);
  });

  it("M5 an empty, blank, missing or too long text is 400", async () => {
    const { tripId } = await accepted();
    for (const text of ["", "   ", undefined, 42, "x".repeat(2001)]) {
      const sent = await send(tripId, rider, text);
      expect(sent.statusCode, JSON.stringify(text)).toBe(400);
      expect(sent.json()).toMatchObject({ code: "invalid_request", reason: "invalid_body" });
    }
    expect((await send(tripId, rider, "x".repeat(2000))).statusCode).toBe(201);
    expect((await list(tripId, rider)).items).toHaveLength(1);
  });

  it("M6 the same Idempotency-Key sends once", async () => {
    const { tripId } = await accepted();
    const before = (await tripView(tripId, rider)).sequence;
    const first = await send(tripId, rider, "Here now", "chat-once-key-000000001");
    const again = await send(tripId, rider, "Here now", "chat-once-key-000000001");
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect((await list(tripId, rider)).items).toEqual([first.json()]);
    expect((await call(app, "GET", `/trips/${tripId}/events?after=${before}`, rider)).json().items).toHaveLength(1);
    // The same key with another text is another request: refused, not sent.
    const other = await send(tripId, rider, "Here NOW", "chat-once-key-000000001");
    expect(other.json()).toMatchObject({ code: "conflict", reason: "idempotency_key_reused" });
    expect((await list(tripId, rider)).items).toHaveLength(1);
  });

  it("M7 pages oldest first with a cursor", async () => {
    const { tripId } = await accepted();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push((await send(tripId, i % 2 ? rider : drivers.A.headers, `message ${i}`)).json().messageId);
    const first = await list(tripId, drivers.A.headers, "?limit=2");
    expect(first.items.map((m: { text: string }) => m.text)).toEqual(["message 1", "message 2"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await list(tripId, drivers.A.headers, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((m: { messageId: string }) => m.messageId)).toEqual(ids.slice(2, 4));
    const third = await list(tripId, drivers.A.headers, `?limit=2&cursor=${second.nextCursor}`);
    expect(third).toEqual({ items: [expect.objectContaining({ messageId: ids[4], from: "rider" })], nextCursor: null });
    expect((await list(tripId, rider)).items.map((m: { messageId: string }) => m.messageId)).toEqual(ids);
    const bad = await call(app, "GET", `/trips/${tripId}/messages?cursor=not-a-cursor`, rider);
    expect(bad.json()).toMatchObject({ code: "invalid_request", reason: "invalid_cursor" });
  });

  it("M8 the chat stays open for an hour after the trip ended, then closes", async () => {
    const tripId = await completed();
    // Access tokens live 15 minutes: an hour on, both sides have signed in again.
    const signInAgain = async () => {
      rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
      drivers.A.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    };
    await advance(59 * 60);
    await signInAgain();
    const soon = await send(tripId, rider, "I left my umbrella in the car");
    expect(soon.statusCode).toBe(201);
    const answer = await send(tripId, drivers.A.headers, "Got it, I'll bring it back");
    expect(answer.statusCode).toBe(201);
    await advance(61 * 60);
    await signInAgain();
    const late = await send(tripId, rider, "Still there?");
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: "invalid_transition", reason: "chat_closed", projection: { tripId, status: "completed" } });
    // Reading stays possible.
    expect((await list(tripId, drivers.A.headers)).items.map((m: { text: string }) => m.text)).toEqual(["I left my umbrella in the car", "Got it, I'll bring it back"]);
  });
});
