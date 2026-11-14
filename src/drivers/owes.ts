import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { liveDocument, standardKey } from "../config/service.js";
import { scheduleTimer } from "../jobs/timers.js";
import { WITHDRAW_CASH } from "../dispatch/runtime/shared.js";

/**
 * S5 J8, contract v0.18.84 `debtModel.driverOwes` (owner Q-S5-1 "Both" 2026-11-12; 2026-11-13 14:22 "150 DT … admin can
 * change", 14:32 shipped OFF, 14:54 "can recive trip but cash trip … always admin can switch on/off", 14:59 "What he
 * owes Movera", 15:01 "He keeps it").
 *
 * owed (per currency) = −min(0, his next payout worked out now + the rest carried from earlier payouts below 0):
 * the cash he holds (commission + rider debt he collected on pay-in-car trips) minus the earnings Movera holds for him,
 * plus what is still owed from earlier weeks. A "Driver paid Movera" entry (paid_to_movera, +amount) raises the sum.
 *
 * The limit (CountryRules.driverOwesLimit of the country standard) only stops NEW pay-in-car offers; going online is
 * never refused, card / Apple Pay / wallet trips still come, and rides he already accepted stay his.
 */

type Money = { amountMinor: number; currency: string };
export type OwesLimit = { enabled: boolean; max: Money | null };

const DEFAULTS = (contract as unknown as { configDefaults: { driverOwesLimit: Record<string, OwesLimit> } }).configDefaults.driverOwesLimit;

/** The contract's own payout sum (admin/payouts.ts payoutLines): every amount, less the cash of trips and cash tips. */
const PAYOUT_SUM = sql<string>`coalesce(sum(e.amount_minor - CASE WHEN e.kind IN ('trip', 'tip') THEN coalesce(e.cash_minor, 0) ELSE 0 END), 0)`;

/**
 * CountryRules.driverOwesLimit of the country standard (a zone's own value is ignored). Missing = the contract default
 * (OFF everywhere; TN 150 DT stored). Usable only when enabled with a max > 0.
 */
export async function owesLimitOf(ex: Executor, country: string | null): Promise<OwesLimit> {
  if (!country) return { enabled: false, max: null };
  const doc = (await liveDocument<{ driverOwesLimit?: Partial<OwesLimit> }>(ex, "country_rules", standardKey(country)))?.document;
  const set = doc?.driverOwesLimit;
  const fallback = DEFAULTS[country] ?? { enabled: false, max: null };
  const max = set && "max" in set ? (set.max ?? null) : fallback.max;
  const enabled = set && typeof set.enabled === "boolean" ? set.enabled : fallback.enabled;
  return { enabled: enabled && max !== null && max.amountMinor > 0, max };
}

/**
 * What each driver owes Movera in `currency` (0 when nothing): one grouped query over the unpaid entries
 * (index earnings_unpaid) and one over the open payouts below 0, for all `driverIds` at once (Rule 33).
 * Carried rest before J13 (contract debtModel.driverOwes.owed, Q-M3 / Q-S5-7a): a payout below 0 that is not paid yet
 * is read as it is (no UPDATE).
 */
export async function owedByDriver(ex: Executor, driverIds: readonly string[], currency: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (driverIds.length === 0) return out;
  const ids = [...new Set(driverIds)];
  const unpaid = await ex
    .selectFrom("earnings_entries as e")
    .select(["e.driver_id", PAYOUT_SUM.as("sum")])
    .where("e.driver_id", "in", ids)
    .where("e.payout_id", "is", null)
    .where("e.currency", "=", currency)
    .groupBy("e.driver_id")
    .execute();
  const carried = await ex
    .selectFrom("payouts")
    .select(["driver_id", sql<string>`coalesce(sum(amount_minor), 0)`.as("sum")])
    .where("driver_id", "in", ids)
    .where("currency", "=", currency)
    .where("amount_minor", "<", "0")
    .where("status", "in", ["pending", "pending_approval"])
    .groupBy("driver_id")
    .execute();
  const net = new Map<string, number>();
  for (const r of unpaid) net.set(r.driver_id, (net.get(r.driver_id) ?? 0) + Number(r.sum));
  for (const r of carried) net.set(r.driver_id, (net.get(r.driver_id) ?? 0) + Number(r.sum));
  for (const id of ids) out.set(id, Math.max(0, -(net.get(id) ?? 0)));
  return out;
}

/** One driver's owed in his country's currency and his country's limit. */
export async function owesState(ex: Executor, driverId: string): Promise<{ owed: Money; limit: OwesLimit; over: boolean } | null> {
  const row = await ex.selectFrom("drivers").select(["country"]).where("driver_id", "=", driverId).executeTakeFirst();
  const limit = await owesLimitOf(ex, row?.country ?? null);
  if (!limit.max) return null;
  const owed = (await owedByDriver(ex, [driverId], limit.max.currency)).get(driverId) ?? 0;
  return { owed: { amountMinor: owed, currency: limit.max.currency }, limit, over: limit.enabled && owed >= limit.max.amountMinor };
}

/**
 * Of `driverIds`, those who may get NO offer for this trip: only a pay-in-car trip, only while the trip country's limit is
 * on, only drivers whose owed is at or above it (debtModel.driverOwes.cashOffers). Empty for every other trip.
 */
export async function overOwesLimit(ex: Executor, trip: { zone_id: string; payment_method: string }, driverIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (trip.payment_method !== "cash" || driverIds.length === 0) return out;
  const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", trip.zone_id).executeTakeFirst();
  const limit = await owesLimitOf(ex, zone?.country ?? null);
  if (!limit.enabled || !limit.max) return out;
  for (const [id, owed] of await owedByDriver(ex, driverIds, limit.max.currency)) if (owed >= limit.max.amountMinor) out.set(id, owed);
  return out;
}

/** The 409 details of debtModel.driverOwes.cashOffers ("owed:<minor> <CUR>", "limit:<minor> <CUR>"). */
export const owesDetails = (owed: number, limit: Money): string[] => [`owed:${owed} ${limit.currency}`, `limit:${limit.amountMinor} ${limit.currency}`];

/**
 * debtModel.driverOwes.cashOffers "it applies at once": once his owed may have risen (a paid end of a pay-in-car trip,
 * an admin entry), a withdraw job closes his OPEN pay-in-car offers if he is at or over the limit (re-checked when it
 * runs; lock order trip → offer → driver, like going offline). Accepted trips (the current one, a queued one, a booked
 * ride he holds) are never touched (owner 15:01 "He keeps it").
 */
export async function checkCashOffersSoon(trx: Trx, driverId: string, now: Date): Promise<void> {
  const open = await trx.selectFrom("offers").innerJoin("trips", "trips.trip_id", "offers.trip_id").select("offers.offer_id")
    .where("offers.driver_id", "=", driverId).where("offers.status", "=", "open").where("trips.payment_method", "=", "cash").executeTakeFirst();
  if (open) await scheduleTimer(trx, { kind: WITHDRAW_CASH, refId: driverId, dueAt: now, payload: {} });
}
