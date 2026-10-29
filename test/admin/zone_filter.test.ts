import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { adminSession } from "../support/admin.js";
import { testWorld } from "../support/world.js";

/**
 * contract v0.17.2 (owner 2026-10-29, "Fix fully"): the admin lists follow the country and zones picked in the
 * panel: zoneId, zoneIds and country narrow every list inside the admin's own zones; an unknown filter is 400.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-29T10:00:00Z") };
let superAdmin: Record<string, string>;
let stockholmOnly: Record<string, string>;
const ids = { seTrip: "", se2Trip: "", frTrip: "", seRider: "", frRider: "", seDriver: "", frDriver: "" };

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url: `/api/v1${url}`, headers });
const itemIds = async (url: string, headers = superAdmin, key = "tripId") => {
  const res = await get(url, headers);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as Record<string, string>[]).map((row) => row[key]).sort();
};

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  ids.seRider = await insertRider(database.db);
  ids.frRider = await insertRider(database.db);
  ids.seTrip = await insertTrip(database.db, ids.seRider, { status: "completed" });
  ids.se2Trip = await insertTrip(database.db, ids.seRider, { status: "completed" });
  ids.frTrip = await insertTrip(database.db, ids.frRider, { status: "completed" });
  await database.db.updateTable("trips").set({ zone_id: "Z001" }).where("trip_id", "=", ids.seTrip).execute();
  await database.db.updateTable("trips").set({ zone_id: "Z002" }).where("trip_id", "=", ids.se2Trip).execute();
  await database.db.updateTable("trips").set({ zone_id: "FR-PC", currency: "EUR" }).where("trip_id", "=", ids.frTrip).execute();
  ids.seDriver = await insertDriver(database.db);
  ids.frDriver = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ zone_ids: ["Z001"], online_status: "online" }).where("driver_id", "=", ids.seDriver).execute();
  await database.db.updateTable("drivers").set({ zone_ids: ["FR-PC"], online_status: "online" }).where("driver_id", "=", ids.frDriver).execute();
  superAdmin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  stockholmOnly = (await adminSession(app, database.db, "super", { zoneIds: ["Z001"], now: clock.now })).headers;
});

afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("admin lists follow country and zones", () => {
  it("trips: country, zoneId and zoneIds", async () => {
    expect(await itemIds("/admin/trips?country=FR")).toEqual([ids.frTrip]);
    expect(await itemIds("/admin/trips?country=SE")).toEqual([ids.seTrip, ids.se2Trip].sort());
    expect(await itemIds("/admin/trips?zoneId=FR-PC")).toEqual([ids.frTrip]);
    expect(await itemIds("/admin/trips?zoneIds=Z001,FR-PC")).toEqual([ids.seTrip, ids.frTrip].sort());
    expect(await itemIds("/admin/trips?zoneIds=Z001&zoneIds=Z002")).toEqual([ids.seTrip, ids.se2Trip].sort());
    // A zone named outside the country gives nothing.
    expect(await itemIds("/admin/trips?country=FR&zoneIds=Z001")).toEqual([]);
  });

  it("riders: only riders with a trip in the zones", async () => {
    expect(await itemIds("/admin/riders?zoneId=FR-PC", superAdmin, "riderId")).toEqual([ids.frRider]);
    expect(await itemIds("/admin/riders?country=SE", superAdmin, "riderId")).toEqual([ids.seRider]);
  });

  it("drivers and live drivers: by country", async () => {
    expect(await itemIds("/admin/drivers?country=FR", superAdmin, "driverId")).toEqual([ids.frDriver]);
    expect(await itemIds("/admin/live/drivers?country=FR", superAdmin, "driverId")).toEqual([ids.frDriver]);
    expect(await itemIds("/admin/live/drivers?zoneIds=Z001", superAdmin, "driverId")).toEqual([ids.seDriver]);
  });

  it("payments, refunds, payouts, tickets, ratings and incidents take the filters", async () => {
    for (const path of ["/admin/payments", "/admin/refunds", "/admin/payouts", "/admin/tickets", "/admin/ratings", "/admin/incidents"]) {
      for (const filter of ["country=FR", "zoneId=FR-PC", "zoneIds=FR-PC,Z001"]) {
        const res = await get(`${path}?${filter}`, superAdmin);
        expect(res.statusCode, `${path}?${filter}: ${res.body}`).toBe(200);
      }
    }
  });

  it("stays inside the admin's zones", async () => {
    expect(await itemIds("/admin/trips?country=SE", stockholmOnly)).toEqual([ids.seTrip]);
    expect(await itemIds("/admin/trips?country=FR", stockholmOnly)).toEqual([]);
    const outside = await get("/admin/trips?zoneId=FR-PC", stockholmOnly);
    expect(outside.statusCode).toBe(403);
    expect(outside.json().reason).toBe("zone_out_of_scope");
    expect((await get("/admin/riders?zoneIds=Z002", stockholmOnly)).statusCode).toBe(403);
  });

  it("an unknown filter is 400 unknown_filter", async () => {
    for (const path of ["/admin/trips", "/admin/riders", "/admin/drivers", "/admin/payments", "/admin/refunds", "/admin/payouts", "/admin/tickets", "/admin/ratings", "/admin/incidents", "/admin/live/drivers"]) {
      const res = await get(`${path}?zone=FR-PC`, superAdmin);
      expect(res.statusCode, path).toBe(400);
      expect(res.json().reason, path).toBe("unknown_filter");
    }
    expect((await get("/admin/trips?country=france", superAdmin)).statusCode).toBe(400);
  });
});
