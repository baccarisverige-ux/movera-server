import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { contract, CONTRACTS_DIR } from "../../src/contract/contract.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { RADAR_ZONE_REPEAT, radarZoneRepeatHandler } from "../../src/dispatch/tools.js";
import { setOfflineWithoutPosition } from "../../src/drivers/presence.js";
import { unlinkFromFleet } from "../../src/drivers/onboarding.js";
import { loadDriver, seedDriver } from "../../src/drivers/service.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { releaseDriver } from "../../src/trips/ride.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, NORRMALM, SODERMALM, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.6 §32: the admin's Dispatch tools (owner G4-F1..F6 of 2026-10-31, Rules decisions/driver-g4.md) and the
 * real offline reason (owner 2026-10-31 "Send the real reason", decisions/driver-g3.md). SE and FR. Each block fails on
 * the server before this change (no routes, tables or fields).
 */

let database: TestDatabase;
let app: FastifyInstance;
let worker: TimerWorker;
let admin: Record<string, string>;
const clock = { now: new Date("2026-10-31T10:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const advance = async (seconds: number) => {
  clock.now = new Date(clock.now.getTime() + seconds * 1000);
  await worker.runDue();
};

// A and B near Sergels torg (Stockholm); C in Paris.
const SPOTS = { A: { lat: 59.3335, lng: 18.0655 }, B: { lat: 59.338, lng: 18.075 }, C: { lat: 48.8656, lng: 2.3212 } };
const drivers: Record<"A" | "B" | "C", { id: string; vehicleId: string; headers: Record<string, string> }> = {} as never;
let rider: Record<string, string>;
// A small area around A only.
const AROUND_A: Array<[number, number]> = [[59.332, 18.063], [59.332, 18.068], [59.335, 18.068], [59.335, 18.063]];

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.insertInto("config_live").values([
    { doc: "dispatch", zone_id: "Z001", version: 1, document: JSON.stringify(sample("dispatch_document")), published_at: clock.now, published_by: null },
    { doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(sample("driver_app_config")), published_at: clock.now, published_by: null },
  ]).execute();
  worker = new TimerWorker(database.db, { handlers: { ...dispatchHandlers, [RADAR_ZONE_REPEAT]: radarZoneRepeatHandler }, logger: { warn: () => undefined, error: (d, m) => console.error(m, d) }, clock: () => clock.now });
  const phones = { A: TEST_PHONES[1]!, B: TEST_PHONES[2]!, C: TEST_PHONES[3]! };
  for (const key of ["A", "B", "C"] as const) {
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: phones[key], firstName: `Driver ${key}`, make: "Volvo", model: "V60", year: 2021, color: "Black", plate: `DTL00${key}`, categoryIds: ["economy"], zoneIds: [key === "C" ? "FR-PC" : "Z001"] }, clock.now),
    );
    drivers[key] = { id: made.driverId, vehicleId: made.vehicleId, headers: {} };
  }
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 3600_000);
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "expired"]).execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("offers").execute();
  await database.db.deleteFrom("dispatch_controls").execute();
  // No automatic offers: only the admin's sends.
  await database.db.insertInto("dispatch_controls").values({ zone_id: "Z001", paused: true, mode: null, by: null, at: clock.now, version: 1 }).execute();
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  for (const key of ["A", "B", "C"] as const) {
    drivers[key].headers = (await signIn(app, ({ A: TEST_PHONES[1], B: TEST_PHONES[2], C: TEST_PHONES[3] } as const)[key]!, "driver")).headers;
    await database.db.updateTable("drivers").set({ online_status: "online", online_since: clock.now, last_free_at: clock.now, account_status: "active", language: null, offline_reason: null, offline_note: null, offline_at: null }).where("driver_id", "=", drivers[key].id).execute();
    await database.db.updateTable("vehicles").set({ status: "approved" }).where("vehicle_id", "=", drivers[key].vehicleId).execute();
    await call(app, "POST", "/driver/location", drivers[key].headers, { fixes: [{ ...SPOTS[key], accuracy: 5, measuredAt: clock.now.toISOString() }] });
  }
});

async function book() {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  const trip = (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
  if (typeof trip.tripId !== "string") throw new Error(`booking failed: ${JSON.stringify(trip)}`);
  await worker.runDue();
  return trip.tripId as string;
}
const version = async (tripId: string) => (await call(app, "GET", `/admin/trips/${tripId}`, admin)).json().version as number;
const openOffers = async (key: "A" | "B" | "C") => (await call(app, "GET", "/driver/offers", drivers[key].headers)).json().items as Array<{ offerId: string; tripId: string; kind: string; source: string; expiresAt: string; version: number }>;
const audits = (action: string) => database.db.selectFrom("admin_audit").select(["action", "target_id"]).where("action", "=", action).execute();

describe("G4-F1: dispatch never waits for a second admin", () => {
  it("old pending dispatch approvals expire (migration 0040); the contract says so", async () => {
    await database.db.insertInto("approvals").values([
      { approval_id: "apr_g4_dispatch", action: "dispatch.control", target_type: "config", target_id: "Z001", payload: JSON.stringify({ zoneId: "Z001" }), approve_permission: "dispatch.approve", zone_id: "Z001", status: "pending_approval", requested_by: "adm_x", requested_at: clock.now, expires_at: new Date(clock.now.getTime() + 86_400_000) },
      { approval_id: "apr_g4_pricing", action: "config.publish", target_type: "config", target_id: "pricing", payload: JSON.stringify({ doc: "pricing" }), approve_permission: "approval.decide", zone_id: "Z001", status: "pending_approval", requested_by: "adm_x", requested_at: clock.now, expires_at: new Date(clock.now.getTime() + 86_400_000) },
    ] as never).execute();
    await database.pool.query(readFileSync(new URL("../../migrations/0040_dispatch_tools.sql", import.meta.url), "utf8"));
    const rows = await database.db.selectFrom("approvals").select(["approval_id", "status"]).where("approval_id", "like", "apr_g4_%").orderBy("approval_id").execute();
    expect(rows).toEqual([{ approval_id: "apr_g4_dispatch", status: "expired" }, { approval_id: "apr_g4_pricing", status: "pending_approval" }]);
    expect((contract as unknown as { dispatchTools: { approvals: string } }).dispatchTools.approvals).toContain("never wait for a second admin");
  });
});

describe("G4-F2: saved presets per country", () => {
  it("create, list per country, unique name, check values, change, delete; audited; a Swedish admin cannot touch France", async () => {
    const values = sample("dispatch_document");
    const made = await call(app, "POST", "/admin/dispatch/presets", admin, { country: "SE", name: "Rush hour", values });
    expect(made.statusCode, made.body).toBe(201);
    const preset = made.json();
    expect(preset).toMatchObject({ country: "SE", name: "Rush hour", version: 1 });
    expect(preset.values).not.toHaveProperty("zoneId");
    expect((await call(app, "POST", "/admin/dispatch/presets", admin, { country: "SE", name: "rush HOUR", values })).json()).toMatchObject({ code: "conflict", reason: "name_taken" });
    // The same name is free in France.
    expect((await call(app, "POST", "/admin/dispatch/presets", admin, { country: "FR", name: "Rush hour", values })).statusCode).toBe(201);
    expect((await call(app, "POST", "/admin/dispatch/presets", admin, { country: "SE", name: "Broken", values: { ...values, radar: { on: true } } })).json()).toMatchObject({ reason: "invalid_document" });
    const se = (await call(app, "GET", "/admin/dispatch/presets?country=SE", admin)).json().items;
    expect(se.map((p: { name: string }) => p.name)).toEqual(["Rush hour"]);
    const changed = await call(app, "PUT", `/admin/dispatch/presets/${preset.presetId}`, admin, { expectedVersion: 1, name: "Evening" });
    expect(changed.json()).toMatchObject({ name: "Evening", version: 2 });
    expect((await call(app, "DELETE", `/admin/dispatch/presets/${preset.presetId}?expectedVersion=1`, admin)).json()).toMatchObject({ code: "version_mismatch" });
    expect((await call(app, "DELETE", `/admin/dispatch/presets/${preset.presetId}?expectedVersion=2`, admin)).statusCode).toBe(204);
    expect((await audits("dispatch.preset.delete")).map((a) => a.target_id)).toContain(preset.presetId);
    const swede = (await adminSession(app, database.db, "ops", { zoneIds: ["Z001"], now: clock.now })).headers;
    expect((await call(app, "POST", "/admin/dispatch/presets", swede, { country: "FR", name: "Paris", values })).json()).toMatchObject({ code: "forbidden", reason: "zone_out_of_scope" });
    expect((await call(app, "GET", "/admin/dispatch/presets", swede)).json().items.every((p: { country: string }) => p.country === "SE")).toBe(true);
  });
});

describe("G4-F3: driver groups; send to the free members, nearest first", () => {
  it("drivers of the country only; the server picks the free members; never fails for one busy member; 409 when none is free", async () => {
    expect((await call(app, "POST", "/admin/dispatch/groups", admin, { country: "SE", name: "Mixed", driverIds: [drivers.A.id, drivers.C.id] })).json()).toMatchObject({ reason: "driver_not_in_country", details: [drivers.C.id] });
    const group = (await call(app, "POST", "/admin/dispatch/groups", admin, { country: "SE", name: "Airport regulars", driverIds: [drivers.A.id, drivers.B.id] })).json();
    expect(group).toMatchObject({ country: "SE", driverIds: [drivers.A.id, drivers.B.id] });
    // B is offline: only A gets it.
    await database.db.updateTable("drivers").set({ online_status: "offline" }).where("driver_id", "=", drivers.B.id).execute();
    const tripId = await book();
    const sent = await call(app, "POST", `/admin/trips/${tripId}/radar-group`, admin, { expectedVersion: await version(tripId), groupId: group.groupId });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({ pickedFrom: "group" });
    expect(sent.json().offers.map((o: { kind: string; source: string }) => [o.kind, o.source])).toEqual([["radar", "admin"]]);
    expect((await openOffers("A")).map((o) => o.tripId)).toEqual([tripId]);
    expect(await openOffers("B")).toEqual([]);
    // Both again: A already holds an offer of this trip, B is offline → nobody free.
    expect((await call(app, "POST", `/admin/trips/${tripId}/radar-group`, admin, { expectedVersion: await version(tripId), groupId: group.groupId })).json()).toMatchObject({ code: "conflict", reason: "no_free_driver" });
    // Two ways at once are refused.
    expect((await call(app, "POST", `/admin/trips/${tripId}/radar-group`, admin, { expectedVersion: await version(tripId), groupId: group.groupId, driverIds: [drivers.A.id] })).json()).toMatchObject({ reason: "radar_group_target" });
  });
});

describe("G4-F4: radar zones and rules; send again until taken", () => {
  it("free drivers inside only, the rule's seconds; repeats to newcomers; stops on the admin's word", async () => {
    const zone = (await call(app, "POST", "/admin/dispatch/radar-zones", admin, { zoneId: "Z001", name: "Sergels torg", polygon: AROUND_A })).json();
    expect(zone).toMatchObject({ country: "SE", zoneId: "Z001" });
    const other = (await call(app, "POST", "/admin/dispatch/radar-zones", admin, { zoneId: "Z001", name: "Elsewhere", polygon: [[59.40, 18.0], [59.40, 18.01], [59.41, 18.01]] })).json();
    const rule = (await call(app, "POST", "/admin/dispatch/radar-rules", admin, { country: "SE", name: "Repeat 20 s", radarZoneIds: [zone.radarZoneId], seconds: 20, maxDrivers: 5, repeat: true })).json();
    expect(rule).toMatchObject({ seconds: 20, maxDrivers: 5, repeat: true });
    expect((await call(app, "GET", `/admin/dispatch/radar-zones/${zone.radarZoneId}/free?categoryId=economy`, admin)).json()).toMatchObject({ free: 1 });
    const tripId = await book();
    expect((await call(app, "POST", `/admin/trips/${tripId}/radar-group`, admin, { expectedVersion: await version(tripId), radarZoneId: other.radarZoneId, ruleId: rule.ruleId })).json()).toMatchObject({ reason: "rule_not_for_zone" });
    const sent = await call(app, "POST", `/admin/trips/${tripId}/radar-group`, admin, { expectedVersion: await version(tripId), radarZoneId: zone.radarZoneId, ruleId: rule.ruleId });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({ pickedFrom: "radar_zone", radarZoneSend: { active: true, repeat: true, rounds: 1 } });
    const [first] = await openOffers("A");
    expect(new Date(first!.expiresAt).getTime() - clock.now.getTime()).toBe(20_000);
    // Checker MEDIUM: any admin who opens the trip sees the running send.
    const another = (await adminSession(app, database.db, "dispatcher", { now: clock.now })).headers;
    expect((await call(app, "GET", `/admin/trips/${tripId}`, another)).json().radarZoneSend).toMatchObject({ radarZoneId: zone.radarZoneId, ruleId: rule.ruleId, intervalSeconds: 20, rounds: 1, active: true, startedAt: clock.now.toISOString() });
    expect(await openOffers("B")).toEqual([]);
    // B drives into the area; nobody accepts: the next round reaches him.
    await call(app, "POST", "/driver/location", drivers.B.headers, { fixes: [{ lat: 59.3333, lng: 18.0660, accuracy: 5, measuredAt: new Date(clock.now.getTime() + 1000).toISOString() }] });
    await advance(20);
    await worker.runDue();
    expect((await openOffers("B")).map((o) => o.tripId)).toEqual([tripId]);
    const send = await database.db.selectFrom("radar_zone_sends").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(send.rounds).toBeGreaterThanOrEqual(2);
    // The admin stops it: no more rounds.
    const stopped = await call(app, "POST", `/admin/trips/${tripId}/radar-zone/stop`, admin, { note: "Found one by phone" });
    expect(stopped.json()).toMatchObject({ active: false, stopReason: "admin" });
    expect((await call(app, "GET", `/admin/trips/${tripId}`, admin)).json()).not.toHaveProperty("radarZoneSend");
    expect((await call(app, "POST", `/admin/trips/${tripId}/radar-zone/stop`, admin, {})).json()).toMatchObject({ reason: "radar_zone_send_not_found" });
    const offersBefore = await database.db.selectFrom("offers").select("offer_id").where("trip_id", "=", tripId).execute();
    await advance(25);
    await advance(25);
    expect((await database.db.selectFrom("offers").select("offer_id").where("trip_id", "=", tripId).execute()).length).toBe(offersBefore.length);
    // A radar zone a rule lists cannot go.
    expect((await call(app, "DELETE", `/admin/dispatch/radar-zones/${zone.radarZoneId}?expectedVersion=1`, admin)).json()).toMatchObject({ reason: "radar_zone_in_use" });
    expect((await call(app, "POST", "/admin/dispatch/radar-rules", admin, { country: "SE", name: "Too long", radarZoneIds: "all", seconds: 200, maxDrivers: 5, repeat: false })).statusCode).toBe(400);
  });

  it("a repeating send ends by itself when a driver accepts", async () => {
    const zone = (await call(app, "POST", "/admin/dispatch/radar-zones", admin, { zoneId: "Z001", name: "Accept zone", polygon: AROUND_A })).json();
    const rule = (await call(app, "POST", "/admin/dispatch/radar-rules", admin, { country: "SE", name: "All zones 15 s", radarZoneIds: "all", seconds: 15, maxDrivers: 3, repeat: true })).json();
    const tripId = await book();
    expect((await call(app, "POST", `/admin/trips/${tripId}/radar-group`, admin, { expectedVersion: await version(tripId), radarZoneId: zone.radarZoneId, ruleId: rule.ruleId })).statusCode).toBe(200);
    const [offer] = await openOffers("A");
    expect((await call(app, "POST", `/offers/${offer!.offerId}/accept`, drivers.A.headers, { expectedVersion: offer!.version })).statusCode).toBe(200);
    // Checker LOW 2: inactive at once, before any timer fires; the admin view shows nothing.
    const send = await database.db.selectFrom("radar_zone_sends").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect(send).toMatchObject({ active: false, stop_reason: "accepted" });
    expect(await database.db.selectFrom("timers").select("kind").where("kind", "=", RADAR_ZONE_REPEAT).where("ref_id", "=", send.send_id).execute()).toEqual([]);
    expect((await call(app, "GET", `/admin/trips/${tripId}`, admin)).json()).not.toHaveProperty("radarZoneSend");
  });

  it("a repeating send ends at once when the rider cancels, and when the search ends", async () => {
    const zone = (await call(app, "POST", "/admin/dispatch/radar-zones", admin, { zoneId: "Z001", name: "Cancel zone", polygon: AROUND_A })).json();
    const rule = (await call(app, "POST", "/admin/dispatch/radar-rules", admin, { country: "SE", name: "Cancel rule", radarZoneIds: "all", seconds: 15, maxDrivers: 3, repeat: true })).json();
    const tripId = await book();
    expect((await call(app, "POST", `/admin/trips/${tripId}/radar-group`, admin, { expectedVersion: await version(tripId), radarZoneId: zone.radarZoneId, ruleId: rule.ruleId })).statusCode).toBe(200);
    const trip = (await call(app, "GET", `/trips/${tripId}`, rider)).json();
    expect((await call(app, "POST", `/trips/${tripId}/cancel`, rider, { expectedVersion: trip.version, reasonCode: "plans_changed" })).statusCode).toBe(200);
    expect(await database.db.selectFrom("radar_zone_sends").select(["active", "stop_reason"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow()).toEqual({ active: false, stop_reason: "trip_over" });
    // Search end: a send running when the search ends. v0.18.39 §63: a live search has no end timer of its own any
    // more (owner N2), so the end (still used by a zone without dispatch rules) is put due here.
    const second = await book();
    expect((await call(app, "POST", `/admin/trips/${second}/radar-group`, admin, { expectedVersion: await version(second), radarZoneId: zone.radarZoneId, ruleId: rule.ruleId })).statusCode).toBe(200);
    await database.db.insertInto("timers").values({ kind: "search_end", ref_id: second, due_at: clock.now, payload: JSON.stringify({}), last_error: null, created_at: clock.now }).execute();
    await worker.runDue();
    expect(await database.db.selectFrom("radar_zone_sends").select(["active", "stop_reason"]).where("trip_id", "=", second).executeTakeFirstOrThrow()).toEqual({ active: false, stop_reason: "search_ended" });
    expect((await call(app, "GET", `/admin/trips/${second}`, admin)).json()).not.toHaveProperty("radarZoneSend");
  });
});

describe("G4-F6: events per country on the driver map", () => {
  const details = {
    title: { sv: "Konsert på Friends Arena", fr: "Concert au Friends Arena", en: "Concert at Friends Arena" },
    description: { sv: "Slutar 23:00", fr: "Se termine à 23 h", en: "Ends 23:00" },
    pickupNote: { sv: "Hämta vid port 3", fr: "Prise en charge porte 3", en: "Pick up at gate 3" },
  };
  it("admin creates; drivers of that country see it in their language; changes signal the driver stream; off / ended / other country hidden", async () => {
    const listener = await database.pool.connect();
    const heard: string[] = [];
    listener.on("notification", (n) => heard.push(n.payload ?? ""));
    await listener.query("LISTEN movera_config_published");
    const startsAt = new Date(clock.now.getTime() + 3600_000).toISOString();
    const endsAt = new Date(clock.now.getTime() + 4 * 3600_000).toISOString();
    expect((await call(app, "POST", "/admin/dispatch/events", admin, { country: "SE", name: "Bad", location: { lat: 59.37, lng: 18.0 }, startsAt: endsAt, endsAt: startsAt, details })).json()).toMatchObject({ reason: "ends_before_start" });
    const made = await call(app, "POST", "/admin/dispatch/events", admin, { country: "SE", name: "Friends Arena concert", location: { lat: 59.3727, lng: 18.0002 }, startsAt, endsAt, details });
    expect(made.statusCode, made.body).toBe(201);
    const event = made.json();
    await new Promise((r) => setTimeout(r, 150));
    expect(heard.map((h) => JSON.parse(h)).some((p: { doc: string; zoneId: string }) => p.doc === "events" && p.zoneId === "Z001")).toBe(true);
    await listener.query("UNLISTEN *");
    listener.release();
    let seen = (await call(app, "GET", "/driver/events", drivers.A.headers)).json();
    expect(seen.items).toEqual([expect.objectContaining({ eventId: event.eventId, location: { lat: 59.3727, lng: 18.0002 }, running: false, title: "Concert at Friends Arena", pickupNote: "Pick up at gate 3", language: "en" })]);
    await database.db.updateTable("drivers").set({ language: "sv" }).where("driver_id", "=", drivers.A.id).execute();
    seen = (await call(app, "GET", "/driver/events", drivers.A.headers)).json();
    expect(seen.items[0]).toMatchObject({ title: "Konsert på Friends Arena", language: "sv" });
    // A Paris driver sees nothing of Sweden.
    expect((await call(app, "GET", "/driver/events", drivers.C.headers)).json().items).toEqual([]);
    // Off → hidden.
    const off = await call(app, "PUT", `/admin/dispatch/events/${event.eventId}`, admin, { expectedVersion: 1, on: false });
    expect(off.json()).toMatchObject({ on: false, version: 2 });
    expect((await call(app, "GET", "/driver/events", drivers.A.headers)).json().items).toEqual([]);
    // France has its own; ended ones are hidden.
    const paris = await call(app, "POST", "/admin/dispatch/events", admin, { country: "FR", name: "Salon", location: { lat: 48.83, lng: 2.29 }, startsAt: new Date(clock.now.getTime() - 3600_000).toISOString(), endsAt: new Date(clock.now.getTime() + 600_000).toISOString(), details });
    expect(paris.statusCode).toBe(201);
    await database.db.updateTable("drivers").set({ language: "fr" }).where("driver_id", "=", drivers.C.id).execute();
    expect((await call(app, "GET", "/driver/events", drivers.C.headers)).json().items[0]).toMatchObject({ running: true, title: "Concert au Friends Arena", language: "fr" });
    clock.now = new Date(clock.now.getTime() + 700_000);
    expect((await call(app, "GET", "/driver/events", drivers.C.headers)).json().items).toEqual([]);
    expect((await audits("dispatch.event.update")).length).toBeGreaterThan(0);
  });
});

describe("Offline reason (owner 'Send the real reason')", () => {
  const profile = async (key: "A" | "B" | "C") => (await call(app, "GET", "/driver/profile", drivers[key].headers)).json();
  const lastNotice = async (driverId: string) => database.db.selectFrom("notifications").selectAll().where("subject_id", "=", driverId).where("kind", "=", "set_offline").orderBy("created_at", "desc").orderBy("notification_id", "desc").executeTakeFirst();

  it("missed offers → missed_offers with the count; going online clears it", async () => {
    const doc = sample("driver_app_config");
    doc.offers.autoOffline.missedExclusive = 1;
    await database.db.updateTable("config_live").set({ document: JSON.stringify(doc) }).where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
    const tripId = await book();
    expect((await call(app, "POST", `/admin/trips/${tripId}/assign`, admin, { expectedVersion: await version(tripId), driverId: drivers.A.id })).statusCode).toBe(200);
    const [offer] = await openOffers("A");
    // Owner 2026-11-16 (contract v0.18.120): he lets it run out (a decline no longer counts).
    clock.now = new Date(new Date(offer!.expiresAt).getTime() + 1000);
    await worker.runDue();
    expect(await profile("A")).toMatchObject({ onlineStatus: "offline", offlineReason: "missed_offers", offlineAt: clock.now.toISOString() });
    const notice = await lastNotice(drivers.A.id);
    // v0.18.66 §87 (contract.json#noticeLanguage): a Swedish driver with no language set reads his country's language (was English).
    expect(notice).toMatchObject({ body: "Du lät 1 Exklusiva erbjudanden gå ut i rad", data: { reason: "missed_offers", count: 1 } });
    await database.db.updateTable("config_live").set({ document: JSON.stringify(sample("driver_app_config")) }).where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
    await database.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", tripId).execute();
    const v = (await profile("A")).version;
    const back = await call(app, "POST", "/driver/availability", drivers.A.headers, { expectedVersion: v, onlineStatus: "online", location: { ...SPOTS.A, accuracy: 5, measuredAt: clock.now.toISOString() } });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).not.toHaveProperty("offlineReason");
  });

  it("car blocked → vehicle_blocked with the admin's note; account on hold → account_status (Swedish text)", async () => {
    const car = (await call(app, "GET", `/admin/vehicles?q=DTL00B`, admin)).json().items[0];
    const blocked = await call(app, "POST", `/admin/vehicles/${drivers.B.vehicleId}/review`, admin, { expectedVersion: car.version, decision: "blocked", note: "Insurance missing" });
    expect(blocked.statusCode, blocked.body).toBe(200);
    expect(await profile("B")).toMatchObject({ onlineStatus: "offline", offlineReason: "vehicle_blocked", offlineNote: "Insurance missing" });
    expect((await lastNotice(drivers.B.id))?.data).toMatchObject({ reason: "vehicle_blocked", note: "Insurance missing" });
    await database.db.updateTable("drivers").set({ language: "sv" }).where("driver_id", "=", drivers.A.id).execute();
    const a = await profile("A");
    expect((await call(app, "POST", `/admin/drivers/${drivers.A.id}/status`, admin, { expectedVersion: a.version, accountStatus: "on_hold", note: "Check papers" })).statusCode).toBe(200);
    expect(await profile("A")).toMatchObject({ offlineReason: "account_status" });
    expect((await profile("A"))).not.toHaveProperty("offlineNote");
    expect((await lastNotice(drivers.A.id))?.body).toBe("Ditt konto är pausat – kontakta Movera");
  });

  it("no position → no_position with the minutes; removed from the fleet → fleet_removed; leaving himself → none; blocked during a trip → reason at its end", async () => {
    await database.db.updateTable("driver_locations").set({ received_at: new Date(clock.now.getTime() - 10 * 60_000) }).where("driver_id", "=", drivers.A.id).execute();
    await database.db.transaction().execute((trx) => setOfflineWithoutPosition(trx, clock.now));
    expect(await profile("A")).toMatchObject({ offlineReason: "no_position" });
    expect((await lastNotice(drivers.A.id))?.data).toMatchObject({ reason: "no_position", minutes: 5 });
    await database.db.transaction().execute(async (trx) => unlinkFromFleet(trx, await loadDriver(trx, drivers.B.id, true), clock.now, "removed_by_admin"));
    expect(await profile("B")).toMatchObject({ offlineReason: "fleet_removed" });
    await database.db.updateTable("drivers").set({ online_status: "online", offline_reason: null }).where("driver_id", "=", drivers.B.id).execute();
    await database.db.transaction().execute(async (trx) => unlinkFromFleet(trx, await loadDriver(trx, drivers.B.id, true), clock.now, "left"));
    expect(await profile("B")).not.toHaveProperty("offlineReason");
    await database.db.updateTable("drivers").set({ online_status: "on_trip", account_status: "suspended", offline_reason: null }).where("driver_id", "=", drivers.C.id).execute();
    await database.db.transaction().execute((trx) => releaseDriver(trx, drivers.C.id, clock.now));
    expect(await profile("C")).toMatchObject({ onlineStatus: "offline", offlineReason: "account_status" });
    const reasons = (contract as unknown as { driverHome: { setOffline: { reasons: Record<string, Record<string, string>> } } }).driverHome.setOffline.reasons;
    for (const r of Object.values(reasons)) for (const l of ["sv", "fr", "en"]) expect(r[l]!.length).toBeGreaterThan(0);
  });
});

describe("G4-F3..F6: list, change and delete groups, radar zones, rules and events (admin tools CRUD)", () => {
  it("groups: list per country, rename, change members (country check), version mismatch, not found, delete; Swedish admin sees Sweden only", async () => {
    const made = (await call(app, "POST", "/admin/dispatch/groups", admin, { country: "SE", name: "Night shift", driverIds: [drivers.A.id] })).json();
    expect(made).toMatchObject({ version: 1, driverIds: [drivers.A.id] });
    const listed = (await call(app, "GET", "/admin/dispatch/groups?country=SE", admin)).json().items;
    expect(listed.map((g: { groupId: string }) => g.groupId)).toContain(made.groupId);
    expect((await call(app, "PUT", `/admin/dispatch/groups/${made.groupId}`, admin, { expectedVersion: 1, driverIds: [drivers.C.id] })).json()).toMatchObject({ reason: "driver_not_in_country" });
    const changed = (await call(app, "PUT", `/admin/dispatch/groups/${made.groupId}`, admin, { expectedVersion: 1, name: "Night crew", driverIds: [drivers.A.id, drivers.B.id] })).json();
    expect(changed).toMatchObject({ name: "Night crew", version: 2, driverIds: [drivers.A.id, drivers.B.id] });
    expect((await call(app, "PUT", `/admin/dispatch/groups/${made.groupId}`, admin, { expectedVersion: 1, name: "Stale" })).json()).toMatchObject({ code: "version_mismatch" });
    expect((await call(app, "PUT", "/admin/dispatch/groups/dgr_nothing", admin, { expectedVersion: 1, name: "X" })).json()).toMatchObject({ reason: "group_not_found" });
    const swede = (await adminSession(app, database.db, "ops", { zoneIds: ["Z001"], now: clock.now })).headers;
    expect((await call(app, "GET", "/admin/dispatch/groups", swede)).json().items.every((g: { country: string }) => g.country === "SE")).toBe(true);
    expect((await call(app, "DELETE", `/admin/dispatch/groups/${made.groupId}?expectedVersion=1`, admin)).json()).toMatchObject({ code: "version_mismatch" });
    expect((await call(app, "DELETE", `/admin/dispatch/groups/${made.groupId}?expectedVersion=2`, admin)).statusCode).toBe(204);
    expect((await call(app, "DELETE", `/admin/dispatch/groups/${made.groupId}?expectedVersion=2`, admin)).json()).toMatchObject({ reason: "group_not_found" });
    expect((await audits("dispatch.group.delete")).map((a) => a.target_id)).toContain(made.groupId);
  });

  it("radar zones and rules: list, rename, redraw (shape check), rule zones must be of the country, delete in order", async () => {
    const zone = (await call(app, "POST", "/admin/dispatch/radar-zones", admin, { zoneId: "Z001", name: "CRUD zone", polygon: AROUND_A })).json();
    expect((await call(app, "GET", "/admin/dispatch/radar-zones?country=SE", admin)).json().items.map((z: { radarZoneId: string }) => z.radarZoneId)).toContain(zone.radarZoneId);
    expect((await call(app, "PUT", `/admin/dispatch/radar-zones/${zone.radarZoneId}`, admin, { expectedVersion: 1, polygon: [[59.33, 18.06], [59.33, 18.06], [59.33, 18.06]] })).json()).toMatchObject({ reason: "invalid_polygon" });
    const bigger: Array<[number, number]> = [[59.331, 18.062], [59.331, 18.069], [59.336, 18.069], [59.336, 18.062]];
    const redrawn = (await call(app, "PUT", `/admin/dispatch/radar-zones/${zone.radarZoneId}`, admin, { expectedVersion: 1, name: "CRUD zone 2", polygon: bigger })).json();
    expect(redrawn).toMatchObject({ name: "CRUD zone 2", version: 2, polygon: bigger });
    expect((await call(app, "PUT", "/admin/dispatch/radar-zones/rzn_nothing", admin, { expectedVersion: 1, name: "X" })).json()).toMatchObject({ reason: "radar_zone_not_found" });
    expect((await call(app, "DELETE", "/admin/dispatch/radar-zones/rzn_nothing?expectedVersion=1", admin)).json()).toMatchObject({ reason: "radar_zone_not_found" });

    expect((await call(app, "POST", "/admin/dispatch/radar-rules", admin, { country: "FR", name: "Wrong country", radarZoneIds: [zone.radarZoneId], seconds: 20, maxDrivers: 5, repeat: false })).json()).toMatchObject({ reason: "zone_not_in_country", details: [zone.radarZoneId] });
    const rule = (await call(app, "POST", "/admin/dispatch/radar-rules", admin, { country: "SE", name: "CRUD rule", radarZoneIds: [zone.radarZoneId], seconds: 20, maxDrivers: 5, repeat: false })).json();
    expect((await call(app, "GET", "/admin/dispatch/radar-rules?country=SE", admin)).json().items.map((r: { ruleId: string }) => r.ruleId)).toContain(rule.ruleId);
    expect((await call(app, "PUT", `/admin/dispatch/radar-rules/${rule.ruleId}`, admin, { expectedVersion: 1, radarZoneIds: ["rzn_nothing"] })).json()).toMatchObject({ reason: "zone_not_in_country" });
    const changedRule = (await call(app, "PUT", `/admin/dispatch/radar-rules/${rule.ruleId}`, admin, { expectedVersion: 1, name: "CRUD rule 2", radarZoneIds: "all", seconds: 30, maxDrivers: 2, repeat: true })).json();
    expect(changedRule).toMatchObject({ name: "CRUD rule 2", version: 2, radarZoneIds: "all", seconds: 30, maxDrivers: 2, repeat: true });
    expect((await call(app, "PUT", `/admin/dispatch/radar-rules/${rule.ruleId}`, admin, { expectedVersion: 1, name: "Stale" })).json()).toMatchObject({ code: "version_mismatch" });
    expect((await call(app, "PUT", "/admin/dispatch/radar-rules/rzr_nothing", admin, { expectedVersion: 1, name: "X" })).json()).toMatchObject({ reason: "radar_rule_not_found" });
    expect((await call(app, "DELETE", `/admin/dispatch/radar-rules/${rule.ruleId}?expectedVersion=1`, admin)).json()).toMatchObject({ code: "version_mismatch" });
    expect((await call(app, "DELETE", `/admin/dispatch/radar-rules/${rule.ruleId}?expectedVersion=2`, admin)).statusCode).toBe(204);
    expect((await call(app, "DELETE", `/admin/dispatch/radar-zones/${zone.radarZoneId}?expectedVersion=2`, admin)).statusCode).toBe(204);
    expect((await audits("dispatch.radar_rule.delete")).map((a) => a.target_id)).toContain(rule.ruleId);
    expect((await audits("dispatch.radar_zone.delete")).map((a) => a.target_id)).toContain(zone.radarZoneId);
  });

  it("events: list per country and time window, not found, version mismatch, delete signals the drivers", async () => {
    const details = { title: { sv: "Match", fr: "Match", en: "Match" }, description: { sv: "Slutar 22:00", fr: "Fin 22 h", en: "Ends 22:00" }, pickupNote: { sv: "Port 1", fr: "Porte 1", en: "Gate 1" } };
    const startsAt = new Date(clock.now.getTime() + 24 * 3600_000).toISOString();
    const endsAt = new Date(clock.now.getTime() + 27 * 3600_000).toISOString();
    const event = (await call(app, "POST", "/admin/dispatch/events", admin, { country: "SE", name: "CRUD match", location: { lat: 59.37, lng: 18.0 }, startsAt, endsAt, details })).json();
    const inWindow = (await call(app, "GET", `/admin/dispatch/events?country=SE&from=${encodeURIComponent(startsAt)}&to=${encodeURIComponent(endsAt)}`, admin)).json().items;
    expect(inWindow.map((e: { eventId: string }) => e.eventId)).toContain(event.eventId);
    const later = new Date(clock.now.getTime() + 48 * 3600_000).toISOString();
    const outside = (await call(app, "GET", `/admin/dispatch/events?country=SE&from=${encodeURIComponent(later)}`, admin)).json().items;
    expect(outside.map((e: { eventId: string }) => e.eventId)).not.toContain(event.eventId);
    expect((await call(app, "GET", "/admin/dispatch/events?country=FR", admin)).json().items.map((e: { eventId: string }) => e.eventId)).not.toContain(event.eventId);
    expect((await call(app, "PUT", "/admin/dispatch/events/evt_nothing", admin, { expectedVersion: 1, on: false })).json()).toMatchObject({ reason: "event_not_found" });
    expect((await call(app, "PUT", `/admin/dispatch/events/${event.eventId}`, admin, { expectedVersion: 1, startsAt: endsAt, endsAt: startsAt })).json()).toMatchObject({ reason: "ends_before_start" });
    expect((await call(app, "DELETE", `/admin/dispatch/events/${event.eventId}?expectedVersion=9`, admin)).json()).toMatchObject({ code: "version_mismatch" });
    const listener = await database.pool.connect();
    const heard: string[] = [];
    listener.on("notification", (n) => heard.push(n.payload ?? ""));
    await listener.query("LISTEN movera_config_published");
    expect((await call(app, "DELETE", `/admin/dispatch/events/${event.eventId}?expectedVersion=1`, admin)).statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 150));
    await listener.query("UNLISTEN *");
    listener.release();
    expect(heard.map((h) => JSON.parse(h)).some((p: { doc: string }) => p.doc === "events")).toBe(true);
    expect((await call(app, "GET", "/admin/dispatch/events?country=SE", admin)).json().items.map((e: { eventId: string }) => e.eventId)).not.toContain(event.eventId);
    expect((await audits("dispatch.event.delete")).map((a) => a.target_id)).toContain(event.eventId);
  });
});
