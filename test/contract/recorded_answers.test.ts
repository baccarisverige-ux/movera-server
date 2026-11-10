import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { schemaProblem } from "../../src/contract/schemas.js";

/**
 * Step 72 (T14, global plan V35.5, "tests that passed and failed live"): real answers of the staging server
 * (test/fixtures/recorded/*.json, captured by tools/livecheck/record_answers.mjs, ids/tokens/phones/e-mails/names
 * replaced) checked against the contract schemas the server itself validates with (src/contract/schemas.ts). A
 * hand-written answer can only be as right as its author; these are what the apps really got. One test per file.
 */

const DIR = new URL("../fixtures/recorded/", import.meta.url);
const SCHEMA: Record<string, string> = {
  rider_zones_tn: "ZoneList",
  rider_config_tn_tc: "RiderAppConfig",
  quote_tunis: "QuoteList",
  driver_offers: "OfferPage",
  trip_view_rider_accepted: "TripProjection",
  trip_view_driver_in_trip: "TripProjection",
  trip_view_rider_completed: "TripProjection",
  trip_events_page: "RealtimeEventPage",
  receipt_rider: "Receipt",
  receipt_driver: "Receipt",
};
type Recorded = { route: string; status: number; server: string; body: Record<string, unknown> };
const load = (name: string): Recorded => JSON.parse(readFileSync(new URL(`${name}.json`, DIR), "utf8")) as Recorded;

describe("recorded staging answers match the contract (T14)", () => {
  it("every recorded file has exactly one test below, and every test its file (fixtures used by one test each)", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
    expect(files).toEqual(Object.keys(SCHEMA).sort());
  });

  it("no token, phone number or e-mail survived the cleaning", () => {
    for (const name of Object.keys(SCHEMA)) {
      const text = readFileSync(new URL(`${name}.json`, DIR), "utf8");
      expect(text, name).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
      expect(text, name).not.toMatch(/\+(?!10000000000)\d{8,15}/);
      expect(text, name).not.toMatch(/[A-Za-z0-9._-]+@(?!example\.test)[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    }
  });

  for (const [name, schema] of Object.entries(SCHEMA)) {
    it(`${name}: ${schema}`, () => {
      const rec = load(name);
      expect(rec.server).toBe("staging");
      expect(rec.status).toBeLessThan(300);
      expect(schemaProblem(schema, rec.body), `${rec.route} vs ${schema}`).toBeNull();
    });
  }
});
