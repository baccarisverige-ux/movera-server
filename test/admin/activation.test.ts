import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activationBlockers } from "../../src/admin/lists.js";
import { requiredDocuments } from "../../src/drivers/onboardingRules.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { approveDriverDocuments, insertDriver } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/** Contract v0.10.1 (driverOnboarding.activation): active needs every required driver document approved. */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-28T09:00:00Z") };
const required = requiredDocuments("SE", "driver");

async function swedishDriver(): Promise<string> {
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ country: "SE", zone_ids: ["Z001"], account_status: "on_hold" }).where("driver_id", "=", id).execute();
  return id;
}
async function activate(driverId: string) {
  const sup = await adminSession(app, database.db, "super", { now: clock.now });
  const v = (await call(app, "GET", `/admin/drivers/${driverId}`, sup.headers)).json().version;
  return call(app, "POST", `/admin/drivers/${driverId}/status`, sup.headers, { expectedVersion: v, accountStatus: "active", note: "ok" });
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
  it("lists every required type when nothing is approved", async () => {
    const id = await swedishDriver();
    await database.db.transaction().execute(async (trx) => {
      expect(await activationBlockers(trx, { driver_id: id, country: "SE" })).toEqual(required);
    });
    const res = await activate(id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "documents_not_approved", details: required });
  });

  it("names only the missing types; in review does not count; admin_check and acceptance do", async () => {
    const id = await swedishDriver();
    const [first, ...rest] = required;
    await approveDriverDocuments(database.db, id, rest);
    await database.db.updateTable("documents").set({ status: "in_review" }).where("owner_id", "=", id).where("type", "=", rest[0]!).execute();
    const res = await activate(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().details).toEqual([first, rest[0]]);
    expect(required).toEqual(expect.arrayContaining(["terms", "info_session"]));
  });

  it("activates once every required document is approved", async () => {
    const id = await swedishDriver();
    await approveDriverDocuments(database.db, id);
    const res = await activate(id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountStatus: "active" });
  });

  it("suspending needs no documents", async () => {
    const id = await swedishDriver();
    const sup = await adminSession(app, database.db, "super", { now: clock.now });
    const v = (await call(app, "GET", `/admin/drivers/${id}`, sup.headers)).json().version;
    const res = await call(app, "POST", `/admin/drivers/${id}/status`, sup.headers, { expectedVersion: v, accountStatus: "suspended", note: "ok" });
    expect(res.json()).toMatchObject({ accountStatus: "suspended" });
  });
});
