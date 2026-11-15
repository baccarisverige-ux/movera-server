import { waitingExtrasOf } from "../trips/waitingRules.js";
import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import type { Trx } from "../db/db.js";
import { standardKey } from "../config/service.js";

/**
 * S5 J8, contract v0.18.84 debtModel.dbFloor (owner Q-S5-3; owner 2026-11-13 15:00 "Any amount": no admin cap on Max
 * rider debt, the database floor follows the setting so a running trip's fee is always saved).
 *
 * floor = min(current floor, −(3 × max), −(max + 4 × the largest cancel or no-show fee the country's settings can
 * produce)) — room for the fees of every ride a rider may still have open (3 booked rides + 1 live trip, B1.34) on top
 * of a debt just under the max. Recomputed in the SAME transaction as the admin save of Max rider debt or of a cancel /
 * no-show fee; it ONLY moves down (lowering the max or a fee leaves it), so it never lands on or above a balance.
 */

type Money = { amountMinor: number; currency: string };
type FeeRuleJson = { type?: string; value?: unknown; max?: Money | null; min?: Money | null };

const DEFAULT_MAX = (contract as unknown as { configDefaults: { maxRiderDebt: Record<string, Money> } }).configDefaults.maxRiderDebt;

const minor = (m: unknown, currency: string): number => {
  const money = m as Money | null | undefined;
  return money && money.currency === currency && Number.isFinite(money.amountMinor) ? Math.max(0, Math.trunc(money.amountMinor)) : 0;
};

/** The largest fee one rule can produce: fixed = its value; percent = its max (a percent rule with no max has no bound). */
function ruleMax(rule: FeeRuleJson | undefined, currency: string): number {
  if (!rule) return 0;
  if (rule.type === "fixed") return Math.max(0, Math.trunc(Number(rule.value) || 0), minor(rule.min, currency));
  return Math.max(minor(rule.max, currency), minor(rule.min, currency));
}

/** The largest cancel or no-show fee of every live pricing and rider document of the country (standard + its zones). */
export async function largestFee(trx: Trx, country: string, currency: string): Promise<number> {
  const keys = (await trx.selectFrom("zones").select("zone_id").where("country", "=", country).execute()).map((z) => z.zone_id);
  const docs = await trx.selectFrom("config_live").select(["doc", "document"]).where("doc", "in", ["pricing", "rider_app_config", "driver_app_config"]).where("zone_id", "in", [standardKey(country), ...keys]).execute();
  // Must-fix 4 (supervisor J8 round 1): the driver document's waiting rules may set their own no-show fee (far pickup,
  // airport / event / scheduled rides); a far pickup with no fee of its own uses the contract default (85 kr / 8.10 €).
  // waitingExtrasOf reads them exactly as the no-show does, the default included, so a zone with no driver document counts too.
  const extrasFees = (waiting: unknown) => {
    const x = waitingExtrasOf(waiting, currency);
    return [x.farPickup.noShowFee, x.rideTypes.airport.noShowFee, x.rideTypes.event.noShowFee, x.rideTypes.scheduled.noShowFee].map((m) => minor(m, currency));
  };
  let largest = Math.max(0, ...extrasFees(undefined));
  for (const { doc, document } of docs) {
    if (doc === "driver_app_config") {
      largest = Math.max(largest, ...extrasFees((document as { waiting?: unknown }).waiting));
    } else if (doc === "pricing") {
      const cats = (document as { categories?: Record<string, { waiting?: { noShowFee?: unknown } }> }).categories ?? {};
      for (const c of Object.values(cats)) largest = Math.max(largest, minor(c?.waiting?.noShowFee, currency));
    } else {
      const fees = (document as { cancelFees?: { live?: Record<string, FeeRuleJson>; reservation?: Record<string, FeeRuleJson> } }).cancelFees ?? {};
      for (const rule of [...Object.values(fees.live ?? {}), ...Object.values(fees.reservation ?? {})]) largest = Math.max(largest, ruleMax(rule, currency));
    }
  }
  return largest;
}

/** The floor the settings ask for now (≤ 0), before the "only down" rule. */
export function floorFor(maxMinor: number, largestFeeMinor: number): number {
  return Math.min(-3 * maxMinor, -(maxMinor + 4 * largestFeeMinor));
}

/**
 * Moves the country currency's floor down when its settings need more room; never up. Locks the floor row (the UPDATE /
 * upsert) in the caller's transaction, i.e. the admin save itself. Returns the floor now.
 */
export async function followFloor(trx: Trx, country: string, now: Date): Promise<number | null> {
  const zone = await trx.selectFrom("zones").select("currency").where("country", "=", country).executeTakeFirst();
  if (!zone) return null;
  const currency = zone.currency;
  const rules = await trx.selectFrom("config_live").select("document").where("doc", "=", "country_rules").where("zone_id", "=", standardKey(country)).executeTakeFirst();
  const set = (rules?.document as { maxRiderDebt?: Money } | undefined)?.maxRiderDebt;
  const max = set && set.currency === currency && set.amountMinor > 0 ? set.amountMinor : minor(DEFAULT_MAX[country], currency);
  const wanted = floorFor(max, await largestFee(trx, country, currency));
  const row = await trx
    .insertInto("wallet_floors")
    .values({ currency, floor_minor: wanted, updated_at: now })
    .onConflict((oc) => oc.column("currency").doUpdateSet({ floor_minor: sql`least(wallet_floors.floor_minor, excluded.floor_minor)`, updated_at: now }))
    .returning("floor_minor")
    .executeTakeFirstOrThrow();
  return Number(row.floor_minor);
}
