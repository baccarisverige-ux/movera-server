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
import { liftEndedPauses } from "../../src/riders/moderation.js";
import { fileApproval } from "../../src/admin/approvals.js";

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
let riderId: string;
let admin: Record<string, string>;
let dispatcherOther: Record<string, string>;
let finance: Record<string, string>;
let dispatcher: Record<string, string>;

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
  riderId = (await call(app, "GET", "/rider/profile", rider)).json().riderId;
  for (const key of ["A", "B"] as const) {
    drivers[key].headers = (await signIn(app, { A: TEST_PHONES[1], B: TEST_PHONES[2] }[key]!, "driver")).headers;
    await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", drivers[key].id).execute();
    await moveTo(key, SPOTS[key]);
  }
});

beforeEach(async () => {
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  dispatcher = (await adminSession(app, database.db, "dispatcher", { now: clock.now })).headers;
  dispatcherOther = (await adminSession(app, database.db, "dispatcher", { zoneIds: ["Z002"], now: clock.now })).headers;
  finance = (await adminSession(app, database.db, "finance", { now: clock.now })).headers;
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
const driverRow = (key: "A" | "B") => database.db.selectFrom("drivers").selectAll().where("driver_id", "=", drivers[key].id).executeTakeFirstOrThrow();
const entries = (tripId: string) => database.db.selectFrom("earnings_entries").select(["kind", "amount_minor", "gross_minor", "commission_minor", "cash_minor"]).where("trip_id", "=", tripId).orderBy("kind").execute();

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

describe("the rider's \"I'm on the way\" (contract v0.5.4)", () => {
  it("reaches the driver as a rider_on_the_way event; status and version stay; refused before a driver is coming", async () => {
    const { tripId, quote } = await book();
    const early = await call(app, "POST", `/trips/${tripId}/on-the-way`, rider, {});
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: "invalid_transition" });
    // Booked, no driver yet: searching, or offered once dispatch has run.
    expect(["searching", "offered"]).toContain(early.json().projection?.status);
    // Cancelled through the API, so its open offers are withdrawn before the next booking.
    const cancelled = await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: early.json().projection.version, reasonCode: "plans_changed" });
    expect(cancelled.statusCode).toBe(200);
    void quote;

    const a = await accepted();
    let v = a.version;
    await step(a.tripId, "head-to-pickup", v);
    const arrived = await step(a.tripId, "arrive", ++v);
    expect(arrived.json().status).toBe("arrived");
    const before = (await call(app, "GET", `/trips/${a.tripId}/events`, drivers.A.headers)).json().items.length;

    const told = await call(app, "POST", `/trips/${a.tripId}/on-the-way`, rider, {});
    expect(told.statusCode).toBe(200);
    expect(told.json()).toMatchObject({ status: "arrived", version: arrived.json().version });

    const events = (await call(app, "GET", `/trips/${a.tripId}/events`, drivers.A.headers)).json().items;
    // v0.18.56 §78 (chat.onTheWay): the event is followed by one chat message in the driver's language.
    expect(events).toHaveLength(before + 2);
    expect(events[events.length - 2]).toMatchObject({ kind: "rider_on_the_way", version: arrived.json().version, projection: { status: "arrived" } });
    expect(events[events.length - 1]).toMatchObject({ kind: "message", version: arrived.json().version, message: { from: "rider", auto: "on_my_way" } });
    // The driver's commands still send the same expectedVersion.
    expect((await step(a.tripId, "board", arrived.json().version)).json().status).toBe("rider_onboard");
  });
});

describe("completed before the destination (owner decision 28)", () => {
  it("the rider pays for what was driven, never more than booked; at the drop-off the booked fare stands", async () => {
    // Ended 2 km short of the drop-off, a few minutes after boarding.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the API in a test helper
    const total = (p: Record<string, any>) => Number((p.fare?.total ?? p.fare)?.amountMinor);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the API in a test helper
    const lines = (p: Record<string, any>) => ((p.fareLines ?? p.fare?.fareLines ?? []) as { code: string }[]).map((l) => l.code);
    const a = await accepted();
    const booked = total(await riderView(a.tripId));
    const { version } = await toBoard(a.tripId, a.version, 0);
    await step(a.tripId, "start", version);
    await advance(180);
    await moveTo("A", { lat: 59.3300, lng: 18.0660 });
    const early = await call(app, "POST", `/trips/${a.tripId}/complete`, drivers.A.headers, { expectedVersion: version + 1 });
    expect(early.statusCode).toBe(200);
    const paid = early.json();
    expect(paid.status).toBe("completed");
    expect(total(paid)).toBeLessThan(booked);
    expect(lines(paid)).toContain("minimum_adjust");
    expect((await database.db.selectFrom("trips").select("cash_collected_minor").where("trip_id", "=", a.tripId).executeTakeFirstOrThrow()).cash_collected_minor).toBe(String(total(paid)));
    expect(total(await riderView(a.tripId))).toBe(total(paid));

    // At the drop-off: the booked fare and its lines, untouched.
    const b = await accepted();
    const bookedB = total(await riderView(b.tripId));
    const boardedB = await toBoard(b.tripId, b.version, 0);
    await step(b.tripId, "start", boardedB.version);
    const done = await step(b.tripId, "complete", boardedB.version + 1);
    expect(total(done.json())).toBe(bookedB);
    expect(lines(done.json())).not.toContain("minimum_adjust");
  });
});

const adminPost = (path: string, body: Record<string, unknown>, who = admin) => call(app, "POST", `/admin${path}`, who, body);
const adminView = async (tripId: string) => (await call(app, "GET", `/admin/trips/${tripId}`, admin)).json();
const audits = async (tripId: string) => (await call(app, "GET", `/admin/audit?targetId=${tripId}`, admin)).json().items.map((a: { action: string }) => a.action);
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

describe("admin lists", () => {
  it("lists trips with filters; another zone's admin sees nothing and is refused", async () => {
    const { tripId } = await accepted();
    const list = (await call(app, "GET", `/admin/trips?status=accepted&status=driver_to_pickup`, admin)).json();
    expect(list.items.map((t: { tripId: string }) => t.tripId)).toContain(tripId);
    expect(list.items[0]).toHaveProperty("driverEarnings");
    expect((await call(app, "GET", `/admin/trips?q=${tripId}`, admin)).json().items).toHaveLength(1);
    expect((await call(app, "GET", `/admin/trips?status=completed&riderId=${riderId}&limit=1`, admin)).statusCode).toBe(200);
    expect((await call(app, "GET", `/admin/trips`, dispatcherOther)).json().items).toEqual([]);
    expect((await call(app, "GET", `/admin/trips/${tripId}`, dispatcherOther)).json()).toMatchObject({ code: "forbidden", reason: "zone_out_of_scope" });
    expect((await call(app, "GET", `/admin/trips/${tripId}`, rider)).statusCode).toBe(403);
    const riders = (await call(app, "GET", `/admin/riders?q=${encodeURIComponent(TEST_PHONES[0]!)}`, admin)).json();
    expect(riders.items[0]).toMatchObject({ riderId, wallet: { amountMinor: 0 } });
    const drv = (await call(app, "GET", "/admin/drivers?onlineStatus=on_trip", admin)).json();
    expect(drv.items.map((d: { driverId: string }) => d.driverId)).toEqual([drivers.A.id]);
    expect(drv.items[0]).toHaveProperty("location");
    const near = (await call(app, "GET", `/admin/trips/${tripId}/nearby-drivers?radiusKm=5`, admin)).json();
    expect(near.items.map((d: { driverId: string }) => d.driverId)).toEqual(expect.arrayContaining([drivers.A.id, drivers.B.id]));
    const offers = (await call(app, "GET", `/admin/trips/${tripId}/offers`, admin)).json();
    expect(offers.items[0]).toMatchObject({ driverId: drivers.A.id, status: "claimed" });
  });
});

describe("admin trip commands", () => {
  beforeEach(clearFees);

  it("cancel after accept: the rider pays nothing, the driver is free and gets the bonus the admin gave", async () => {
    const { tripId, version } = await accepted();
    const res = await adminPost(`/trips/${tripId}/cancel`, { expectedVersion: version, reasonCode: "admin_operational", note: "Road closed", driverBonus: { amountMinor: 5000, currency: "SEK" } });
    expect(res.json()).toMatchObject({ status: "cancelled_by_admin", cancellation: { actor: "admin", reasonCode: "admin_operational", fee: null } });
    expect((await riderView(tripId)).cancellation).not.toHaveProperty("note");
    expect((await driverRow("A")).online_status).toBe("online");
    expect(await entries(tripId)).toEqual([{ kind: "bonus", amount_minor: "5000", gross_minor: null, commission_minor: null, cash_minor: null }]);
    expect(await audits(tripId)).toContain("trip.cancel");
    // Over the 200 kr bonus limit, or a stale version, is refused.
    const again = await accepted();
    expect((await adminPost(`/trips/${again.tripId}/cancel`, { expectedVersion: again.version, reasonCode: "admin_other", note: "x", driverBonus: { amountMinor: 25000, currency: "SEK" } })).json()).toMatchObject({ reason: "bonus_over_limit" });
    expect((await adminPost(`/trips/${again.tripId}/cancel`, { expectedVersion: again.version + 3, reasonCode: "admin_other", note: "x" })).json()).toMatchObject({ code: "version_mismatch" });
    expect((await adminPost(`/trips/${again.tripId}/cancel`, { expectedVersion: again.version, reasonCode: "plans_changed", note: "x" })).json()).toMatchObject({ reason: "invalid_reason_code" });
  });

  it("reassign: back to searching, offered again; the old driver is free", async () => {
    const { tripId, version } = await accepted();
    await step(tripId, "head-to-pickup", version);
    const res = await adminPost(`/trips/${tripId}/reassign`, { expectedVersion: version + 1, reasonCode: "admin_driver_request", note: "Driver called" });
    expect(res.json()).toMatchObject({ status: "searching" });
    expect(res.json()).not.toHaveProperty("driverId");
    await worker.runDue();
    expect((await adminView(tripId)).status).toBe("offered");
    expect((await driverRow("A")).online_status).toBe("online");
  });

  it("direct assign with a bonus: the driver's card shows it, accepting locks the trip", async () => {
    // Pause automatic offers so only the admin's offer goes out.
    await database.db.insertInto("dispatch_controls").values({ zone_id: "Z001", paused: true, mode: null, by: null, at: clock.now, version: 1 }).onConflict((c) => c.column("zone_id").doUpdateSet({ paused: true })).execute();
    try {
      const { tripId } = await book();
      const trip = await adminView(tripId);
      expect(trip.status).toBe("searching");
      const res = await adminPost(`/trips/${tripId}/assign`, { expectedVersion: trip.version, driverId: drivers.B.id, driverBonus: { amountMinor: 3000, currency: "SEK" }, priority: true });
      expect(res.json()).toMatchObject({ status: "offered", driverBonus: { amountMinor: 3000 } });
      expect(await riderView(tripId)).not.toHaveProperty("driverBonus");
      const [offer] = (await call(app, "GET", "/driver/offers", drivers.B.headers)).json().items;
      expect(offer).toMatchObject({ kind: "assigned", source: "admin", priority: true, fare: { amountMinor: 21700 + 3000 }, driverEarnings: { amountMinor: 15760 + 3000 }, driverBonus: { amountMinor: 3000 } });
      // An offline driver cannot be assigned.
      await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", drivers.A.id).execute();
      const offered = await adminView(tripId);
      expect((await adminPost(`/trips/${tripId}/assign`, { expectedVersion: offered.version, driverId: drivers.A.id })).json()).toMatchObject({ reason: "driver_not_available" });
      const ok = await call(app, "POST", `/offers/${offer.offerId}/accept`, drivers.B.headers, { expectedVersion: offer.version });
      expect(ok.json()).toMatchObject({ status: "accepted", driverId: drivers.B.id, commission: { amountMinor: 21700 - 15760 - 3000 } });
      const locked = await adminView(tripId);
      expect((await adminPost(`/trips/${tripId}/assign`, { expectedVersion: locked.version, driverId: drivers.A.id })).json()).toMatchObject({ code: "invalid_transition" });
    } finally {
      await database.db.updateTable("dispatch_controls").set({ paused: false }).execute();
    }
  });

  it("radar group: both see it, the first to accept wins", async () => {
    await database.db.insertInto("dispatch_controls").values({ zone_id: "Z001", paused: true, mode: null, by: null, at: clock.now, version: 1 }).onConflict((c) => c.column("zone_id").doUpdateSet({ paused: true })).execute();
    try {
      const { tripId } = await book();
      const trip = await adminView(tripId);
      const res = await adminPost(`/trips/${tripId}/radar-group`, { expectedVersion: trip.version, driverIds: [drivers.A.id, drivers.B.id] });
      expect(res.statusCode).toBe(200);
      const group = res.json();
      expect(group.offers).toHaveLength(2);
      expect(group.projection.status).toBe("offered");
      const [offerB] = (await call(app, "GET", "/driver/offers", drivers.B.headers)).json().items;
      expect(offerB.groupId).toBe(group.groupId);
      await call(app, "POST", `/offers/${offerB.offerId}/accept`, drivers.B.headers, { expectedVersion: offerB.version });
      expect((await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items).toEqual([]);
    } finally {
      await database.db.updateTable("dispatch_controls").set({ paused: false }).execute();
    }
  });

  it("no-show by an admin can waive the fee; complete by an admin can set the driver's pay (S5 J6: the rider's fare stays)", async () => {
    const first = await accepted();
    const ns = await adminPost(`/trips/${first.tripId}/no-show`, { expectedVersion: first.version, note: "Rider never came", waiveFee: true });
    expect(ns.json()).toMatchObject({ status: "no_show", cancellation: { actor: "admin", fee: null } });
    const second = await accepted();
    const { version: v } = await toBoard(second.tripId, second.version, 60);
    await step(second.tripId, "start", v);
    const done = await adminPost(`/trips/${second.tripId}/complete`, { expectedVersion: v + 1, note: "Driver app froze", driverPay: { amountMinor: 12000, currency: "SEK" } });
    // S5 J6 (owner Q-M7): the rider pays the booked 217 kr; the driver's pay is the 120 kr the admin typed.
    expect(done.json()).toMatchObject({ status: "completed", fare: { amountMinor: 21700 }, paymentStatus: "captured", driverEarnings: { amountMinor: 15760 }, driverTotal: { amountMinor: 12000 }, driverAdjustments: { amountMinor: 12000 - 15760 } });
    expect(done.json().fareLines.map((l: { code: string }) => l.code)).not.toContain("adjustment");
  });

  it("adjust: waiting on a running trip; a paid trip needs a refund; waiving an owed fee keeps the driver's share", async () => {
    const { tripId, version } = await accepted();
    const { version: v } = await toBoard(tripId, version, 60);
    const adj = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: v, waitingSeconds: 120, reason: "Rider was late" });
    expect(adj.statusCode).toBe(200);
    expect(adj.json()).toMatchObject({ fare: { amountMinor: 24400 }, waiting: { chargedSeconds: 120 } });
    await step(tripId, "start", v + 1);
    const done = await step(tripId, "complete", v + 2);
    expect((await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: done.json().version, driverPay: { amountMinor: 10000, currency: "SEK" }, reason: "x" })).json()).toMatchObject({ reason: "use_refund" });

    const ns = await accepted();
    await step(ns.tripId, "head-to-pickup", ns.version);
    await step(ns.tripId, "arrive", ns.version + 1);
    await advance(5 * 60);
    const noShow = await step(ns.tripId, "no-show", ns.version + 2);
    const waived = await adminPost(`/trips/${ns.tripId}/adjust`, { expectedVersion: noShow.json().version, waiveCancelFee: true, reason: "Rider had an emergency" });
    expect(waived.json()).toMatchObject({ cancellation: { feeStatus: "waived" } });
    expect((await call(app, "GET", "/rider/profile", rider)).json().outstanding).toBeNull();
    expect(await entries(ns.tripId)).toEqual([{ kind: "fee_share", amount_minor: "5200", gross_minor: null, commission_minor: null, cash_minor: null }]);
    // The terminal trip's change goes out as payment_updated (it passes the apps' terminal gate).
    const last = await database.db.selectFrom("trip_events").select("kind").where("trip_id", "=", ns.tripId).orderBy("sequence", "desc").executeTakeFirstOrThrow();
    expect(last.kind).toBe("payment_updated");
  });
});

describe("refunds and the wallet", () => {
  beforeEach(clearFees);

  it("deep fix (g7-g9 M1): with an old debt on the fare, the driver's share is min(refund, fare − debt) × earnings ÷ (fare − debt); the rider gets a refund notice", async () => {
    const { tripId, version } = await completedTrip();
    // 318 kr = 78 kr ride + 240 kr old fee collected; driver earnings 57 kr.
    await database.db.updateTable("trips").set({ fare_minor: 31800, cash_collected_minor: 31800, driver_earnings_minor: 5700, fare_lines: JSON.stringify([{ code: "base", amount: { amountMinor: 7800, currency: "SEK" } }, { code: "outstanding_fee", amount: { amountMinor: 24000, currency: "SEK" } }]) }).where("trip_id", "=", tripId).execute();
    const res = await adminPost(`/trips/${tripId}/refund`, { expectedVersion: version, amount: { amountMinor: 7800, currency: "SEK" }, reason: "Ride refunded", fromDriver: true });
    expect(res.statusCode, res.body).toBe(201);
    // Fail-before: 7800 × 5700 / 31800 = 1398.
    expect((await entries(tripId)).find((e) => e.kind === "adjustment")?.amount_minor).toBe("-5700");
    expect(await database.db.selectFrom("notifications").select("kind").where("trip_id", "=", tripId).where("kind", "=", "refund").execute()).toHaveLength(1);
  });

  it("refund taken from the driver; the rider keeps it in the wallet; the next ride uses the wallet first", async () => {
    const { tripId, version } = await completedTrip();
    const res = await adminPost(`/trips/${tripId}/refund`, { expectedVersion: version, amount: { amountMinor: 5000, currency: "SEK" }, reason: "Long detour", fromDriver: true });
    expect(res.statusCode).toBe(201);
    const refund = res.json();
    expect(refund).toMatchObject({ tripId, status: "done", destination: null, amount: { amountMinor: 5000 } });
    expect((await adminView(tripId)).paymentStatus).toBe("partially_refunded");
    // 50 kr of 217 kr: the driver loses 157.60 × 50 / 217 = 36.31 kr.
    expect((await entries(tripId)).find((e) => e.kind === "adjustment")?.amount_minor).toBe(String(-Math.round((5000 * 15760) / 21700)));
    expect((await adminPost(`/trips/${tripId}/refund`, { expectedVersion: version + 1, amount: { amountMinor: 20000, currency: "SEK" }, reason: "x" })).json()).toMatchObject({ reason: "refund_too_large" });

    const mine = (await call(app, "GET", "/rider/refunds", rider)).json().items;
    expect(mine[0]).toMatchObject({ refundId: refund.refundId, destination: null, choices: ["wallet", "swish", "bank"] });
    const chosen = await call(app, "POST", `/rider/refunds/${refund.refundId}/destination`, rider, { method: "wallet" });
    expect(chosen.json()).toMatchObject({ destination: "wallet", payoutStatus: null });
    expect((await call(app, "POST", `/rider/refunds/${refund.refundId}/destination`, rider, { method: "wallet" })).json()).toMatchObject({ reason: "destination_chosen" });
    expect((await call(app, "GET", "/wallet", rider)).json().balance).toEqual({ amountMinor: 5000, currency: "SEK" });

    const next = await accepted();
    const { version: v, boarded } = await toBoard(next.tripId, next.version, 60);
    expect(boarded).toMatchObject({ walletApplied: { amountMinor: 5000 }, cashToCollect: { amountMinor: 16700 } });
    await step(next.tripId, "start", v);
    const done = await step(next.tripId, "complete", v + 1);
    expect((await database.db.selectFrom("trips").select(["cash_collected_minor", "wallet_applied_minor"]).where("trip_id", "=", next.tripId).executeTakeFirstOrThrow())).toEqual({ cash_collected_minor: "16700", wallet_applied_minor: "5000" });
    expect(done.json().fare.amountMinor).toBe(21700);
    expect((await call(app, "GET", "/wallet", rider)).json().balance.amountMinor).toBe(0);
    const ledger = (await call(app, "GET", "/wallet/entries", rider)).json().items.map((e: { kind: string; amount: { amountMinor: number } }) => [e.kind, e.amount.amountMinor]);
    expect(ledger).toEqual([["charge", -5000], ["refund", 5000]]);
    // The driver's earnings are the same; Movera covers the wallet part.
    expect((await entries(next.tripId)).find((e) => e.kind === "trip")).toMatchObject({ amount_minor: "15760", cash_minor: "16700" });
  });

  it("refund by Swish: the admin sees it to pay and marks it paid; bank details follow the country", async () => {
    const { tripId, version } = await completedTrip();
    const refund = (await adminPost(`/trips/${tripId}/refund`, { expectedVersion: version, amount: { amountMinor: 3000, currency: "SEK" }, reason: "Wrong route" })).json();
    expect((await call(app, "POST", `/rider/refunds/${refund.refundId}/destination`, rider, { method: "bank", bank: { iban: "FR7630006000011234567890189", holderName: "Test Rider" } })).json()).toMatchObject({ reason: "bank_details_invalid" });
    expect((await call(app, "POST", `/rider/refunds/${refund.refundId}/destination`, rider, { method: "swish", swish: { phone: "0701234567" } })).statusCode).toBe(400);
    const chosen = await call(app, "POST", `/rider/refunds/${refund.refundId}/destination`, rider, { method: "swish", swish: { phone: "+46701234567" } });
    expect(chosen.json()).toMatchObject({ destination: "swish", payoutStatus: "pending", payoutTo: "Swish ••4567" });
    const toPay = (await call(app, "GET", "/admin/refunds/payouts", finance)).json().items;
    expect(toPay.find((r: { refundId: string }) => r.refundId === refund.refundId)).toMatchObject({ payoutTo: { swish: { phone: "+46701234567" } }, amount: { amountMinor: 3000 } });
    expect((await adminPost(`/refunds/${refund.refundId}/paid`, {}, dispatcher)).statusCode).toBe(403);
    expect((await adminPost(`/refunds/${refund.refundId}/paid`, { note: "Swish sent" }, finance)).json()).toMatchObject({ payoutStatus: "paid" });
    expect((await adminPost(`/refunds/${refund.refundId}/paid`, {}, finance)).json()).toMatchObject({ reason: "already_paid" });
    expect((await call(app, "GET", "/wallet", rider)).json().balance.amountMinor).toBe(0);
  });

  it("v0.7.2: a finance admin's refund runs at once (one admin is enough); a dispatcher cannot refund", async () => {
    const { tripId, version } = await completedTrip();
    expect((await adminPost(`/trips/${tripId}/refund`, { expectedVersion: version, amount: { amountMinor: 1000, currency: "SEK" }, reason: "x" }, dispatcher)).statusCode).toBe(403);
    const done = await adminPost(`/trips/${tripId}/refund`, { expectedVersion: version, amount: { amountMinor: 1000, currency: "SEK" }, reason: "Late driver" }, finance);
    expect(done.statusCode, done.body).toBe(201);
    expect(done.json().status).toBe("done");
    expect((await database.db.selectFrom("refunds").select("amount_minor").where("trip_id", "=", tripId).execute())).toEqual([{ amount_minor: "1000" }]);
    expect(await database.db.selectFrom("approvals").selectAll().where("target_id", "=", tripId).execute()).toEqual([]);
  });
});

const riderVersion = async (id: string) => (await database.db.selectFrom("riders").select("version").where("rider_id", "=", id).executeTakeFirstOrThrow()).version;

describe("v0.18.39 fix job 0 (A2): Add money to wallet (owner G12 Q5, Q-D, build-spec Q1/Q2)", () => {
  it("SE: finance adds kr with a reason; history, push and audit; limits and currency are checked", async () => {
    await completedTrip();
    await clearFees();
    // v0.18.82 S5 J4 (moneyBase.versionGuard): each click carries the rider version the admin last saw.
    const credit = async (body: Record<string, unknown>, who = finance, id = riderId) => adminPost(`/riders/${id}/wallet-credit`, { expectedVersion: await riderVersion(id), ...body }, who);
    expect((await credit({ amount: { amountMinor: 5000, currency: "SEK" }, reason: "Long wait" }, dispatcher)).statusCode).toBe(403);
    expect((await credit({ amount: { amountMinor: 5000, currency: "SEK" }, reason: " " })).statusCode).toBe(400);
    expect((await credit({ amount: { amountMinor: -100, currency: "SEK" }, reason: "x" })).statusCode).toBe(400);
    expect((await credit({ amount: { amountMinor: 5000, currency: "EUR" }, reason: "x" })).json()).toMatchObject({ reason: "wallet_currency_mismatch" });
    expect((await credit({ amount: { amountMinor: 290_001, currency: "SEK" }, reason: "x" })).json()).toMatchObject({ reason: "wallet_credit_too_large" });
    const done = await credit({ amount: { amountMinor: 290_000, currency: "SEK" }, reason: "Long wait" });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().wallet).toEqual({ amountMinor: 290_000, currency: "SEK" });
    expect((await call(app, "GET", "/wallet", rider)).json().balance.amountMinor).toBe(290_000);
    expect((await call(app, "GET", "/wallet/entries", rider)).json().items[0]).toMatchObject({ kind: "adjustment", amount: { amountMinor: 290_000, currency: "SEK" } });
    const note = await database.db.selectFrom("notifications").select(["kind", "title", "body"]).where("subject_id", "=", riderId).where("kind", "=", "wallet_credit").executeTakeFirstOrThrow();
    expect(note.title).toBe("Pengar i din plånbok");
    expect(note.body).toMatch(/^Movera har lagt till 2\s900 kr i din plånbok\.$/);
    expect((await audits(riderId)).filter((a: string) => a === "rider.wallet_credit")).toHaveLength(1);
    // The admin's own country limit (country standard) wins over the default.
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-SE", version: 9, document: JSON.stringify({ country: "SE", walletCreditMax: { amountMinor: 10_000, currency: "SEK" } }), published_at: clock.now, published_by: null })
      .onConflict((c) => c.columns(["doc", "zone_id"]).doUpdateSet({ document: JSON.stringify({ country: "SE", walletCreditMax: { amountMinor: 10_000, currency: "SEK" } }) })).execute();
    expect((await credit({ amount: { amountMinor: 10_001, currency: "SEK" }, reason: "x" })).json()).toMatchObject({ reason: "wallet_credit_too_large" });
    expect((await credit({ amount: { amountMinor: 10_000, currency: "SEK" }, reason: "Sorry" })).statusCode).toBe(200);
    // Fix job 0 (owner A2-1 "Per country, in Pricing"): a zone's own value is ignored; the country Standard's limit counts.
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "Z001", version: 9, document: JSON.stringify({ country: "SE", walletCreditMax: { amountMinor: 5_000, currency: "SEK" } }), published_at: clock.now, published_by: null }).execute();
    expect((await credit({ amount: { amountMinor: 5_001, currency: "SEK" }, reason: "Per country" })).statusCode).toBe(200);
    expect((await credit({ amount: { amountMinor: 10_001, currency: "SEK" }, reason: "x" })).json()).toMatchObject({ reason: "wallet_credit_too_large" });
    // A limit saved in another currency is not this country's limit: the default (2 900 kr) applies.
    await database.db.updateTable("config_live").set({ document: JSON.stringify({ country: "SE", walletCreditMax: { amountMinor: 1_000, currency: "EUR" } }) }).where("doc", "=", "country_rules").where("zone_id", "=", "standard-SE").execute();
    expect((await credit({ amount: { amountMinor: 20_000, currency: "SEK" }, reason: "Default limit" })).statusCode).toBe(200);
    await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").where("zone_id", "in", ["standard-SE", "Z001"]).execute();
    await clearFees();
  });

  it("FR: a rider seen only in Paris gets €; a rider with no country is refused", async () => {
    const { headers } = await signIn(app, TEST_PHONES[5]!, "rider");
    const id = (await call(app, "GET", "/rider/profile", headers)).json().riderId as string;
    expect((await adminPost(`/riders/${id}/wallet-credit`, { expectedVersion: await riderVersion(id), amount: { amountMinor: 1000, currency: "EUR" }, reason: "Goodwill" }, finance)).json()).toMatchObject({ reason: "rider_country_unknown" });
    await database.db.updateTable("riders").set({ last_seen_zone_id: "FR-PC" }).where("rider_id", "=", id).execute();
    expect((await adminPost(`/riders/${id}/wallet-credit`, { expectedVersion: await riderVersion(id), amount: { amountMinor: 1000, currency: "SEK" }, reason: "x" }, finance)).json()).toMatchObject({ reason: "wallet_currency_mismatch" });
    expect((await adminPost(`/riders/${id}/wallet-credit`, { expectedVersion: await riderVersion(id), amount: { amountMinor: 25_001, currency: "EUR" }, reason: "x" }, finance)).json()).toMatchObject({ reason: "wallet_credit_too_large" });
    const ok = await adminPost(`/riders/${id}/wallet-credit`, { expectedVersion: await riderVersion(id), amount: { amountMinor: 25_000, currency: "EUR" }, reason: "Goodwill" }, finance);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().wallet).toEqual({ amountMinor: 25_000, currency: "EUR" });
    const note = await database.db.selectFrom("notifications").select(["title", "body"]).where("subject_id", "=", id).where("kind", "=", "wallet_credit").executeTakeFirstOrThrow();
    expect(note.title).toBe("Argent dans votre portefeuille");
    expect(note.body).toMatch(/^Movera a ajouté 250\s€ à votre portefeuille\.$/);
  });
});

describe("v0.18.39 fix job 0 (owner A2-2): Mark as paid on an owed fee, with a reason", () => {
  beforeEach(clearFees);
  const owedNoShow = async () => {
    const ns = await accepted();
    await step(ns.tripId, "head-to-pickup", ns.version);
    await step(ns.tripId, "arrive", ns.version + 1);
    await advance(5 * 60);
    await step(ns.tripId, "no-show", ns.version + 2);
    return ns.tripId;
  };
  it("SE: finance marks it paid with a reason (audited); the next quote no longer carries it; no second mark", async () => {
    const tripId = await owedNoShow();
    const owed = (await call(app, "GET", "/rider/profile", rider)).json().outstanding;
    expect(owed).toMatchObject({ currency: "SEK" });
    const mark = (body: Record<string, unknown>, who = finance, trip = tripId) => adminPost(`/riders/${riderId}/fees/${trip}/mark-paid`, body, who);
    expect((await mark({ reason: "Paid by Swish" }, dispatcher)).statusCode).toBe(403);
    expect((await mark({ reason: "  " })).json()).toMatchObject({ reason: "reason_required" });
    expect((await mark({})).json()).toMatchObject({ reason: "reason_required" });
    const done = await mark({ reason: "Paid by Swish" });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().outstanding ?? null).toBeNull();
    expect((await call(app, "GET", "/rider/profile", rider)).json().outstanding).toBeNull();
    const fee = await database.db.selectFrom("rider_fees").select(["status", "carried_by"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(fee).toEqual({ status: "paid", carried_by: null });
    const trip = await database.db.selectFrom("trips").select("cancellation").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect((trip.cancellation as { feeStatus?: string }).feeStatus).toBe("paid");
    const row = await database.db.selectFrom("admin_audit").select(["action", "detail"]).where("action", "=", "rider.fee_mark_paid").where("target_id", "=", riderId).executeTakeFirstOrThrow();
    expect(row.detail).toMatchObject({ tripId, reason: "Paid by Swish", currency: "SEK" });
    const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    expect(JSON.stringify(quote.fareLines ?? [])).not.toContain("outstanding_fee");
    expect((await mark({ reason: "Again" })).json()).toMatchObject({ reason: "fee_not_owed" });
  });
  it("an owed fee left alone is still added by itself to the next trip (no 'Ask rider to pay')", async () => {
    await owedNoShow();
    const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    expect(JSON.stringify(quote.fareLines)).toContain("outstanding_fee");
  });
});

describe("account status", () => {
  it("a suspended driver goes offline and gets no offers; a suspended rider cannot book", async () => {
    const me = (await call(app, "GET", "/admin/drivers?q=" + drivers.B.id, admin)).json().items[0];
    const off = await adminPost(`/drivers/${drivers.B.id}/status`, { expectedVersion: me.version, accountStatus: "suspended", note: "Documents expired" });
    expect(off.json()).toMatchObject({ accountStatus: "suspended", onlineStatus: "offline" });
    const back = await adminPost(`/drivers/${drivers.B.id}/status`, { expectedVersion: off.json().version, accountStatus: "active", note: "Renewed" });
    expect(back.json().accountStatus).toBe("active");

    const r = (await call(app, "GET", `/admin/riders?q=${riderId}`, admin)).json().items[0];
    const blocked = await adminPost(`/riders/${riderId}/status`, { expectedVersion: r.version, status: "suspended", note: "Fraud check" });
    expect(blocked.json().status).toBe("suspended");
    const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    const trip = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
    expect(trip.json()).toMatchObject({ reason: "account_suspended" });
    await adminPost(`/riders/${riderId}/status`, { expectedVersion: blocked.json().version, status: "active", note: "Cleared" });
    expect((await audits(riderId)).filter((a: string) => a === "rider.status")).toEqual(["rider.status", "rider.status"]);
  });

  it("v0.18.39 fix job 0 (A2, G16 Q16-2): Warn → Pause → Ban with reasons; the pause ends by itself; none undoes it", async () => {
    const book = async () => {
      const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
      return call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
    };
    let r = (await call(app, "GET", `/admin/riders?q=${riderId}`, admin)).json().items[0];
    expect(r.moderation).toEqual({ level: "none", until: null });
    // Only riders.block; a pause needs its days, other levels none.
    expect((await adminPost(`/riders/${riderId}/moderation`, { expectedVersion: r.version, level: "warning", reason: "x" }, finance)).statusCode).toBe(403);
    expect((await adminPost(`/riders/${riderId}/moderation`, { expectedVersion: r.version, level: "paused", reason: "Unpaid fees" })).json()).toMatchObject({ reason: "pause_days_required" });
    expect((await adminPost(`/riders/${riderId}/moderation`, { expectedVersion: r.version, level: "banned", reason: "x", pauseDays: 3 })).json()).toMatchObject({ reason: "pause_days_not_allowed" });
    expect((await adminPost(`/riders/${riderId}/moderation`, { expectedVersion: r.version, level: "paused", reason: "x", pauseDays: 366 })).statusCode).toBe(400);
    expect((await adminPost(`/riders/${riderId}/moderation`, { expectedVersion: r.version, level: "warning", reason: " " })).statusCode).toBe(400);

    // Warning: the rider still rides and sees the notice.
    r = (await adminPost(`/riders/${riderId}/moderation`, { expectedVersion: r.version, level: "warning", reason: "Repeated cancellations" })).json();
    expect(r).toMatchObject({ status: "active", moderation: { level: "warning", reason: "Repeated cancellations", until: null } });
    expect((await call(app, "GET", "/rider/profile", rider)).json().moderation).toMatchObject({ level: "warning", reason: "Repeated cancellations" });
    expect((await adminPost(`/riders/${riderId}/moderation`, { expectedVersion: r.version - 1, level: "none", reason: "x" })).json()).toMatchObject({ code: "version_mismatch" });

    // Pause for 2 days: no booking and no sign-in, with the reason and the end.
    r = (await adminPost(`/riders/${riderId}/moderation`, { expectedVersion: r.version, level: "paused", reason: "Unpaid fees", pauseDays: 2 })).json();
    const until = new Date(clock.now.getTime() + 2 * 86_400_000).toISOString();
    expect(r).toMatchObject({ status: "suspended", moderation: { level: "paused", reason: "Unpaid fees", until } });
    expect((await book()).json()).toMatchObject({ reason: "account_suspended", projection: { level: "paused", reason: "Unpaid fees", until } });
    clock.now = new Date(clock.now.getTime() + 5 * 60_000);
    const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone: TEST_PHONES[0]!, app: "rider" }, remoteAddress: "10.9.9.9" });
    expect(challenge.statusCode, challenge.body).toBe(200);
    const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone: TEST_PHONES[0]!, sessionId: challenge.json().sessionId, code: "1234" } });
    expect(verify.statusCode, verify.body).toBe(403);
    expect(verify.json()).toMatchObject({ reason: "account_suspended", projection: { level: "paused" } });

    // After the end the rider can book again at once; the hourly sweep clears the row.
    clock.now = new Date(clock.now.getTime() + 2 * 86_400_000 + 1000);
    expect(await liftEndedPauses(database.db, clock.now)).toBe(1);
    // Tokens ran out over the two days: the rider signs in again (allowed now), the admin too.
    rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    expect((await call(app, "GET", "/rider/profile", rider)).json()).toMatchObject({ riderId, status: "active" });
    admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    r = (await call(app, "GET", `/admin/riders?q=${riderId}`, admin)).json().items[0];
    expect(r).toMatchObject({ status: "active", moderation: { level: "none", until: null } });

    // Ban until undone; none undoes it.
    r = (await adminPost(`/riders/${riderId}/moderation`, { expectedVersion: r.version, level: "banned", reason: "Suspected fraud" })).json();
    expect(r).toMatchObject({ status: "suspended", moderation: { level: "banned", reason: "Suspected fraud", until: null } });
    expect((await book()).json()).toMatchObject({ reason: "account_suspended", projection: { level: "banned" } });
    r = (await adminPost(`/riders/${riderId}/moderation`, { expectedVersion: r.version, level: "none", reason: "Cleared after call" })).json();
    expect(r).toMatchObject({ status: "active", moderation: { level: "none" } });
    expect((await audits(riderId)).filter((a: string) => a === "rider.moderation")).toHaveLength(4);
  });
});

/*
 * v0.18.82 S5 J6 (contract.json#moneyBase.adminFare; owner Q-M7 2026-11-12 "If admin increase fare it's only for the
 * driver side !! The rider pay same amount when booked"; Q-S5-8 2026-11-13 "Admin types driver pay", "No, without tip",
 * "The change", "32 DT, keep change"): the admin types the driver's new pay; the rider's price never moves.
 */
describe("J6: the admin types the driver's pay (driverPay); the rider pays the booked price", () => {
  beforeEach(clearFees);
  const SEK = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
  /** The driver's pay without the tip, as the admin sees it. */
  const payOf = (p: { driverTotal?: { amountMinor: number }; tip?: { amount?: { amountMinor: number } } }) => (p.driverTotal?.amountMinor ?? 0) - (p.tip?.amount?.amountMinor ?? 0);

  it("adjust driverPay: only the driver's pay moves; the rider's fare, lines and receipt stay; the change is kept across a re-price and paid at the end", async () => {
    const { tripId, version } = await accepted();
    const { version: v } = await toBoard(tripId, version, 60);
    const riderBefore = await riderView(tripId);
    const adminBefore = await adminView(tripId);
    const payBefore = payOf(adminBefore);
    const res = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: v, driverPay: SEK(payBefore + 2000), reason: "Long detour for the driver" });
    expect(res.statusCode, res.body).toBe(200);
    // The rider sees nothing of it.
    const riderAfter = await riderView(tripId);
    expect(riderAfter.fare).toEqual(riderBefore.fare);
    expect(riderAfter.fareLines).toEqual(riderBefore.fareLines);
    expect(res.json().fare).toEqual(adminBefore.fare);
    expect(res.json().commission).toEqual(adminBefore.commission);
    // The driver's pay is what the admin typed; the change is its own line.
    expect(payOf(res.json())).toBe(payBefore + 2000);
    expect(res.json().driverAdjustments).toEqual(SEK(2000));
    expect(res.json().driverEarnings).toEqual(adminBefore.driverEarnings);
    // The driver sees it on his trip too.
    const driverSide = (await call(app, "GET", `/trips/${tripId}`, drivers.A.headers)).json();
    expect(driverSide.driverTotal).toEqual(SEK(payBefore + 2000));

    // M8 "keep change": a later re-price (paid waiting) works the pay out again and adds the admin's change on top.
    const repriced = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: res.json().version, waitingSeconds: 120, reason: "Rider was late" });
    expect(repriced.statusCode, repriced.body).toBe(200);
    expect(repriced.json().fare.amountMinor).toBeGreaterThan(riderBefore.fare.amountMinor);
    expect(repriced.json().driverAdjustments).toEqual(SEK(2000));
    const pickup = repriced.json().pickupPay?.amountMinor ?? 0;
    const bonus = repriced.json().driverBonus?.amountMinor ?? 0;
    expect(payOf(repriced.json())).toBe(repriced.json().driverEarnings.amountMinor + pickup + bonus + 2000);

    await step(tripId, "start", repriced.json().version);
    const done = await step(tripId, "complete", repriced.json().version + 1);
    expect(done.statusCode, done.body).toBe(200);
    // The rider pays the re-priced fare, never the admin's change.
    expect(done.json().fare).toEqual(repriced.json().fare);
    const receipt = (await call(app, "GET", `/trips/${tripId}/receipt`, rider)).json();
    expect(receipt.total).toEqual(repriced.json().fare);
    expect(JSON.stringify(receipt)).not.toContain("adjustment");
    // Paid with the trip: one trip entry, one adjustment entry of the admin's change.
    const paid = await entries(tripId);
    expect(paid.filter((e) => e.kind === "trip")).toHaveLength(1);
    expect(paid.filter((e) => e.kind === "adjustment").map((e) => e.amount_minor)).toEqual(["2000"]);
    const ended = await adminView(tripId);
    expect(ended.driverTotal).toEqual(SEK(repriced.json().driverEarnings.amountMinor + pickup + bonus + 2000));
    expect(ended.moneySplit.riderPaid).toEqual(repriced.json().fare);
  });

  it("the change is limited by the zone's driverPayChangeMax and the pay never goes below 0; nothing is written", async () => {
    const { tripId, version } = await accepted();
    const { version: v } = await toBoard(tripId, version, 60);
    const payBefore = payOf(await adminView(tripId));
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "Z001", version: 1, document: JSON.stringify({ driverPayChangeMax: SEK(5000) }), published_at: clock.now, published_by: null }).execute();
    try {
      const above = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: v, driverPay: SEK(payBefore + 5001), reason: "Too much" });
      expect(above.statusCode, above.body).toBe(400);
      expect(above.json()).toMatchObject({ code: "invalid_request", reason: "driver_pay_above_max" });
      const down = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: v, driverPay: SEK(payBefore - 5001), reason: "Too much down" });
      expect(down.json()).toMatchObject({ reason: "driver_pay_above_max" });
      const atMax = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: v, driverPay: SEK(payBefore + 5000), reason: "At the limit" });
      expect(atMax.statusCode, atMax.body).toBe(200);
      const negative = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: atMax.json().version, driverPay: SEK(-1), reason: "Below zero" });
      expect(negative.statusCode).toBe(400);
      expect(negative.json()).toMatchObject({ reason: "driver_pay_below_zero" });
      expect((await adminView(tripId)).version).toBe(atMax.json().version);
    } finally {
      await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").where("zone_id", "=", "Z001").execute();
    }
  });

  it("the old fare (a rider price) is refused on adjust and complete: 400 fare_is_driver_pay, nothing written", async () => {
    const { tripId, version } = await accepted();
    const { version: v } = await toBoard(tripId, version, 60);
    const before = await adminView(tripId);
    const adjust = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: v, fare: SEK(20000), reason: "Traffic" });
    expect(adjust.statusCode, adjust.body).toBe(400);
    expect(adjust.json()).toMatchObject({ code: "invalid_request", reason: "fare_is_driver_pay" });
    const complete = await adminPost(`/trips/${tripId}/complete`, { expectedVersion: v, note: "Driver app froze", fare: SEK(20000) });
    expect(complete.statusCode, complete.body).toBe(400);
    expect(complete.json()).toMatchObject({ code: "invalid_request", reason: "fare_is_driver_pay" });
    const after = await adminView(tripId);
    expect(after.version).toBe(before.version);
    expect(after.fare).toEqual(before.fare);
    expect(after.status).toBe("rider_onboard");
  });

  it("admin complete with driverPay: the rider pays the normal price; the change is from the pay the completion works out; a trip ends once (M14)", async () => {
    const { tripId, version } = await accepted();
    const { version: v } = await toBoard(tripId, version, 60);
    await step(tripId, "start", v);
    const fareBefore = (await riderView(tripId)).fare;
    const done = await adminPost(`/trips/${tripId}/complete`, { expectedVersion: v + 1, note: "Driver app froze", driverPay: SEK(10000) });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ status: "completed", paymentStatus: "captured" });
    expect(done.json().fare).toEqual(fareBefore);
    expect(done.json().fareLines.map((l: { code: string }) => l.code)).not.toContain("adjustment");
    expect(payOf(done.json())).toBe(10000);
    const normal = 10000 - done.json().driverAdjustments.amountMinor;
    const paid = await entries(tripId);
    expect(paid.filter((e) => e.kind === "adjustment").map((e) => Number(e.amount_minor))).toEqual([10000 - normal]);
    expect((await call(app, "GET", `/trips/${tripId}/receipt`, rider)).json().total).toEqual(fareBefore);
    // M14: a second end is refused and credits nothing again.
    const again = await adminPost(`/trips/${tripId}/complete`, { expectedVersion: done.json().version, note: "again", driverPay: SEK(12000) });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "invalid_transition" });
    expect(await entries(tripId)).toEqual(paid);
  });

  it("a reassigned trip does not carry the old driver's pay change to the next driver", async () => {
    const { tripId, version } = await accepted();
    await step(tripId, "head-to-pickup", version);
    const v = version + 1;
    const payBefore = payOf(await adminView(tripId));
    const changed = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: v, driverPay: SEK(payBefore + 1500), reason: "Far pickup" });
    expect(changed.statusCode, changed.body).toBe(200);
    const back = await adminPost(`/trips/${tripId}/reassign`, { expectedVersion: changed.json().version, reasonCode: "admin_driver_request", note: "Driver stuck" });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().driverAdjustments).toBeUndefined();
    const row = await database.db.selectFrom("trips").select("driver_adjustments_minor").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(Number(row.driver_adjustments_minor)).toBe(0);
  });
});

/* Supervisor NO-GO 2026-11-13 (audits/impact/j6-driverpay-supervisor.md) + owner decision 2026-11-13: a trip that ends
 * without a paid ride follows only the cancel-fee rules; the admin's change never reaches the next driver; the pay
 * never goes below 0. */
describe("J6 round 2: the admin's change is cleared or capped where the money says so", () => {
  beforeEach(clearFees);
  const SEK = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
  const payOf = (p: { driverTotal?: { amountMinor: number }; tip?: { amount?: { amountMinor: number } } }) => (p.driverTotal?.amountMinor ?? 0) - (p.tip?.amount?.amountMinor ?? 0);
  const adjustedRow = (tripId: string) => database.db.selectFrom("trips").select(["driver_adjustments_minor", "version"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  /** An accepted trip whose driver pay the admin raised by 15 kr. */
  async function raised() {
    const { tripId, version } = await accepted();
    const before = payOf(await adminView(tripId));
    const res = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: version, driverPay: SEK(before + 1500), reason: "Far pickup" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().driverAdjustments).toEqual(SEK(1500));
    return { tripId, version: res.json().version as number };
  }

  it("must-fix 1: a booked ride given back to the list (admin reassign of a held booked ride) clears the old driver's change", async () => {
    const { tripId, version } = await raised();
    await database.db.updateTable("trips").set({ kind: "scheduled" }).where("trip_id", "=", tripId).execute();
    const back = await adminPost(`/trips/${tripId}/reassign`, { expectedVersion: version, reasonCode: "admin_operational", note: "Driver sick" });
    expect(back.statusCode, back.body).toBe(200);
    expect(Number((await adjustedRow(tripId)).driver_adjustments_minor)).toBe(0);
    expect((await adminView(tripId)).driverAdjustments).toBeUndefined();
  });

  it("must-fix 2: rider cancel and admin cancel after the change: no change on the row, nothing shown, no adjustment entry", async () => {
    const r = await raised();
    const cancelled = await call(app, "POST", `/trips/${r.tripId}/cancel`, rider, { expectedVersion: r.version, reasonCode: "plans_changed" });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(Number((await adjustedRow(r.tripId)).driver_adjustments_minor)).toBe(0);
    const viewR = await adminView(r.tripId);
    expect(viewR.driverAdjustments).toBeUndefined();
    expect((viewR.earningsBreakdown ?? []).map((l: { code: string }) => l.code)).not.toContain("adjustment");
    expect((await entries(r.tripId)).filter((e) => e.kind === "adjustment")).toEqual([]);

    const a = await raised();
    const byAdmin = await adminPost(`/trips/${a.tripId}/cancel`, { expectedVersion: a.version, reasonCode: "admin_operational", note: "Road closed" });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect(Number((await adjustedRow(a.tripId)).driver_adjustments_minor)).toBe(0);
    expect(byAdmin.json().driverAdjustments).toBeUndefined();
    expect(byAdmin.json().moneySplit.driverTotal).toEqual(byAdmin.json().driverTotal);
  });

  it("must-fix 2: a no-show after the change pays only the fee share; a later driver-pay starts from it", async () => {
    const { tripId, version } = await raised();
    await step(tripId, "head-to-pickup", version);
    await step(tripId, "arrive", version + 1);
    await advance(5 * 60);
    const noShow = await step(tripId, "no-show", version + 2);
    expect(noShow.statusCode, noShow.body).toBe(200);
    expect(Number((await adjustedRow(tripId)).driver_adjustments_minor)).toBe(0);
    const view = await adminView(tripId);
    const share = (await entries(tripId)).find((e) => e.kind === "fee_share");
    expect(view.driverAdjustments).toBeUndefined();
    expect(view.driverTotal).toEqual(SEK(Number(share?.amount_minor)));
    expect((await entries(tripId)).filter((e) => e.kind === "adjustment")).toEqual([]);
  });

  it("must-fix 3: a kept negative change is capped at the paid end so the pay is never below 0 (row and entry)", async () => {
    const { tripId, version } = await accepted();
    const { version: v } = await toBoard(tripId, version, 60);
    await step(tripId, "start", v);
    const down = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: v + 1, driverPay: SEK(0), reason: "Driver went the wrong way" });
    expect(down.statusCode, down.body).toBe(200);
    expect(payOf(down.json())).toBe(0);
    // The rider ends at once: the driven price is far below the booked one, so the pay without the change shrinks.
    const ended = await call(app, "POST", `/trips/${tripId}/end-early`, rider, { expectedVersion: down.json().version, reasonCode: "something_else" });
    expect(ended.statusCode, ended.body).toBe(200);
    const view = await adminView(tripId);
    expect(payOf(view)).toBe(0);
    const paid = await entries(tripId);
    const earned = paid.filter((e) => e.kind !== "adjustment").reduce((s, e) => s + Number(e.amount_minor), 0);
    const adjustment = paid.filter((e) => e.kind === "adjustment").reduce((s, e) => s + Number(e.amount_minor), 0);
    expect(earned + adjustment).toBe(0);
    expect(Number((await adjustedRow(tripId)).driver_adjustments_minor)).toBe(adjustment);
  });

  it("should-fix: admin complete with driverPay on a trip with no driver is refused with 400 driver_pay_no_driver", async () => {
    const { tripId } = await book();
    const trip = await adminView(tripId);
    const res = await adminPost(`/trips/${tripId}/complete`, { expectedVersion: trip.version, note: "x", driverPay: SEK(1000) });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ reason: "driver_pay_no_driver" });
  });

  it("should-fix: an approval filed before J6 that carries fare is refused when approved (400) and stays pending; nothing written", async () => {
    const { tripId, version } = await accepted();
    const filer = await adminSession(app, database.db, "dispatcher", { now: clock.now });
    const pending = await database.db.transaction().execute((trx) =>
      fileApproval(trx, { actor: "admin", subjectId: filer.adminId, sessionId: "test", zones: ["Z001"], role: "dispatcher" }, { action: "trip.adjust", targetType: "trip", targetId: tripId, zoneId: "Z001", payload: { tripId, expectedVersion: version, fare: SEK(10000), reason: "old admin" }, approvePermission: "approval.decide" }, clock.now),
    );
    const res = await adminPost(`/approvals/${pending.approvalId}/approve`, {});
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ reason: "fare_is_driver_pay" });
    const row = await database.db.selectFrom("approvals").select("status").where("approval_id", "=", pending.approvalId).executeTakeFirstOrThrow();
    expect(row.status).toBe("pending_approval");
    expect((await adjustedRow(tripId)).version).toBe(version);
  });
});
