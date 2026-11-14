import { moneyText } from "../rules/money.js";
import { perMinWithAppFee } from "../rules/fare.js";
import { contract } from "../contract/contract.js";
import { liveDocument } from "../config/service.js";
import type { Executor } from "../db/db.js";
import { effectiveWaiting, waitingExtrasOf, type CategoryWaiting, type Money, type WaitingContext, type WaitingRuleId } from "../trips/waitingRules.js";

/**
 * v0.18.8 (contract.json#arrivedWaiting.termsTexts; owner G6 decision 4): the Terms' {waitingRules} paragraph filled with a
 * zone's live waiting, no-show and cancel numbers, per category and per extra rule, in the text's language and the zone's
 * currency. Null when the zone has no pricing (the paragraph is then left out).
 */

type Lang = "sv" | "fr" | "en";
type Lines = { category: Record<Lang, string>; cancelFixed: Record<Lang, string>; cancelPercent: Record<Lang, string>; rule: Record<Lang, string>; stops: Record<Lang, string> };
const AW = (contract as unknown as { arrivedWaiting: { termsTexts: { lines: Lines }; rules: { texts: Record<WaitingRuleId, Record<Lang, string>> } } }).arrivedWaiting;
const LABELS = (contract as unknown as { categories: { labels: Record<string, string> } }).categories.labels;

/**
 * The Terms' money (price format, owner 2026-11-14 "make sure rider and driver app show correct prices every where";
 * contract.json#moneyDisplay §81): the format follows the currency, not the text's language, and whole amounts keep their
 * decimals — '13,49 kr', '0,55 €', '5.000 DT', '65,00 kr' in sv, fr and en. (fixtures/arrived_waiting.json#termsMoney
 * still shows the older en / whole-amount texts: contract gap 2 of audits/price-display-2026-11-14.)
 */
export function termsMoney(m: Money, _lang: Lang): string {
  return moneyText(m);
}

/**
 * Gap 15 (contract.json#waitingPriceShown, owner 2026-11-02 "Show price incl. fee", Rules decisions/driver-g6.md:96): the
 * Terms tell the rider the price per minute as he pays it, with the category's app fee (12,26 kr + 10 % = 13,49 kr), as
 * the rider app shows it; a category without an app fee keeps its raw price.
 */
const shownPerMin = (perMin: Money, appFeePct: unknown): Money =>
  typeof appFeePct === "number" && Number.isFinite(appFeePct) && appFeePct >= 0 && appFeePct <= 100 ? perMinWithAppFee(perMin, appFeePct) : perMin;

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (all, k: string) => (k in values ? String(values[k]) : all));
const minutes = (n: number, lang: Lang) => (lang === "en" ? String(n) : String(n).replace(".", ","));

type PricingDoc = { currency: string; categories: Record<string, { label?: string; waiting?: CategoryWaiting; stopWaitPerMin?: Money; appFeePct?: unknown }> };
type FeeRule = { freeMin: number; type: string; value: number };

export async function waitingRulesText(ex: Executor, zoneId: string, lang: Lang): Promise<string | null> {
  const pricing = (await liveDocument<PricingDoc>(ex, "pricing", zoneId))?.document;
  if (!pricing?.categories) return null;
  const driver = (await liveDocument<{ waiting?: unknown }>(ex, "driver_app_config", zoneId))?.document;
  const rider = (await liveDocument<{ cancelFees?: { live?: Record<string, FeeRule> } }>(ex, "rider_app_config", zoneId))?.document;
  const ids = Object.keys(pricing.categories).filter((id) => pricing.categories[id]?.waiting);
  if (ids.length === 0) return null;
  const label = (id: string) => pricing.categories[id]?.label ?? LABELS[id] ?? id;
  const out: string[] = [];
  for (const id of ids) {
    const w = pricing.categories[id]!.waiting!;
    out.push(fill(AW.termsTexts.lines.category[lang], { category: label(id), free: minutes(w.freeWaitMin, lang), perMin: termsMoney(shownPerMin(w.perMin, pricing.categories[id]!.appFeePct), lang), noShowAfter: minutes(w.noShowAfterMin, lang), noShowFee: termsMoney(w.noShowFee, lang) }));
    const rule = rider?.cancelFees?.live?.[id];
    if (rule && rule.value > 0) {
      if (rule.type === "fixed") out.push(fill(AW.termsTexts.lines.cancelFixed[lang], { category: label(id), freeMin: minutes(rule.freeMin, lang), fee: termsMoney({ amountMinor: rule.value, currency: pricing.currency }, lang) }));
      else if (rule.type === "percent") out.push(fill(AW.termsTexts.lines.cancelPercent[lang], { category: label(id), freeMin: minutes(rule.freeMin, lang), pct: minutes(rule.value, lang) }));
    }
  }
  // The extra rules, on the headline category (economy, else the first).
  const head = ids.includes("economy") ? "economy" : ids[0]!;
  const base = pricing.categories[head]!.waiting!;
  const extras = waitingExtrasOf(driver?.waiting, pricing.currency);
  const none: WaitingContext = { kind: "live", pickupInAirportZone: false, inEvent: false, acceptPickupMeters: null };
  const cases: Array<[WaitingRuleId, boolean, WaitingContext]> = [
    ["airport", extras.rideTypes.airport.on, { ...none, pickupInAirportZone: true }],
    ["scheduled", extras.rideTypes.scheduled.on, { ...none, kind: "scheduled" }],
    ["event", extras.rideTypes.event.on, { ...none, inEvent: true }],
    ["far_pickup", extras.farPickup.on, { ...none, acceptPickupMeters: extras.farPickup.km * 1000 + 1 }],
  ];
  for (const [id, on, ctx] of cases) {
    if (!on) continue;
    const eff = effectiveWaiting(base, extras, ctx);
    const name = fill(AW.rules.texts[id][lang], { km: minutes(extras.farPickup.km, lang) });
    out.push(fill(AW.termsTexts.lines.rule[lang], { rule: name, free: minutes(eff.freeWaitMin, lang), noShowAfter: minutes(eff.noShowAfterMin, lang), noShowFee: termsMoney(eff.noShowFee, lang) }));
  }
  const stopPrice = pricing.categories[head]!.stopWaitPerMin;
  if (stopPrice && (stopPrice.amountMinor > 0 || extras.stopFreeWaitMin > 0)) {
    out.push(fill(AW.termsTexts.lines.stops[lang], { free: minutes(extras.stopFreeWaitMin, lang), perMin: termsMoney(shownPerMin(stopPrice, pricing.categories[head]!.appFeePct), lang) }));
  }
  return out.join("\n");
}
