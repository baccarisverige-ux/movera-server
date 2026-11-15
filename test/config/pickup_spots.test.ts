import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.115 (BQ-V21, contract.json#pickupSpots; owner full-audit Q6 "Keep as 'approximate'" => admin on/off
 * per zone, default on; Rules decisions/rider-g4-pickup.md:7): RiderAppConfig.booking.pickupSpots.on.
 * Rule 36: fails on main — GET /rider/config serves no booking.pickupSpots and a non-boolean on is saved.
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-15T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8")) as Record<string, unknown>;
const riderDoc = (zoneId: string, booking: Record<string, unknown>) => {
  const doc = sample("rider_app_config");
  return { ...doc, zoneId, booking: { ...(doc["booking"] as Record<string, unknown>), ...booking } };
};

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  for (const doc of ["driver_app_config", "rider_app_config"]) {
    await database.db.insertInto("config_live").values({ doc: doc as never, zone_id: "Z001", version: 1, document: JSON.stringify(sample(doc)), published_at: clock.now, published_by: null }).execute();
  }
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("pickup entrance chips switch (v0.18.115)", () => {
  it("a rider document without the field (published before v0.18.115) is served with booking.pickupSpots.on true", async () => {
    const rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    const res = await call(app, "GET", "/rider/config?zoneId=Z001", rider);
    expect(res.statusCode).toBe(200);
    expect(res.json().booking.pickupSpots).toEqual({ on: true });
    // The other booking fields are untouched.
    expect(res.json().booking.maxStops).toBe((sample("rider_app_config")["booking"] as { maxStops: number }).maxStops);
  });

  it("the driver document gets no pickupSpots (the driver app is not changed)", async () => {
    const driver = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    const res = await call(app, "GET", "/driver/config?zoneId=Z001", driver);
    expect(res.statusCode).toBe(200);
    expect(res.json().booking?.pickupSpots).toBeUndefined();
  });

  it("PUT rider_app_config: a pickupSpots that is not { on: boolean } is 400 invalid_document; the draft is not saved", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    for (const pickupSpots of [true, "off", { on: "no" }, { on: 0 }, { on: null }]) {
      const res = await call(app, "PUT", "/admin/config/rider_app_config", admin, { expectedVersion: 1, zoneId: "Z001", document: riderDoc("Z001", { pickupSpots }) });
      expect(res.statusCode, JSON.stringify(pickupSpots)).toBe(400);
      expect(res.json()).toMatchObject({ code: "invalid_request", reason: "invalid_document" });
    }
  });

  it("the admin turns it off for one zone: saved in the zone's rider document, published, served off; turned on again", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    const draft = (await call(app, "GET", "/admin/config/rider_app_config?zoneId=Z001", admin)).json();
    const off = await call(app, "PUT", "/admin/config/rider_app_config", admin, { expectedVersion: draft.version, zoneId: "Z001", document: riderDoc("Z001", { pickupSpots: { on: false } }) });
    expect(off.statusCode).toBe(200);
    expect(off.json().document.booking.pickupSpots).toEqual({ on: false });
    const published = await call(app, "POST", "/admin/config/rider_app_config/publish", admin, { expectedVersion: off.json().version, zoneId: "Z001" });
    expect(published.statusCode).toBe(200);
    const stored = await database.db.selectFrom("config_live").select("document").where("doc", "=", "rider_app_config").where("zone_id", "=", "Z001").executeTakeFirstOrThrow();
    expect((stored.document as { booking: { pickupSpots: unknown } }).booking.pickupSpots).toEqual({ on: false });
    expect((await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json().booking.pickupSpots).toEqual({ on: false });

    const draft2 = (await call(app, "GET", "/admin/config/rider_app_config?zoneId=Z001", admin)).json();
    const again = await call(app, "PUT", "/admin/config/rider_app_config", admin, { expectedVersion: draft2.version, zoneId: "Z001", document: riderDoc("Z001", { pickupSpots: { on: true } }) });
    expect(again.statusCode).toBe(200);
    await call(app, "POST", "/admin/config/rider_app_config/publish", admin, { expectedVersion: again.json().version, zoneId: "Z001" });
    expect((await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json().booking.pickupSpots).toEqual({ on: true });
  });
});
