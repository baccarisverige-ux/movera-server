import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { CONFIG_CHANNEL } from "../../src/config/service.js";
import { TRIP_EVENTS_CHANNEL, appendTripEvent } from "../../src/db/tripLog.js";
import { readEnv } from "../../src/env.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { NORRMALM, SODERMALM, call, fixedRouter, signIn } from "../support/world.js";
import { readFileSync } from "node:fs";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";

let database: TestDatabase;
let app: FastifyInstance;
let hub: NotificationHub;
let base: string;
let firstRider: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 1, document: JSON.stringify(pricing), published_at: new Date(), published_by: null }).execute();
  hub = new NotificationHub(database.url, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL]);
  await hub.start();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "stream-test-secret".padEnd(48, "s") }), logger: false, db: database.db, router: fixedRouter, hub });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await app.close();
  await hub.stop();
  await database.drop();
});

type Sse = { events: Array<{ id: string; data: Record<string, unknown> }>; comments: string[]; cursors: string[]; status: number; headers: http.IncomingHttpHeaders; ended: boolean; close: () => void };

/** Opens an SSE connection like a phone would and collects what arrives. */
function listen(path: string, headers: Record<string, string>): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const out: Sse = { events: [], comments: [], cursors: [], status: 0, headers: {}, ended: false, close: () => undefined };
    const req = http.get(`${base}${path}`, { headers: { ...headers, accept: "text/event-stream" } }, (res) => {
      out.status = res.statusCode ?? 0;
      out.headers = res.headers;
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.startsWith(":")) out.comments.push(block.slice(1).trim());
          else {
            const id = /^id: (.*)$/m.exec(block)?.[1] ?? "";
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (data) out.events.push({ id, data: JSON.parse(data) });
            else if (id) out.cursors.push(id);
          }
        }
      });
      res.on("end", () => (out.ended = true));
      out.close = () => req.destroy();
      resolve(out);
    });
    req.on("error", (error) => (out.ended ? undefined : reject(error)));
  });
}
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return check();
};

async function bookTrip(rider: Record<string, string>) {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  return (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
}

describe("trip stream", () => {
  it("replays from the cursor, then sends new events live, redacted for the rider", async () => {
    const rider = (firstRider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers);
    const trip = await bookTrip(rider);
    const sse = await listen(`/trips/${trip.tripId}/events?after=1`, rider);
    expect(sse.status).toBe(200);
    expect(sse.headers["content-type"]).toContain("text/event-stream");
    expect(sse.headers["x-api-version"]).toBe("0.5");
    expect(await until(() => sse.events.length === 1)).toBe(true);
    expect(sse.events[0]).toMatchObject({ id: "2", data: { tripId: trip.tripId, sequence: 2, kind: "trip_projection", projection: { status: "searching" } } });

    await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
    expect(await until(() => sse.events.length === 2)).toBe(true);
    expect(sse.events[1]).toMatchObject({ id: "3", data: { sequence: 3, version: 4, projection: { status: "cancelled_by_rider" } } });
    expect(sse.events[1]!.data["projection"]).not.toHaveProperty("driverEarnings");
    sse.close();
  });

  it("Last-Event-ID resumes after that sequence; an admin sees the money split", async () => {
    const rider = (await signIn(app, TEST_PHONES[2]!, "rider")).headers;
    const trip = await bookTrip(rider);
    const admin = await adminSession(app, database.db, "super");
    const sse = await listen(`/trips/${trip.tripId}/events`, { ...admin.headers, "last-event-id": "1" });
    expect(await until(() => sse.events.length === 1)).toBe(true);
    expect(sse.events[0]!.data).toMatchObject({ sequence: 2, projection: { driverEarnings: { amountMinor: 15760 } } });
    sse.close();
  });

  it("another rider cannot open it", async () => {
    const owner = (await signIn(app, TEST_PHONES[3]!, "rider")).headers;
    const trip = await bookTrip(owner);
    const stranger = (await signIn(app, TEST_PHONES[4]!, "rider")).headers;
    const res = await fetch(`${base}/trips/${trip.tripId}/events`, { headers: { ...stranger, accept: "text/event-stream" } });
    expect(res.status).toBe(404);
  });

  it("closing the server ends open streams", async () => {
    const extra = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "stream-test-secret".padEnd(48, "s") }), logger: false, db: database.db, router: fixedRouter, hub });
    await extra.listen({ host: "127.0.0.1", port: 0 });
    const rider = (await signIn(app, TEST_PHONES[5]!, "rider")).headers;
    const trip = await bookTrip(rider);
    const port = (extra.server.address() as AddressInfo).port;
    let opened!: () => void;
    const open = new Promise<void>((resolve) => (opened = resolve));
    const done = new Promise<boolean>((resolve) => {
      http.get(`http://127.0.0.1:${port}/api/v1/trips/${trip.tripId}/events`, { headers: { ...rider, accept: "text/event-stream" } }, (res) => {
        opened();
        res.resume();
        res.on("end", () => resolve(true));
      });
    });
    // Wait until the stream is open (headers received) instead of a fixed sleep, so close() never races the request.
    await open;
    await extra.close();
    expect(await done).toBe(true);
  });
});

describe("config stream", () => {
  it("config_published arrives when the admin publishes the rider document", async () => {
    // Signing in again within 30 s is refused (resend limit), so reuse the first rider's session.
    const rider = firstRider;
    const sse = await listen("/rider/config/stream?zoneId=Z001", rider);
    expect(sse.status).toBe(200);
    const owner = await adminSession(app, database.db, "super");
    const doc = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/rider_app_config.json`, "utf8"));
    await app.inject({ method: "PUT", url: "/api/v1/admin/config/rider_app_config", headers: { ...owner.headers, "content-type": "application/json", "idempotency-key": "stream-put-key-000001" }, payload: { expectedVersion: 1, zoneId: "Z001", document: doc } });
    await call(app, "POST", "/admin/config/rider_app_config/publish", owner.headers, { expectedVersion: 2, zoneId: "Z001" });
    expect(await until(() => sse.events.length === 1)).toBe(true);
    expect(sse.events[0]).toMatchObject({ id: "1", data: { kind: "config_published", doc: "rider_app_config", zoneId: "Z001", version: 1 } });
    sse.close();
    // Reconnecting with an older Last-Event-ID gets the newest version at once.
    const again = await listen("/rider/config/stream?zoneId=Z001", { ...rider, "last-event-id": "0" });
    expect(await until(() => again.events.length === 1)).toBe(true);
    again.close();
  });

  it("zones (any zone) and this zone's content arrive on the rider and driver streams (v0.11.0, v0.10.0)", async () => {
    const owner = await adminSession(app, database.db, "super");
    const sse = await listen("/rider/config/stream?zoneId=Z001", firstRider);
    expect(sse.status).toBe(200);
    const zones = (await call(app, "GET", "/admin/zones", owner.headers)).json().zones as Array<{ zoneId: string; version: number }>;
    const tunis = zones.find((z) => z.zoneId === "TN-TC")!;
    await call(app, "PUT", "/admin/zones/TN-TC", owner.headers, { expectedVersion: tunis.version, names: { sv: "Stor-Tunis", fr: "Grand Tunis", en: "Tunis area" } });
    expect(await until(() => sse.events.length === 1)).toBe(true);
    expect(sse.events[0]).toMatchObject({ id: "1", data: { kind: "config_published", doc: "zones", zoneId: "TN-TC", version: tunis.version + 1 } });
    await call(app, "POST", "/admin/content/help/publish", owner.headers, { zoneIds: ["Z002"], title: "Other zone", text: { sv: "a", fr: "b", en: "c" } });
    await call(app, "POST", "/admin/content/help/publish", owner.headers, { zoneIds: ["Z001"], title: "Help", text: { sv: "a", fr: "b", en: "c" } });
    expect(await until(() => sse.events.length === 2)).toBe(true);
    expect(sse.events[1]!.data).toMatchObject({ kind: "config_published", doc: "content", zoneId: "Z001", version: 1 });
    sse.close();
  });
});

describe("listen connection", () => {
  it("after the database drops the listen connection, the hub reconnects and streams catch up", async () => {
    const rider = (await signIn(app, TEST_PHONES[1]!, "rider")).headers;
    const trip = await bookTrip(rider);
    const sse = await listen(`/trips/${trip.tripId}/events?after=2`, rider);
    await new Promise((r) => setTimeout(r, 100));
    await database.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'movera-server-listen' AND datname = current_database()");
    // A change made while the hub is away is still delivered once it is back.
    await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
    expect(await until(() => sse.events.length === 1, 5000)).toBe(true);
    expect(sse.events[0]!.data).toMatchObject({ sequence: 3, projection: { status: "cancelled_by_rider" } });
    sse.close();
  });
});

describe("driver offer feed", () => {
  it("replays the driver's offer events from ?after= as a JSON page", async () => {
    const driver = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    const page = await fetch(`${base}/driver/offers/stream?after=0`, { headers: driver });
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ items: [], nextCursor: null });
    const sse = await listen("/driver/offers/stream", driver);
    expect(sse.status).toBe(200);
    expect(sse.headers["content-type"]).toContain("text/event-stream");
    sse.close();
  });

  it("03c: a feed opened without a cursor starts at the newest event (an id: with no data), so an app that just started gets no old history (no old driverOffline)", async () => {
    const driver = (await signIn(app, TEST_PHONES[4]!, "driver")).headers;
    const driverId = (await call(app, "GET", "/driver/profile", driver)).json().driverId as string;
    const old = new Date(Date.now() - 3 * 3600_000);
    for (const [sequence, offer] of [
      [1, { offerId: "o1", status: "expired" }],
      [2, { offerId: "o2", status: "expired", driverOffline: true }],
      [3, { offerId: "o3", status: "withdrawn" }],
    ] as const) {
      await database.db.insertInto("offer_events").values({ driver_id: driverId, sequence, event_id: `evt_old_${sequence}`, kind: "offer_withdrawn", offer: JSON.stringify(offer), occurred_at: old }).execute();
    }
    const fresh = await listen("/driver/offers/stream", driver);
    expect(await until(() => fresh.cursors.length === 1)).toBe(true);
    expect(fresh.cursors).toEqual(["3"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(fresh.events).toEqual([]);
    fresh.close();

    // A cursor (after=, Last-Event-ID) still replays from there; after=0 is the whole history.
    const resumed = await listen("/driver/offers/stream?after=1", driver);
    expect(await until(() => resumed.events.length === 2)).toBe(true);
    expect(resumed.events.map((e) => e.id)).toEqual(["2", "3"]);
    expect(resumed.events[0]!.data).toMatchObject({ sequence: 2, driverOffline: true });
    expect(resumed.cursors).toEqual([]);
    resumed.close();
    const all = await listen("/driver/offers/stream", { ...driver, "last-event-id": "0" });
    expect(await until(() => all.events.length === 3)).toBe(true);
    all.close();
  });

  /** A driver who went online at `onlineSince`, with offer events written straight into the feed. */
  async function onlineDriver(phone: string, onlineSince: Date) {
    const headers = (await signIn(app, phone, "driver")).headers;
    const driverId = (await call(app, "GET", "/driver/profile", headers)).json().driverId as string;
    await database.db.updateTable("drivers").set({ online_status: "online", online_since: onlineSince }).where("driver_id", "=", driverId).execute();
    const event = (sequence: number, offer: Record<string, unknown>, at: Date) =>
      database.db.insertInto("offer_events").values({ driver_id: driverId, sequence, event_id: `evt_${driverId}_${sequence}`, kind: offer.status === "open" ? "offer_created" : "offer_withdrawn", offer: JSON.stringify(offer), occurred_at: at }).execute();
    return { headers, event };
  }

  it("03c fix: an offer made after Go online but before the feed opens is delivered; an old driverOffline from before Go online is not", async () => {
    const onlineSince = new Date(Date.now() - 60_000);
    const { headers, event } = await onlineDriver(TEST_PHONES[0]!, onlineSince);
    await event(1, { offerId: "old1", status: "expired" }, new Date(onlineSince.getTime() - 3 * 3600_000));
    await event(2, { offerId: "old2", status: "expired", driverOffline: true }, new Date(onlineSince.getTime() - 3600_000));
    await event(3, { offerId: "new3", status: "open" }, new Date(onlineSince.getTime() + 5_000));
    const sse = await listen("/driver/offers/stream", headers);
    expect(await until(() => sse.events.length === 1)).toBe(true);
    expect(sse.cursors).toEqual(["2"]);
    expect(sse.events.map((e) => e.id)).toEqual(["3"]);
    expect(sse.events[0]!.data).toMatchObject({ sequence: 3, offer: { offerId: "new3" } });
    await new Promise((r) => setTimeout(r, 200));
    expect(sse.events.some((e) => e.data.driverOffline === true)).toBe(false);
    sse.close();
  });

  it("03c fix: an empty feed still sends `id: 0`, and a reconnect after a network loss gets the offers made in the gap", async () => {
    const onlineSince = new Date(Date.now() - 60_000);
    const { headers, event } = await onlineDriver(TEST_PHONES[2]!, onlineSince);
    const first = await listen("/driver/offers/stream", headers);
    expect(await until(() => first.cursors.length === 1)).toBe(true);
    expect(first.cursors).toEqual(["0"]);
    first.close();
    // Network loss: two offers are made while the phone is away.
    await event(1, { offerId: "gap1", status: "open" }, new Date());
    await event(2, { offerId: "gap2", status: "expired" }, new Date());
    // The app reconnects with the cursor it got (after=0) ...
    const resumed = await listen("/driver/offers/stream?after=0", headers);
    expect(await until(() => resumed.events.length === 2)).toBe(true);
    expect(resumed.events.map((e) => e.id)).toEqual(["1", "2"]);
    resumed.close();
    // ... and even an app that lost its cursor gets everything since Go online.
    const noCursor = await listen("/driver/offers/stream", headers);
    expect(await until(() => noCursor.events.length === 2)).toBe(true);
    expect(noCursor.cursors).toEqual(["0"]);
    expect(noCursor.events.map((e) => (e.data.offer as { offerId: string }).offerId)).toEqual(["gap1", "gap2"]);
    noCursor.close();
  });

  it("03c fix: online with only old events (an old driverOffline before Go online) replays nothing and sends the cursor", async () => {
    const onlineSince = new Date(Date.now() - 60_000);
    const { headers, event } = await onlineDriver(TEST_PHONES[3]!, onlineSince);
    await event(1, { offerId: "o1", status: "expired" }, new Date(onlineSince.getTime() - 7200_000));
    await event(2, { offerId: "o2", status: "expired", driverOffline: true }, new Date(onlineSince.getTime() - 1000));
    const sse = await listen("/driver/offers/stream", headers);
    expect(await until(() => sse.cursors.length === 1)).toBe(true);
    expect(sse.cursors).toEqual(["2"]);
    await new Promise((r) => setTimeout(r, 200));
    expect(sse.events).toEqual([]);
    sse.close();
  });
});

// v0.18.45 §68 (contract.json#driverReservationsLive, Rules plan/LA-BUILD-PLAN-2026-11-06.md §2): booked-ride hint on the driver config stream.
describe("driver_reservations_changed (v0.18.45 §68)", () => {
  const subjectOf = (headers: Record<string, string>) =>
    JSON.parse(Buffer.from(headers["authorization"]!.split(" ")[1]!.split(".")[1]!, "base64url").toString("utf8")).sub as string;
  const asBooked = (tripId: string, zoneId = "Z001") =>
    database.db.updateTable("trips").set({ scheduled_at: new Date(Date.now() + 86_400_000), zone_id: zoneId }).where("trip_id", "=", tripId).execute();
  const touch = (tripId: string) =>
    database.db.transaction().execute((trx) => appendTripEvent(trx, { tripId, kind: "trip_projection", version: 1, projection: {} }));
  const quiet = () => new Promise((r) => setTimeout(r, 300));
  const kinds = (sse: Sse, kind: string) => sse.events.filter((e) => e.data["kind"] === kind);
  let rider: Record<string, string>;
  let driver: Record<string, string>;
  beforeAll(async () => {
    // Own numbers: the six test phones are already used above (resend limit 30 s).
    await seedTestPhones(database.db, ["+46701740611", "+46701740612"]);
    rider = (await signIn(app, "+46701740611", "rider")).headers;
    driver = (await signIn(app, "+46701740612", "driver")).headers;
  });

  it("a booked ride of the zone that changes (here: cancelled) reaches the zone's driver stream; rider_trip_changed is unchanged", async () => {
    const raw: Array<Record<string, unknown>> = [];
    const off = hub.subscribe(TRIP_EVENTS_CHANNEL, (p) => { if (p !== null) raw.push(p); });
    const trip = await bookTrip(rider);
    await asBooked(trip.tripId);
    const drv = await listen("/driver/config/stream?zoneId=Z001", driver);
    const rid = await listen("/rider/config/stream?zoneId=Z001", rider);
    expect(drv.status).toBe(200);
    await quiet();
    await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
    expect(await until(() => kinds(drv, "driver_reservations_changed").length === 1)).toBe(true);
    const ev = kinds(drv, "driver_reservations_changed")[0]!;
    expect(Object.keys(ev.data).sort()).toEqual(["eventId", "kind", "occurredAt", "serverTime", "tripId"]);
    expect(ev.data["tripId"]).toBe(trip.tripId);
    // The rider event keeps exactly its v0.18.32 shape; the NOTIFY payload only gained fields.
    expect(await until(() => kinds(rid, "rider_trip_changed").length >= 1)).toBe(true);
    expect(Object.keys(kinds(rid, "rider_trip_changed").at(-1)!.data).sort()).toEqual(["eventId", "kind", "occurredAt", "serverTime", "tripId"]);
    expect(kinds(rid, "driver_reservations_changed")).toHaveLength(0);
    const last = raw.filter((p) => p["tripId"] === trip.tripId).at(-1)!;
    expect(last).toMatchObject({ tripId: trip.tripId, sequence: 3, riderId: subjectOf(rider), zoneId: "Z001", scheduled: true });
    off();
    drv.close();
    rid.close();
  });

  it("a now-ride sends nothing; a booked ride of another zone sends nothing unless it names the driver", async () => {
    const drv = await listen("/driver/config/stream?zoneId=Z001", driver);
    await quiet();
    const now = await bookTrip(rider);
    await call(app, "POST", `/trips/${now.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
    const other = await bookTrip(rider);
    await asBooked(other.tripId, "Z002");
    await touch(other.tripId);
    await quiet();
    expect(kinds(drv, "driver_reservations_changed")).toHaveLength(0);
    await database.db.updateTable("trips").set({ driver_id: subjectOf(driver) }).where("trip_id", "=", other.tripId).execute();
    await touch(other.tripId);
    expect(await until(() => kinds(drv, "driver_reservations_changed").length === 1)).toBe(true);
    expect(kinds(drv, "driver_reservations_changed")[0]!.data["tripId"]).toBe(other.tripId);
    drv.close();
    await database.db.updateTable("trips").set({ status: "cancelled_by_rider", driver_id: null }).where("trip_id", "=", other.tripId).execute();
  });

  it("a rolled-back change sends nothing", async () => {
    const trip = await bookTrip(rider);
    await asBooked(trip.tripId);
    const drv = await listen("/driver/config/stream?zoneId=Z001", driver);
    await quiet();
    await expect(database.db.transaction().execute(async (trx) => {
      await appendTripEvent(trx, { tripId: trip.tripId, kind: "trip_projection", version: 1, projection: {} });
      throw new Error("roll back");
    })).rejects.toThrow("roll back");
    await quiet();
    expect(kinds(drv, "driver_reservations_changed")).toHaveLength(0);
    await touch(trip.tripId);
    expect(await until(() => kinds(drv, "driver_reservations_changed").length === 1)).toBe(true);
    drv.close();
    await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
  });

  it("rule 33: with 2 server copies (2 hubs), one commit reaches the driver streams on both copies", async () => {
    const hub2 = new NotificationHub(database.url, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL]);
    await hub2.start();
    const app2 = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "stream-test-secret".padEnd(48, "s") }), logger: false, db: database.db, router: fixedRouter, hub: hub2 });
    await app2.listen({ host: "127.0.0.1", port: 0 });
    const base2 = `http://127.0.0.1:${(app2.server.address() as AddressInfo).port}/api/v1`;
    try {
      const trip = await bookTrip(rider);
      await asBooked(trip.tripId);
      const one = await listen("/driver/config/stream?zoneId=Z001", driver);
      const saved = base;
      base = base2;
      const two = await listen("/driver/config/stream?zoneId=Z001", driver);
      base = saved;
      expect([one.status, two.status]).toEqual([200, 200]);
      await quiet();
      await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
      expect(await until(() => kinds(one, "driver_reservations_changed").length === 1 && kinds(two, "driver_reservations_changed").length === 1)).toBe(true);
      one.close();
      two.close();
    } finally {
      await app2.close();
      await hub2.stop();
    }
  });
});
