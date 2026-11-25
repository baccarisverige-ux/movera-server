import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { smsSignInOtherFor } from "../../src/auth/smsSignIn.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, testWorld } from "../support/world.js";

/** Contract v0.18.157 (contract.json#smsSignIn.otherCountries.setting): Sweden standard only, super admins only. */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-24T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const rules = (country: string, currency: string, other: unknown) => {
  const r = sample("rider_app_config"), d = sample("driver_app_config");
  return { version: 1, publishedAt: clock.now.toISOString(), country, currency, tips: r.tips ?? [], raiseSteps: r.raiseSteps ?? [], driverBonus: d.driverBonus ?? {}, ...(other === undefined ? {} : { smsSignInOtherCountries: other }) };
};
const draftVersion = async (admin: Record<string, string>) => ((await call(app, "GET", "/admin/config/country_rules?country=SE", admin)).json().version as number | undefined) ?? 1;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("PUT / publish country_rules with smsSignInOtherCountries", () => {
  it("wrong values are 400 invalid_document; a zone or another country is 400 sms_sign_in_other_home_only", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    for (const bad of [true, { enabled: "yes" }, { enabled: true, dailyCap: 9 }, { enabled: true, dailyCap: 100_001 }, { enabled: true, x: 1 }, { perCodeDailyCap: 0 }, { perMinuteCap: 10_001 }, { blockedCallingCodes: ["+999999"] }, { blockedCallingCodes: ["+49", "+49"] }]) {
      const res = await call(app, "PUT", "/admin/config/country_rules", admin, { expectedVersion: await draftVersion(admin), country: "SE", document: rules("SE", "SEK", bad) });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().reason, JSON.stringify(bad)).toBe("invalid_document");
    }
    const zone = await call(app, "PUT", "/admin/config/country_rules", admin, { expectedVersion: 1, zoneId: "Z001", document: rules("SE", "SEK", { enabled: true }) });
    expect(zone.statusCode).toBe(400);
    expect(zone.json().reason).toBe("sms_sign_in_other_home_only");
  });

  it("only a super admin changes it; a save by another admin that leaves it out keeps it; published value is read", async () => {
    const config = (await adminSession(app, database.db, "config", { now: clock.now })).headers;
    const tried = await call(app, "PUT", "/admin/config/country_rules", config, { expectedVersion: await draftVersion(config), country: "SE", document: rules("SE", "SEK", { enabled: false, dailyCap: 50 }) });
    expect(tried.statusCode, tried.body).toBe(403);
    expect(tried.json().reason).toBe("super_admin_only");

    const sup = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    expect(await smsSignInOtherFor(database.db)).toMatchObject({ enabled: true, dailyCap: 50, perCodeDailyCap: 10, perMinuteCap: 30, blockedCallingCodes: [] });
    const saved = await call(app, "PUT", "/admin/config/country_rules", sup, { expectedVersion: await draftVersion(sup), country: "SE", document: rules("SE", "SEK", { enabled: false, dailyCap: 120 }) });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await smsSignInOtherFor(database.db)).toMatchObject({ enabled: true, dailyCap: 50, perCodeDailyCap: 10, perMinuteCap: 30, blockedCallingCodes: [] });

    // The config admin's Tips & limits save leaves the key out: kept, not refused.
    const other = await call(app, "PUT", "/admin/config/country_rules", config, { expectedVersion: await draftVersion(config), country: "SE", document: rules("SE", "SEK", undefined) });
    expect(other.statusCode, other.body).toBe(200);
    expect(other.json().keptKeys).toContain("smsSignInOtherCountries");
    const published = await call(app, "POST", "/admin/config/country_rules/publish", sup, { country: "SE", expectedVersion: other.json().version });
    expect(published.statusCode, published.body).toBeLessThan(300);
    expect(await smsSignInOtherFor(database.db)).toMatchObject({ enabled: false, dailyCap: 120 });
  });

  it("Restore by an admin who is not a super admin keeps the live other-countries setting (pricingHistory.restoreKeeps)", async () => {
    const sup = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const config = (await adminSession(app, database.db, "config", { now: clock.now })).headers;
    const publish = async (other: unknown) => {
      const put = await call(app, "PUT", "/admin/config/country_rules", sup, { expectedVersion: await draftVersion(sup), country: "SE", document: rules("SE", "SEK", other) });
      expect(put.statusCode, put.body).toBe(200);
      const pub = await call(app, "POST", "/admin/config/country_rules/publish", sup, { country: "SE", expectedVersion: put.json().version });
      expect(pub.statusCode, pub.body).toBeLessThan(300);
      return pub.json().version as number;
    };
    const wide = await publish({ enabled: true, dailyCap: 100_000, perCodeDailyCap: 100_000, perMinuteCap: 10_000, blockedCallingCodes: [] });
    const tight = await publish({ enabled: false, dailyCap: 10, blockedCallingCodes: ["+882"] });
    const restored = await call(app, "POST", "/admin/config/country_rules/restore", config, { country: "SE", expectedVersion: tight, version: wide });
    expect(restored.statusCode, restored.body).toBeLessThan(300);
    expect(await smsSignInOtherFor(database.db)).toMatchObject({ enabled: false, dailyCap: 10, blockedCallingCodes: ["+882"] });
  });
});
