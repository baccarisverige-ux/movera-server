import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TEST_ACCOUNTS, TEST_FLEET_CODE, seedTestAccounts } from "../../src/drivers/seedTest.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/** The test week's ready accounts: activated drivers in an approved fleet, active riders, no approval wait. */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-10-26T08:00:00Z") };

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  await database.db.transaction().execute((trx) => seedTestAccounts(trx, DEFAULT_TEST_ACCOUNTS, clock.now));
  // Running it again changes nothing but the versions.
  await database.db.transaction().execute((trx) => seedTestAccounts(trx, DEFAULT_TEST_ACCOUNTS, clock.now));
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("the seeded test accounts", () => {
  it("every driver signs in active, in the approved fleet, with his car picked and every document approved", async () => {
    let owner: Record<string, string> = {};
    for (const d of DEFAULT_TEST_ACCOUNTS.drivers) {
      const headers = (await signIn(app, d.phone, "driver")).headers;
      if (d.owner) owner = headers;
      const me = (await call(app, "GET", "/driver/profile", headers)).json();
      expect(me).toMatchObject({ accountStatus: "active", firstName: d.firstName, lastName: d.lastName, country: "SE", cityId: "stockholm_lan", fleet: { name: "Movera Test AB", status: "approved", role: d.owner ? "owner" : "member" } });
      expect(me.vehicleId).toBeDefined();
      const required = [...me.requiredDocuments, ...(me.requiredFleetDocuments ?? [])];
      const approved = me.documents.filter((x: { status: string }) => x.status === "approved").map((x: { type: string }) => x.type);
      for (const type of required) expect(approved).toContain(type);
      const online = await call(app, "POST", "/driver/availability", headers, { expectedVersion: me.version, onlineStatus: "online" });
      expect(online.json()).toMatchObject({ onlineStatus: "online" });
    }
    // (A second code request for the same phone within 30 s is refused, so the owner's first session is reused.)
    const fleet = (await call(app, "GET", "/driver/fleet", owner)).json();
    expect(fleet.fleet.code).toBe(TEST_FLEET_CODE);
    expect(fleet.drivers).toHaveLength(3);
    expect(fleet.vehicles.map((v: { status: string }) => v.status)).toEqual(["approved", "approved", "approved"]);
    const admin = await adminSession(app, database.db, "super", { now: clock.now });
    const list = (await call(app, "GET", "/admin/drivers?accountStatus=active", admin.headers)).json();
    expect(list.items).toHaveLength(3);
    const fleets = (await call(app, "GET", "/admin/fleets", admin.headers)).json();
    expect(fleets.items).toEqual([expect.objectContaining({ name: "Movera Test AB", status: "approved", code: TEST_FLEET_CODE, driverCount: 3, vehicleCount: 3 })]);
  });

  it("every rider signs in as an existing active rider with a name", async () => {
    for (const r of DEFAULT_TEST_ACCOUNTS.riders) {
      const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone: r.phone, app: "rider" } });
      const tokens = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone: r.phone, sessionId: verify.json().sessionId, code: "1234" } });
      expect(tokens.json().isNewRider).toBe(false);
      const me = await app.inject({ method: "GET", url: "/api/v1/rider/profile", headers: { authorization: `Bearer ${tokens.json().accessToken}` } });
      expect(me.json()).toMatchObject({ firstName: r.firstName, status: "active" });
    }
  });
});
