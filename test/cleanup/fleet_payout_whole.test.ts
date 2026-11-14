import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePeriods } from "../../src/admin/payouts.js";
import { contractJson } from "../../src/contract/contract.js";
import { priceFare, type PricingDocument } from "../../src/rules/fare.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";

/**
 * Owner 2026-10-29 (Rules decisions/driver-g10.md:3): "Movera dont care about what fleet owner take from drivers! We just
 * send payout to owner fleet and if there is any % u delete that"; owner 2026-11-14 ~02:49 UTC "What the fuck is fleet
 * owner keep !???". Contract v0.18.88 contract.json#fleetPayoutWhole (fleetShareRemoved, v0.18.13): fleetCommissionPct
 * is removed and IGNORED; a fleet driver's payout is his whole driver earnings, paid to the fleet owner.
 */

let database: TestDatabase;
let n = 0;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => database.drop());
beforeEach(async () => {
  await database.db.deleteFrom("earnings_entries").execute();
  await database.db.deleteFrom("payouts").execute();
});

const tripEntry = (driverId: string, at: string, amount: number, gross: number) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_fw${++n}`, driver_id: driverId, trip_id: null, kind: "trip", currency: "SEK", amount_minor: amount, gross_minor: gross, commission_minor: gross - amount, cash_minor: null, at: new Date(at) }).execute();
const tipEntry = (driverId: string, at: string, amount: number) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_fw${++n}`, driver_id: driverId, trip_id: null, kind: "tip", currency: "SEK", amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: null, at: new Date(at) }).execute();

async function fleetDriver(): Promise<string> {
  const ownerId = await insertDriver(database.db);
  const fleetId = `flt_fw${++n}`;
  const now = new Date("2026-10-20T10:00:00Z");
  await database.db.updateTable("drivers").set({ account_type: "fleet", zone_ids: ["Z001"], country: "SE" }).where("driver_id", "=", ownerId).execute();
  await database.db.insertInto("fleets").values({ fleet_id: fleetId, owner_driver_id: ownerId, name: "SE Taxi", org_number: "000000-0000", address: "Gatan 1", country: "SE", city_id: "stockholm", zone_id: "Z001", status: "approved", created_at: now, updated_at: now } as never).execute();
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ account_type: "driver", fleet_id: fleetId, fleet_linked_at: now, zone_ids: ["Z001"], country: "SE" }).where("driver_id", "=", id).execute();
  return id;
}
async function ownDriver(): Promise<string> {
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ account_type: "driver", fleet_id: null, zone_ids: ["Z001"], country: "SE" }).where("driver_id", "=", id).execute();
  return id;
}
const paid = (driverId: string) =>
  database.db.selectFrom("payouts").select(["currency", "amount_minor"]).where("driver_id", "=", driverId).execute().then((rows) => rows.map((r) => [r.currency, Number(r.amount_minor)]));

describe("fleet payouts = the whole driver earnings (contract v0.18.88 fleetPayoutWhole)", () => {
  it("a fleet driver's payout is every krona he earned, exactly like an own driver's (no fleet % taken off)", async () => {
    const fleet = await fleetDriver();
    const own = await ownDriver();
    for (const id of [fleet, own]) {
      await tripEntry(id, "2026-10-27T10:00:00Z", 16_000, 20_000);
      await tripEntry(id, "2026-10-28T10:00:00Z", 8_050, 10_063);
      await tipEntry(id, "2026-10-28T11:00:00Z", 2_000);
    }
    expect(await database.db.transaction().execute((trx) => closePeriods(trx, new Date("2026-11-02T08:00:00Z")))).toBe(2);
    expect(await paid(fleet)).toEqual([["SEK", 16_000 + 8_050 + 2_000]]);
    expect(await paid(own)).toEqual(await paid(fleet));
  });

  it("a pricing document that still carries fleetCommissionPct (an old admin) prices exactly the same: the key is ignored", () => {
    const doc = contractJson<PricingDocument>("fixtures/config/pricing_document.json");
    expect(doc).not.toHaveProperty("fleetCommissionPct");
    const input = { categoryId: "economy", km: 12.4, minutes: 21, kind: "live" as const };
    const plain = priceFare(doc, input);
    for (const pct of [5, 10, 30]) {
      const old = { ...doc, fleetCommissionPct: pct } as PricingDocument;
      expect(priceFare(old, input)).toEqual(plain);
    }
  });

  it("no server source file reads a fleet-owner % (fleetCommissionPct, fleetPct, fleet_commission, fleet_pct)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|sql)$/.test(name) && /fleetCommission|fleetPct|fleet_commission|fleet_pct|fleetShare|fleet_share/i.test(readFileSync(path, "utf8"))) hits.push(path);
      }
    };
    walk("src");
    walk("migrations");
    expect(hits).toEqual([]);
  });
});
