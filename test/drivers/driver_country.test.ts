import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { sweepAlerts } from "../../src/alerts/detector.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.162 (contract.json#driverCountryFirst; owner 2026-11-25 "Yes"): the country is picked first
 * (PUT /driver/country), no car without a country (409 country_required), a changed country moves the zone too, the
 * admin change (POST /admin/drivers/{id}/country: reason, scope, fleet rules, cars
 * re-checked, audit) and the alert driver_no_country.
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-25T10:00:00Z") };
let admin: { headers: Record<string, string>; adminId: string };
const db = () => database.db;
const car = (plate: string) => ({ make: "Volvo", model: "V60", color: "Black", seats: 4, year: 2022, plate, fuel: "hybrid" });
const details = (extra: Record<string, unknown> = {}) => ({
  firstName: "Ana", lastName: "Berg", dateOfBirth: "1985-03-12", email: "ana@example.se", country: "SE", cityId: "stockholm_lan", language: "sv",
  accountType: "fleet", termsAccepted: true, company: { name: "Berg Taxi AB", orgNumber: "556677-8899", address: "Storgatan 1" }, ...extra,
});
const row = (id: string) => db().selectFrom("drivers").selectAll().where("driver_id", "=", id).executeTakeFirstOrThrow();

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  admin = await adminSession(app, database.db, "super", { now: clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("v0.18.162 driver country first", () => {
  it("a new driver has no country; no car before it; the step saves it with the country's zone; closed countries refused", async () => {
    const me = (await signIn(app, TEST_PHONES[0]!, "driver")).headers;
    const view = (await call(app, "GET", "/driver/profile", me)).json();
    expect(view.country).toBeUndefined();
    const refused = await call(app, "POST", "/driver/vehicles", me, car("DC 100"));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: "country_required" });
    expect(await db().selectFrom("vehicles").select("vehicle_id").where("plate", "=", "DC 100").execute()).toEqual([]);
    expect((await call(app, "PUT", "/driver/country", me, { country: "TN" })).json()).toMatchObject({ reason: "country_not_open" });
    const saved = await call(app, "PUT", "/driver/country", me, { country: "FR" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().country).toBe("FR");
    const r = await row(saved.json().driverId);
    expect(r.zone_ids).toEqual(["FR-PC"]);
    // Changed on the step before approval: the zone and city follow the new country (M1), then the form goes through
    // and a car can be added.
    expect((await call(app, "PUT", "/driver/country", me, { country: "SE" })).statusCode).toBe(200);
    expect(await row(saved.json().driverId)).toMatchObject({ country: "SE", zone_ids: ["Z001"], city_id: "stockholm_lan" });
    expect((await call(app, "POST", "/driver/onboarding", me, details())).statusCode).toBe(200);
    expect((await call(app, "POST", "/driver/vehicles", me, car("DC 101"))).statusCode).toBe(201);
  });

  it("admin change: reason required, fleet owner alone moves his fleet, cars re-checked, audit; approved driver cannot use the step", async () => {
    const me = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    await call(app, "PUT", "/driver/country", me, { country: "SE" });
    const d = (await call(app, "POST", "/driver/onboarding", me, details({ email: "b@example.se", company: { name: "B AB", orgNumber: "556677-0001", address: "Gatan 2" } }))).json();
    expect((await call(app, "POST", "/driver/vehicles", me, car("DC 200"))).statusCode).toBe(201);
    await db().updateTable("vehicles").set({ status: "approved" }).where("plate", "=", "DC 200").execute();
    await db().updateTable("drivers").set({ account_status: "active" }).where("driver_id", "=", d.driverId).execute();
    expect((await call(app, "PUT", "/driver/country", me, { country: "FR" })).json()).toMatchObject({ reason: "details_locked" });
    const v = (await row(d.driverId)).version;
    const noReason = await call(app, "POST", `/admin/drivers/${d.driverId}/country`, admin.headers, { expectedVersion: v, country: "FR", reason: " " });
    expect(noReason.json()).toMatchObject({ reason: "reason_required" });
    const stale = await call(app, "POST", `/admin/drivers/${d.driverId}/country`, admin.headers, { expectedVersion: v + 5, country: "FR", reason: "Works in Paris" });
    expect(stale.json()).toMatchObject({ code: "version_mismatch" });
    const ok = await call(app, "POST", `/admin/drivers/${d.driverId}/country`, admin.headers, { expectedVersion: v, country: "FR", reason: "Works in Paris" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().country).toBe("FR");
    const r = await row(d.driverId);
    expect(r).toMatchObject({ country: "FR", zone_ids: ["FR-PC"], city_id: "paris" });
    const fleet = await db().selectFrom("fleets").selectAll().where("owner_driver_id", "=", d.driverId).executeTakeFirstOrThrow();
    expect(fleet).toMatchObject({ country: "FR", city_id: "paris", zone_id: "FR-PC" });
    const entry = await db().selectFrom("admin_audit").selectAll().where("action", "=", "driver.country").where("target_id", "=", d.driverId).executeTakeFirstOrThrow();
    expect(entry.detail).toMatchObject({ from: "SE", to: "FR", reason: "Works in Paris", fleetMoved: true });
    // A missing reason is reason_required; the same country again writes no second audit entry; TN (no city) is refused.
    const fv = (await row(d.driverId)).version;
    expect((await call(app, "POST", `/admin/drivers/${d.driverId}/country`, admin.headers, { expectedVersion: fv, country: "FR" })).json()).toMatchObject({ reason: "reason_required" });
    expect((await call(app, "POST", `/admin/drivers/${d.driverId}/country`, admin.headers, { expectedVersion: fv, country: "FR", reason: "again" })).statusCode).toBe(200);
    expect((await db().selectFrom("admin_audit").selectAll().where("action", "=", "driver.country").where("target_id", "=", d.driverId).execute()).length).toBe(1);
    expect((await call(app, "POST", `/admin/drivers/${d.driverId}/country`, admin.headers, { expectedVersion: fv, country: "TN", reason: "x" })).json()).toMatchObject({ reason: "country_not_open" });
  });

  it("a fleet member cannot be moved away from his fleet's country; a zone admin of another country is refused", async () => {
    const owner = (await signIn(app, TEST_PHONES[2]!, "driver")).headers;
    await call(app, "PUT", "/driver/country", owner, { country: "SE" });
    const o = (await call(app, "POST", "/driver/onboarding", owner, details({ email: "c@example.se", company: { name: "C AB", orgNumber: "556677-0002", address: "Gatan 3" } }))).json();
    const member = (await signIn(app, TEST_PHONES[3]!, "driver")).headers;
    const m = (await call(app, "PUT", "/driver/country", member, { country: "SE" })).json();
    const fleetId = (await row(o.driverId)).fleet_id!;
    await db().updateTable("drivers").set({ fleet_id: fleetId }).where("driver_id", "=", m.driverId).execute();
    const v = (await row(m.driverId)).version;
    const res = await call(app, "POST", `/admin/drivers/${m.driverId}/country`, admin.headers, { expectedVersion: v, country: "FR", reason: "x" });
    expect(res.json()).toMatchObject({ reason: "fleet_other_country" });
    const ov = (await row(o.driverId)).version;
    expect((await call(app, "POST", `/admin/drivers/${o.driverId}/country`, admin.headers, { expectedVersion: ov, country: "FR", reason: "x" })).json()).toMatchObject({ reason: "fleet_other_country" });
    expect((await call(app, "PUT", "/driver/country", member, { country: "FR" })).json()).toMatchObject({ reason: "fleet_other_country" });
    const se = await adminSession(app, database.db, "super", { now: clock.now, zoneIds: ["Z001"] });
    expect((await call(app, "POST", `/admin/drivers/${m.driverId}/country`, se.headers, { expectedVersion: v, country: "FR", reason: "x" })).json()).toMatchObject({ reason: "zone_out_of_scope" });
  });

  it("alert driver_no_country for a driver with data and no country; solved once he has one", async () => {
    const me = (await signIn(app, TEST_PHONES[4]!, "driver")).headers;
    const id = (await call(app, "GET", "/driver/profile", me)).json().driverId;
    await db().updateTable("drivers").set({ account_type: "driver" }).where("driver_id", "=", id).execute();
    await db().transaction().execute((trx) => sweepAlerts(trx, clock.now));
    const open = await db().selectFrom("admin_alerts_live").selectAll().where("kind", "=", "driver_no_country").where("state", "=", "open").execute();
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((a) => (a.ref as { driverId?: string }).driverId === id)).toBe(true);
    await call(app, "PUT", "/driver/country", me, { country: "SE" });
    await db().transaction().execute((trx) => sweepAlerts(trx, clock.now));
    expect(await db().selectFrom("admin_alerts_live").select("alert_id").where("kind", "=", "driver_no_country").where("state", "=", "open").execute()).toEqual([]);
  });

  it("an invited number gets the inviting fleet's country at sign-in; migration 0137 gives members their fleet's country", async () => {
    const fleet = await db().selectFrom("fleets").selectAll().where("country", "=", "SE").orderBy("created_at").executeTakeFirstOrThrow();
    await db().insertInto("fleet_invitations").values({ invitation_id: "inv_dc_001", fleet_id: fleet.fleet_id, direction: "owner_invite", driver_id: null, phone: TEST_PHONES[5]!, expires_at: new Date(clock.now.getTime() + 86400_000), created_at: clock.now, updated_at: clock.now } as never).execute();
    const invited = (await signIn(app, TEST_PHONES[5]!, "driver")).headers;
    const view = (await call(app, "GET", "/driver/profile", invited)).json();
    expect(view.country).toBe(fleet.country);
    expect((await row(view.driverId)).zone_ids).toEqual([fleet.zone_id]);
    // The one-time fix: a member with no country gets the fleet's; a driver with no fleet stays null.
    const lone = await insertDriver(db());
    const member = await insertDriver(db());
    await db().updateTable("drivers").set({ country: null, zone_ids: [] }).where("driver_id", "=", lone).execute();
    await db().updateTable("drivers").set({ country: null, zone_ids: [], fleet_id: fleet.fleet_id }).where("driver_id", "=", member).execute();
    await sql.raw(readFileSync(new URL("../../migrations/0137_driver_country.sql", import.meta.url), "utf8")).execute(db());
    expect(await row(member)).toMatchObject({ country: fleet.country, zone_ids: [fleet.zone_id] });
    expect((await row(lone)).country).toBeNull();
  });
});
