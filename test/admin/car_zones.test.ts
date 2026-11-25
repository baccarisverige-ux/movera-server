import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";
import { adminSession } from "../support/admin.js";
import { testWorld } from "../support/world.js";

/**
 * v0.18.161 (owner 2026-11-25 "Yes, fix it": the admin mixed French and Swedish cars; contract.json#adminListFilters.carZones):
 * GET /admin/vehicles and GET /admin/fleets take zoneId / zoneIds / country like the other admin lists, in the SQL of the
 * page and of total; a car's zone is its fleet's, else its driver's first zone, else none (left out once a filter is
 * given); a named zone outside the admin's is 403 zone_out_of_scope; an unknown key is 400 unknown_filter; the admin's
 * Vehicle carries zoneId / country and Fleet carries zoneId.
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-25T10:00:00Z") };
let superAdmin: Record<string, string>;
let z001Admin: Record<string, string>;
const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });
const ids = (res: { json: () => { items: Array<Record<string, string>> } }, key: string) => res.json().items.map((r) => r[key]).sort();

beforeAll(async () => {
  database = await freshDatabase();
  const db = database.db;
  app = await testWorld(db, database.url, clock);
  const se = await insertDriver(db);
  const fr = await insertDriver(db);
  const loose = await insertDriver(db);
  await db.updateTable("drivers").set({ zone_ids: ["Z001"], country: "SE" }).where("driver_id", "=", se).execute();
  await db.updateTable("drivers").set({ zone_ids: ["FR-PC"], country: "FR" }).where("driver_id", "=", fr).execute();
  await db.updateTable("drivers").set({ zone_ids: [], country: "FR" }).where("driver_id", "=", loose).execute();
  const at = (m: number) => new Date(clock.now.getTime() - m * 60_000);
  await db.insertInto("fleets").values([
    { fleet_id: "flt_cz_se", name: "SE fleet", org_number: "556000-0001", address: "A", country: "SE", city_id: "stockholm", zone_id: "Z001", owner_driver_id: se, status: "approved", version: 1, created_at: at(1), updated_at: at(1) },
    { fleet_id: "flt_cz_fr", name: "FR fleet", org_number: "123456789", address: "B", country: "FR", city_id: "paris", zone_id: "FR-PC", owner_driver_id: fr, status: "pending", version: 1, created_at: at(2), updated_at: at(2) },
  ] as never).execute();
  const car = (n: number, fleet: string | null, driver: string | null) => ({ vehicle_id: `veh_cz_${n}`, make: "Volvo", model: "V60", year: 2022, color: "grey", plate: `CZ ${100 + n}`, fleet_id: fleet, driver_id: driver, category_ids: n === 1 ? ["comfort"] : ["economy"], created_at: at(10 + n), updated_at: at(10 + n) });
  await db.insertInto("vehicles").values([
    car(1, "flt_cz_se", null), // Z001 by its fleet
    car(2, null, se), // Z001 by its driver
    car(3, "flt_cz_fr", null), // FR-PC by its fleet
    car(4, null, fr), // FR-PC by its driver
    car(5, null, loose), // no zone (driver without zones), country FR
    car(6, null, null), // no zone, no country
  ] as never).execute();
  superAdmin = (await adminSession(app, db, "super", { now: clock.now })).headers;
  z001Admin = (await adminSession(app, db, "super", { zoneIds: ["Z001"], now: clock.now })).headers;
});

afterAll(async () => {
  await app?.close();
  await database.drop();
});

describe("v0.18.161 admin cars by zone and country", () => {
  it("no filter: an all-zones admin sees every car, zoneless ones too, with zoneId and country", async () => {
    const res = await get("/admin/vehicles", superAdmin);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().total).toBe(6);
    const by = Object.fromEntries((res.json().items as Array<{ vehicleId: string; zoneId: string | null; country: string | null }>).map((v) => [v.vehicleId, [v.zoneId, v.country]]));
    expect(by).toEqual({ veh_cz_1: ["Z001", "SE"], veh_cz_2: ["Z001", "SE"], veh_cz_3: ["FR-PC", "FR"], veh_cz_4: ["FR-PC", "FR"], veh_cz_5: [null, "FR"], veh_cz_6: [null, null] });
  });

  it("country=SE / country=FR: only that country's zoned cars, total under the same filter", async () => {
    const se = await get("/admin/vehicles?country=SE", superAdmin);
    expect(ids(se, "vehicleId")).toEqual(["veh_cz_1", "veh_cz_2"]);
    expect(se.json().total).toBe(2);
    const fr = await get("/admin/vehicles?country=FR", superAdmin);
    // veh_cz_5 is a French car with no zone: left out once a filter is given.
    expect(ids(fr, "vehicleId")).toEqual(["veh_cz_3", "veh_cz_4"]);
    expect(fr.json().total).toBe(2);
  });

  it("zoneIds and zoneId narrow; with country only the named zones in that country", async () => {
    expect(ids(await get("/admin/vehicles?zoneIds=FR-PC", superAdmin), "vehicleId")).toEqual(["veh_cz_3", "veh_cz_4"]);
    expect(ids(await get("/admin/vehicles?zoneIds=Z001,FR-PC", superAdmin), "vehicleId")).toEqual(["veh_cz_1", "veh_cz_2", "veh_cz_3", "veh_cz_4"]);
    expect(ids(await get("/admin/vehicles?zoneId=Z001", superAdmin), "vehicleId")).toEqual(["veh_cz_1", "veh_cz_2"]);
    const mixed = await get("/admin/vehicles?zoneIds=Z001,FR-PC&country=FR", superAdmin);
    expect(ids(mixed, "vehicleId")).toEqual(["veh_cz_3", "veh_cz_4"]);
    expect(mixed.json().total).toBe(2);
    expect(ids(await get("/admin/vehicles?categoryId=comfort&country=SE", superAdmin), "vehicleId")).toEqual(["veh_cz_1"]);
  });

  it("a zone-limited admin: his zones only; a zone outside them is 403 zone_out_of_scope; a country he does not cover is empty", async () => {
    const own = await get("/admin/vehicles", z001Admin);
    expect(ids(own, "vehicleId")).toEqual(["veh_cz_1", "veh_cz_2"]);
    expect(own.json().total).toBe(2);
    for (const q of ["zoneId=FR-PC", "zoneIds=Z001,FR-PC"]) {
      const res = await get(`/admin/vehicles?${q}`, z001Admin);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "forbidden", reason: "zone_out_of_scope" });
    }
    const fr = await get("/admin/vehicles?country=FR", z001Admin);
    expect(fr.json()).toMatchObject({ items: [], nextCursor: null, total: 0 });
  });

  it("an unknown key is 400 unknown_filter", async () => {
    const res = await get("/admin/vehicles?colour=red", superAdmin);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ reason: "unknown_filter" });
    expect((await get("/admin/fleets?colour=red", superAdmin)).json()).toMatchObject({ reason: "unknown_filter" });
  });

  it("fleets: zoneId on every row; zoneIds / country narrow with total; outside is 403", async () => {
    const all = await get("/admin/fleets", superAdmin);
    expect(all.statusCode, all.body).toBe(200);
    expect(Object.fromEntries((all.json().items as Array<{ fleetId: string; zoneId: string }>).map((f) => [f.fleetId, f.zoneId]))).toEqual({ flt_cz_se: "Z001", flt_cz_fr: "FR-PC" });
    const fr = await get("/admin/fleets?country=FR", superAdmin);
    expect(ids(fr, "fleetId")).toEqual(["flt_cz_fr"]);
    expect(fr.json().total).toBe(1);
    expect(ids(await get("/admin/fleets?zoneIds=Z001", superAdmin), "fleetId")).toEqual(["flt_cz_se"]);
    expect(ids(await get("/admin/fleets?zoneId=FR-PC&status=pending", superAdmin), "fleetId")).toEqual(["flt_cz_fr"]);
    expect(ids(await get("/admin/fleets", z001Admin), "fleetId")).toEqual(["flt_cz_se"]);
    const out = await get("/admin/fleets?zoneIds=FR-PC", z001Admin);
    expect(out.statusCode).toBe(403);
    expect(out.json()).toMatchObject({ reason: "zone_out_of_scope" });
  });

});
