import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.158 (contract.json#crashCatcher.setting; owner 2026-11-24 "Add to admin all kind of crash"): the
 * per-zone switch crashReports { on } in both app documents, default on. Rule 36: fails on main — GET /rider/config and
 * GET /driver/config serve no crashReports and a non-boolean on is saved.
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-24T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8")) as Record<string, unknown>;

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

describe("crash reports switch (v0.18.158)", () => {
  it("documents published before v0.18.158 are served with crashReports.on true, to both apps", async () => {
    const rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    const driver = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    expect((await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json().crashReports).toEqual({ on: true });
    expect((await call(app, "GET", "/driver/config?zoneId=Z001", driver)).json().crashReports).toEqual({ on: true });
  });

  it("a saved and published off is served off", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    for (const doc of ["rider_app_config", "driver_app_config"]) {
      const put = await call(app, "PUT", `/admin/config/${doc}`, admin, { expectedVersion: 1, zoneId: "Z001", document: { ...sample(doc), zoneId: "Z001", crashReports: { on: false } } });
      expect(put.statusCode, doc).toBe(200);
      const pub = await call(app, "POST", `/admin/config/${doc}/publish`, admin, { zoneId: "Z001", expectedVersion: put.json().version });
      expect(pub.statusCode, `${doc} ${pub.body}`).toBe(200);
    }
    const rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    const driver = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    expect((await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json().crashReports).toEqual({ on: false });
    expect((await call(app, "GET", "/driver/config?zoneId=Z001", driver)).json().crashReports).toEqual({ on: false });
  });

  it("PUT: a crashReports that is not { on: boolean } is 400 invalid_document in both documents", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    for (const doc of ["rider_app_config", "driver_app_config"]) {
      for (const crashReports of [true, "off", { on: "no" }, { on: 0 }, { on: null }]) {
        const res = await call(app, "PUT", `/admin/config/${doc}`, admin, { expectedVersion: 2, zoneId: "Z001", document: { ...sample(doc), zoneId: "Z001", crashReports } });
        expect(res.statusCode, `${doc} ${JSON.stringify(crashReports)}`).toBe(400);
        expect(res.json()).toMatchObject({ code: "invalid_request", reason: "invalid_document" });
      }
    }
  });
});
