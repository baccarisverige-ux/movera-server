import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { TRIP_EVENTS_CHANNEL } from "../../src/db/tripLog.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { LIVE_LOCATION_CHANNEL, resetLiveLocationSpacing } from "../../src/trips/liveLocation.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * v0.18.144 (contract.json#liveLocation; owner 2026-11-20): two-way live location. PUT /trips/{tripId}/live-location is
 * relayed to the other side's GET /trips/{tripId}/events?live=true as `event: live_location`, never stored; only from
 * accept to ride end; per-zone switch RiderAppConfig.liveLocation.share; spaced by sendEverySeconds.
 */

let database: TestDatabase;
let app: FastifyInstance;
let hub: NotificationHub;
let worker: TimerWorker;
let base: string;
const clock = { now: new Date("2026-10-24T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
/** The zone switch is OFF by default (supervisor 2026-11-20: until the load test passes); these tests turn it on. */
const riderDoc = () => ({ ...sample("rider_app_config"), liveLocation: { share: true } });
const SPOT = { lat: 59.3335, lng: 18.0655 };
let driver: { id: string; headers: Record<string, string> };
let rider: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  hub = new NotificationHub(database.url, [TRIP_EVENTS_CHANNEL, LIVE_LOCATION_CHANNEL]);
  await hub.start();
  app = await testWorld(database.db, database.url, clock, { hub });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1`;
  await database.db.insertInto("config_live").values([
    { doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null },
    { doc: "rider_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(riderDoc()), published_at: clock.now, published_by: null },
  ]).execute();
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Ali", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "LIV001", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now));
  driver = { id: made.driverId, headers: {} };
});
afterAll(async () => {
  await app.close();
  await hub.stop();
  await database.drop();
});

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  resetLiveLocationSpacing();
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driver.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driver.id).execute();
  expect((await call(app, "POST", "/driver/location", driver.headers, { fixes: [{ ...SPOT, accuracy: 5, measuredAt: clock.now.toISOString() }] })).statusCode).toBe(200);
});

async function book() {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  await worker.runDue();
  return trip.tripId as string;
}
async function accepted(booked?: string) {
  const tripId = booked ?? (await book());
  const [offer] = (await call(app, "GET", "/driver/offers", driver.headers)).json().items;
  expect(offer?.tripId).toBe(tripId);
  const res = await call(app, "POST", `/offers/${offer.offerId}/accept`, driver.headers, { expectedVersion: offer.version });
  expect(res.statusCode).toBe(200);
  return { tripId, version: res.json().version as number };
}
const share = (tripId: string, who: Record<string, string>, body: Record<string, unknown>) => call(app, "PUT", `/trips/${tripId}/live-location`, who, body);

type Frames = { events: Array<{ event: string; data: Record<string, unknown> }>; close: () => void };
function listen(path: string, headers: Record<string, string>): Promise<Frames> {
  return new Promise((resolve, reject) => {
    const out: Frames = { events: [], close: () => undefined };
    const req = http.get(`${base}${path}`, { headers: { ...headers, accept: "text/event-stream" } }, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1] ?? "message";
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (data !== undefined) out.events.push({ event: name, data: JSON.parse(data) });
        }
      });
      out.close = () => req.destroy();
      setTimeout(() => resolve(out), 300);
    });
    req.on("error", (e) => (e.message.includes("socket hang up") ? undefined : reject(e)));
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const liveFrames = (f: Frames) => f.events.filter((e) => e.event === "live_location").map((e) => e.data);

describe("v0.18.144 live location", () => {
  it("L1 the rider's point reaches the driver's ?live=true stream as live_location (no id), not the rider's own, not a stream without ?live", async () => {
    const { tripId } = await accepted();
    const driverLive = await listen(`/trips/${tripId}/events?live=true`, driver.headers);
    const driverOld = await listen(`/trips/${tripId}/events`, driver.headers);
    const riderLive = await listen(`/trips/${tripId}/events?live=true`, rider);
    const eventsBefore = await database.db.selectFrom("trip_events").select(({ fn }) => fn.countAll<string>().as("n")).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    const res = await share(tripId, rider, { sharing: true, lat: 59.3341, lng: 18.0632, accuracyM: 6 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sharing: true, sendEverySeconds: 8 });
    await wait(400);
    expect(liveFrames(driverLive)).toEqual([{ tripId, side: "rider", sharing: true, lat: 59.3341, lng: 18.0632, accuracyM: 6, at: clock.now.toISOString() }]);
    expect(liveFrames(driverOld)).toEqual([]);
    expect(liveFrames(riderLive)).toEqual([]);
    // Never stored: no trip event, no version bump.
    const eventsAfter = await database.db.selectFrom("trip_events").select(({ fn }) => fn.countAll<string>().as("n")).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(eventsAfter.n).toBe(eventsBefore.n);
    // The driver's point reaches the rider.
    expect((await share(tripId, driver.headers, { sharing: true, lat: 59.3335, lng: 18.0655 })).statusCode).toBe(200);
    await wait(400);
    expect(liveFrames(riderLive).map((f) => f["side"])).toEqual(["driver"]);
    for (const f of [driverLive, driverOld, riderLive]) f.close();
  });

  it("L2 spaced by sendEverySeconds - 1 (429 live_location_too_often); turning off always passes", async () => {
    const { tripId } = await accepted();
    expect((await share(tripId, rider, { sharing: true, lat: 59.3341, lng: 18.0632 })).statusCode).toBe(200);
    clock.now = new Date(clock.now.getTime() + 3000);
    const soon = await share(tripId, rider, { sharing: true, lat: 59.3341, lng: 18.0632 });
    expect(soon.statusCode).toBe(429);
    expect(soon.json().reason).toBe("live_location_too_often");
    expect((await share(tripId, rider, { sharing: false })).statusCode).toBe(200);
    // Alternation: off does not reset the spacing, so on right after off is still refused.
    expect((await share(tripId, rider, { sharing: true, lat: 59.3341, lng: 18.0632 })).statusCode).toBe(429);
    clock.now = new Date(clock.now.getTime() + 7000);
    expect((await share(tripId, rider, { sharing: true, lat: 59.3341, lng: 18.0632 })).statusCode).toBe(200);
  });

  it("L3 only from accept to ride end (409 live_location_not_active), only the trip's own sides, lat/lng needed", async () => {
    const tripId = await book();
    const early = await share(tripId, rider, { sharing: true, lat: 59.3341, lng: 18.0632 });
    expect(early.statusCode).toBe(409);
    expect(early.json().reason).toBe("live_location_not_active");
    const { tripId: active } = await accepted(tripId);
    expect((await share(active, rider, { sharing: true })).statusCode).toBe(400);
    const stranger = (await signIn(app, TEST_PHONES[3]!, "rider")).headers;
    expect((await share(active, stranger, { sharing: false })).statusCode).toBe(404);
    // The window ends at pickup: nothing is relayed once the rider is on board.
    await database.db.updateTable("trips").set({ status: "rider_onboard" }).where("trip_id", "=", active).execute();
    expect((await share(active, rider, { sharing: true, lat: 1, lng: 1 })).json().reason).toBe("live_location_not_active");
    await database.db.updateTable("trips").set({ status: "cancelled_by_rider" }).where("trip_id", "=", active).execute();
    expect((await share(active, rider, { sharing: true, lat: 1, lng: 1 })).json().reason).toBe("live_location_not_active");
  });

  it("L4 the zone switch: GET /rider/config serves liveLocation (default OFF); share false -> 409 live_location_off; a bad value is 400 invalid_document", async () => {
    const config = (await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json();
    expect(config.document?.liveLocation ?? config.liveLocation).toEqual({ share: true, adjustPickupMeters: 30, sendEverySeconds: 8 });
    await database.db.updateTable("config_live").set({ document: JSON.stringify(sample("rider_app_config")) }).where("doc", "=", "rider_app_config").where("zone_id", "=", "Z001").execute();
    const never = (await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json();
    expect(never.document?.liveLocation ?? never.liveLocation).toEqual({ share: false, adjustPickupMeters: 30, sendEverySeconds: 8 });
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const draft = (await call(app, "GET", "/admin/config/rider_app_config?zoneId=Z001", admin.headers)).json();
    const bad = await call(app, "PUT", "/admin/config/rider_app_config", admin.headers, { expectedVersion: draft.version, zoneId: "Z001", document: { ...draft.document, liveLocation: { share: "yes" } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().reason).toBe("invalid_document");
    const zero = await call(app, "PUT", "/admin/config/rider_app_config", admin.headers, { expectedVersion: draft.version, zoneId: "Z001", document: { ...draft.document, liveLocation: { share: false, adjustPickupMeters: 5 } } });
    expect(zero.json().reason, "5 m is neither 0 (off) nor 10-500").toBe("invalid_document");
    const doc = { ...sample("rider_app_config"), liveLocation: { share: false, adjustPickupMeters: 0, sendEverySeconds: 6 } };
    await database.db.updateTable("config_live").set({ document: JSON.stringify(doc), version: 2 }).where("doc", "=", "rider_app_config").where("zone_id", "=", "Z001").execute();
    const { tripId } = await accepted();
    const served = (await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json();
    expect(served.document?.liveLocation ?? served.liveLocation, "0 = the banner is off").toMatchObject({ adjustPickupMeters: 0 });
    const off = await share(tripId, rider, { sharing: true, lat: 59.3341, lng: 18.0632 });
    expect(off.statusCode).toBe(409);
    expect(off.json().reason).toBe("live_location_off");
    await database.db.updateTable("config_live").set({ document: JSON.stringify(riderDoc()), version: 3 }).where("doc", "=", "rider_app_config").where("zone_id", "=", "Z001").execute();
  });
});
