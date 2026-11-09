import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { contract, CONTRACTS_DIR } from "../../src/contract/contract.js";
import { zoneAt } from "../../src/config/zoneLookup.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { ensureMaintenanceTimers, maintenanceHandlers } from "../../src/jobs/maintenance.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { isStaleFix } from "../../src/trips/eta.js";
import { DISPATCH_FIX_MAX_AGE_SECONDS, ETA_FIX_MAX_AGE_SECONDS } from "../../src/drivers/service.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { approveDriverDocuments, approveVehicleDocuments, insertRider, insertTrip } from "../support/seed.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.4 §29 (owner decisions of driver group 3, Rules decisions/driver-g3.md): G3-R1 set offline with no
 * position for 5 minutes, decision 2 / G3-R5 going online needs a fresh position, G3-R2 outside his zones (online,
 * flagged, no trips), G3-R4 real riders online per zone. Each in Sweden (Z001) and France (FR-PC).
 */

type Home = {
  setOffline: { noticeKind: string; auditAction: string; text: { line: Record<string, string>; title: Record<string, string> } };
  locationRequired: { reason: string };
};
const HOME = (contract as unknown as { driverHome: Home }).driverHome;

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-02T08:00:00Z") };
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));

const STOCKHOLM = { lat: 59.3335, lng: 18.0655 };
const PARIS = { lat: 48.8566, lng: 2.3522 };
/** Enköping: outside every zone (west of the Stockholm County rectangle, 17.25 E). */
const OUTSIDE = { lat: 59.636, lng: 17.077 };
const SE = { id: "", phone: TEST_PHONES[1]!, home: STOCKHOLM, zone: "Z001", language: "sv", country: "SE" };
const FR = { id: "", phone: TEST_PHONES[2]!, home: PARIS, zone: "FR-PC", language: "fr", country: "FR" };
type Who = typeof SE;
const riderPhone = TEST_PHONES[0]!;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  // Dispatch reaches far (one 200 km step), so only the zone rule can keep a driver out.
  const dispatch = sample("dispatch_document");
  dispatch.radius.steps = [200];
  await database.db.insertInto("config_live").values([
    { doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(dispatch), published_at: clock.now, published_by: null },
    { doc: "rider_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("rider_app_config")), published_at: clock.now, published_by: null },
  ]).execute();
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, ...rideHandlers, ...maintenanceHandlers }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  for (const [who, plate] of [[SE, "GTH001"], [FR, "GTH002"]] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: who.phone, firstName: `Driver ${who.country}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate, categoryIds: ["economy"], zoneIds: [who.zone] }, clock.now),
    );
    who.id = made.driverId;
    await database.db.updateTable("drivers").set({ language: who.language, country: who.country }).where("driver_id", "=", who.id).execute();
    await approveDriverDocuments(database.db, who.id);
    await approveVehicleDocuments(database.db, made.vehicleId, who.id, who.country);
  }
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

const tokens = new Map<string, { at: number; headers: Record<string, string> }>();
async function headersOf(phone: string, appName: "rider" | "driver") {
  const held = tokens.get(`${appName}:${phone}`);
  if (held && clock.now.getTime() - held.at >= 0 && clock.now.getTime() - held.at < 5 * 60_000) return held.headers;
  const { headers } = await signIn(app, phone, appName);
  tokens.set(`${appName}:${phone}`, { at: clock.now.getTime(), headers });
  return headers;
}
const me = async (who: Who) => (await call(app, "GET", "/driver/profile", await headersOf(who.phone, "driver"))).json();
const fix = (at: { lat: number; lng: number }, agoSeconds = 0) => ({ ...at, accuracy: 5, measuredAt: new Date(clock.now.getTime() - agoSeconds * 1000).toISOString() });
const goOnline = async (who: Who, location?: ReturnType<typeof fix>) =>
  call(app, "POST", "/driver/availability", await headersOf(who.phone, "driver"), { expectedVersion: (await me(who)).version, onlineStatus: "online", ...(location ? { location } : {}) });
const sendFix = async (who: Who, at: { lat: number; lng: number }) => {
  // A newer fix than the last one (only a newer fix replaces the stored position).
  clock.now = new Date(clock.now.getTime() + 1000);
  return call(app, "POST", "/driver/location", await headersOf(who.phone, "driver"), { fixes: [fix(at)] });
};
const row = (who: Who) => database.db.selectFrom("drivers").selectAll().where("driver_id", "=", who.id).executeTakeFirstOrThrow();

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 24 * 3600_000);
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "cancelled_by_system", "no_show", "expired", "failed"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.deleteFrom("driver_locations").execute();
  await database.db.deleteFrom("config_live").where("doc", "=", "driver_app_config").execute();
  await database.db.updateTable("drivers").set({ online_status: "offline", online_since: null }).where("driver_id", "in", [SE.id, FR.id]).execute();
});

describe("decision 2 / G3-R5: going online needs a fresh position", () => {
  for (const who of [SE, FR]) {
    it(`${who.country}: no position → 409 location_required; a position 5 min old → 409; a fresh one → online`, async () => {
      const none = await goOnline(who);
      expect(none.statusCode).toBe(409);
      expect(none.json()).toMatchObject({ reason: HOME.locationRequired.reason });
      const old = await goOnline(who, fix(who.home, 300));
      expect(old.statusCode).toBe(409);
      expect(old.json()).toMatchObject({ reason: "location_required" });
      expect((await row(who)).online_status).toBe("offline");
      const ok = await goOnline(who, fix(who.home));
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ onlineStatus: "online", outsideArea: false });
    });

    it(`${who.country}: v0.18.52 §74 — a position the app sends while OFFLINE is not stored, so it is not enough; the one in the go-online request is`, async () => {
      // Before v0.18.52 the fix posted a moment ago was stored and let him go online without a location in the body.
      const posted = await sendFix(who, who.home);
      expect(posted.statusCode).toBe(200);
      expect(posted.json()).toMatchObject({ accepted: 0 });
      const refused = await goOnline(who);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ reason: "location_required" });
      const ok = await goOnline(who, fix(who.home));
      expect(ok.statusCode).toBe(200);
      expect(ok.json().onlineStatus).toBe("online");
    });
  }
});

describe("G3-R2: outside his zones he goes online, is told so, and gets no trips", () => {
  it("SE driver in Paris and FR driver in Stockholm: 200 online with outsideArea and his own zones' names", async () => {
    const se = await goOnline(SE, fix(PARIS));
    expect(se.statusCode).toBe(200);
    expect(se.json()).toMatchObject({ onlineStatus: "online", outsideArea: true, areaZones: [{ zoneId: "Z001", name: "Stockholm län" }] });
    const fr = await goOnline(FR, fix(STOCKHOLM));
    expect(fr.statusCode).toBe(200);
    expect(fr.json()).toMatchObject({ onlineStatus: "online", outsideArea: true, areaZones: [{ zoneId: "FR-PC", name: expect.any(String) }] });
    // He drives home: the location answer and the profile say he is inside again.
    const back = await sendFix(SE, STOCKHOLM);
    expect(back.json()).toMatchObject({ accepted: 1, outsideArea: false });
    expect((await me(SE)).outsideArea).toBe(false);
    // And out again.
    const out = await sendFix(FR, OUTSIDE);
    expect(out.json()).toMatchObject({ outsideArea: true, areaZones: [{ zoneId: "FR-PC" }] });
    expect((await me(FR)).outsideArea).toBe(true);
  });

  it("dispatch offers nothing to a driver whose latest position is outside his zones (SE, 200 km radius)", async () => {
    expect(await zoneAt(database.db, OUTSIDE)).toBeNull();
    expect((await goOnline(SE, fix(OUTSIDE))).json().outsideArea).toBe(true);
    const rider = await headersOf(riderPhone, "rider");
    const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    const booked = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
    expect(booked.statusCode).toBe(201);
    await worker.runDue();
    expect((await call(app, "GET", "/driver/offers", await headersOf(SE.phone, "driver"))).json().items).toEqual([]);
    // Back inside his zone: the next round offers it to him.
    await sendFix(SE, STOCKHOLM);
    await advance(20);
    const items = (await call(app, "GET", "/driver/offers", await headersOf(SE.phone, "driver"))).json().items;
    expect(items.map((o: { tripId: string }) => o.tripId)).toContain(booked.json().tripId);
  });
});

describe("G3-R1: no position for 5 minutes while online → set offline by the server", () => {
  const notices = (who: Who) => database.db.selectFrom("notifications").selectAll().where("subject_id", "=", who.id).where("kind", "=", HOME.setOffline.noticeKind).execute();
  for (const who of [SE, FR]) {
    it(`${who.country}: online at 4 min 50 s, offline after 5 min with a ${who.language} notice and an audit line`, async () => {
      await ensureMaintenanceTimers(database.db, clock.now);
      expect((await goOnline(who, fix(who.home))).statusCode).toBe(200);
      const before = (await notices(who)).length;
      const versionOnline = (await row(who)).version;
      await advance(290);
      expect((await row(who)).online_status).toBe("online");
      await advance(40);
      const after = await row(who);
      expect(after.online_status).toBe("offline");
      expect(after.version).toBe(versionOnline + 1);
      const mine = await notices(who);
      expect(mine.length).toBe(before + 1);
      expect(mine[mine.length - 1]).toMatchObject({ title: HOME.setOffline.text.title[who.language], deep_link: "movera-driver://home", audience: "driver" });
      const last = mine[mine.length - 1]!;
      // v0.18.48 §70: the French line is two sentences ("Title. Body."); sv/en keep "Title – body".
      expect(who.language === "fr" ? `${last.title}. ${last.body}.` : `${last.title} – ${last.body.toLowerCase()}`).toBe(HOME.setOffline.text.line[who.language]);
      const auditRows = await database.db.selectFrom("admin_audit").selectAll().where("target_id", "=", who.id).where("action", "=", HOME.setOffline.auditAction).execute();
      expect(auditRows.length).toBeGreaterThan(0);
      expect(auditRows[auditRows.length - 1]).toMatchObject({ target_type: "driver", admin_id: null, zone_id: who.zone });
      // The job books itself again.
      expect(await database.db.selectFrom("timers").select("kind").where("kind", "=", "no_fix_offline").execute()).toHaveLength(1);
    });
  }

  it("positions keep him online; a driver on a trip is never set offline; the zone's noFixMinutes is used", async () => {
    await ensureMaintenanceTimers(database.db, clock.now);
    await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "FR-PC", version: 1, document: JSON.stringify({ offers: { autoOffline: { noFixMinutes: 10 } } }), published_at: clock.now, published_by: null }).execute();
    expect((await goOnline(SE, fix(SE.home))).statusCode).toBe(200);
    expect((await goOnline(FR, fix(FR.home))).statusCode).toBe(200);
    for (let i = 0; i < 8; i += 1) {
      await sendFix(SE, SE.home);
      await advance(60);
    }
    expect((await row(SE)).online_status).toBe("online");
    // FR: 10 minutes in this zone.
    expect((await row(FR)).online_status).toBe("online");
    await advance(150);
    expect((await row(FR)).online_status).toBe("offline");
    // SE on a trip with no position: stays on the trip.
    const tripId = await insertTrip(database.db, await insertRider(database.db), { status: "in_trip" });
    await database.db.updateTable("trips").set({ driver_id: SE.id }).where("trip_id", "=", tripId).execute();
    await database.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", SE.id).execute();
    await advance(20 * 60);
    expect((await row(SE)).online_status).toBe("online");
  });

  it("G5 live re-test: a still phone re-sending its last OS fix (same measuredAt) every tick stays online and not stale", async () => {
    await ensureMaintenanceTimers(database.db, clock.now);
    const still = fix(SE.home);
    expect((await goOnline(SE, still)).statusCode).toBe(200);
    for (let i = 0; i < 36; i += 1) {
      await advance(10);
      const sent = await call(app, "POST", "/driver/location", await headersOf(SE.phone, "driver"), { fixes: [still] });
      expect(sent.statusCode).toBe(200);
    }
    // 6 minutes on: the server heard him every 10 s.
    expect((await row(SE)).online_status).toBe("online");
    const stored = await database.db.selectFrom("driver_locations").selectAll().where("driver_id", "=", SE.id).executeTakeFirstOrThrow();
    expect(clock.now.getTime() - stored.received_at.getTime()).toBeLessThan(120_000);
    expect(stored.measured_at.toISOString()).toBe(still.measuredAt);
  });

  for (const [minutes, offered] of [[6, false], [3, true]] as const) {
    it(`checker: a ${minutes}-min-old fix re-sent every 10 s keeps him online; offered: ${offered}; its ETA is stale`, async () => {
      await ensureMaintenanceTimers(database.db, clock.now);
      const still = fix(SE.home);
      expect((await goOnline(SE, still)).statusCode).toBe(200);
      for (let i = 0; i < minutes * 6; i += 1) {
        await advance(10);
        expect((await call(app, "POST", "/driver/location", await headersOf(SE.phone, "driver"), { fixes: [still] })).statusCode).toBe(200);
      }
      expect((await row(SE)).online_status).toBe("online");
      const stored = await database.db.selectFrom("driver_locations").selectAll().where("driver_id", "=", SE.id).executeTakeFirstOrThrow();
      expect(isStaleFix(stored, clock.now)).toBe(true);
      const rider = await headersOf(riderPhone, "rider");
      const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
      const booked = await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" });
      expect(booked.statusCode).toBe(201);
      await worker.runDue();
      const items = (await call(app, "GET", "/driver/offers", await headersOf(SE.phone, "driver"))).json().items as { tripId: string }[];
      expect(items.map((o) => o.tripId).includes(booked.json().tripId)).toBe(offered);
    });
  }

  it("checker: the fix-age limits sit next to STALE_AFTER_SECONDS", () => {
    expect(DISPATCH_FIX_MAX_AGE_SECONDS).toBe(300);
    expect(ETA_FIX_MAX_AGE_SECONDS).toBe(120);
    const now = clock.now;
    expect(isStaleFix({ received_at: now, measured_at: new Date(now.getTime() - 60_000) }, now)).toBe(false);
    expect(isStaleFix({ received_at: now, measured_at: new Date(now.getTime() - 121_000) }, now)).toBe(true);
  });

  it("noFixMinutes 0 = never", async () => {
    await ensureMaintenanceTimers(database.db, clock.now);
    await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify({ offers: { autoOffline: { noFixMinutes: 0 } } }), published_at: clock.now, published_by: null }).execute();
    expect((await goOnline(SE, fix(SE.home))).statusCode).toBe(200);
    await advance(30 * 60);
    expect((await row(SE)).online_status).toBe("online");
  });
});

describe("G3-R4: riders online per zone are real", () => {
  it("riders with the map open (SE and FR) or with an open request count in their zone; old ones do not", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const counts = async () => Object.fromEntries(((await call(app, "GET", "/admin/live/drivers", admin)).json().ridersOnline as Array<{ zoneId: string; count: number }>).map((r) => [r.zoneId, r.count]));
    const start = await counts();
    expect(start).toMatchObject({ Z001: 0, "FR-PC": 0 });
    const rider = await headersOf(riderPhone, "rider");
    expect((await call(app, "GET", `/rider/nearby-vehicles?lat=${STOCKHOLM.lat}&lng=${STOCKHOLM.lng}`, rider)).statusCode).toBe(200);
    expect(await counts()).toMatchObject({ Z001: 1, "FR-PC": 0 });
    // The same rider opens the map in Paris: he moves there.
    await call(app, "GET", `/rider/nearby-vehicles?lat=${PARIS.lat}&lng=${PARIS.lng}`, rider);
    expect(await counts()).toMatchObject({ Z001: 0, "FR-PC": 1 });
    // An open request in Stockholm from another rider.
    const open = await insertTrip(database.db, await insertRider(database.db), { status: "searching" });
    await database.db.updateTable("trips").set({ zone_id: "Z001" }).where("trip_id", "=", open).execute();
    expect(await counts()).toMatchObject({ Z001: 1, "FR-PC": 1 });
    // 3 minutes later the map rider is gone; the request still counts.
    clock.now = new Date(clock.now.getTime() + 180_000);
    expect(await counts()).toMatchObject({ Z001: 1, "FR-PC": 0 });
  });
});
