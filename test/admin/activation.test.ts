import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activationBlockers } from "../../src/drivers/readiness.js";
import { requiredDocuments } from "../../src/drivers/onboardingRules.js";
import { newId } from "../../src/ids.js";
import { setAvailability } from "../../src/drivers/service.js";
import { ApiError } from "../../src/http/errors.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { approveDriverDocuments, approveFleetDocuments, approveVehicleDocuments, insertDriver } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/**
 * Contract v0.14.0 (driverOnboarding.activation, owner decision 2026-10-28): activation needs the person's driver
 * documents, and for a fleet owner the company's too; no car. A car is picked or driven only with its documents approved.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-28T09:00:00Z") };
const driverDocs = requiredDocuments("SE", "driver");
const fleetDocs = requiredDocuments("SE", "fleet");
const scoped = (scope: string, types: string[]) => types.map((t) => `${scope}:${t}`);

async function swedishDriver(accountType: "driver" | "fleet" = "driver"): Promise<string> {
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ country: "SE", zone_ids: ["Z001"], account_status: "on_hold", account_type: accountType }).where("driver_id", "=", id).execute();
  return id;
}
async function setStatus(driverId: string, accountStatus: string) {
  const sup = await adminSession(app, database.db, "super", { now: clock.now });
  const v = (await call(app, "GET", `/admin/drivers/${driverId}`, sup.headers)).json().version;
  return call(app, "POST", `/admin/drivers/${driverId}/status`, sup.headers, { expectedVersion: v, accountStatus, note: "ok" });
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("driver activation", () => {
  it("a member: lists every own required type when nothing is approved", async () => {
    const id = await swedishDriver();
    expect(await activationBlockers(database.db, { driver_id: id, country: "SE", account_type: "driver" })).toEqual(scoped("driver", driverDocs));
    const res = await setStatus(id, "active");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "documents_not_approved", details: scoped("driver", driverDocs) });
  });

  it("a member: names only the missing; in review does not count; admin_check and acceptance do", async () => {
    const id = await swedishDriver();
    const [first, second, ...rest] = driverDocs;
    await approveDriverDocuments(database.db, id, [second!, ...rest]);
    await database.db.updateTable("documents").set({ status: "in_review" }).where("owner_id", "=", id).where("type", "=", second!).execute();
    const res = await setStatus(id, "active");
    expect(res.json().details).toEqual([`driver:${first}`, `driver:${second}`]);
    expect(driverDocs).toEqual(expect.arrayContaining(["terms", "info_session"]));
  });

  it("a member needs only his own documents (no company documents, no car)", async () => {
    const id = await swedishDriver();
    await approveDriverDocuments(database.db, id);
    expect((await setStatus(id, "active")).json()).toMatchObject({ accountStatus: "active" });
  });

  it("a fleet owner with his driver documents but not the company's: 409 with fleet: details", async () => {
    const id = await swedishDriver("fleet");
    await approveDriverDocuments(database.db, id);
    await approveFleetDocuments(database.db, id, fleetDocs.slice(1));
    const res = await setStatus(id, "active");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "documents_not_approved", details: [`fleet:${fleetDocs[0]}`] });
  });

  it("a fleet owner with company documents but not his own is refused too", async () => {
    const id = await swedishDriver("fleet");
    await approveFleetDocuments(database.db, id);
    await approveDriverDocuments(database.db, id, driverDocs.slice(1));
    expect((await setStatus(id, "active")).json().details).toEqual([`driver:${driverDocs[0]}`]);
  });

  it("a fleet owner with everything approved and no car is activated", async () => {
    const id = await swedishDriver("fleet");
    await approveDriverDocuments(database.db, id);
    await approveFleetDocuments(database.db, id);
    expect((await setStatus(id, "active")).json()).toMatchObject({ accountStatus: "active" });
    expect((await database.db.selectFrom("drivers").select("vehicle_id").where("driver_id", "=", id).executeTakeFirstOrThrow()).vehicle_id).toBeNull();
  });

  it("suspending needs no documents", async () => {
    const id = await swedishDriver();
    expect((await setStatus(id, "suspended")).json()).toMatchObject({ accountStatus: "suspended" });
  });
});

describe("a car's documents", () => {
  it("an approved car with documents missing cannot be driven online; approved documents let it", async () => {
    const id = await swedishDriver("fleet");
    await approveDriverDocuments(database.db, id);
    await approveFleetDocuments(database.db, id);
    const fleetId = newId("flt");
    await database.db.insertInto("fleets").values({ fleet_id: fleetId, owner_driver_id: id, name: "Test Taxi AB", org_number: "000000-0000", address: "Gatan 1", country: "SE", city_id: "stockholm_lan", zone_id: "Z001", status: "approved", created_at: clock.now, updated_at: clock.now } as never).execute();
    const vehicleId = newId("veh");
    await database.db.insertInto("vehicles").values({ vehicle_id: vehicleId, fleet_id: fleetId, driver_id: id, make: "Volvo", model: "V60", year: 2022, color: "Grey", plate: "TST 001", seats: 4, category_ids: ["economy"], status: "approved", created_at: clock.now, updated_at: clock.now } as never).execute();
    await database.db.updateTable("drivers").set({ fleet_id: fleetId, vehicle_id: vehicleId, category_ids: ["economy"] }).where("driver_id", "=", id).execute();
    expect((await setStatus(id, "active")).json()).toMatchObject({ accountStatus: "active" });
    await approveVehicleDocuments(database.db, vehicleId, id, "SE", ["insurance"]);
    const goOnline = async () => {
      const v = (await database.db.selectFrom("drivers").select("version").where("driver_id", "=", id).executeTakeFirstOrThrow()).version;
      return database.db.transaction().execute((trx) => setAvailability(trx, id, { expectedVersion: v, onlineStatus: "online" }, clock.now)).catch((e: unknown) => e);
    };
    const refused = await goOnline();
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(409);
    expect((refused as ApiError).body("r")).toMatchObject({ code: "documents_not_approved", reason: "vehicle_documents_not_approved", details: ["vehicle:vehicle_registration"] });
    await approveVehicleDocuments(database.db, vehicleId, id, "SE");
    const after = await goOnline();
    expect(after instanceof ApiError ? after.options.reason : "passed").not.toBe("vehicle_documents_not_approved");
  });
});
