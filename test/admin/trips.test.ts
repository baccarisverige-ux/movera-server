import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { haversineKm } from "../../src/maps/routing.js";
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

const step = async (tripId: string, path: string, version: number, body: Record<string, unknown> = {}, who = drivers.A.headers) => call(app, "POST", `/trips/${tripId}/${path}`, who, { expectedVersion: version, ...body });
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

const adminPost = (path: string, body: Record<string, unknown>, who = admin) => call(app, "POST", `/admin${path}`, who, body);
const adminView = async (tripId: string) => (await call(app, "GET", `/admin/trips/${tripId}`, admin)).json();
const audits = async (tripId: string) => (await call(app, "GET", `/admin/audit?targetId=${tripId}`, admin)).json().items.map((a: { action: string }) => a.action);
const clearFees = async () => {
  await database.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
  await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_source_trip_id: null, wallet_minor: 0 }).execute();
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

  it("no-show by an admin can waive the fee; complete by an admin can set the fare", async () => {
    const first = await accepted();
    const ns = await adminPost(`/trips/${first.tripId}/no-show`, { expectedVersion: first.version, note: "Rider never came", waiveFee: true });
    expect(ns.json()).toMatchObject({ status: "no_show", cancellation: { actor: "admin", fee: null } });
    const second = await accepted();
    const { version: v } = await toBoard(second.tripId, second.version, 60);
    await step(second.tripId, "start", v);
    const done = await adminPost(`/trips/${second.tripId}/complete`, { expectedVersion: v + 1, note: "Driver app froze", fare: { amountMinor: 20000, currency: "SEK" } });
    expect(done.json()).toMatchObject({ status: "completed", fare: { amountMinor: 20000 }, paymentStatus: "captured" });
    expect(done.json().fareLines).toEqual(expect.arrayContaining([{ code: "adjustment", amount: { amountMinor: -1700, currency: "SEK" } }]));
    // The driver keeps their share of the fare: 157.60 × 200 / 217.
    expect(done.json().driverEarnings.amountMinor).toBe(Math.round((15760 * 20000) / 21700));
  });

  it("adjust: waiting on a running trip; a paid trip needs a refund; waiving an owed fee keeps the driver's share", async () => {
    const { tripId, version } = await accepted();
    const { version: v } = await toBoard(tripId, version, 60);
    const adj = await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: v, waitingSeconds: 120, reason: "Rider was late" });
    expect(adj.statusCode).toBe(200);
    expect(adj.json()).toMatchObject({ fare: { amountMinor: 24400 }, waiting: { chargedSeconds: 120 } });
    await step(tripId, "start", v + 1);
    const done = await step(tripId, "complete", v + 2);
    expect((await adminPost(`/trips/${tripId}/adjust`, { expectedVersion: done.json().version, fare: { amountMinor: 10000, currency: "SEK" }, reason: "x" })).json()).toMatchObject({ reason: "use_refund" });

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

  it("a non-super admin's refund waits for a second admin; a dispatcher cannot refund", async () => {
    const { tripId, version } = await completedTrip();
    expect((await adminPost(`/trips/${tripId}/refund`, { expectedVersion: version, amount: { amountMinor: 1000, currency: "SEK" }, reason: "x" }, dispatcher)).statusCode).toBe(403);
    const pending = await adminPost(`/trips/${tripId}/refund`, { expectedVersion: version, amount: { amountMinor: 1000, currency: "SEK" }, reason: "Late driver" }, finance);
    expect(pending.statusCode).toBe(202);
    expect(await database.db.selectFrom("refunds").selectAll().where("trip_id", "=", tripId).execute()).toEqual([]);
    const approved = await adminPost(`/approvals/${pending.json().approvalId}/approve`, {});
    expect(approved.statusCode).toBe(200);
    expect((await database.db.selectFrom("refunds").select("amount_minor").where("trip_id", "=", tripId).execute())).toEqual([{ amount_minor: "1000" }]);
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
    expect(await audits(riderId)).toEqual(["rider.status", "rider.status"]);
  });
});
