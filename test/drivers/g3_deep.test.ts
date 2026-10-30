import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { contract } from "../../src/contract/contract.js";
import { scoreInputs } from "../../src/drivers/performance.js";
import { seedDriver } from "../../src/drivers/service.js";
import { haversineKm } from "../../src/maps/routing.js";
import { newId } from "../../src/ids.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertRider, insertTrip } from "../support/seed.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.4 §29, deep second audit of driver group 3 (Rules decisions/driver-g3.md): G3-D2 real performance
 * numbers, G3-D4 nearby cars slightly moved, G3-D5 one supply/demand rule per zone. Sweden (Z001) and France (FR-PC).
 */

type Perf = { windowDays: number; minOffers: number; minTrips: number; dispatchDefaults: Record<string, number> };
type Blur = { minMeters: number; maxMeters: number; stableMinutes: number };
const HOME = (contract as unknown as { driverHome: { performance: Perf; nearbyBlur: Blur } }).driverHome;

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-03T08:00:00Z") };

const STOCKHOLM = { lat: 59.3335, lng: 18.0655 };
const PARIS = { lat: 48.8566, lng: 2.3522 };
const SE = { id: "", phone: TEST_PHONES[1]!, home: STOCKHOLM, zone: "Z001", country: "SE" };
const FR = { id: "", phone: TEST_PHONES[2]!, home: PARIS, zone: "FR-PC", country: "FR" };
type Who = typeof SE;
let riderId = "";

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  for (const [who, plate] of [[SE, "GTD001"], [FR, "GTD002"]] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: who.phone, firstName: `Driver ${who.country}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate, categoryIds: ["economy"], zoneIds: [who.zone] }, clock.now),
    );
    who.id = made.driverId;
    await database.db.updateTable("drivers").set({ country: who.country }).where("driver_id", "=", who.id).execute();
  }
  riderId = await insertRider(database.db);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 24 * 3600_000);
  await database.db.deleteFrom("offers").execute();
  await database.db.deleteFrom("driver_cancels").execute();
  await database.db.deleteFrom("driver_locations").execute();
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin"]).execute();
  await database.db.updateTable("drivers").set({ online_status: "offline", rating_sum: 0, rating_count: 0 }).where("driver_id", "in", [SE.id, FR.id]).execute();
});

/** n offers to the driver, `daysAgo` days back, ending in `status`. */
async function offers(who: Who, n: number, status: "claimed" | "declined" | "expired" | "withdrawn" | "claimed_elsewhere", daysAgo = 1, kind: "exclusive" | "assigned" | "radar" = "exclusive") {
  for (let i = 0; i < n; i++) {
    const tripId = await insertTrip(database.db, riderId, { status: "completed" });
    const sent = new Date(clock.now.getTime() - daysAgo * 24 * 3600_000 - i * 60_000);
    await database.db.insertInto("offers").values({
      offer_id: newId("ofr"), trip_id: tripId, driver_id: who.id, kind, status, round: 1, group_id: null, reason_code: null, currency: "SEK",
      fare_minor: 10_000, driver_earnings_minor: 8_000, pickup_meters: 500, pickup_eta_seconds: 120, sent_at: sent, expires_at: new Date(sent.getTime() + 20_000),
      answered_at: sent, decline_reason: null,
    }).execute();
  }
}
async function cancels(who: Who, n: number, daysAgo = 1) {
  for (let i = 0; i < n; i++) {
    const tripId = await insertTrip(database.db, riderId, { status: "cancelled_by_driver" });
    await database.db.insertInto("driver_cancels").values({ trip_id: tripId, driver_id: who.id, at: new Date(clock.now.getTime() - daysAgo * 24 * 3600_000), from_status: "accepted", reason_code: "other", note: null }).execute();
  }
}
const profile = async (who: Who) => (await call(app, "GET", "/driver/profile", (await signIn(app, who.phone, "driver")).headers)).json();

describe("G3-D2: real acceptance %, cancellation % and rating (last 30 days)", () => {
  for (const who of [SE, FR]) {
    it(`${who.country}: nulls ("—") until enough offers and trips`, async () => {
      await offers(who, 9, "claimed");
      const body = await profile(who);
      expect(body.performance).toMatchObject({ windowDays: 30, offersAnswerable: 9, offersAccepted: 9, tripsCancelled: 0, ratingCount: 0, acceptancePct: null, cancellationPct: null, rating: null });
    });

    it(`${who.country}: counts only answerable exclusive/assigned offers inside 30 days; cancels against accepted`, async () => {
      await offers(who, 8, "claimed");
      await offers(who, 4, "claimed", 2, "assigned");
      await offers(who, 3, "declined");
      await offers(who, 1, "expired");
      // Not counted: he could not answer, Radar, or older than 30 days.
      await offers(who, 5, "withdrawn");
      await offers(who, 2, "claimed_elsewhere");
      await offers(who, 6, "declined", 1, "radar");
      await offers(who, 7, "declined", 31);
      await cancels(who, 3);
      await cancels(who, 2, 31);
      await database.db.updateTable("drivers").set({ rating_sum: 4 * 5 + 4, rating_count: 5 }).where("driver_id", "=", who.id).execute();
      const body = await profile(who);
      expect(body.performance).toMatchObject({ offersAnswerable: 16, offersAccepted: 12, tripsCancelled: 3, acceptancePct: 75, cancellationPct: 25, rating: 4.8, ratingCount: 5 });
      // The admin sees the same numbers.
      const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
      const seen = await call(app, "GET", `/admin/drivers/${who.id}`, admin);
      expect(seen.statusCode).toBe(200);
      expect(seen.json().performance).toEqual(body.performance);
    });
  }

  it("dispatch uses the same counts (any data), and the §3.6 defaults only with none", () => {
    const base = { windowDays: 30, from: "", offersAnswerable: 0, offersAccepted: 0, tripsCancelled: 0, ratingCount: 0, acceptancePct: null, cancellationPct: null, rating: null };
    expect(scoreInputs(base)).toEqual({});
    expect(scoreInputs({ ...base, offersAnswerable: 4, offersAccepted: 2, tripsCancelled: 1, ratingCount: 1, rating: 4.2 })).toEqual({ acceptancePct: 50, cancelPct: 50, rating: 4.2 });
    expect(HOME.performance.dispatchDefaults).toEqual({ rating: 4.7, acceptancePct: 85, cancellationPct: 5 });
  });
});

/** Puts the driver online with a fresh fix at `at` (server clock). */
async function place(who: Who, at: { lat: number; lng: number }, status: "online" | "on_trip" = "online", secondsAgo = 0) {
  const t = new Date(clock.now.getTime() - secondsAgo * 1000);
  await database.db.updateTable("drivers").set({ online_status: status, account_status: "active" }).where("driver_id", "=", who.id).execute();
  const row = { lat: at.lat, lng: at.lng, accuracy: 8, heading: 90, measured_at: t, received_at: t, moving: false, zone_id: who.zone };
  await database.db.insertInto("driver_locations").values({ driver_id: who.id, ...row }).onConflict((c) => c.column("driver_id").doUpdateSet(row)).execute();
}

describe("G3-D4: nearby cars are moved 100–200 m, stable, without identity", () => {
  for (const who of [SE, FR]) {
    it(`${who.country}: never the exact spot; the same spot inside the slot; another after it`, async () => {
      // Start of a slot, so a few minutes later is still inside it.
      const slot = HOME.nearbyBlur.stableMinutes * 60_000;
      clock.now = new Date(Math.ceil(clock.now.getTime() / slot) * slot);
      await place(who, who.home);
      const rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
      const ask = async () => (await call(app, "GET", `/rider/nearby-vehicles?lat=${who.home.lat}&lng=${who.home.lng}`, rider)).json().items;
      const [car] = await ask();
      const meters = haversineKm(who.home, car) * 1000;
      // 100–200 m, plus at most ~10 m from rounding to 4 decimals.
      expect(meters).toBeGreaterThan(HOME.nearbyBlur.minMeters - 12);
      expect(meters).toBeLessThan(HOME.nearbyBlur.maxMeters + 12);
      expect(Object.keys(car).sort()).toEqual(["heading", "key", "lat", "lng"]);
      clock.now = new Date(clock.now.getTime() + 3 * 60_000);
      await place(who, who.home);
      const [same] = await ask();
      expect([same.lat, same.lng]).toEqual([car.lat, car.lng]);
      clock.now = new Date(clock.now.getTime() + slot);
      await place(who, who.home);
      const [next] = await ask();
      expect([next.lat, next.lng]).not.toEqual([car.lat, car.lng]);
    });
  }
});

describe("G3-D5: one supply/demand rule per zone for the rows and the shortage alert", () => {
  it("SE and FR: every online driver counts in his zone (stale too); waiting > free is a shortage", async () => {
    // SE driver free with a stale fix; FR driver on a trip.
    await place(SE, SE.home, "online", 600);
    await place(FR, FR.home, "on_trip");
    for (const zone of ["Z001", "Z001", "FR-PC"]) {
      const tripId = await insertTrip(database.db, await insertRider(database.db), { status: "searching" });
      await database.db.updateTable("trips").set({ zone_id: zone }).where("trip_id", "=", tripId).execute();
    }
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const res = await call(app, "GET", "/admin/live/drivers?zoneIds=Z001,FR-PC", admin);
    expect(res.statusCode).toBe(200);
    const rows = res.json().zoneSupply as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.zoneId === "Z001")).toEqual({ zoneId: "Z001", online: 1, free: 1, busy: 0, waiting: 2, level: "short", shortage: true });
    expect(rows.find((r) => r.zoneId === "FR-PC")).toEqual({ zoneId: "FR-PC", online: 1, free: 0, busy: 1, waiting: 1, level: "short", shortage: true });
    // One free driver per waiting rider is tight, no rider is ok: no shortage.
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("zone_id", "=", "Z001").where("status", "=", "searching").execute();
    const tripId = await insertTrip(database.db, await insertRider(database.db), { status: "searching" });
    await database.db.updateTable("trips").set({ zone_id: "Z001" }).where("trip_id", "=", tripId).execute();
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("zone_id", "=", "FR-PC").where("status", "=", "searching").execute();
    const after = (await call(app, "GET", "/admin/live/drivers?zoneIds=Z001,FR-PC", admin)).json().zoneSupply as Array<Record<string, unknown>>;
    expect(after.find((r) => r.zoneId === "Z001")).toMatchObject({ waiting: 1, free: 1, level: "tight", shortage: false });
    expect(after.find((r) => r.zoneId === "FR-PC")).toMatchObject({ waiting: 0, level: "ok", shortage: false });
  });
});
