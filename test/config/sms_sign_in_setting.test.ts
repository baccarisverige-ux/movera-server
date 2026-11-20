import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { smsSignInFor } from "../../src/auth/smsSignIn.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, testWorld } from "../support/world.js";

/**
 * Contract v0.18.133 (contract.json#smsSignIn.setting): the admin saves and publishes CountryRules.smsSignIn on the
 * country standard through the usual config routes. Rule 36: fails on main (no check: a zone's own rules and wrong
 * values were stored as they came).
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-19T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const rules = (smsSignIn: unknown) => {
  const r = sample("rider_app_config"), d = sample("driver_app_config");
  return { version: 1, publishedAt: clock.now.toISOString(), country: "SE", currency: "SEK", tips: r.tips ?? [], raiseSteps: r.raiseSteps ?? [], driverBonus: d.driverBonus ?? {}, smsSignIn };
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

describe("PUT / publish country_rules with smsSignIn", () => {
  it("wrong values are 400 invalid_document; a zone's own rules are 400 sms_sign_in_country_only", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    for (const bad of [true, { enabled: "yes" }, { enabled: true, dailyCap: 9 }, { enabled: true, dailyCap: 100_001 }, { enabled: true, dailyCap: 1.5 }, { enabled: true, password: "x" }]) {
      const res = await call(app, "PUT", "/admin/config/country_rules", admin, { expectedVersion: 1, country: "SE", document: rules(bad) });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().reason, JSON.stringify(bad)).toBe("invalid_document");
    }
    const zone = await call(app, "PUT", "/admin/config/country_rules", admin, { expectedVersion: 1, zoneId: "Z001", document: rules({ enabled: true }) });
    expect(zone.statusCode).toBe(400);
    expect(zone.json().reason).toBe("sms_sign_in_country_only");
  });

  it("off until published; the published switch and limit are what the sign-in reads; switching off holds at once", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    expect(await smsSignInFor(database.db, "SE")).toEqual({ enabled: false, dailyCap: 200, requireDeviceCheck: false });
    const saved = await call(app, "PUT", "/admin/config/country_rules", admin, { expectedVersion: 1, country: "SE", document: rules({ enabled: true, dailyCap: 350 }) });
    expect(saved.statusCode, saved.body).toBe(200);
    // A draft changes nothing.
    expect(await smsSignInFor(database.db, "SE")).toEqual({ enabled: false, dailyCap: 200, requireDeviceCheck: false });
    const published = await call(app, "POST", "/admin/config/country_rules/publish", admin, { country: "SE", expectedVersion: saved.json().version });
    expect(published.statusCode, published.body).toBeLessThan(300);
    expect(await smsSignInFor(database.db, "SE")).toEqual({ enabled: true, dailyCap: 350, requireDeviceCheck: false });
    expect(await smsSignInFor(database.db, "FR")).toEqual({ enabled: false, dailyCap: 200, requireDeviceCheck: false });
    const draft = await call(app, "GET", "/admin/config/country_rules?country=SE", admin);
    const off = await call(app, "PUT", "/admin/config/country_rules", admin, { expectedVersion: draft.json().version, country: "SE", document: rules({ enabled: false, dailyCap: 350 }) });
    expect(off.statusCode, off.body).toBe(200);
    const offLive = await call(app, "POST", "/admin/config/country_rules/publish", admin, { country: "SE", expectedVersion: off.json().version });
    expect(offLive.statusCode, offLive.body).toBeLessThan(300);
    expect(await smsSignInFor(database.db, "SE")).toEqual({ enabled: false, dailyCap: 350, requireDeviceCheck: false });
  });
});
