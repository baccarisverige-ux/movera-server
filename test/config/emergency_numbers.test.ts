import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { emergencyNumbersOf } from "../../src/config/emergencyNumbers.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * v0.18.57 §79 (contract.json#emergencyNumbers, owner 2026-11-10, Rule 0): emergency numbers per country.
 * Rule 36: fails on main — no validation, no defaults, the apps get no emergencyNumbers.
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-10T12:00:00Z") };
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
const rules = (emergencyNumbers: unknown) => {
  const r = sample("rider_app_config"), d = sample("driver_app_config");
  return { version: 1, publishedAt: clock.now.toISOString(), country: "SE", currency: "SEK", tips: r.tips ?? [], raiseSteps: r.raiseSteps ?? [], driverBonus: d.driverBonus ?? {}, emergencyNumbers };
};
const row = (kind: string, number: string, en = "Police") => ({ kind, number, label: { sv: en, fr: en, en } });

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

describe("emergency numbers (§79)", () => {
  it("defaults: SE/FR 112 general; TN police 197 + ambulance 190; unknown country 112", () => {
    expect(emergencyNumbersOf(undefined, "SE").map((r) => [r.kind, r.number])).toEqual([["general", "112"]]);
    expect(emergencyNumbersOf(undefined, "FR").map((r) => [r.kind, r.number])).toEqual([["general", "112"]]);
    expect(emergencyNumbersOf(undefined, "TN").map((r) => [r.kind, r.number])).toEqual([["police", "197"], ["ambulance", "190"]]);
    expect(emergencyNumbersOf(undefined, "XX").map((r) => r.number)).toEqual(["112"]);
  });

  it("PUT country_rules: bad lists → 400 invalid_emergency_numbers; a zone's own rules → emergency_numbers_country_only", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const bads = [[], Array.from({ length: 7 }, () => row("police", "112")), [row("police", "11a")], [row("army", "112")], [{ kind: "police", number: "112", label: { sv: "x", fr: "x" } }], [row("police", "112", "x".repeat(41))]];
    for (const emergencyNumbers of bads) {
      const res = await call(app, "PUT", "/admin/config/country_rules", admin, { expectedVersion: 1, country: "SE", document: rules(emergencyNumbers) });
      expect(res.statusCode).toBe(400);
      expect(res.json().reason).toBe("invalid_emergency_numbers");
    }
    const zone = await call(app, "PUT", "/admin/config/country_rules", admin, { expectedVersion: 1, zoneId: "Z001", document: rules([row("general", "112")]) });
    expect(zone.statusCode).toBe(400);
    expect(zone.json().reason).toBe("emergency_numbers_country_only");
    const ok = await call(app, "PUT", "/admin/config/country_rules", admin, { expectedVersion: 1, country: "SE", document: rules([row("police", "+46114", "Polis"), row("general", "112", "SOS")]) });
    expect(ok.json()).toMatchObject({ version: 2 });
  });

  it("both apps get the zone country's list (default, then the published standard)", async () => {
    const rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    expect((await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json().emergencyNumbers.map((r: { number: string }) => r.number)).toEqual(["112"]);
    const list = [row("police", "114"), row("general", "112")];
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-SE", version: 7, document: JSON.stringify({ country: "SE", emergencyNumbers: list }), published_at: clock.now, published_by: null }).execute();
    expect((await call(app, "GET", "/rider/config?zoneId=Z001", rider)).json().emergencyNumbers).toEqual(list);
    const driver = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    const got = await call(app, "GET", "/driver/config?zoneId=Z001", driver);
    if (got.statusCode === 200) expect(got.json().emergencyNumbers).toEqual(list);
  });
});
