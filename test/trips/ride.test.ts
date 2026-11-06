import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { driverPerformance } from "../../src/drivers/performance.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { driverCancelReasonsOf, rideHandlers, takeBackNotHeading } from "../../src/trips/ride.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

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

describe("the ride", () => {
  it("pickup to drop-off: the waiting after 5 free minutes is charged, the driver's in full; cash; both rate", async () => {
    const { tripId, version } = await accepted();
    const { version: v, boarded } = await toBoard(tripId, version, 7 * 60);
    // 120 s × 12.26 kr/min = 24.52 kr; (197 + 24.52) × 1.10 = 243.67 → 244 kr.
    expect(boarded.waiting.chargedSeconds).toBe(120);
    expect(boarded.fare).toEqual({ amountMinor: 24400, currency: "SEK" });
    expect(boarded.fareLines).toEqual(expect.arrayContaining([{ code: "waiting", amount: { amountMinor: 2452, currency: "SEK" } }]));
    // No commission on waiting: 197 × 0.8 + 24.52 = 182.12 kr.
    expect(boarded.driverEarnings).toEqual({ amountMinor: 18212, currency: "SEK" });
    expect((await riderView(tripId)).fare.amountMinor).toBe(24400);
    expect(await riderView(tripId)).not.toHaveProperty("driverEarnings");

    expect((await step(tripId, "start", v)).json().status).toBe("in_trip");
    // Close to the drop-off: "Almost there".
    await advance(60);
    await moveTo("A", { lat: SODERMALM.lat + 0.002, lng: SODERMALM.lng });
    await worker.runDue();
    const near = await riderView(tripId);
    expect(near.status).toBe("approaching_dropoff");

    const done = await step(tripId, "complete", near.version, { cashCollected: { amountMinor: 24400, currency: "SEK" } });
    expect(done.json()).toMatchObject({ status: "completed", paymentStatus: "captured", ratingStatus: "pending" });
    expect((await driverRow("A")).online_status).toBe("online");
    expect(await entries(tripId)).toEqual([{ kind: "trip", amount_minor: "18212", gross_minor: "24400", commission_minor: "6188", cash_minor: "24400" }]);

    const riderRates = await call(app, "POST", `/trips/${tripId}/rating`, rider, { stars: 5, tags: ["clean_car"] });
    expect(riderRates.statusCode).toBe(201);
    expect(riderRates.json()).toEqual({ tripId, from: "rider", stars: 5, tags: ["clean_car"] });
    expect((await call(app, "POST", `/trips/${tripId}/rating`, rider, { stars: 4 })).json()).toMatchObject({ code: "invalid_transition", reason: "already_rated" });
    expect((await call(app, "POST", `/trips/${tripId}/rating`, drivers.A.headers, { skip: true })).statusCode).toBe(204);
    expect((await riderView(tripId)).ratingStatus).toBe("submitted");
    expect((await call(app, "GET", `/trips/${tripId}`, drivers.A.headers)).json().ratingStatus).toBe("skipped");
    expect((await driverRow("A")).rating_count).toBe(1);
    const kinds = await database.db.selectFrom("trip_events").select("kind").where("trip_id", "=", tripId).orderBy("sequence").execute();
    expect(kinds.filter((k) => k.kind === "rating_updated")).toHaveLength(2);

    const report = (await call(app, "GET", "/driver/earnings?period=day", drivers.A.headers)).json();
    expect(report).toMatchObject({ driverId: drivers.A.id, period: "day", timeZone: "Europe/Stockholm" });
    const today = report.periods.at(-1);
    expect(today).toMatchObject({ tripCount: 1, gross: { amountMinor: 24400 }, commission: { amountMinor: 6188 }, cashCollected: { amountMinor: 24400 }, net: { amountMinor: 18212 } });
  });

  it("no wait charge when the rider boards inside the free minutes; the fare stays the quote's", async () => {
    const { tripId, version, quote } = await accepted();
    const { boarded } = await toBoard(tripId, version, 4 * 60);
    expect(boarded.waiting.chargedSeconds).toBe(0);
    expect(boarded.fare).toEqual(quote.total);
  });

  it("steps out of order, a stale version or another driver's trip are refused", async () => {
    const { tripId, version } = await accepted();
    expect((await step(tripId, "arrive", version)).json()).toMatchObject({ code: "invalid_transition" });
    expect((await step(tripId, "head-to-pickup", version + 5)).json()).toMatchObject({ code: "version_mismatch" });
    expect((await step(tripId, "head-to-pickup", version, {}, drivers.B.headers)).statusCode).toBe(404);
    expect((await step(tripId, "complete", version)).json()).toMatchObject({ code: "invalid_transition" });
    // A rider cannot drive the trip.
    expect((await step(tripId, "head-to-pickup", version, {}, rider)).statusCode).toBe(403);
    // "Online" while on a trip does not make the driver free for new offers.
    const me = (await call(app, "GET", "/driver/profile", drivers.A.headers)).json();
    await call(app, "POST", "/driver/availability", drivers.A.headers, { expectedVersion: me.version, onlineStatus: "online", location: { ...SPOTS.A, accuracy: 5, measuredAt: clock.now.toISOString() } });
    expect((await driverRow("A")).online_status).toBe("on_trip");
  });
});

describe("no-show and unpaid fees", () => {
  it("no-show only after the wait; the fee is owed, the driver gets 80 % at once, the next ride carries it and clears it", async () => {
    const { tripId, version } = await accepted();
    await step(tripId, "head-to-pickup", version);
    await step(tripId, "arrive", version + 1);
    await advance(4 * 60);
    expect((await step(tripId, "no-show", version + 2)).json()).toMatchObject({ code: "invalid_transition", reason: "no_show_too_early" });
    await advance(60);
    const noShow = await step(tripId, "no-show", version + 2, { reasonCode: "rider_no_show" });
    expect(noShow.json()).toMatchObject({
      status: "no_show",
      fare: { amountMinor: 6500 },
      driverEarnings: { amountMinor: 5200 },
      cancellation: { actor: "driver", reasonCode: "rider_no_show", fee: { amountMinor: 6500, currency: "SEK" }, feeStatus: "owed" },
    });
    expect((await driverRow("A")).online_status).toBe("online");
    expect(await entries(tripId)).toEqual([{ kind: "fee_share", amount_minor: "5200", gross_minor: null, commission_minor: null, cash_minor: null }]);
    expect((await call(app, "GET", "/rider/profile", rider)).json().outstanding).toEqual({ amountMinor: 6500, currency: "SEK" });

    // The next ride carries the 65 kr; the driver collects it but it is not their money.
    const next = await accepted();
    expect(next.quote.total.amountMinor).toBe(21700 + 6500);
    expect(next.quote.fareLines).toEqual(expect.arrayContaining([{ code: "outstanding_fee", amount: { amountMinor: 6500, currency: "SEK" }, sourceTripId: tripId }]));
    const { version: v } = await toBoard(next.tripId, next.version, 60);
    await step(next.tripId, "start", v);
    const done = await step(next.tripId, "complete", v + 1);
    expect(done.json()).toMatchObject({ status: "completed", fare: { amountMinor: 28200 }, driverEarnings: { amountMinor: 15760 } });
    expect(await entries(next.tripId)).toEqual([{ kind: "trip", amount_minor: "15760", gross_minor: "21700", commission_minor: "5940", cash_minor: "28200" }]);
    expect((await call(app, "GET", "/rider/profile", rider)).json().outstanding).toBeNull();
    expect((await riderView(tripId)).cancellation.feeStatus).toBe("paid");
  });

  it("a trip that carried the fee but did not complete leaves it owed", async () => {
    await database.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
    await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_source_trip_id: null }).execute();
    const first = await accepted();
    await step(first.tripId, "head-to-pickup", first.version);
    await step(first.tripId, "arrive", first.version + 1);
    await advance(5 * 60);
    await step(first.tripId, "no-show", first.version + 2);
    const next = await book();
    expect(next.quote.total.amountMinor).toBe(21700 + 6500);
    const trip = await riderView(next.tripId);
    await call(app, "POST", `/trips/${next.tripId}/cancel`, rider, { expectedVersion: trip.version, reasonCode: "plans_changed" });
    expect((await call(app, "GET", "/rider/profile", rider)).json().outstanding).toEqual({ amountMinor: 6500, currency: "SEK" });
    await database.db.updateTable("rider_fees").set({ status: "waived" }).execute();
    await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_source_trip_id: null }).execute();
  });
});

describe("the rider's cancel after accept", () => {
  beforeEach(async () => {
    await database.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
    await database.db.updateTable("riders").set({ outstanding_minor: 0, outstanding_source_trip_id: null }).execute();
  });
  const cancel = async (tripId: string) => {
    const trip = await riderView(tripId);
    return call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: trip.version, reasonCode: "plans_changed" });
  };

  it("free inside the 2 minutes; the driver is free again", async () => {
    const { tripId } = await accepted();
    await advance(90);
    const res = await cancel(tripId);
    expect(res.json()).toMatchObject({ status: "cancelled_by_rider", cancellation: { fee: null } });
    expect(res.json().cancellation).not.toHaveProperty("feeStatus");
    expect((await driverRow("A")).online_status).toBe("online");
  });

  it("after 2 minutes with the driver on the way: 35 kr owed, all of it to the driver", async () => {
    const { tripId } = await accepted();
    await advance(150);
    await moveTo("A", NORRMALM);
    const res = await cancel(tripId);
    expect(res.json()).toMatchObject({ status: "cancelled_by_rider", fare: { amountMinor: 3500 }, cancellation: { fee: { amountMinor: 3500, currency: "SEK" }, feeStatus: "owed" } });
    expect(await entries(tripId)).toEqual([{ kind: "fee_share", amount_minor: "3500", gross_minor: null, commission_minor: null, cash_minor: null }]);
    expect((await call(app, "GET", "/rider/profile", rider)).json().outstanding).toEqual({ amountMinor: 3500, currency: "SEK" });
  });

  it("v0.18.35 (owner Q-A): standing still for 2 minutes → free cancel and a 'not driving to the rider' notice every minute; a LIVE trip is never taken back, even with reassign on in an old admin document", async () => {
    // The admin panel published reassign: true until v0.18.35; the server must ignore it for live trips.
    const old = JSON.stringify({ ...sample("driver_app_config"), headingCheck: { on: true, headingPct: 80, notHeadingMinutes: 2, reassign: true } });
    await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
    await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: old, published_at: clock.now, published_by: null }).execute();
    try {
    const { tripId } = await accepted();
    // The server's check runs with every 30 s ETA tick; a car that does not move is not heading to the pickup.
    // 2 km away (not within the arrive radius, which counts as heading).
    const FAR = { lat: SPOTS.A.lat + 0.018, lng: SPOTS.A.lng };
    for (let i = 0; i < 10; i++) {
      await moveTo("A", FAR);
      await advance(30);
    }
    const seen = await riderView(tripId);
    expect(seen.status).toBe("accepted");
    expect(seen.driverId).toBe(drivers.A.id);
    expect(seen.headingCheck).toMatchObject({ heading: false, freeCancel: true });
    const counted = await database.db.selectFrom("driver_cancels").select("reason_code").where("trip_id", "=", tripId).where("driver_id", "=", drivers.A.id).execute();
    expect(counted).toEqual([]);
    // Owner job-4 Q4 "On every minutes": not heading since ~30 s, free (notice) from ~150 s, then every 60 s until 300 s.
    const notices = await database.db.selectFrom("notifications").select("kind").where("subject_id", "=", drivers.A.id).where("trip_id", "=", tripId).where("kind", "=", "heading_not_to_rider").execute();
    expect(notices.length).toBeGreaterThanOrEqual(2);
    expect(notices.length).toBeLessThanOrEqual(3);
    expect((await cancel(tripId)).json().cancellation.fee).toBeNull();
    } finally {
      await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").execute();
    }
  });

  it("v0.18.35: the old live take-back stays (rule 21, never deleted) but nothing calls it; called directly it still works", async () => {
    const { tripId } = await accepted();
    await database.db.transaction().execute(async (trx) => {
      const trip = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).forUpdate().executeTakeFirstOrThrow();
      await takeBackNotHeading(trx, trip, clock.now);
      await takeBackNotHeading(trx, { ...trip, driver_id: null }, clock.now);
    });
    const counted = await database.db.selectFrom("driver_cancels").select("reason_code").where("trip_id", "=", tripId).execute();
    expect(counted.map((r) => r.reason_code)).toEqual(["not_heading_to_pickup"]);
  });

  it("v0.18.35: notice off in the zone → no 'not driving to the rider' notice, the trip stays his", async () => {
    const off = JSON.stringify({ ...sample("driver_app_config"), headingCheck: { on: true, headingPct: 80, notHeadingMinutes: 2, reassign: false, notice: false } });
    await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
    await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: off, published_at: clock.now, published_by: null }).execute();
    try {
      const { tripId } = await accepted();
      const FAR = { lat: SPOTS.A.lat + 0.018, lng: SPOTS.A.lng };
      for (let i = 0; i < 8; i++) {
        await moveTo("A", FAR);
        await advance(30);
      }
      expect((await riderView(tripId)).driverId).toBe(drivers.A.id);
      expect(await database.db.selectFrom("notifications").select("kind").where("trip_id", "=", tripId).where("kind", "=", "heading_not_to_rider").execute()).toEqual([]);
    } finally {
      await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").execute();
    }
  });

  it("checker 1: no heading check yet (a trip accepted before the deploy) → the normal fee rules, not a free cancel", async () => {
    const { tripId } = await accepted();
    await advance(150);
    await moveTo("A", NORRMALM);
    await database.db.updateTable("trips").set({ heading_check: null }).where("trip_id", "=", tripId).execute();
    const res = await cancel(tripId);
    expect(res.json().cancellation.fee).toEqual({ amountMinor: 3500, currency: "SEK" });
  });

  it("no rider settings published: 65 kr after 2 minutes; an admin share setting applies", async () => {
    await database.db.deleteFrom("config_live").where("doc", "=", "rider_app_config").execute();
    await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify({ cancelFees: { driverSharePct: 60 } }), published_at: clock.now, published_by: null }).execute();
    try {
      const { tripId } = await accepted();
      await advance(150);
      await moveTo("A", NORRMALM);
      const res = await cancel(tripId);
      expect(res.json()).toMatchObject({ fare: { amountMinor: 6500 }, cancellation: { fee: { amountMinor: 6500 } } });
      expect(await entries(tripId)).toEqual([{ kind: "fee_share", amount_minor: "3900", gross_minor: null, commission_minor: null, cash_minor: null }]);
    } finally {
      await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").execute();
      await database.db.insertInto("config_live").values({ doc: "rider_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("rider_app_config")), published_at: clock.now, published_by: null }).execute();
    }
  });

  it("after 2 minutes but the driver keeps driving away from the pickup for 2 minutes: no fee (reassign off)", async () => {
    await database.db.updateTable("config_live").set({ document: JSON.stringify({ ...sample("driver_app_config"), headingCheck: { on: true, headingPct: 80, notHeadingMinutes: 2, reassign: false } }) }).where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
    const inserted = (await database.db.selectFrom("config_live").select("doc").where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute()).length === 0;
    if (inserted) await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify({ ...sample("driver_app_config"), headingCheck: { on: true, headingPct: 80, notHeadingMinutes: 2, reassign: false } }), published_at: clock.now, published_by: null }).execute();
    try {
      const { tripId } = await accepted();
      for (let i = 0; i < 6; i++) {
        await moveTo("A", { lat: SPOTS.A.lat + 0.002 * i, lng: SPOTS.A.lng + 0.002 * i });
        await advance(30);
      }
      const view = await riderView(tripId);
      expect(view.status).toBe("accepted");
      expect(view.headingCheck).toMatchObject({ heading: false, freeCancel: true });
      const res = await cancel(tripId);
      expect(res.json().cancellation.fee).toBeNull();
    } finally {
      await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").execute();
    }
  });

  it("the admin turns the heading check off during the pickup: the kept answer is cleared and the trip stays his", async () => {
    const { tripId } = await accepted();
    const FAR = { lat: SPOTS.A.lat + 0.018, lng: SPOTS.A.lng };
    await moveTo("A", FAR);
    await advance(30);
    expect((await database.db.selectFrom("trips").select("heading_check").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).heading_check).not.toBeNull();
    const off = JSON.stringify({ ...sample("driver_app_config"), headingCheck: { on: false, headingPct: 80, notHeadingMinutes: 2, reassign: true } });
    await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
    await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: off, published_at: clock.now, published_by: null }).execute();
    try {
      for (let i = 0; i < 6; i++) {
        await moveTo("A", FAR);
        await advance(30);
      }
      expect((await database.db.selectFrom("trips").select("heading_check").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).heading_check).toBeNull();
      const view = await riderView(tripId);
      expect(view.status).toBe("accepted");
      expect(view.driverId).toBe(drivers.A.id);
      expect(view.headingCheck ?? null).toBeNull();
    } finally {
      await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").execute();
    }
  });
});

describe("the driver's cancel", () => {
  it("before boarding: back to searching, offered to another driver, never to them again", async () => {
    const { tripId, version } = await accepted();
    await step(tripId, "head-to-pickup", version);
    const bad = await call(app, "POST", `/trips/${tripId}/cancel`, drivers.A.headers, { expectedVersion: version + 1, reasonCode: "safety_concern_on_trip" });
    expect(bad.json()).toMatchObject({ code: "invalid_request", reason: "invalid_reason_code" });
    const res = await call(app, "POST", `/trips/${tripId}/cancel`, drivers.A.headers, { expectedVersion: version + 1, reasonCode: "vehicle_issue_before_start" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("searching");
    await worker.runDue();
    const seen = await riderView(tripId);
    expect(seen.status).toBe("offered");
    expect(seen).not.toHaveProperty("driver");
    expect(seen.acceptedAt).toBeNull();
    expect((await call(app, "GET", "/driver/offers", drivers.B.headers)).json().items[0]?.tripId).toBe(tripId);
    expect((await driverRow("A")).online_status).toBe("online");
    for (let i = 0; i < 6; i++) await advance(15);
    const toA = await database.db.selectFrom("offers").select("offer_id").where("trip_id", "=", tripId).where("driver_id", "=", drivers.A.id).where("status", "!=", "claimed").execute();
    expect(toA).toEqual([]);
    expect(await database.db.selectFrom("driver_cancels").select(["reason_code", "from_status"]).where("trip_id", "=", tripId).execute()).toEqual([{ reason_code: "vehicle_issue_before_start", from_status: "driver_to_pickup" }]);
    // The trip is no longer A's.
    expect((await call(app, "GET", `/trips/${tripId}`, drivers.A.headers)).statusCode).toBe(404);
  });

  it("on board: the trip ends, the rider pays for what was driven", async () => {
    const { tripId, version } = await accepted();
    const { version: v } = await toBoard(tripId, version, 60);
    await step(tripId, "start", v);
    await advance(300);
    await moveTo("A", { lat: 59.3236, lng: 18.0692 });
    const res = await call(app, "POST", `/trips/${tripId}/cancel`, drivers.A.headers, { expectedVersion: v + 1, reasonCode: "vehicle_issue_on_trip" });
    expect(res.json()).toMatchObject({ status: "cancelled_by_driver", paymentStatus: "captured", cancellation: { actor: "driver", reasonCode: "vehicle_issue_on_trip" } });
    const fare = res.json().fare.amountMinor;
    expect(fare).toBeGreaterThanOrEqual(5400); // at least the minimum 49 kr + app fee
    expect(fare).toBeLessThan(21700);
    expect((await driverRow("A")).online_status).toBe("online");
  });
  // L-c (owner 2026-11-06 "Remove it (Safe)"): the driver app no longer says "Doesn't count" next to a reason. Every
  // give-back counts on the driver's record, whatever the reason: also the car, safety and accident reasons that
  // admin's Cancel reasons page can still mark "Doesn't count" (the server never reads that mark).
  const counted = async () => (await driverPerformance(database.db, drivers.A.id, clock.now)).tripsCancelled;
  for (const reasonCode of ["vehicle_issue_before_start", "unsafe_pickup"]) {
    it(`a give-back before boarding with ${reasonCode} counts on the driver's record`, async () => {
      const before = await counted();
      const { tripId, version } = await accepted();
      await step(tripId, "head-to-pickup", version);
      const res = await call(app, "POST", `/trips/${tripId}/cancel`, drivers.A.headers, { expectedVersion: version + 1, reasonCode });
      expect(res.statusCode).toBe(200);
      expect(await counted()).toBe(before + 1);
    });
  }
  for (const reasonCode of ["vehicle_issue_on_trip", "safety_concern_on_trip", "accident_or_road_emergency"]) {
    it(`a give-back on board with ${reasonCode} counts on the driver's record`, async () => {
      const before = await counted();
      const { tripId, version } = await accepted();
      const { version: v } = await toBoard(tripId, version, 60);
      await step(tripId, "start", v);
      await advance(60);
      const res = await call(app, "POST", `/trips/${tripId}/cancel`, drivers.A.headers, { expectedVersion: v + 1, reasonCode });
      expect(res.json().status).toBe("cancelled_by_driver");
      expect(await counted()).toBe(before + 1);
    });
  }
});

describe("the rider ends early", () => {
  it("pays the driven part, never more than booked, and may rate; the driver may not", async () => {
    const { tripId, version, quote } = await accepted();
    const { version: v } = await toBoard(tripId, version, 60);
    await step(tripId, "start", v);
    await advance(240);
    await moveTo("A", { lat: 59.3290, lng: 18.0670 });
    await advance(60);
    await moveTo("A", { lat: 59.3250, lng: 18.0690 });
    const before = await riderView(tripId);
    const res = await call(app, "POST", `/trips/${tripId}/end-early`, rider, { expectedVersion: before.version });
    expect(res.statusCode).toBe(200);
    const ended = res.json();
    expect(ended).toMatchObject({ status: "cancelled_by_rider", ratingStatus: "pending", paymentStatus: "captured", cancellation: { actor: "rider", reasonCode: "something_else" } });
    expect(ended.fare.amountMinor).toBeLessThanOrEqual(quote.total.amountMinor);
    expect(ended.fareLines.map((l: { code: string }) => l.code)).toEqual(expect.arrayContaining(["base", "distance", "time", "app_fee"]));
    expect((await call(app, "POST", `/trips/${tripId}/rating`, rider, { stars: 3 })).statusCode).toBe(201);
    // v0.18.10 (owner G8 Q1): after the rider's early end the driver rates too.
    expect((await call(app, "POST", `/trips/${tripId}/rating`, drivers.A.headers, { stars: 3 })).statusCode).toBe(201);
    // End early is only on board.
    await advance(1);
    const other = await accepted();
    expect((await call(app, "POST", `/trips/${other.tripId}/end-early`, rider, { expectedVersion: other.version })).json()).toMatchObject({ code: "invalid_transition" });
  });

  it("a plain cancel is never rated, with or without a tip (v0.18.10: tips exist, contract.json#finish.tips)", async () => {
    const { tripId } = await book();
    const trip = await riderView(tripId);
    await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: trip.version, reasonCode: "plans_changed" });
    expect((await call(app, "POST", `/trips/${tripId}/rating`, rider, { stars: 5 })).json()).toMatchObject({ code: "invalid_transition" });
    expect((await call(app, "POST", `/trips/${tripId}/rating`, rider, { stars: 5, tip: { amountMinor: 2000, currency: "SEK" } })).json()).toMatchObject({ reason: "rating_not_allowed" });
  });
});

/* ---------------------------------------------------------------- live clean-up 1 (contract v0.18.13) */

const pushes = async (tripId: string) =>
  (await database.db.selectFrom("notifications").select(["data", "title", "bell", "audience"]).where("trip_id", "=", tripId).where("kind", "=", "trip_update").orderBy("created_at").orderBy("notification_id").execute())
    .map((r) => (r.data as { moment: string }).moment);

describe("v0.18.13 rider pushes for the trip moments (G13, contract.json#riderTripPush)", () => {
  it("driver found, almost there, arrived — push only, in the rider's language; nothing for the rider's own cancel", async () => {
    await database.db.updateTable("riders").set({ language: "fr", consents: JSON.stringify({}) }).execute();
    const { tripId, version } = await accepted();
    await step(tripId, "head-to-pickup", version);
    await moveTo("A", NORRMALM);
    await advance(30);
    await advance(30);
    await step(tripId, "arrive", version + 1);
    expect(await pushes(tripId)).toEqual(["driver_found", "driver_arriving", "driver_arrived"]);
    const rows = await database.db.selectFrom("notifications").select(["title", "bell", "audience", "body"]).where("trip_id", "=", tripId).where("kind", "=", "trip_update").orderBy("created_at").execute();
    expect(rows[0]).toMatchObject({ title: "Chauffeur trouvé", bell: true, audience: "rider", body: "Driver A est en route vers vous." });
    const trip = await riderView(tripId);
    await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: trip.version, reasonCode: "plans_changed" });
    expect(await pushes(tripId)).toEqual(["driver_found", "driver_arriving", "driver_arrived"]);
    await database.db.updateTable("rider_fees").set({ status: "waived" }).where("status", "=", "owed").execute();
    await database.db.updateTable("riders").set({ language: null, outstanding_minor: 0, outstanding_source_trip_id: null }).execute();
  });

  it("the driver cancels: 'finding you a new driver' (Swedish); an admin cancel: trip cancelled", async () => {
    await database.db.updateTable("riders").set({ language: "sv" }).execute();
    const { tripId, version } = await accepted();
    await call(app, "POST", `/trips/${tripId}/cancel`, drivers.A.headers, { expectedVersion: version, reasonCode: "vehicle_issue_before_start" });
    expect((await pushes(tripId)).sort()).toEqual(["driver_changed", "driver_found"]);
    const titles = (await database.db.selectFrom("notifications").select("title").where("trip_id", "=", tripId).where("kind", "=", "trip_update").execute()).map((r) => r.title).sort();
    expect(titles).toEqual(["Förare hittad", "Vi söker en ny förare"]);
    await database.db.updateTable("riders").set({ language: null }).execute();
  });

  it("owner G13: rideUpdates off stops only 'driver found' and 'arriving'; 'driver arrived' is always sent (fail-before: none)", async () => {
    await database.db.updateTable("riders").set({ consents: JSON.stringify({ rideUpdates: false }) }).execute();
    try {
      const { tripId, version } = await accepted();
      await step(tripId, "head-to-pickup", version);
      await moveTo("A", NORRMALM);
      await step(tripId, "arrive", version + 1);
      const sent = await database.db.selectFrom("notifications").select("data").where("trip_id", "=", tripId).where("kind", "=", "trip_update").execute();
      expect(sent.map((r) => (r.data as { moment: string }).moment)).toEqual(["driver_arrived"]);
    } finally {
      await database.db.updateTable("riders").set({ consents: JSON.stringify({}) }).execute();
    }
  });
});

describe("v0.18.13 driving-time limits on the server (decisions/driving-time-limits.md)", () => {
  /** A finished trip of driver A: `toPickup` minutes to the pickup, 10 waiting (never counted), `onTrip` on board. */
  async function drove(toPickup: number, onTrip: number, endedMinutesAgo = 0) {
    const end = new Date(clock.now.getTime() - endedMinutesAgo * 60_000);
    const boarded = new Date(end.getTime() - onTrip * 60_000);
    const arrived = new Date(boarded.getTime() - 10 * 60_000);
    const accepted = new Date(arrived.getTime() - toPickup * 60_000);
    const { tripId } = await book();
    await database.db.updateTable("trips").set({ status: "completed", driver_id: drivers.A.id, accepted_at: accepted, arrived_at: arrived, boarded_at: boarded, ended_at: end, updated_at: end }).where("trip_id", "=", tripId).execute();
    await database.db.deleteFrom("offers").where("trip_id", "=", tripId).execute();
  }
  const goOnline = async () => {
    const me = (await call(app, "GET", "/driver/profile", drivers.A.headers)).json();
    return call(app, "POST", "/driver/availability", drivers.A.headers, { expectedVersion: me.version, onlineStatus: "online" });
  };
  const goOffline = async () => {
    const me = (await call(app, "GET", "/driver/profile", drivers.A.headers)).json();
    return call(app, "POST", "/driver/availability", drivers.A.headers, { expectedVersion: me.version, onlineStatus: "offline" });
  };

  it("counts driving to pickup + on trip only (not waiting); at 12 h: no offers and going online is refused; 6 h offline resets", async () => {
    // Only this test's driving counts (the file's earlier trips of A are taken out of his history).
    await database.db.updateTable("trips").set({ accepted_at: null, boarded_at: null }).where("driver_id", "=", drivers.A.id).execute();
    await moveTo("A", SPOTS.A);
    await goOffline();
    // 11 h 50 min of counted driving (lots of waiting in between does not count), ended an hour ago.
    await drove(60, 650, 60);
    let me = (await call(app, "GET", "/driver/profile", drivers.A.headers)).json();
    expect(me.drivingTime).toMatchObject({ drivenMinutes: 710, maxMinutes: 720, reached: false, resetAfterOfflineHours: 6 });
    await drove(5, 10, 5);
    me = (await call(app, "GET", "/driver/profile", drivers.A.headers)).json();
    expect(me.drivingTime).toMatchObject({ drivenMinutes: 725, reached: true });
    await moveTo("A", SPOTS.A);
    const refused = await goOnline();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "conflict", reason: "driving_limit_reached" });
    // Online anyway (an old app): dispatch does not offer him trips.
    await database.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", drivers.A.id).execute();
    await moveTo("A", SPOTS.A);
    await moveTo("B", SPOTS.B);
    const { tripId } = await book();
    expect((await call(app, "GET", "/driver/offers", drivers.A.headers)).json().items.map((o: { tripId: string }) => o.tripId)).not.toContain(tripId);
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", tripId).execute();
    // 6 hours offline in a row: the counter starts again.
    await goOffline();
    clock.now = new Date(clock.now.getTime() + 6 * 3600_000 + 60_000);
    drivers.A.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    await moveTo("A", SPOTS.A);
    const back = await goOnline();
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().drivingTime).toMatchObject({ drivenMinutes: 0, reached: false });
  });
});

describe("v0.18.13 driver cancel reasons from the admin (G5-9)", () => {
  it("the admin list is what the app shows; the server takes every contract code (old apps)", async () => {
    const doc = { ...sample("driver_app_config"), cancelReasons: { driverBeforeTrip: ["rider_requested_cancel", "unsafe_pickup"] } };
    await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").execute();
    await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(doc), published_at: clock.now, published_by: null }).execute();
    try {
      const { tripId, version } = await accepted();
      // Checker 3: an old app shows the built-in list; a contract code the admin turned off is still taken.
      expect((await driverCancelReasonsOf(database.db, "Z001")).driverBeforeTrip).toEqual(["rider_requested_cancel", "unsafe_pickup"]);
      const bad = await call(app, "POST", `/trips/${tripId}/cancel`, drivers.A.headers, { expectedVersion: version, reasonCode: "safety_concern_on_trip" });
      expect(bad.json()).toMatchObject({ code: "invalid_request", reason: "invalid_reason_code" });
      const old = await call(app, "POST", `/trips/${tripId}/cancel`, drivers.A.headers, { expectedVersion: version, reasonCode: "vehicle_issue_before_start" });
      expect(old.statusCode, old.body).toBe(200);
    } finally {
      await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").execute();
    }
  });
});
