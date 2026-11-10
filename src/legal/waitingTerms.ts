import { majorText } from "../rules/money.js";
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

/** sv / fr '12,26 kr', '0,50 €'; en '12.26 kr', '€0.50'; whole amounts without decimals (fixtures/arrived_waiting.json#termsMoney). */
export function termsMoney(m: Money, lang: Lang): string {
  let num = majorText(m);
  if (m.currency === "TND") return `${num} DT`; // v0.18.59 §81: dot in every language
  if (lang !== "en") num = num.replace(".", ",");
  if (m.currency === "SEK") return `${num} kr`;
  if (m.currency === "EUR") return lang === "en" ? `€${num}` : `${num} €`;
  return `${num} ${m.currency}`;
}

const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (all, k: string) => (k in values ? String(values[k]) : all));
const minutes = (n: number, lang: Lang) => (lang === "en" ? String(n) : String(n).replace(".", ","));

type PricingDoc = { currency: string; categories: Record<string, { label?: string; waiting?: CategoryWaiting; stopWaitPerMin?: Money }> };
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
    out.push(fill(AW.termsTexts.lines.category[lang], { category: label(id), free: minutes(w.freeWaitMin, lang), perMin: termsMoney(w.perMin, lang), noShowAfter: minutes(w.noShowAfterMin, lang), noShowFee: termsMoney(w.noShowFee, lang) }));
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
    out.push(fill(AW.termsTexts.lines.stops[lang], { free: minutes(extras.stopFreeWaitMin, lang), perMin: termsMoney(stopPrice, lang) }));
  }
  return out.join("\n");
}
