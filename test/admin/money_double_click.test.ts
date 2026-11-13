import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countryTimeZone } from "../../src/admin/payouts.js";
import { sampleForZone } from "../../src/config/seedConfig.js";
import { payChangeMaxOf, tipRulesOf } from "../../src/trips/finish.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";
import { call, testWorld } from "../support/world.js";

/**
 * S5 J4 / B2.3 (contract v0.18.82, contract.json#moneyBase.versionGuard; owner Sitting 3 item 106 "refuse a second click",
 * decisions/session-2026-11-06.md): the admin's "Add money to wallet" and "Change driver pay" carry expectedVersion
 * (the rider's version / the trip's version). Two clicks with two Idempotency-Keys and the same version: the first
 * writes, the second gets 409 version_mismatch with the fresh projection and writes nothing. A missing version is 400.
 * Fail-before: both clicks answered 200 and the money moved twice. Sweden (SEK), France (EUR), Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
let app: FastifyInstance;
let finance: Record<string, string>;
const clock = { now: new Date("2026-11-13T10:00:00Z") };

const CASES = [
  { country: "SE", zone: "Z001", currency: "SEK", credit: 5_000, pay: 10_000 }, // 50 kr, +100 kr
  { country: "FR", zone: "FR-PC", currency: "EUR", credit: 5_000, pay: 1_000 }, // 50 €, +10 €
  { country: "TN", zone: "TN-TC", currency: "TND", credit: 5_000, pay: 5_000 }, // 5.000 DT, +5.000 DT
] as const;

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  finance = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

/** A rider whose country is known (his latest trip is in the zone) and a driver's ended trip there. */
async function world(zone: string, currency: string) {
  const riderId = await insertRider(database.db);
  const driverId = await insertDriver(database.db);
  const tripId = await insertTrip(database.db, riderId, { status: "completed", driverId });
  await database.db.updateTable("trips").set({
    zone_id: zone, currency, fare_minor: 30_000, booked_fare_minor: 30_000, driver_earnings_minor: 24_000, commission_minor: 6_000,
    pickup_pay_minor: 0, driver_bonus_minor: 0, payment_method: "cash", ended_at: clock.now,
  }).where("trip_id", "=", tripId).execute();
  return { riderId, driverId, tripId };
}
const riderVersion = async (riderId: string) => (await database.db.selectFrom("riders").select("version").where("rider_id", "=", riderId).executeTakeFirstOrThrow()).version;
const tripVersion = async (tripId: string) => (await database.db.selectFrom("trips").select("version").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).version;
const balance = async (riderId: string, currency: string) =>
  Number((await database.db.selectFrom("rider_wallets").select("balance_minor").where("rider_id", "=", riderId).where("currency", "=", currency).executeTakeFirst())?.balance_minor ?? 0);

describe("S5 J4 (v0.18.82 moneyBase.versionGuard, owner 106): a second click on an admin money button is refused", () => {
  for (const c of CASES) {
    it(`${c.country}: Add money to wallet twice (two keys, same rider version) → one credit; the second is 409 with the fresh rider`, async () => {
      const { riderId } = await world(c.zone, c.currency);
      const version = await riderVersion(riderId);
      const body = { expectedVersion: version, amount: { amountMinor: c.credit, currency: c.currency }, reason: "Long wait" };
      const first = await call(app, "POST", `/admin/riders/${riderId}/wallet-credit`, finance, body);
      const second = await call(app, "POST", `/admin/riders/${riderId}/wallet-credit`, finance, body);
      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(409);
      expect(second.json()).toMatchObject({ code: "version_mismatch" });
      expect(second.json().projection).toMatchObject({ riderId, version: version + 1, wallet: { amountMinor: c.credit, currency: c.currency } });
      expect(await balance(riderId, c.currency)).toBe(c.credit);
      const entries = await database.db.selectFrom("wallet_entries").select("amount_minor").where("rider_id", "=", riderId).execute();
      expect(entries.map((e) => Number(e.amount_minor))).toEqual([c.credit]);
      // With the fresh version the admin can add again (a real second credit, not a double click).
      const again = await call(app, "POST", `/admin/riders/${riderId}/wallet-credit`, finance, { ...body, expectedVersion: version + 1 });
      expect(again.statusCode, again.body).toBe(200);
      expect(await balance(riderId, c.currency)).toBe(2 * c.credit);
    });

    it(`${c.country}: Change driver pay twice (two keys, same trip version) → one adjustment; the second is 409 with the fresh trip`, async () => {
      const { tripId } = await world(c.zone, c.currency);
      const version = await tripVersion(tripId);
      const body = { expectedVersion: version, change: { amountMinor: c.pay, currency: c.currency }, reason: "Long wait at the airport" };
      const first = await call(app, "POST", `/admin/trips/${tripId}/driver-pay`, finance, body);
      const second = await call(app, "POST", `/admin/trips/${tripId}/driver-pay`, finance, body);
      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(409);
      expect(second.json()).toMatchObject({ code: "version_mismatch" });
      expect(second.json().projection).toMatchObject({ tripId, version: version + 1, driverAdjustments: { amountMinor: c.pay, currency: c.currency } });
      const entries = await database.db.selectFrom("earnings_entries").select("amount_minor").where("trip_id", "=", tripId).where("kind", "=", "adjustment").execute();
      expect(entries.map((e) => Number(e.amount_minor))).toEqual([c.pay]);
      const row = await database.db.selectFrom("trips").select("driver_adjustments_minor").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
      expect(Number(row.driver_adjustments_minor)).toBe(c.pay);
    });
  }

  it("a missing or invalid expectedVersion is 400 and nothing is written (both buttons)", async () => {
    const { riderId, tripId } = await world("TN-TC", "TND");
    const credit = { amount: { amountMinor: 5_000, currency: "TND" }, reason: "x" };
    const pay = { change: { amountMinor: 5_000, currency: "TND" }, reason: "x" };
    for (const extra of [{}, { expectedVersion: 0 }, { expectedVersion: "1" }]) {
      const a = await call(app, "POST", `/admin/riders/${riderId}/wallet-credit`, finance, { ...credit, ...extra });
      expect([a.statusCode, a.json().code], a.body).toEqual([400, "invalid_request"]);
      const b = await call(app, "POST", `/admin/trips/${tripId}/driver-pay`, finance, { ...pay, ...extra });
      expect([b.statusCode, b.json().code], b.body).toEqual([400, "invalid_request"]);
    }
    expect(await balance(riderId, "TND")).toBe(0);
    expect(await database.db.selectFrom("earnings_entries").select("entry_id").where("trip_id", "=", tripId).execute()).toEqual([]);
  });

  it("the same Idempotency-Key twice still replays the first answer (not a 409)", async () => {
    const { riderId } = await world("Z001", "SEK");
    const body = { expectedVersion: await riderVersion(riderId), amount: { amountMinor: 5_000, currency: "SEK" }, reason: "Once" };
    const first = await call(app, "POST", `/admin/riders/${riderId}/wallet-credit`, finance, body, "j4-same-key-0000001");
    const replay = await call(app, "POST", `/admin/riders/${riderId}/wallet-credit`, finance, body, "j4-same-key-0000001");
    expect([first.statusCode, replay.statusCode]).toEqual([200, 200]);
    expect(await balance(riderId, "SEK")).toBe(5_000);
  });
});

describe("S5 J4 TN-1 (v0.18.82 configDefaults, owner Q-S5-6 re-confirmed 2026-11-13): Tunisia defaults from the contract copy", () => {
  it("driver pay change max TN 100 DT (it limits the change); custom tip max TN 30 DT; payouts on Africa/Tunis", async () => {
    expect(await payChangeMaxOf(database.db, "TN-TC", "TND")).toBe(100_000);
    expect(tipRulesOf(null, "TN", "TND").customMax).toEqual({ amountMinor: 30_000, currency: "TND" });
    const seeded = sampleForZone({ tipRules: { customMax: { amountMinor: 20_000, currency: "SEK" } } }, { zoneId: "TN-TC", currency: "TND", country: "TN", timeZone: "Africa/Tunis" });
    expect((seeded["tipRules"] as { customMax: unknown }).customMax).toEqual({ amountMinor: 30_000, currency: "TND" });
    expect(countryTimeZone("TN")).toBe("Africa/Tunis");
    // The change is limited, not the pay: 100.001 DT is refused, 100.000 DT is accepted.
    const { tripId } = await world("TN-TC", "TND");
    const over = await call(app, "POST", `/admin/trips/${tripId}/driver-pay`, finance, { expectedVersion: await tripVersion(tripId), change: { amountMinor: 100_001, currency: "TND" }, reason: "x" });
    expect([over.statusCode, over.json().reason]).toEqual([400, "driver_pay_above_max"]);
    const max = await call(app, "POST", `/admin/trips/${tripId}/driver-pay`, finance, { expectedVersion: await tripVersion(tripId), change: { amountMinor: 100_000, currency: "TND" }, reason: "x" });
    expect(max.statusCode, max.body).toBe(200);
  });
});
