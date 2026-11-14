import { sql } from "kysely";
import type { ColumnType } from "kysely";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { newId } from "../ids.js";
import { liveDocument, standardKey } from "../config/service.js";

/**
 * S5 J8, contract v0.18.84 `debtModel` (owner Sitting 3 2026-11-12 Q-M1..Q-M4, Q-S5-3..Q-S5-5; 2026-11-13 15:00
 * "Any amount"). The rider's unpaid fee is a NEGATIVE wallet balance (riderWallet): a WalletEntry kind fee (−fee) in
 * the balance of the fee's currency. The debt is never copied into a price; it is read ONCE, when a trip is paid
 * (readAtPayment), under the wallet row lock, so two trips or two server copies never pay it twice.
 * rider_fees rows stay as history (Rule 21): status owed while unpaid, paid / waived when settled.
 */

/** wallet_floors (migration 0102): the safety floor per currency that only moves down (debtFloor.ts). */
export interface WalletFloorsTable {
  currency: string;
  floor_minor: ColumnType<string, number | string, number | string>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

declare module "../db/schema.js" {
  interface Database {
    wallet_floors: WalletFloorsTable;
  }
}

type Money = { amountMinor: number; currency: string };

/** contract.json#debtModel.oldApps: new fields and the new reminder line go only to apps on 0.18.84 or later. */
export const DEBT_MODEL_SINCE = "0.18.84";

/** A wallet move that may go below 0 (a fee) — the database floor (0102) is the only limit. */
async function moveIntoDebt(trx: Trx, riderId: string, currency: string, deltaMinor: number, now: Date) {
  await trx
    .insertInto("rider_wallets")
    .values({ rider_id: riderId, currency, balance_minor: deltaMinor, updated_at: now })
    .onConflict((oc) => oc.columns(["rider_id", "currency"]).doUpdateSet({ balance_minor: sql`rider_wallets.balance_minor + ${deltaMinor}`, updated_at: now }))
    .execute();
}

/**
 * Puts one unpaid fee into the wallet: a fee entry (−fee, tripId = the trip that owes it) and the balance moved, once
 * per trip (unique index wallet_entries_fee_once, 0103). False when it was already there.
 */
export async function feeIntoWallet(trx: Trx, fee: { tripId: string; riderId: string; amount: Money; at: Date }, now: Date): Promise<boolean> {
  const inserted = await trx
    .insertInto("wallet_entries")
    .values({ entry_id: newId("wlt", fee.at.getTime()), rider_id: fee.riderId, kind: "fee", currency: fee.amount.currency, amount_minor: -fee.amount.amountMinor, trip_id: fee.tripId, at: fee.at })
    .onConflict((oc) => oc.column("trip_id").where("kind", "=", "fee").doNothing())
    .returning("entry_id")
    .executeTakeFirst();
  if (inserted === undefined) return false;
  await moveIntoDebt(trx, fee.riderId, fee.amount.currency, -fee.amount.amountMinor, now);
  return true;
}

/**
 * Changeover (debtModel.changeover, supervisor M3 + "two server copies"): a fee written by an older server copy (rider_fees
 * owed, no wallet entry yet) is moved into the wallet before the debt is read. Idempotent (feeIntoWallet).
 */
export async function sweepOwedFees(trx: Trx, riderId: string, currency?: string): Promise<void> {
  let q = trx
    .selectFrom("rider_fees")
    .select(["trip_id", "rider_id", "currency", "amount_minor", "created_at"])
    .where("rider_id", "=", riderId)
    .where("status", "=", "owed")
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom("wallet_entries").select("entry_id").whereRef("wallet_entries.trip_id", "=", "rider_fees.trip_id").where("wallet_entries.kind", "=", "fee"))));
  if (currency !== undefined) q = q.where("currency", "=", currency);
  for (const f of await q.orderBy("created_at").orderBy("trip_id").execute()) {
    await feeIntoWallet(trx, { tripId: f.trip_id, riderId: f.rider_id, amount: { amountMinor: Number(f.amount_minor), currency: f.currency }, at: f.created_at }, f.created_at);
  }
}

/** Owed fees not in the wallet yet (written by an older server copy; sweepOwedFees moves them in at payment). */
async function unsweptFees(ex: Executor, riderId: string, currency: string): Promise<number> {
  const row = await ex.selectFrom("rider_fees").select(sql<string>`coalesce(sum(amount_minor), 0)`.as("sum")).where("rider_id", "=", riderId).where("status", "=", "owed").where("currency", "=", currency)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom("wallet_entries").select("entry_id").whereRef("wallet_entries.trip_id", "=", "rider_fees.trip_id").where("wallet_entries.kind", "=", "fee")))).executeTakeFirst();
  return Number(row?.sum ?? 0);
}

/** The rider's debt in one currency = −min(0, balance); `lock` takes the wallet row lock (payment). */
export async function riderDebt(ex: Executor, riderId: string, currency: string, lock = false): Promise<number> {
  let q = ex.selectFrom("rider_wallets").select("balance_minor").where("rider_id", "=", riderId).where("currency", "=", currency);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  return Math.max(0, -Number(row?.balance_minor ?? 0));
}

/** The oldest unpaid fee in a currency (FareLine.sourceTripId of the outstanding_fee line), null when none. */
async function oldestOwedFee(ex: Executor, riderId: string, currency: string): Promise<string | null> {
  const row = await ex.selectFrom("rider_fees").select("trip_id").where("rider_id", "=", riderId).where("status", "=", "owed").where("currency", "=", currency).orderBy("created_at").orderBy("trip_id").executeTakeFirst();
  return row?.trip_id ?? null;
}

type FareLineJson = { code: string; amount: Money; sourceTripId?: string };

/**
 * readAtPayment + changeover: the trip's price as paid now. A copied outstanding_fee line (a trip made before J8) is
 * dropped, and the debt of the trip's currency read now is added as the one outstanding_fee line. `fareMinor` and
 * `lines` are the price before the debt (they may still hold the copied line). Movera's commission stays the same:
 * commissionOf takes every outstanding_fee line out of the fare (rules/commission.ts), so it is not recomputed here.
 */
export function withDebt(fareMinor: number, lines: FareLineJson[], currency: string, debt: { amountMinor: number; sourceTripId: string | null }): { fareMinor: number; lines: FareLineJson[]; copied: number } {
  const copied = lines.filter((l) => l.code === "outstanding_fee").reduce((sum, l) => sum + Number(l.amount.amountMinor), 0);
  const kept = lines.filter((l) => l.code !== "outstanding_fee");
  if (debt.amountMinor > 0) kept.push({ code: "outstanding_fee", amount: { amountMinor: debt.amountMinor, currency }, ...(debt.sourceTripId ? { sourceTripId: debt.sourceTripId } : {}) });
  return { fareMinor: fareMinor - copied + debt.amountMinor, lines: kept, copied };
}

/** The debt to add to this trip's payment now (read without a lock: preview; with: payment). */
export async function debtForPayment(ex: Executor, trip: Pick<TripRow, "rider_id" | "currency">, lock: boolean): Promise<{ amountMinor: number; sourceTripId: string | null }> {
  // A read without the lock (the complete preview) does not sweep; it counts the fees an older server copy wrote that
  // the payment's sweep will move in, so the preview shows what complete will read.
  const amountMinor = (await riderDebt(ex, trip.rider_id, trip.currency, lock)) + (lock ? 0 : await unsweptFees(ex, trip.rider_id, trip.currency));
  return { amountMinor, sourceTripId: amountMinor > 0 ? await oldestOwedFee(ex, trip.rider_id, trip.currency) : null };
}

/**
 * The paid trip took `paidMinor` of the debt: a WalletEntry kind debt_paid (+paid) brings the balance back up, and the
 * oldest unpaid fees it covers are marked paid by this trip (history). Runs under the wallet row lock taken by
 * debtForPayment(lock) in the same transaction.
 */
export async function payDebt(trx: Trx, trip: Pick<TripRow, "trip_id" | "rider_id" | "currency">, paidMinor: number, now: Date): Promise<void> {
  if (paidMinor <= 0) return;
  await trx.insertInto("wallet_entries").values({ entry_id: newId("wlt", now.getTime()), rider_id: trip.rider_id, kind: "debt_paid", currency: trip.currency, amount_minor: paidMinor, trip_id: trip.trip_id, at: now }).execute();
  await moveIntoDebt(trx, trip.rider_id, trip.currency, paidMinor, now);
  const owed = await trx.selectFrom("rider_fees").select(["trip_id", "amount_minor"]).where("rider_id", "=", trip.rider_id).where("status", "=", "owed").where("currency", "=", trip.currency).orderBy("created_at").orderBy("trip_id").forUpdate().execute();
  let left = paidMinor;
  for (const fee of owed) {
    const amount = Number(fee.amount_minor);
    if (amount > left) break;
    left -= amount;
    await trx.updateTable("rider_fees").set({ status: "paid", carried_by: trip.trip_id, settled_at: now }).where("trip_id", "=", fee.trip_id).execute();
    const source = await trx.selectFrom("trips").select("cancellation").where("trip_id", "=", fee.trip_id).executeTakeFirst();
    if (source?.cancellation) await trx.updateTable("trips").set({ cancellation: JSON.stringify({ ...(source.cancellation as object), feeStatus: "paid" }) }).where("trip_id", "=", fee.trip_id).execute();
  }
}

/**
 * debtModel.adminCorrections: Mark as paid, waive and reverse no-show write a correction — a WalletEntry kind adjustment
 * (+the fee, at most what is still owed in that currency) — never an edit of a past entry. A ride open at that moment
 * simply reads the lower debt when it is paid (no fee_on_running_trip refusal any more).
 */
export async function correctFee(trx: Trx, fee: { trip_id: string; rider_id: string; currency: string; amount_minor: string | number }, now: Date): Promise<number> {
  await sweepOwedFees(trx, fee.rider_id, fee.currency);
  const debt = await riderDebt(trx, fee.rider_id, fee.currency, true);
  const back = Math.min(Number(fee.amount_minor), debt);
  if (back > 0) {
    await trx.insertInto("wallet_entries").values({ entry_id: newId("wlt", now.getTime()), rider_id: fee.rider_id, kind: "adjustment", currency: fee.currency, amount_minor: back, trip_id: fee.trip_id, at: now }).execute();
    await moveIntoDebt(trx, fee.rider_id, fee.currency, back, now);
  }
  return back;
}

/** Every currency the rider owes in, oldest unpaid fee first (Rider.outstandingByCurrency, derived from the wallet). */
export async function debtsByCurrency(ex: Executor, riderId: string): Promise<Array<{ amountMinor: number; currency: string; sourceTripId: string | null }>> {
  const rows = await ex.selectFrom("rider_wallets").select(["currency", "balance_minor"]).where("rider_id", "=", riderId).where("balance_minor", "<", "0").execute();
  if (rows.length === 0) return [];
  const fees = await ex.selectFrom("rider_fees").select(["trip_id", "currency", "created_at"]).where("rider_id", "=", riderId).where("status", "=", "owed").orderBy("created_at").orderBy("trip_id").execute();
  const first = new Map<string, { tripId: string; at: number }>();
  for (const f of fees) if (!first.has(f.currency)) first.set(f.currency, { tripId: f.trip_id, at: f.created_at.getTime() });
  return rows
    .map((r) => ({ amountMinor: -Number(r.balance_minor), currency: r.currency, sourceTripId: first.get(r.currency)?.tripId ?? null, at: first.get(r.currency)?.at ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at || a.currency.localeCompare(b.currency))
    .map(({ amountMinor, currency, sourceTripId }) => ({ amountMinor, currency, sourceTripId }));
}

/* ---------------------------------------------------------------- Max rider debt (booking) */

const DEFAULT_MAX = (contract as unknown as { configDefaults: { maxRiderDebt: Record<string, Money> } }).configDefaults.maxRiderDebt;

/** CountryRules.maxRiderDebt of the country standard (a zone's own value is ignored); missing / other currency = default. */
export async function maxRiderDebtOf(ex: Executor, country: string, currency: string): Promise<Money | null> {
  const doc = (await liveDocument<{ maxRiderDebt?: Money }>(ex, "country_rules", standardKey(country)))?.document;
  const set = doc?.maxRiderDebt;
  if (set && set.currency === currency && Number.isInteger(set.amountMinor) && set.amountMinor > 0) return set;
  const fallback = DEFAULT_MAX[country];
  return fallback && fallback.currency === currency ? fallback : null;
}
