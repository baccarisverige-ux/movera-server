import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/guard.js";
import { driverPayouts, listPayouts, makePayouts } from "../../src/admin/payouts.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { creditWallet } from "../../src/riders/wallet.js";
import { commissionOf } from "../../src/rules/commission.js";
import { tripProjection } from "../../src/trips/projection.js";
import { driverEarnings } from "../../src/trips/ride/earnings.js";
import { completeTrip, endEarly } from "../../src/trips/ride/finish.js";
import { receiptOf } from "../../src/trips/finish.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * BQ-M25 (money; contract.json#priceDisplay.owedToMovera "the cash he collected for the trip", contract §payouts "cash
 * collected = − the cash the driver took"): on a card trip nothing is collected in the car. Before: complete set
 * cash_collected_minor = fare − wallet on every payment method and creditTrip booked it as the driver's cash, so the payout
 * took the whole fare off the driver ("cash collected" line) while TripFinish.owedToMovera said Movera owes him his pay.
 * Card trips (with and without a wallet part) book 0 cash; a cash trip is unchanged. Sweden (SEK) and Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
const SUPER: Principal = { actor: "admin", subjectId: "adm_m25", sessionId: "s_m25", zones: ["*"], role: "super", perms: [] } as unknown as Principal;
const ADMIN = { actor: "admin" as const, subjectId: "adm_m25" };
const FROM = new Date("2026-11-09T00:00:00Z");
const NOW = new Date("2026-11-14T10:00:00Z");
const TO = new Date("2026-11-16T00:00:00Z");

type Case = { currency: "SEK" | "TND"; zone: string; tz: string; fare: number; earnings: number; pickup: number; bonus: number };
const SEK: Case = { currency: "SEK", zone: "Z001", tz: "Europe/Stockholm", fare: 18_750, earnings: 15_000, pickup: 360, bonus: 1_000 };
const TND: Case = { currency: "TND", zone: "TN-TC", tz: "Africa/Tunis", fare: 12_350, earnings: 9_880, pickup: 1_125, bonus: 500 };

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

/** Completes the trip (an admin at the booked fare: the same complete path as the driver's), pays the week, reads every money view. */
async function finished(c: Case, method: "card" | "cash", wallet: number) {
  const { trip, driverId } = await onBoard(c, method, wallet);
  const done = await database.db.transaction().execute((trx) => completeTrip(trx, ADMIN, trip.trip_id, { expectedVersion: trip.version, fare: { amountMinor: c.fare, currency: c.currency } }, NOW));
  const entry = await database.db.selectFrom("earnings_entries").select(["cash_minor"]).where("trip_id", "=", trip.trip_id).where("kind", "=", "trip").executeTakeFirstOrThrow();
  const finish = tripProjection(done, "driver")["finish"] as { driverTotal: { amountMinor: number }; owedToMovera: { amountMinor: number } };
  const [payout] = await database.db.transaction().execute((trx) => makePayouts(trx, { driverId, from: FROM, to: TO, source: "manual", by: null }, NOW));
  const lines = payout!.lines as Array<{ code: string; amountMinor: number }>;
  const mine = (await driverPayouts(database.db, driverId, { limit: 10 }, NOW)).items[0]!;
  const admin = (await listPayouts(database.db, SUPER, { limit: 10, driverId })).items[0]!;
  const report = await driverEarnings(database.db, driverId, { period: "week", from: FROM.toISOString(), to: TO.toISOString(), timeZone: c.tz, currency: c.currency }, NOW);
  const receipt = await receiptOf(database.db, done, "admin");
  return { done, entry, finish, payout: payout!, lines, mine, admin, report, receipt };
}

beforeAll(async () => {
  database = await freshDatabase();
  // The rider's early end prices what was driven: the Swedish pricing sample.
  const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 1, document: JSON.stringify(pricing), published_at: NOW, published_by: null }).execute();
});
afterAll(async () => {
  await database.drop();
});

describe.each([SEK, TND])("BQ-M25: a card trip books 0 cash ($currency)", (c) => {
  const driverTotal = c.earnings + c.pickup + c.bonus;

  it.each([0, c.currency === "SEK" ? 2_500 : 1_275])("card (wallet part %i): 0 cash on the trip and the ledger; payout = Driver gets = −owedToMovera = driverTotal", async (wallet) => {
    const r = await finished(c, "card", wallet);
    expect(Number(r.done.wallet_applied_minor)).toBe(wallet);
    // The ledger first (the bug): creditTrip booked fare − wallet as his cash.
    expect(Number(r.entry.cash_minor)).toBe(0);
    expect(Number(r.done.cash_collected_minor)).toBe(0);
    // No "cash collected" line: he took no cash. The payout pays his whole driverTotal.
    expect(r.lines.find((l) => l.code === "cash_collected")).toBeUndefined();
    expect(Number(r.payout.amount_minor)).toBe(driverTotal);
    expect(r.finish.driverTotal.amountMinor).toBe(driverTotal);
    // owedToMovera = cash held − driverTotal: Movera owes him exactly what the payout pays.
    expect(r.finish.owedToMovera.amountMinor).toBe(-driverTotal);
    expect(-r.finish.owedToMovera.amountMinor).toBe(Number(r.payout.amount_minor));
    expect(r.mine.summary).toEqual({ driverGets: { amountMinor: driverTotal, currency: c.currency }, moveraGets: { amountMinor: c.fare - driverTotal, currency: c.currency } });
    expect(r.admin.summary).toEqual(r.mine.summary);
    expect(r.report.periods.map((p) => p.cashCollected.amountMinor)).toEqual([0]);
    expect(r.receipt.cashPaid).toEqual({ amountMinor: 0, currency: c.currency });
  });

  it("cash (wallet part): unchanged — fare − wallet booked as cash, payout = driverTotal − cash = −owedToMovera", async () => {
    const wallet = c.currency === "SEK" ? 2_500 : 1_275;
    const r = await finished(c, "cash", wallet);
    const cash = c.fare - wallet;
    expect(Number(r.done.cash_collected_minor)).toBe(cash);
    expect(Number(r.entry.cash_minor)).toBe(cash);
    expect(r.lines.find((l) => l.code === "cash_collected")?.amountMinor).toBe(-cash);
    expect(Number(r.payout.amount_minor)).toBe(driverTotal - cash);
    expect(r.finish.owedToMovera.amountMinor).toBe(cash - driverTotal);
    expect(-r.finish.owedToMovera.amountMinor).toBe(Number(r.payout.amount_minor));
    expect(r.report.periods.map((p) => p.cashCollected.amountMinor)).toEqual([cash]);
    expect(r.receipt.cashPaid).toEqual({ amountMinor: cash, currency: c.currency });
  });
});

describe("BQ-M25: the rider's early end of a card trip books 0 cash too (same creditTrip)", () => {
  it("SEK card + wallet: end_early → 0 cash on the row and the ledger", async () => {
    const { trip } = await onBoard(SEK, "card", 2_500);
    const ended = await database.db.transaction().execute((trx) => endEarly(trx, trip.rider_id, trip.trip_id, { expectedVersion: trip.version }, NOW));
    expect(Number(ended.cash_collected_minor)).toBe(0);
    const entry = await database.db.selectFrom("earnings_entries").select(["cash_minor"]).where("trip_id", "=", trip.trip_id).where("kind", "=", "trip").executeTakeFirstOrThrow();
    expect(Number(entry.cash_minor)).toBe(0);
  });
});

describe("BQ-M25: a paid card trip can still be refunded up to its fare (refund room = what the rider paid)", () => {
  it("SEK card + wallet: refund room is the fare (card part + wallet), not the wallet part only", async () => {
    const r = await finished(SEK, "card", 2_500);
    const { paidByRider } = await import("../../src/admin/trips.js");
    expect(paidByRider(r.done)).toBe(SEK.fare);
    // A cash trip: the cash taken + the wallet part (unchanged).
    const cash = await finished(SEK, "cash", 2_500);
    expect(paidByRider(cash.done)).toBe(SEK.fare);
    expect(paidByRider({ ...cash.done, cash_collected_minor: "10000" } as TripRow)).toBe(10_000 + 2_500);
  });
});
