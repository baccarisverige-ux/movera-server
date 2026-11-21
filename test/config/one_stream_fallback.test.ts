import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Contract v0.18.150 (L20 stream backup; owner 2026-11-21 "Switch to old two (Rec.)", contract.json#driverOneStreamFallback):
 * DriverAppConfig.realtime.oneStreamFallback { failuresInARow 1-10 default 3, retryOneAfterMinutes 1-60 default 10 }.
 * PUT /admin/config/driver_app_config refuses a bad one (400 invalid_request, reason invalid_document); GET /driver/config
 * always serves it (the document's values, else the defaults); a save that leaves it out keeps it (configDocs.keptKeys).
 * Rule 36: fails on main (not served; a bad value is saved; not kept).
 */
let database: TestDatabase;
let app: FastifyInstance;
let admin: Record<string, string>;
const clock = { now: new Date("2026-11-21T09:00:00Z") };
const driverDoc = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/driver_app_config.json`, "utf8")) as Record<string, unknown>;
const put = (body: Record<string, unknown>) => call(app, "PUT", "/admin/config/driver_app_config", admin, body);

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(driverDoc), published_at: clock.now, published_by: null }).execute();
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

async function driverConfig() {
  const headers = (await signIn(app, TEST_PHONES[3]!, "driver")).headers;
  const res = await call(app, "GET", "/driver/config?zoneId=Z001", headers);
  expect(res.statusCode).toBe(200);
  return res.json();
}
const setLive = (document: Record<string, unknown>) =>
  database.db.updateTable("config_live").set({ document: JSON.stringify(document) }).where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();

describe("DriverAppConfig.realtime.oneStreamFallback (v0.18.150)", () => {
  it("GET /driver/config serves the defaults 3 / 10 when the document has none (published before v0.18.150)", async () => {
    await setLive({ ...driverDoc, realtime: { oneStream: true } });
    expect((await driverConfig()).realtime).toEqual({ oneStream: true, oneStreamFallback: { failuresInARow: 3, retryOneAfterMinutes: 10 } });
  });

  it("GET /driver/config serves the document's values; a missing or bad stored key takes its default", async () => {
    await setLive({ ...driverDoc, realtime: { oneStream: true, oneStreamFallback: { failuresInARow: 5, retryOneAfterMinutes: 30 } } });
    expect((await driverConfig()).realtime.oneStreamFallback).toEqual({ failuresInARow: 5, retryOneAfterMinutes: 30 });
    await setLive({ ...driverDoc, realtime: { oneStream: false, oneStreamFallback: { failuresInARow: 2 } } });
    expect((await driverConfig()).realtime).toEqual({ oneStream: false, oneStreamFallback: { failuresInARow: 2, retryOneAfterMinutes: 10 } });
    await setLive({ ...driverDoc, realtime: { oneStreamFallback: { failuresInARow: 99, retryOneAfterMinutes: "x" } } });
    expect((await driverConfig()).realtime).toEqual({ oneStream: false, oneStreamFallback: { failuresInARow: 3, retryOneAfterMinutes: 10 } });
    await setLive(driverDoc);
  });

  it("PUT refuses an oneStreamFallback that is not an object, not whole numbers or out of range (400 invalid_document)", async () => {
    const bad: unknown[] = [
      true, "3", [3], null,
      { failuresInARow: 0 }, { failuresInARow: 11 }, { failuresInARow: 2.5 }, { failuresInARow: "3" }, { failuresInARow: null },
      { retryOneAfterMinutes: 0 }, { retryOneAfterMinutes: 61 }, { retryOneAfterMinutes: 1.5 }, { retryOneAfterMinutes: "10" },
    ];
    for (const oneStreamFallback of bad) {
      const draft = (await call(app, "GET", "/admin/config/driver_app_config?zoneId=Z001", admin)).json();
      const res = await put({ expectedVersion: draft.version, zoneId: "Z001", document: { ...driverDoc, realtime: { oneStream: true, oneStreamFallback } } });
      expect(res.statusCode, JSON.stringify(oneStreamFallback)).toBe(400);
      expect(res.json()).toMatchObject({ code: "invalid_request", reason: "invalid_document" });
    }
  });

  it("PUT saves the edges 1 / 1 and 10 / 60; a save that leaves realtime out keeps both realtime keys", async () => {
    const draft = (await call(app, "GET", "/admin/config/driver_app_config?zoneId=Z001", admin)).json();
    const low = await put({ expectedVersion: draft.version, zoneId: "Z001", document: { ...driverDoc, realtime: { oneStream: true, oneStreamFallback: { failuresInARow: 1, retryOneAfterMinutes: 1 } } } });
    expect(low.statusCode, low.body).toBe(200);
    const high = await put({ expectedVersion: low.json().version, zoneId: "Z001", document: { ...driverDoc, realtime: { oneStream: true, oneStreamFallback: { failuresInARow: 10, retryOneAfterMinutes: 60 } } } });
    expect(high.statusCode, high.body).toBe(200);
    const { realtime: _drop, ...noRealtime } = driverDoc;
    const stale = await put({ expectedVersion: high.json().version, zoneId: "Z001", document: noRealtime });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().document.realtime).toEqual({ oneStream: true, oneStreamFallback: { failuresInARow: 10, retryOneAfterMinutes: 60 } });
    expect([...stale.json().keptKeys].sort()).toEqual(["realtime.oneStream", "realtime.oneStreamFallback"]);
    const onlySwitch = await put({ expectedVersion: stale.json().version, zoneId: "Z001", document: { ...noRealtime, realtime: { oneStream: false } } });
    expect(onlySwitch.json().document.realtime).toEqual({ oneStream: false, oneStreamFallback: { failuresInARow: 10, retryOneAfterMinutes: 60 } });
  });
});
