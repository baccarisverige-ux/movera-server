import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../src/ids.js";
import { driverPerformance } from "../../src/drivers/performance.js";
import { missedInRow } from "../../src/dispatch/autoOffline.js";
import { zoneDriverFacts } from "../../src/dispatch/driverFacts.js";
import { drivingLimitReached } from "../../src/drivers/drivingTime.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { adminSession } from "../support/admin.js";
import { testWorld } from "../support/world.js";

/**
 * Contract v0.18.21 §45 (contract.json#dispatchDriverFacts, owner 2026-11-04 "real driver facts"): the admin Dispatch
 * page reads each online driver's real facts; what the server does not track is null, never made up.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-04T10:00:00Z") };
let superAdmin: Record<string, string>;
let stockholmOnly: Record<string, string>;
const ids = { free: "", busy: "", offline: "", fr: "", rich: "" };
const NOT_YET = ["finishingInMin", "extras", "female", "skipsInRow", "favourite", "goingHome", "homeDirectionOk", "priorityUntilMin", "queuePos"];

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  const db = database.db;
  const min = (m: number) => new Date(clock.now.getTime() - m * 60_000);
  ids.free = await insertDriver(db);
  ids.busy = await insertDriver(db);
  ids.offline = await insertDriver(db);
  ids.fr = await insertDriver(db);
  await db.updateTable("drivers").set({ account_status: "active", zone_ids: ["Z001"], online_status: "online", online_since: min(120), last_free_at: min(7), category_ids: ["economy"] }).where("driver_id", "=", ids.free).execute();
  await db.updateTable("drivers").set({ account_status: "active", zone_ids: ["Z001"], online_status: "on_trip", online_since: min(60) }).where("driver_id", "=", ids.busy).execute();
  await db.updateTable("drivers").set({ zone_ids: ["Z001"], online_status: "offline" }).where("driver_id", "=", ids.offline).execute();
  await db.updateTable("drivers").set({ account_status: "active", zone_ids: ["FR-PC"], online_status: "online" }).where("driver_id", "=", ids.fr).execute();
  const rider = await insertRider(db);
  // One ride finished 20 min ago (counts this hour), one 2 h ago (does not).
  const recent = await insertTrip(db, rider, { status: "completed", driverId: ids.free });
  const old = await insertTrip(db, rider, { status: "completed", driverId: ids.free });
  await db.updateTable("trips").set({ ended_at: min(20) }).where("trip_id", "=", recent).execute();
  await db.updateTable("trips").set({ ended_at: min(120) }).where("trip_id", "=", old).execute();
  // Two Exclusive offers he let expire in a row after going online, and a declined one between them that is skipped
  // (owner 2026-11-16: only ignored offers count).
  for (const [n, status] of [[50, "expired"], [45, "declined"], [40, "expired"]] as const) {
    const tripId = await insertTrip(db, rider, { status: "cancelled_by_rider" });
    await db.insertInto("offers").values({ offer_id: newId("ofr"), trip_id: tripId, driver_id: ids.free, kind: "exclusive", status, round: 1, currency: "SEK", fare_minor: 25000, driver_earnings_minor: 20000, pickup_meters: 900, pickup_eta_seconds: 120, sent_at: min(n), expires_at: min(n), answered_at: min(n - 1), group_id: null, reason_code: null, decline_reason: null }).execute();
  }
  // A driver with enough offers, cancels and ratings for every minimum (the batched numbers must equal the per-driver ones).
  ids.rich = await insertDriver(db);
  await db.updateTable("drivers").set({ account_status: "active", zone_ids: ["Z001"], online_status: "online", online_since: min(600), last_free_at: min(3), rating_sum: 14, rating_count: 3 }).where("driver_id", "=", ids.rich).execute();
  for (let k = 0; k < 14; k += 1) {
    const tripId = await insertTrip(db, rider, { status: "cancelled_by_rider" });
    const status = k < 11 ? "claimed" : "declined";
    await db.insertInto("offers").values({ offer_id: newId("ofr"), trip_id: tripId, driver_id: ids.rich, kind: k % 2 ? "assigned" : "exclusive", status, round: 1, currency: "SEK", fare_minor: 25000, driver_earnings_minor: 20000, pickup_meters: 900, pickup_eta_seconds: 120, sent_at: min(300 - k), expires_at: min(300 - k), answered_at: min(299 - k), group_id: null, reason_code: null, decline_reason: null }).execute();
    if (k < 3) await db.insertInto("driver_cancels").values({ trip_id: tripId, driver_id: ids.rich, at: min(200 - k), from_status: "driver_assigned", reason_code: "other", note: null }).execute();
  }
  superAdmin = (await adminSession(app, db, "super", { now: clock.now })).headers;
  stockholmOnly = (await adminSession(app, db, "super", { zoneIds: ["Z001"], now: clock.now })).headers;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("GET /admin/zones/{zoneId}/driver-facts", () => {
  it("lists the zone's online drivers with real facts and null for what is not tracked", async () => {
    const res = await get("/admin/zones/Z001/driver-facts", superAdmin);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { zoneId: string; items: Record<string, unknown>[] };
    expect(body.zoneId).toBe("Z001");
    expect(body.items.map((row) => row.driverId).sort()).toEqual([ids.free, ids.busy, ids.rich].sort());
    const free = body.items.find((row) => row.driverId === ids.free)!;
    expect(free).toMatchObject({ state: "free", idleMin: 7, categoryIds: ["economy"], missedInRow: 2, ridesThisHour: 1, restNeeded: false });
    // Too few offers / trips / ratings for the minimums: null, as Driver.performance.
    expect(free.rating).toBeNull();
    const busy = body.items.find((row) => row.driverId === ids.busy)!;
    expect(busy).toMatchObject({ state: "trip", idleMin: null, missedInRow: 0, ridesThisHour: 0 });
    for (const row of body.items) for (const key of NOT_YET) expect(row[key], key).toBeNull();
  });

  it("refuses a zone outside the admin's scope and an unknown zone", async () => {
    const out = await get("/admin/zones/FR-PC/driver-facts", stockholmOnly);
    expect(out.statusCode).toBe(403);
    expect(out.json().error?.details?.reason ?? out.body).toContain("zone_out_of_scope");
    expect((await get("/admin/zones/NOPE-1/driver-facts", superAdmin)).statusCode).toBe(404);
  });

  it("needs an admin token", async () => {
    expect((await get("/admin/zones/Z001/driver-facts", {})).statusCode).toBe(401);
  });
});

describe("batched facts equal the per-driver reads", () => {
  it("rating, acceptance, cancels, missed in a row and rest match driverPerformance / missedInRow / drivingLimitReached", async () => {
    const db = database.db;
    const { items } = await zoneDriverFacts(db, "Z001", clock.now);
    const rich = items.find((row) => row.driverId === ids.rich)!;
    expect(rich.acceptancePct).not.toBeNull();
    expect(rich.cancelPct).not.toBeNull();
    expect(rich.rating).not.toBeNull();
    for (const row of items) {
      const perf = await driverPerformance(db, row.driverId, clock.now);
      const driver = await db.selectFrom("drivers").select("online_since").where("driver_id", "=", row.driverId).executeTakeFirstOrThrow();
      expect({ rating: row.rating, acceptancePct: row.acceptancePct, cancelPct: row.cancelPct }, row.driverId).toEqual({ rating: perf.rating, acceptancePct: perf.acceptancePct, cancelPct: perf.cancellationPct });
      expect(row.missedInRow).toBe(await missedInRow(db, row.driverId, driver.online_since));
      expect(row.restNeeded).toBe(await drivingLimitReached(db, row.driverId, clock.now));
    }
  });
});

describe("missed in a row is the true count, whatever the zone limit", () => {
  for (const limit of [0, 3]) {
    it(`limit ${limit}, 5 missed → 5`, async () => {
      const db = database.db;
      const zoneId = `Z001`;
      await db.deleteFrom("config_live").where("doc", "=", "driver_app_config").where("zone_id", "=", zoneId).execute();
      await db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: zoneId, version: 1, document: JSON.stringify({ offers: { autoOffline: { missedExclusive: limit } } }), published_at: new Date(), published_by: null }).execute();
      const driverId = await insertDriver(db);
      const at = (m: number) => new Date(clock.now.getTime() - m * 60_000);
      await db.updateTable("drivers").set({ account_status: "active", zone_ids: [zoneId], online_status: "online", online_since: at(100) }).where("driver_id", "=", driverId).execute();
      const rider = await insertRider(db);
      for (let k = 0; k < 5; k += 1) {
        const tripId = await insertTrip(db, rider, { status: "cancelled_by_rider" });
        await db.insertInto("offers").values({ offer_id: newId("ofr"), trip_id: tripId, driver_id: driverId, kind: "exclusive", status: "expired", round: 1, currency: "SEK", fare_minor: 25000, driver_earnings_minor: 20000, pickup_meters: 900, pickup_eta_seconds: 120, sent_at: at(50 - k), expires_at: at(50 - k), answered_at: at(49 - k), group_id: null, reason_code: null, decline_reason: null }).execute();
      }
      const { items } = await zoneDriverFacts(db, zoneId, clock.now);
      expect(items.find((row) => row.driverId === driverId)?.missedInRow).toBe(5);
      await db.deleteFrom("config_live").where("doc", "=", "driver_app_config").where("zone_id", "=", zoneId).execute();
      await db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", driverId).execute();
    });
  }
});
