import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../src/ids.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { approveVehicleDocuments, insertDriver } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/**
 * Contract v0.18.0 (contract.json#driverOnboarding.adminActions): the group 2 admin items on live, for Sweden and
 * France: Vehicles › Update (within the car rules), Vehicles › Link driver, Drivers › Category, Drivers › Bank details.
 * Audited and limited to the admin's zones.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-03T09:00:00Z") };

const COUNTRIES = [
  { country: "SE", zone: "Z001", city: "stockholm_lan", base: 2015, papers: ["vehicle_registration", "insurance"] },
  { country: "FR", zone: "FR-PC", city: "paris", base: 2016, papers: ["vehicle_registration", "insurance", "vtc_sticker"] },
] as const;
type Country = (typeof COUNTRIES)[number];

async function world(c: Country) {
  const ownerId = await insertDriver(database.db);
  const memberId = await insertDriver(database.db);
  const fleetId = newId("flt");
  await database.db.insertInto("fleets").values({ fleet_id: fleetId, owner_driver_id: ownerId, name: `${c.country} Taxi`, org_number: "000000-0000", address: "Gatan 1", country: c.country, city_id: c.city, zone_id: c.zone, status: "approved", created_at: clock.now, updated_at: clock.now } as never).execute();
  for (const [id, type] of [[ownerId, "fleet"], [memberId, "driver"]] as const) {
    await database.db.updateTable("drivers").set({ country: c.country, zone_ids: [c.zone], account_status: "active", account_type: type, fleet_id: fleetId }).where("driver_id", "=", id).execute();
  }
  const vehicleId = newId("veh");
  await database.db.insertInto("vehicles").values({ vehicle_id: vehicleId, fleet_id: fleetId, driver_id: null, make: "Volvo", model: "V60", year: 2021, color: "Grey", plate: `${c.country}-${Math.floor(Math.random() * 1e6)}`, seats: 4, category_ids: ["economy", "comfort"], status: "approved", created_at: clock.now, updated_at: clock.now } as never).execute();
  return { ownerId, memberId, fleetId, vehicleId };
}
const vehicleVersion = async (id: string) => (await database.db.selectFrom("vehicles").select("version").where("vehicle_id", "=", id).executeTakeFirstOrThrow()).version;
const driverVersion = async (id: string) => (await database.db.selectFrom("drivers").select("version").where("driver_id", "=", id).executeTakeFirstOrThrow()).version;
const audits = async (action: string, targetId: string) => database.db.selectFrom("admin_audit").selectAll().where("action", "=", action).where("target_id", "=", targetId).execute();

let away: { headers: Record<string, string> };

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

for (const c of COUNTRIES) {
  describe(`${c.country}: the admin's car and driver items on live`, () => {
    let w: Awaited<ReturnType<typeof world>>;
    let admin: { headers: Record<string, string> };
    beforeAll(async () => {
      w = await world(c);
      admin = await adminSession(app, database.db, "ops", { zoneIds: [c.zone], now: clock.now });
      away = await adminSession(app, database.db, "ops", { zoneIds: [c.country === "SE" ? "FR-PC" : "Z001"], now: clock.now });
    });

    it("Vehicles › Update: refuses a change the car rules do not allow, saves one they do, and audits it", async () => {
      const old = await call(app, "PATCH", `/admin/vehicles/${w.vehicleId}`, admin.headers, { expectedVersion: await vehicleVersion(w.vehicleId), year: c.base - 1 });
      expect(old.json()).toMatchObject({ code: "invalid_request", reason: "category_not_allowed", details: [`economy:year_too_old`, `comfort:year_too_old`] });
      const xl = await call(app, "PATCH", `/admin/vehicles/${w.vehicleId}`, admin.headers, { expectedVersion: await vehicleVersion(w.vehicleId), categoryIds: ["economy", "xl"] });
      expect(xl.json()).toMatchObject({ reason: "category_not_allowed", details: ["xl:too_few_seats"] });
      const ok = await call(app, "PATCH", `/admin/vehicles/${w.vehicleId}`, admin.headers, { expectedVersion: await vehicleVersion(w.vehicleId), seats: 7, fuel: "hybrid", categoryIds: ["economy", "comfort", "xl"] });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ seats: 7, fuel: "hybrid", categoryIds: ["economy", "comfort", "xl"] });
      expect(await audits("vehicle.update", w.vehicleId)).toHaveLength(1);
    });

    it("Vehicles › Link driver: only a driver of the fleet, only a car with its documents, then it is his", async () => {
      const outsider = await insertDriver(database.db);
      const notFleet = await call(app, "POST", `/admin/vehicles/${w.vehicleId}/driver`, admin.headers, { expectedVersion: await vehicleVersion(w.vehicleId), driverId: outsider });
      expect(notFleet.json()).toMatchObject({ code: "invalid_request", reason: "driver_not_in_fleet" });
      const papersMissing = await call(app, "POST", `/admin/vehicles/${w.vehicleId}/driver`, admin.headers, { expectedVersion: await vehicleVersion(w.vehicleId), driverId: w.memberId });
      expect(papersMissing.json()).toMatchObject({ code: "documents_not_approved", reason: "vehicle_documents_not_approved" });
      await approveVehicleDocuments(database.db, w.vehicleId, w.ownerId, c.country);
      const linked = await call(app, "POST", `/admin/vehicles/${w.vehicleId}/driver`, admin.headers, { expectedVersion: await vehicleVersion(w.vehicleId), driverId: w.memberId });
      expect(linked.json()).toMatchObject({ vehicleId: w.vehicleId, driverId: w.memberId });
      const member = await database.db.selectFrom("drivers").select(["vehicle_id", "category_ids"]).where("driver_id", "=", w.memberId).executeTakeFirstOrThrow();
      expect(member).toEqual({ vehicle_id: w.vehicleId, category_ids: ["economy", "comfort", "xl"] });
      expect(await audits("vehicle.link_driver", w.vehicleId)).toHaveLength(1);
    });

    it("Drivers › Category: only categories the driver's car has and fits", async () => {
      const notOnCar = await call(app, "PUT", `/admin/drivers/${w.memberId}/categories`, admin.headers, { expectedVersion: await driverVersion(w.memberId), categoryIds: ["economy", "premium"] });
      expect(notOnCar.json()).toMatchObject({ code: "invalid_request", reason: "category_not_allowed", details: ["premium:not_on_car"] });
      const ok = await call(app, "PUT", `/admin/drivers/${w.memberId}/categories`, admin.headers, { expectedVersion: await driverVersion(w.memberId), categoryIds: ["xl"] });
      expect(ok.json()).toMatchObject({ driverId: w.memberId, categoryIds: ["xl"] });
      // The car loses XL: the driver keeps only what the car still has.
      await call(app, "PATCH", `/admin/vehicles/${w.vehicleId}`, admin.headers, { expectedVersion: await vehicleVersion(w.vehicleId), categoryIds: ["economy"] });
      expect((await database.db.selectFrom("drivers").select("category_ids").where("driver_id", "=", w.memberId).executeTakeFirstOrThrow()).category_ids).toEqual([]);
      const noCar = await call(app, "PUT", `/admin/drivers/${w.ownerId}/categories`, admin.headers, { expectedVersion: await driverVersion(w.ownerId), categoryIds: ["economy"] });
      expect(noCar.json()).toMatchObject({ code: "invalid_transition", reason: "no_vehicle" });
      expect(await audits("driver.categories", w.memberId)).toHaveLength(1);
      // Unlink: the car is free again.
      const freed = await call(app, "POST", `/admin/vehicles/${w.vehicleId}/driver`, admin.headers, { expectedVersion: await vehicleVersion(w.vehicleId), driverId: null });
      expect(freed.json()).not.toHaveProperty("driverId");
    });

    it("Drivers › Bank details: approve or reject (with a reason) the uploaded bank document", async () => {
      const none = await call(app, "POST", `/admin/drivers/${w.ownerId}/bank/review`, admin.headers, { decision: "approved" });
      expect(none.json()).toMatchObject({ code: "not_found", reason: "bank_not_uploaded" });
      await database.db.insertInto("documents").values({ document_id: newId("doc"), driver_id: w.ownerId, owner_kind: "driver", owner_id: w.ownerId, type: "bank_statement", status: "in_review", created_at: clock.now, updated_at: clock.now }).execute();
      const noNote = await call(app, "POST", `/admin/drivers/${w.ownerId}/bank/review`, admin.headers, { decision: "rejected" });
      expect(noNote.json()).toMatchObject({ reason: "note_required" });
      const ok = await call(app, "POST", `/admin/drivers/${w.ownerId}/bank/review`, admin.headers, { decision: "approved" });
      expect(ok.json()).toMatchObject({ type: "bank_statement", status: "approved" });
    });

    it("an admin of another country's zone gets 403 on every one of them, whatever the body", async () => {
      for (const [method, url] of [["PATCH", `/admin/vehicles/${w.vehicleId}`], ["POST", `/admin/vehicles/${w.vehicleId}/driver`], ["PUT", `/admin/drivers/${w.memberId}/categories`], ["POST", `/admin/drivers/${w.ownerId}/bank/review`]] as const) {
        const res = await call(app, method, url, away.headers, { nonsense: true });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json()).toMatchObject({ reason: "zone_out_of_scope" });
      }
    });
  });
}
