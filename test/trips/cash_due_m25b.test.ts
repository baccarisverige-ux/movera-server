import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TripRow } from "../../src/db/tripLog.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { creditWallet } from "../../src/riders/wallet.js";
import { commissionOf } from "../../src/rules/commission.js";
import { tripProjection } from "../../src/trips/projection.js";
import { driverCancel } from "../../src/trips/ride/cancel.js";
import { completePreview, completeTrip, PriceChanged } from "../../src/trips/ride/finish.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * BQ-M25b (contract v0.18.99 contract.json#priceDisplay.nonCashZero; M25 supervisor F1, Rules
 * audits/impact/m25-card-cash-supervisor.md): on a trip not paid in the car (card / Apple Pay / wallet) nothing is collected
 * in cash, so every "cash to collect" number the server sends is 0 — CompletePreview.cashDue, TripFinish.cashToCollect and
 * TripProjection.cashToCollect (driver, rider and admin views). Before: fare − wallet on every payment method. A driver app
 * echoing 0 (or, an older one, fare − wallet) with a previewId on such a trip is not refused with price_changed. The driver's
 * end with the rider on board books 0 cash on a card trip (the M25 coverage gap). A cash trip is unchanged.
 * Sweden (SEK) and Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
const NOW = new Date("2026-11-14T10:00:00Z");

type Case = { currency: "SEK" | "TND"; zone: string; fare: number; earnings: number; pickup: number; bonus: number; wallet: number };
const SEK: Case = { currency: "SEK", zone: "Z001", fare: 18_750, earnings: 15_000, pickup: 360, bonus: 1_000, wallet: 2_500 };
const TND: Case = { currency: "TND", zone: "TN-TC", fare: 12_350, earnings: 9_880, pickup: 1_125, bonus: 500, wallet: 1_275 };

async function onBoard(c: Case, method: "card" | "cash", wallet: number): Promise<{ trip: TripRow; driverId: string }> {
  const riderId = await insertRider(database.db);
  const driverId = await insertDriver(database.db);
  const id = await insertTrip(database.db, riderId, { status: "in_trip", driverId });
  const lines = [{ code: "base", amount: { amountMinor: c.fare, currency: c.currency } }];
  if (wallet > 0) await database.db.transaction().execute((trx) => creditWallet(trx, riderId, { amountMinor: wallet, currency: c.currency }, null, NOW, "adjustment"));
  await database.db.updateTable("trips").set({
    zone_id: c.zone, category_id: "economy", currency: c.currency, fare_minor: c.fare, booked_fare_minor: c.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: c.earnings,
    pickup_pay_minor: c.pickup, driver_bonus_minor: c.bonus, commission_minor: commissionOf(c.fare, lines, c.earnings, c.pickup, c.bonus), payment_method: method,
    accepted_at: new Date(NOW.getTime() - 30 * 60_000), boarded_at: new Date(NOW.getTime() - 20 * 60_000), wallet_applied_minor: wallet,
  }).where("trip_id", "=", id).execute();
  const trip = (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
  return { trip, driverId };
}

const ZERO = (c: Case) => ({ amountMinor: 0, currency: c.currency });
type Finish = { cashToCollect: { amountMinor: number; currency: string } };
const cashOf = (trip: TripRow, viewer: "driver" | "rider" | "admin") => tripProjection(trip, viewer)["cashToCollect"] as { amountMinor: number } | undefined;
const finishOf = (trip: TripRow, viewer: "driver" | "rider" | "admin") => tripProjection(trip, viewer)["finish"] as Finish;

beforeAll(async () => {
  database = await freshDatabase();
  const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 1, document: JSON.stringify(pricing), published_at: NOW, published_by: null }).execute();
  // The driver's end on board prices what was driven (not repriced here: no fixes): Tunisia needs its own prices.
  const tunisia = { ...JSON.parse(JSON.stringify(pricing).replaceAll('"SEK"', '"TND"')), zoneId: "TN-TC", country: "TN", timeZone: "Africa/Tunis" };
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "TN-TC", version: 1, document: JSON.stringify(tunisia), published_at: NOW, published_by: null }).execute();
});
afterAll(async () => {
  await database.drop();
});

describe.each([SEK, TND])("BQ-M25b: no cash to collect on a non-cash trip ($currency)", (c) => {
  it.each([0, c.wallet])("card (wallet part %i): CompletePreview.cashDue is 0; complete with cashCollected 0 is not refused", async (wallet) => {
    const { trip, driverId } = await onBoard(c, "card", wallet);
    const preview = await completePreview(database.db, driverId, trip.trip_id, NOW);
    expect(preview.total).toEqual({ amountMinor: c.fare, currency: c.currency });
    expect(preview.cashDue).toEqual(ZERO(c));
    const done = await database.db.transaction().execute((trx) => completeTrip(trx, { actor: "driver", subjectId: driverId }, trip.trip_id, { expectedVersion: trip.version, previewId: preview.previewId, cashCollected: preview.cashDue }, NOW));
    expect(done.status).toBe("completed");
    expect(Number(done.cash_collected_minor)).toBe(0);
    expect(Number(done.wallet_applied_minor)).toBe(wallet);
    for (const viewer of ["driver", "rider", "admin"] as const) expect(finishOf(done, viewer).cashToCollect).toEqual(ZERO(c));
  });

  it("card: an older driver app echoing fare − wallet with the previewId is not refused either (the server books 0 cash)", async () => {
    const { trip, driverId } = await onBoard(c, "card", c.wallet);
    const preview = await completePreview(database.db, driverId, trip.trip_id, NOW);
    const done = await database.db.transaction().execute((trx) => completeTrip(trx, { actor: "driver", subjectId: driverId }, trip.trip_id, { expectedVersion: trip.version, previewId: preview.previewId, cashCollected: { amountMinor: c.fare - c.wallet, currency: c.currency } }, NOW));
    expect(Number(done.cash_collected_minor)).toBe(0);
  });

  it("card with a wallet part on board: TripProjection.cashToCollect is 0 in every view (no phantom cash)", async () => {
    const { trip } = await onBoard(c, "card", c.wallet);
    for (const viewer of ["driver", "rider", "admin"] as const) {
      const cash = cashOf(trip, viewer);
      if (cash !== undefined) expect(cash).toEqual(ZERO(c));
    }
    // The rider still sees the wallet part, and the 0 beside it.
    expect(cashOf(trip, "rider")).toEqual(ZERO(c));
  });

  it("cash (wallet part): unchanged — cashDue = fare − wallet; cashCollected must equal it (else price_changed)", async () => {
    const { trip, driverId } = await onBoard(c, "cash", c.wallet);
    const preview = await completePreview(database.db, driverId, trip.trip_id, NOW);
    expect(preview.cashDue).toEqual({ amountMinor: c.fare - c.wallet, currency: c.currency });
    for (const viewer of ["driver", "rider", "admin"] as const) expect(cashOf(trip, viewer)).toEqual({ amountMinor: c.fare - c.wallet, currency: c.currency });
    await expect(database.db.transaction().execute((trx) => completeTrip(trx, { actor: "driver", subjectId: driverId }, trip.trip_id, { expectedVersion: trip.version, previewId: preview.previewId, cashCollected: ZERO(c) }, NOW))).rejects.toBeInstanceOf(PriceChanged);
    const done = await database.db.transaction().execute((trx) => completeTrip(trx, { actor: "driver", subjectId: driverId }, trip.trip_id, { expectedVersion: trip.version, previewId: preview.previewId, cashCollected: preview.cashDue }, NOW));
    expect(Number(done.cash_collected_minor)).toBe(c.fare - c.wallet);
    for (const viewer of ["driver", "rider", "admin"] as const) expect(finishOf(done, viewer).cashToCollect).toEqual({ amountMinor: c.fare - c.wallet, currency: c.currency });
  });
});

describe.each([SEK, TND])("BQ-M25b: the driver's end with the rider on board ($currency)", (c) => {
  it("card + wallet part: 0 cash on the row and the ledger; finish.cashToCollect 0", async () => {
    const { trip, driverId } = await onBoard(c, "card", c.wallet);
    const ended = await database.db.transaction().execute((trx) => driverCancel(trx, driverId, trip.trip_id, { expectedVersion: trip.version, reasonCode: "vehicle_issue_on_trip" }, NOW));
    expect(Number(ended.cash_collected_minor)).toBe(0);
    const entry = await database.db.selectFrom("earnings_entries").select(["cash_minor"]).where("trip_id", "=", trip.trip_id).where("kind", "=", "trip").executeTakeFirstOrThrow();
    expect(Number(entry.cash_minor)).toBe(0);
    for (const viewer of ["driver", "rider", "admin"] as const) expect(finishOf(ended, viewer).cashToCollect).toEqual(ZERO(c));
  });

  it("cash + wallet part: unchanged — fare − wallet on the row, the ledger and finish.cashToCollect", async () => {
    const { trip, driverId } = await onBoard(c, "cash", c.wallet);
    const ended = await database.db.transaction().execute((trx) => driverCancel(trx, driverId, trip.trip_id, { expectedVersion: trip.version, reasonCode: "vehicle_issue_on_trip" }, NOW));
    expect(Number(ended.cash_collected_minor)).toBe(c.fare - c.wallet);
    const entry = await database.db.selectFrom("earnings_entries").select(["cash_minor"]).where("trip_id", "=", trip.trip_id).where("kind", "=", "trip").executeTakeFirstOrThrow();
    expect(Number(entry.cash_minor)).toBe(c.fare - c.wallet);
    expect(finishOf(ended, "driver").cashToCollect).toEqual({ amountMinor: c.fare - c.wallet, currency: c.currency });
  });
});
