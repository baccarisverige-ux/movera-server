import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepAlerts } from "../../src/alerts/detector.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";

/**
 * Contract v0.18.161 (alertDesk kind car_no_country; owner 2026-11-25 "Show as errors and must check what happen"): a car
 * with no country is a server alert (group system) in every country that has a zone; solved once the car has a country.
 */
let database: TestDatabase;
const NOW = new Date("2026-11-25T10:00:00Z");
beforeEach(async () => {
  database = await freshDatabase();
});
afterEach(async () => {
  await database.drop();
});
const db = () => database.db;
const sweep = () => db().transaction().execute((trx) => sweepAlerts(trx, NOW));
const alerts = () => db().selectFrom("admin_alerts_live").selectAll().where("kind", "=", "car_no_country").orderBy("country").execute();
const car = (id: string, driver: string | null) => ({ vehicle_id: id, make: "Volvo", model: "V60", year: 2022, color: "grey", plate: `NC ${id.slice(-3)}`, fleet_id: null, driver_id: driver, created_at: NOW, updated_at: NOW });

describe("car_no_country alert (v0.18.161)", () => {
  it("a car with no country alerts in every zone country; a car with a country does not; solved when it gets one", async () => {
    const lost = await insertDriver(db());
    const fine = await insertDriver(db());
    await db().updateTable("drivers").set({ country: null }).where("driver_id", "=", lost).execute();
    await db().updateTable("drivers").set({ country: "SE" }).where("driver_id", "=", fine).execute();
    await db().insertInto("vehicles").values([car("veh_nc_001", lost), car("veh_nc_002", fine), car("veh_nc_003", null)] as never).execute();
    await sweep();
    const zoneCountries = [...new Set((await db().selectFrom("zones").select("country").execute()).map((z) => z.country))].sort();
    const rows = await alerts();
    expect(rows.length).toBe(zoneCountries.length * 2);
    for (const r of rows) expect(r).toMatchObject({ state: "open", level: "important", zone_id: null });
    expect(new Set(rows.map((r) => r.title))).toEqual(new Set(["Car with no country: NC 001", "Car with no country: NC 003"]));
    expect(new Set(rows.map((r) => (r.ref as { vehicleId?: string }).vehicleId))).toEqual(new Set(["veh_nc_001", "veh_nc_003"]));
    await sweep();
    expect((await alerts()).length).toBe(zoneCountries.length * 2);
    await db().updateTable("drivers").set({ country: "SE" }).where("driver_id", "=", lost).execute();
    await db().deleteFrom("vehicles").where("vehicle_id", "=", "veh_nc_003").execute();
    await sweep();
    expect((await alerts()).filter((r) => r.state === "open")).toEqual([]);
  });
});
