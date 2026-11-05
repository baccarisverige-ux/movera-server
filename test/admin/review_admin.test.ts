import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";
import { adminSession } from "../support/admin.js";

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
let admin: Record<string, string>;

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
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `RID00${key}`, categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now),
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
  const signedIn = await signIn(app, TEST_PHONES[0]!, "rider");
  rider = signedIn.headers;
  await call(app, "GET", "/rider/profile", rider);
  for (const key of ["A", "B"] as const) {
    drivers[key].headers = (await signIn(app, { A: TEST_PHONES[1], B: TEST_PHONES[2] }[key]!, "driver")).headers;
    await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", drivers[key].id).execute();
    await moveTo(key, SPOTS[key]);
  }
});

beforeEach(async () => {
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  await adminSession(app, database.db, "dispatcher", { now: clock.now });
  await adminSession(app, database.db, "dispatcher", { zoneIds: ["Z002"], now: clock.now });
  await adminSession(app, database.db, "finance", { now: clock.now });
});

async function book() {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  await worker.runDue();
  return { tripId: trip.tripId as string, quote };
}

/** A books, the best driver (A, nearest) accepts. */
async function accepted() {
  // Same idle time, no ratings and no offer history, so A (the nearest) ranks first.
  await database.db.deleteFrom("offers").where("status", "!=", "open").execute();
  await database.db.updateTable("drivers").set({ last_free_at: clock.now, rating_sum: 0, rating_count: 0 }).execute();
  // The apps send fixes all the time; a fix older than 2 minutes counts as gone.
  for (const key of ["A", "B"] as const) await moveTo(key, SPOTS[key]);
  const { tripId, quote } = await book();
  const [offer] = (await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items;
  expect(offer?.tripId).toBe(tripId);
  const res = await call(app, "POST", `/offers/${offer.offerId}/accept`, drivers.A.headers, { expectedVersion: offer.version });
  expect(res.statusCode).toBe(200);
  return { tripId, quote, version: res.json().version as number };
}

const step = async (tripId: string, path: string, version: number, body: Record<string, unknown> = {}, who = drivers.A.headers) => {
  // A finished trip was driven to the drop-off; what is paid when a driver completes before it is its own test.
  // A fix carries the test clock and only a newer fix counts, so the clock ticks a second each way, and the
  // driver is back where they were afterwards.
  if (path === "complete" && body["location"] === undefined) {
    const key = who === drivers.B.headers ? "B" : "A";
    const before = await database.db.selectFrom("driver_locations").select(["lat", "lng"]).where("driver_id", "=", drivers[key].id).executeTakeFirst();
    clock.now = new Date(clock.now.getTime() + 1000);
    await moveTo(key, SODERMALM);
    const res = await call(app, "POST", `/trips/${tripId}/${path}`, who, { expectedVersion: version, ...body });
    if (before) {
      clock.now = new Date(clock.now.getTime() + 1000);
      await moveTo(key, { lat: Number(before.lat), lng: Number(before.lng) });
    }
    return res;
  }
  return call(app, "POST", `/trips/${tripId}/${path}`, who, { expectedVersion: version, ...body });
};
const riderView = async (tripId: string) => (await call(app, "GET", `/trips/${tripId}`, rider)).json();

/** Drives an accepted trip to the pickup and waits `waitSeconds` before boarding. */
async function toBoard(tripId: string, version: number, waitSeconds: number) {
  let v = version;
  let res = await step(tripId, "head-to-pickup", v);
  expect(res.json().status).toBe("driver_to_pickup");
  res = await step(tripId, "arrive", ++v);
  expect(res.json()).toMatchObject({ status: "arrived", waiting: { arrivedAt: clock.now.toISOString(), chargedSeconds: 0 } });
  await advance(waitSeconds);
  res = await step(tripId, "board", ++v);
  expect(res.json().status).toBe("rider_onboard");
  return { version: ++v, boarded: res.json() };
}

const adminPost = (path: string, body: Record<string, unknown>, who = admin) => call(app, "POST", `/admin${path}`, who, body);
const adminView = async (tripId: string) => (await call(app, "GET", `/admin/trips/${tripId}`, admin)).json();
const clearFees = async () => {
  await database.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
  await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_source_trip_id: null, wallet_minor: 0 }).execute();
  await database.db.deleteFrom("rider_wallets").execute();
};

/** A trip that A drove to the end (no waiting charge). */
async function completedTrip() {
  const { tripId, version } = await accepted();
  const { version: v } = await toBoard(tripId, version, 60);
  await step(tripId, "start", v);
  const done = await step(tripId, "complete", v + 1);
  expect(done.json().status).toBe("completed");
  return { tripId, version: done.json().version as number };
}

const pauseDispatch = (paused: boolean) =>
  database.db.insertInto("dispatch_controls").values({ zone_id: "Z001", paused, mode: null, by: null, at: clock.now, version: 1 }).onConflict((c) => c.column("zone_id").doUpdateSet({ paused })).execute();
const sek = (amountMinor: number) => ({ amountMinor, currency: "SEK" });

describe("review: admin tools", () => {
  beforeEach(clearFees);

  it("R1 the rider's event feed never carries driverBonus", async () => {
    await pauseDispatch(true);
    try {
      const { tripId } = await book();
      const trip = await adminView(tripId);
      const res = await adminPost(`/trips/${tripId}/assign`, { expectedVersion: trip.version, driverId: drivers.B.id, driverBonus: sek(3000) });
      expect(res.statusCode).toBe(200);
      expect(await riderView(tripId)).not.toHaveProperty("driverBonus"); // GET is redacted...
      const events = (await call(app, "GET", `/trips/${tripId}/events`, rider)).json().items;
      const leaked = events.filter((e: { projection?: Record<string, unknown> }) => e.projection && "driverBonus" in e.projection);
      expect(events.length).toBeGreaterThan(0);
      expect(leaked).toEqual([]);
    } finally {
      await pauseDispatch(false);
    }
  });

  it("R2 a Z002-only finance admin does not see a Z001 rider's payout", async () => {
    const { tripId, version } = await completedTrip();
    const refund = (await adminPost(`/trips/${tripId}/refund`, { expectedVersion: version, amount: sek(3000), reason: "Wrong route" })).json();
    await call(app, "POST", `/rider/refunds/${refund.refundId}/destination`, rider, { method: "swish", swish: { phone: "+46701234567" } });
    const otherZone = (await adminSession(app, database.db, "finance", { zoneIds: ["Z002"], now: clock.now })).headers;
    expect((await call(app, "GET", `/admin/trips/${tripId}`, otherZone)).statusCode).toBe(403);
    const items = (await call(app, "GET", "/admin/refunds/payouts", otherZone)).json().items;
    const mine = items.find((r: { refundId: string }) => r.refundId === refund.refundId);
    expect(mine).toBeUndefined();
    expect((await call(app, "GET", "/admin/refunds/payouts", admin)).json().items.find((r: { refundId: string }) => r.refundId === refund.refundId)).toBeDefined();
  });

  it("R3 the per-trip bonus limit counts the trip bonus and lost-driver bonuses together", async () => {
    const { tripId, version } = await accepted();
    const b = await adminPost(`/trips/${tripId}/driver-bonus`, { expectedVersion: version, amount: sek(20000) });
    expect(b.statusCode).toBe(200);
    const re = await adminPost(`/trips/${tripId}/reassign`, { expectedVersion: b.json().version, reasonCode: "admin_operational", note: "x", driverBonus: sek(20000) });
    expect(re.json()).toMatchObject({ reason: "bonus_over_limit" });
  });

  it("R4 the refund cap is what was paid: nothing collected, nothing to refund", async () => {
    const { tripId, version } = await accepted();
    const { version: v } = await toBoard(tripId, version, 60);
    await step(tripId, "start", v);
    const done = await step(tripId, "complete", v + 1, { cashCollected: sek(0) });
    expect(done.json().status).toBe("completed");
    const res = await adminPost(`/trips/${tripId}/refund`, { expectedVersion: done.json().version, amount: sek(21700), reason: "x" });
    expect(res.json()).toMatchObject({ reason: "refund_too_large" });
  });

  it("R5 wallet money that arrives after boarding stays in the wallet", async () => {
    const first = await completedTrip();
    const refund = (await adminPost(`/trips/${first.tripId}/refund`, { expectedVersion: first.version, amount: sek(5000), reason: "x" })).json();
    const next = await accepted();
    const { version: v, boarded } = await toBoard(next.tripId, next.version, 60);
    expect(boarded).not.toHaveProperty("cashToCollect"); // driver: collect the full 217 kr
    await call(app, "POST", `/rider/refunds/${refund.refundId}/destination`, rider, { method: "wallet" });
    await step(next.tripId, "start", v);
    const done = await step(next.tripId, "complete", v + 1, { cashCollected: sek(21700) });
    expect(done.json().status).toBe("completed");
    const t = await database.db.selectFrom("trips").select(["cash_collected_minor", "wallet_applied_minor", "fare_minor"]).where("trip_id", "=", next.tripId).executeTakeFirstOrThrow();
    expect(t).toEqual({ cash_collected_minor: "21700", wallet_applied_minor: "0", fare_minor: "21700" });
    expect((await call(app, "GET", "/wallet", rider)).json().balance.amountMinor).toBe(5000);
  });

  it("R6 a fee that a running trip already carries cannot be waived until that trip is over", async () => {
    const ns = await accepted();
    await step(ns.tripId, "head-to-pickup", ns.version);
    await step(ns.tripId, "arrive", ns.version + 1);
    await advance(5 * 60);
    const noShow = await step(ns.tripId, "no-show", ns.version + 2);
    expect(noShow.json().status).toBe("no_show");
    const next = await accepted(); // quoted with the owed fee as an outstanding_fee line
    const line = (await adminView(next.tripId)).fareLines.find((l: { code: string }) => l.code === "outstanding_fee");
    expect(line?.amount.amountMinor).toBeGreaterThan(0);
    const waived = await adminPost(`/trips/${ns.tripId}/adjust`, { expectedVersion: noShow.json().version, waiveCancelFee: true, reason: "emergency" });
    expect(waived.json()).toMatchObject({ reason: "fee_on_running_trip" });
    const { version: v } = await toBoard(next.tripId, next.version, 60);
    await step(next.tripId, "start", v);
    await step(next.tripId, "complete", v + 1);
    const fee = await database.db.selectFrom("rider_fees").select("status").where("trip_id", "=", ns.tripId).executeTakeFirstOrThrow();
    expect(fee.status).toBe("paid");
  });
  it("R7 the fare cannot be adjusted while offers carry it", async () => {
    await database.db.deleteFrom("offers").where("status", "!=", "open").execute();
    await database.db.updateTable("drivers").set({ last_free_at: clock.now, rating_sum: 0, rating_count: 0 }).execute();
    for (const key of ["A", "B"] as const) await moveTo(key, SPOTS[key]);
    const { tripId } = await book();
    const [offer] = (await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items;
    expect(offer.tripId).toBe(tripId);
    const trip = await adminView(tripId);
    const adj = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: trip.version, fare: sek(10000), reason: "goodwill" });
    expect(adj.json()).toMatchObject({ reason: "adjust_after_accept" });
    const ok = await call(app, "POST", `/offers/${offer.offerId}/accept`, drivers.A.headers, { expectedVersion: offer.version });
    expect(ok.json()).toMatchObject({ status: "accepted", fare: { amountMinor: 21700 }, driverEarnings: { amountMinor: 15760 }, commission: { amountMinor: 21700 - 15760 } });
  });
});
