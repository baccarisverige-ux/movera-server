import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { haversineKm, type Router } from "../../src/maps/routing.js";
import { PICKUP_GEOFENCE, rideHandlers } from "../../src/trips/ride.js";
import { etaHandler, TRIP_ETA } from "../../src/trips/eta.js";
import { ETA_NEAR_MOVE_METERS, ETA_NOW_GAP_MS } from "../../src/trips/etaNow.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Live 5+5 run 2, 2026-11-08 (Rules audits/screens-2026-11-08/live-5x5-run2/REPORT.md, fix 2 "NOT fixed"): the rider kept
 * "2 min · 500 m" for 18-22 s with the driver at the pickup. Proven on staging (one test pair, 8 GPS steps of 122 m): the
 * fix that ENTERED the 300 m radius (244 m straight, 566 m by road) ran the tick at once; the next fixes (122 m, 0 m)
 * were already inside, so nothing ran again until the regular tick 30 s later. Now, inside the radius, a fix far enough
 * from where the stored ETA was computed runs the tick again (still at most one per ETA_NOW_GAP_MS; none standing still).
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-08T12:00:00Z") };
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));

/** A road router: twice the straight line (city streets: 244 m straight was 566 m by road on staging), at 5 m/s. */
const followRouter: Router = {
  route: async (points) => {
    const meters = Math.round(haversineKm(points[0]!, points[points.length - 1]!) * 2000);
    return { distanceMeters: meters, durationSeconds: Math.round(meters / 5), source: "osrm" };
  },
};

/** About 1.3 km north of the pickup (where the driver accepts). */
const FAR = { lat: 59.3443, lng: 18.0649 };
let driver: { id: string; headers: Record<string, string> };
let rider: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null }).execute();
  for (const doc of ["rider_app_config", "driver_app_config"] as const) {
    const document = { ...sample(doc), version: 1 };
    await database.db.insertInto("config_live").values({ doc, zone_id: "Z001", version: 1, document: JSON.stringify(document), published_at: clock.now, published_by: null }).execute();
  }
  // v0.18.93 (job C9): these cases are about the pickup ETA of a driver who stands at the pickup without being arrived;
  // the server's automatic arrival within 100 m (contract.json#autoArrive) is tested in auto_arrive_c9.test.ts, so it
  // does nothing here.
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers, [TRIP_ETA]: etaHandler(followRouter), [PICKUP_GEOFENCE]: async () => undefined }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = await database.db.transaction().execute((trx) =>
    seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Driver", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "ETA002", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
  );
  driver = { id: made.driverId, headers: {} };
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

async function moveTo(at: { lat: number; lng: number }) {
  clock.now = new Date(clock.now.getTime() + 1000);
  const res = await call(app, "POST", "/driver/location", driver.headers, { fixes: [{ ...at, accuracy: 5, measuredAt: clock.now.toISOString() }] });
  expect(res.statusCode).toBe(200);
}

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  driver.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
  await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", driver.id).execute();
  await moveTo(FAR);
});

/** The rider books Norrmalm → Södermalm; the driver, 1.3 km away, takes it; the first ETA tick runs. */
async function accepted() {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const res = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
  expect(res.statusCode).toBe(201);
  await worker.runDue();
  const [offer] = (await call(app, "GET", "/driver/offers", driver.headers)).json().items;
  const accept = await call(app, "POST", `/offers/${offer.offerId}/accept`, driver.headers, { expectedVersion: offer.version });
  expect(accept.statusCode).toBe(200);
  await worker.runDue();
  return { tripId: res.json().tripId as string, version: accept.json().version as number };
}
const step = (tripId: string, path: string, version: number) => call(app, "POST", `/trips/${tripId}/${path}`, driver.headers, { expectedVersion: version });
const riderView = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}`, rider)).json();
const events = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}/events?after=0`, { ...rider, accept: "application/json" })).json().items as Array<Record<string, unknown>>;
const etaEvents = async (tripId: string) => (await events(tripId)).filter((e) => e["kind"] === "location" && e["eta"]).map((e) => e["eta"] as Record<string, unknown>);
const etaTimer = (tripId: string) => database.db.selectFrom("timers").select("due_at").where("kind", "=", TRIP_ETA).where("ref_id", "=", tripId).executeTakeFirst();

const lerp = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, t: number) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
const metersTo = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.round(haversineKm(a, b) * 1000);

/** A fix every `gap` seconds, as the phone (and the live test's GPS) sends them; the worker polls every 200 ms, so whatever is due runs at once. */
async function fixAfter(gap: number, at: { lat: number; lng: number }) {
  clock.now = new Date(clock.now.getTime() + gap * 1000);
  await worker.runDue();
  const res = await call(app, "POST", "/driver/location", driver.headers, { fixes: [{ ...at, accuracy: 5, moving: true, speedMps: 9, measuredAt: clock.now.toISOString() }] });
  expect(res.statusCode).toBe(200);
  await worker.runDue();
}

describe("fix 2 run 2: the rider's pickup ETA follows the driver inside the arrive radius", () => {
  it("8 straight GPS steps to the pickup (the live run): the rider sees the driver at the pickup within ETA_NOW_GAP_MS, not 30 s later", async () => {
    const { tripId, version } = await accepted();
    await step(tripId, "head-to-pickup", version);
    let entered: number | null = null;
    for (let i = 1; i <= 8; i++) {
      const at = lerp(FAR, NORRMALM, i / 8);
      await fixAfter(2.5, at);
      if (entered === null && metersTo(at, NORRMALM) <= 300) entered = i;
    }
    // Entered the radius before the last step (the live run: 244 m, then 122 m, then 0 m).
    expect(entered).toBeLessThan(8);
    const atPickup = clock.now.getTime();
    // The phone keeps sending its position at the pickup (every 2.5 s).
    await fixAfter(2.5, NORRMALM);
    await fixAfter(2.5, NORRMALM);
    const eta = (await riderView(tripId)).eta;
    expect(eta).toMatchObject({ target: "pickup", distanceMeters: 0 });
    expect(Date.parse(eta.at) - atPickup).toBeLessThanOrEqual(ETA_NOW_GAP_MS);
    // The last event the rider's stream got says the same.
    expect((await etaEvents(tripId)).at(-1)).toEqual(eta);
  });

  it("standing still at the pickup (the phone re-sends its fix): no extra tick, only the regular one every 30 s", async () => {
    const { tripId, version } = await accepted();
    await step(tripId, "head-to-pickup", version);
    await fixAfter(2.5, NORRMALM);
    await advance(ETA_NOW_GAP_MS / 1000);
    expect((await riderView(tripId)).eta).toMatchObject({ distanceMeters: 0 });
    const count = (await etaEvents(tripId)).length;
    const regular = (await etaTimer(tripId))!.due_at.getTime();
    // 25 s of fixes a few metres apart (GPS noise) at the pickup.
    for (let i = 0; i < 10; i++) await fixAfter(2.5, { lat: NORRMALM.lat + (i % 2) * 0.00005, lng: NORRMALM.lng });
    expect(clock.now.getTime()).toBeLessThan(regular);
    expect(await etaEvents(tripId)).toHaveLength(count);
    expect((await etaTimer(tripId))!.due_at.getTime()).toBe(regular);
  });

  it("slow small steps inside the radius (10 m a second): at most one extra tick per ETA_NOW_GAP_MS, and the ETA keeps up", async () => {
    const { tripId, version } = await accepted();
    await step(tripId, "head-to-pickup", version);
    const edge = lerp(NORRMALM, FAR, 290 / metersTo(NORRMALM, FAR));
    await fixAfter(1, edge);
    const count = (await etaEvents(tripId)).length;
    const start = clock.now.getTime();
    for (let i = 1; i <= 29; i++) await fixAfter(1, lerp(edge, NORRMALM, i / 29));
    const seconds = (clock.now.getTime() - start) / 1000;
    const extra = (await etaEvents(tripId)).length - count;
    expect(extra).toBeGreaterThanOrEqual(4);
    expect(extra).toBeLessThanOrEqual(Math.floor(seconds / (ETA_NOW_GAP_MS / 1000)) + 1);
    // At the pickup the rider's ETA was computed less than ETA_NEAR_MOVE_METERS (straight) from it (the router doubles it).
    await fixAfter(1, NORRMALM);
    await advance(ETA_NOW_GAP_MS / 1000);
    expect((await riderView(tripId)).eta.distanceMeters).toBeLessThan(2 * ETA_NEAR_MOVE_METERS);
  });
});
