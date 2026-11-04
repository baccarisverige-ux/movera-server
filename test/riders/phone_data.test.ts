import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * BASE B13 (contract v0.18.26 §47, contract.json#phoneDataToServer; owner 2026-11-03 "Phone-only data: Yes, all to
 * server"): rider saved places, driver ride preferences (dispatch skips switched-off categories) and driver emergency
 * contacts on the server, each visible only to its owner; the admin reads emergency contacts only through an incident.
 * Before this change every route below answered 404 and dispatch offered a switched-off category.
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
const clock = { now: new Date("2026-11-04T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
let riderA: Record<string, string>;
let riderB: Record<string, string>;
let driverA: { id: string; headers: Record<string, string> };
let driverB: { id: string; headers: Record<string, string> };

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values({ doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null }).execute();
  worker = new TimerWorker(database.db, { handlers: dispatchHandlers, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const made = [];
  for (const [i, phone] of [TEST_PHONES[2]!, TEST_PHONES[3]!].entries()) {
    made.push(await database.db.transaction().execute((trx) => seedDriver(trx, { phone, firstName: `Driver ${i}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `PDS00${i}`, categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now)));
  }
  driverA = { id: made[0]!.driverId, headers: (await signIn(app, TEST_PHONES[2]!, "driver")).headers };
  driverB = { id: made[1]!.driverId, headers: (await signIn(app, TEST_PHONES[3]!, "driver")).headers };
  riderA = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  riderB = (await signIn(app, TEST_PHONES[1]!, "rider")).headers;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

const home = { label: "Home", kind: "home", place: { address: "Sveavägen 1, Stockholm" } };

describe("rider saved places on the server", () => {
  beforeEach(async () => {
    await database.db.deleteFrom("rider_places").execute();
    await database.db.deleteFrom("rider_places_imported").execute();
  });

  it("saves, lists, changes and deletes the rider's own places; home is one slot", async () => {
    const created = await call(app, "POST", "/rider/places", riderA, home);
    expect(created.statusCode).toBe(201);
    const homeId = created.json().placeId;
    expect(created.json()).toMatchObject({ label: "Home", kind: "home", place: { address: "Sveavägen 1, Stockholm" } });
    // A second home replaces the first and keeps its id.
    const again = await call(app, "POST", "/rider/places", riderA, { ...home, place: { address: "Rue de Rivoli 2, Paris", lat: 48.86, lng: 2.34 } });
    expect(again.json()).toMatchObject({ placeId: homeId, place: { address: "Rue de Rivoli 2, Paris", lat: 48.86, lng: 2.34 } });
    const gym = (await call(app, "POST", "/rider/places", riderA, { label: "Gym", kind: "other", type: "gym", place: { address: "Odengatan 3" } })).json();
    expect(gym).toMatchObject({ kind: "other", type: "gym" });
    const list = (await call(app, "GET", "/rider/places", riderA)).json();
    expect(list.items.map((p: { placeId: string }) => p.placeId)).toEqual([homeId, gym.placeId]);
    expect(list.nextCursor).toBeNull();
    const changed = await call(app, "PUT", `/rider/places/${gym.placeId}`, riderA, { label: "My gym", kind: "other", type: "gym", place: { address: "Odengatan 4" } });
    expect(changed.json()).toMatchObject({ placeId: gym.placeId, label: "My gym", place: { address: "Odengatan 4" } });
    expect((await call(app, "DELETE", `/rider/places/${gym.placeId}`, riderA)).statusCode).toBe(204);
    expect((await call(app, "GET", "/rider/places", riderA)).json().items).toHaveLength(1);
  });

  it("never shows or changes another rider's places", async () => {
    const mine = (await call(app, "POST", "/rider/places", riderA, home)).json();
    expect((await call(app, "GET", "/rider/places", riderB)).json().items).toEqual([]);
    const put = await call(app, "PUT", `/rider/places/${mine.placeId}`, riderB, home);
    expect(put.statusCode).toBe(404);
    expect(put.json().reason).toBe("place_not_found");
    expect((await call(app, "DELETE", `/rider/places/${mine.placeId}`, riderB)).statusCode).toBe(404);
    // A driver token is refused outright.
    expect((await call(app, "GET", "/rider/places", driverA.headers)).statusCode).toBe(403);
    expect((await call(app, "GET", "/rider/places", riderA)).json().items).toHaveLength(1);
  });

  it("refuses more than 50 places", async () => {
    for (let i = 0; i < 50; i++) await database.db.insertInto("rider_places").values({ place_id: `plc_fill_${i}`, rider_id: (await riderId(riderA)), kind: "other", type: null, label: `P${i}`, address: `Street ${i}`, lat: null, lng: null, created_at: clock.now, updated_at: clock.now }).execute();
    const res = await call(app, "POST", "/rider/places", riderA, { label: "One more", kind: "other", place: { address: "X" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("too_many_places");
  });

  it("applies the one-time upload of the phone's places only once", async () => {
    const items = [home, { label: "Work", kind: "work", place: { address: "Kungsgatan 5" } }, { label: "Mall", kind: "other", type: "mall", place: { address: "Mall street" } }];
    const first = await call(app, "POST", "/rider/places/import", riderA, { items });
    expect(first.statusCode).toBe(200);
    expect(first.json().items.map((p: { kind: string }) => p.kind)).toEqual(["home", "work", "other"]);
    // A second phone (or a retry with a new key) uploading again changes nothing.
    const second = await call(app, "POST", "/rider/places/import", riderA, { items: [{ label: "Other", kind: "other", place: { address: "Elsewhere" } }] });
    expect(second.json().items).toHaveLength(3);
  });
});

async function riderId(headers: Record<string, string>): Promise<string> {
  return (await call(app, "GET", "/rider/profile", headers)).json().riderId;
}

describe("driver ride preferences and emergency contacts", () => {
  it("starts empty with updatedAt null, saves, and only the driver sees his own", async () => {
    const empty = (await call(app, "GET", "/driver/preferences", driverB.headers)).json();
    expect(empty).toEqual({ categoriesOff: [], updatedAt: null });
    const saved = await call(app, "PUT", "/driver/preferences", driverB.headers, { categoriesOff: ["premium", "premium"] });
    expect(saved.json()).toEqual({ categoriesOff: ["premium"], updatedAt: clock.now.toISOString() });
    expect((await call(app, "GET", "/driver/preferences", driverA.headers)).json().categoriesOff).toEqual([]);
    const unknown = await call(app, "PUT", "/driver/preferences", driverB.headers, { categoriesOff: ["no_such_type"] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().reason).toBe("unknown_category");
    expect((await call(app, "GET", "/driver/preferences", riderA)).statusCode).toBe(403);
    await call(app, "PUT", "/driver/preferences", driverB.headers, { categoriesOff: [] });
  });

  it("keeps the emergency contacts list (at most 10), private to the driver", async () => {
    expect((await call(app, "GET", "/driver/emergency-contacts", driverA.headers)).json()).toEqual({ items: [], updatedAt: null });
    const items = [{ name: "Sara", phone: "+46701234567", relation: "Sister" }, { name: "Paul", phone: "0612345678" }];
    const saved = await call(app, "PUT", "/driver/emergency-contacts", driverA.headers, { items });
    expect(saved.json()).toEqual({ items, updatedAt: clock.now.toISOString() });
    expect((await call(app, "GET", "/driver/emergency-contacts", driverB.headers)).json().items).toEqual([]);
    const tooMany = await call(app, "PUT", "/driver/emergency-contacts", driverA.headers, { items: Array.from({ length: 11 }, (_, i) => ({ name: `C${i}`, phone: `+4670000000${i}` })) });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().reason).toBe("too_many_contacts");
    const badPhone = await call(app, "PUT", "/driver/emergency-contacts", driverA.headers, { items: [{ name: "X", phone: "call me" }] });
    expect(badPhone.statusCode).toBe(400);
  });

  it("lets an admin read them only through an incident of that driver, in his zones, and audits the read", async () => {
    await call(app, "PUT", "/driver/emergency-contacts", driverA.headers, { items: [{ name: "Sara", phone: "+46701234567" }] });
    await database.db.insertInto("incidents").values({ incident_id: "inc_pds_1", trip_id: null, kind: "sos", severity: "critical", raised_by: "driver", zone_id: "Z001", rider_id: null, driver_id: driverA.id, opened_at: clock.now, updated_at: clock.now } as never).execute();
    const safety = await adminSession(app, database.db, "safety", { zoneIds: ["Z001"], now: clock.now });
    const res = await call(app, "GET", "/admin/incidents/inc_pds_1/emergency-contacts", safety.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ incidentId: "inc_pds_1", driverId: driverA.id, items: [{ name: "Sara", phone: "+46701234567" }] });
    const line = await database.db.selectFrom("admin_audit").selectAll().where("action", "=", "incident.emergency_contacts_viewed").executeTakeFirstOrThrow();
    expect(line).toMatchObject({ admin_id: safety.adminId, target_id: "inc_pds_1" });
    expect(JSON.stringify(line.detail)).not.toContain("46701234567");
    const elsewhere = await adminSession(app, database.db, "safety", { zoneIds: ["Z002"], now: clock.now });
    const out = await call(app, "GET", "/admin/incidents/inc_pds_1/emergency-contacts", elsewhere.headers);
    expect(out.statusCode).toBe(403);
    expect(out.json().reason).toBe("zone_out_of_scope");
    const finance = await adminSession(app, database.db, "finance", { now: clock.now });
    expect((await call(app, "GET", "/admin/incidents/inc_pds_1/emergency-contacts", finance.headers)).statusCode).toBe(403);
    // Owner 2026-11-04: only from an OPEN safety case.
    await database.db.updateTable("incidents").set({ status: "resolved" }).where("incident_id", "=", "inc_pds_1").execute();
    const closed = await call(app, "GET", "/admin/incidents/inc_pds_1/emergency-contacts", safety.headers);
    expect(closed.statusCode).toBe(409);
    expect(closed.json().reason).toBe("incident_closed");
  });

  it("shows saved places and ride preferences read-only on the admin profile pages, audited", async () => {
    await call(app, "POST", "/rider/places", riderA, { label: "Home", kind: "home", place: { address: "Sveavägen 1" } });
    await call(app, "PUT", "/driver/preferences", driverB.headers, { categoriesOff: ["premium"] });
    const ops = await adminSession(app, database.db, "super", { now: clock.now });
    const rid = await riderId(riderA);
    const places = await call(app, "GET", `/admin/riders/${rid}/saved-places`, ops.headers);
    expect(places.statusCode).toBe(200);
    expect(places.json().items[0]).toMatchObject({ kind: "home", place: { address: "Sveavägen 1" } });
    const prefs = await call(app, "GET", `/admin/drivers/${driverB.id}/preferences`, ops.headers);
    expect(prefs.json()).toMatchObject({ driverId: driverB.id, categoriesOff: ["premium"] });
    const actions = (await database.db.selectFrom("admin_audit").select("action").where("admin_id", "=", ops.adminId).execute()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["rider.saved_places_viewed", "driver.preferences_viewed"]));
    const support = await adminSession(app, database.db, "support", { now: clock.now });
    expect((await call(app, "GET", `/admin/drivers/${driverB.id}/preferences`, support.headers)).statusCode).toBe(403);
    const elsewhere = await adminSession(app, database.db, "super", { zoneIds: ["Z002"], now: clock.now });
    expect((await call(app, "GET", `/admin/drivers/${driverB.id}/preferences`, elsewhere.headers)).json().reason).toBe("zone_out_of_scope");
    await call(app, "PUT", "/driver/preferences", driverB.headers, { categoriesOff: [] });
  });
});

describe("dispatch follows the driver's switched-off categories", () => {
  it("does not offer an economy trip to the driver who switched economy off", async () => {
    clock.now = new Date(clock.now.getTime() + 3600_000);
    driverA.headers = (await signIn(app, TEST_PHONES[2]!, "driver")).headers;
    driverB.headers = (await signIn(app, TEST_PHONES[3]!, "driver")).headers;
    riderA = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    // A is right at the pickup, B a bit further: without the switch A would get the Exclusive.
    for (const [d, at] of [[driverA, { lat: 59.3327, lng: 18.065 }], [driverB, { lat: 59.336, lng: 18.07 }]] as const) {
      await database.db.updateTable("drivers").set({ online_status: "online", last_free_at: clock.now }).where("driver_id", "=", d.id).execute();
      await call(app, "POST", "/driver/location", d.headers, { fixes: [{ ...at, accuracy: 5, measuredAt: clock.now.toISOString() }] });
    }
    expect((await call(app, "PUT", "/driver/preferences", driverA.headers, { categoriesOff: ["economy"] })).statusCode).toBe(200);
    const quote = (await call(app, "POST", "/quotes", riderA, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
    const trip = (await call(app, "POST", "/trips", riderA, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
    await worker.runDue();
    const offered = await database.db.selectFrom("offers").select("driver_id").where("trip_id", "=", trip.tripId).execute();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.map((o) => o.driver_id)).not.toContain(driverA.id);
    expect(offered.map((o) => o.driver_id)).toContain(driverB.id);
  });
});
