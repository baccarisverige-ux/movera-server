/**
 * The admin demo's publish checks for a zone's prices (Admin Pricing, zonePricing.ts validateZoneBook), on the
 * server's pricing document (contract v0.6.0 §6.2) where the contract's schema does not already say them. The
 * currency-based sanity maxima of the demo (PRICE_MAX_SEK and its conversion rates) are not in the contract and are
 * not checked here.
 */

type Money = { amountMinor: number; currency: string };
type Category = { base: Money; minimum: Money; maximum: Money | null } & Record<string, unknown>;
type Profile = { id: string; name: string; isDefault: boolean; days: number[]; windows: { from: string; to: string }[]; steps: { ratio: number; multiplier: number }[]; cap: number };
type Doc = {
  categories: Record<string, Category>;
  fees: Record<string, unknown>;
  fixedRoutes: { id: string; from: string; to: string; price: Money }[];
  surge: { maxMultiplier: number; smart: { activeFrom?: string; activeTo?: string; profiles: Profile[] }; scheduled: { id: string; name?: string; multiplier: number; startsAt: string; endsAt: string }[] };
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONEY_FIELDS = ["base", "perKm", "perMin", "minimum", "maximum", "extraStopFee", "stopWaitPerMin", "babySeatFee", "childSeatFee"] as const;

const isMoney = (value: unknown): value is Money => value !== null && typeof value === "object" && typeof (value as Money).amountMinor === "number";

/** Every problem that stops the document from being saved or published, as "path: message". */
export function pricingProblems(document: unknown): string[] {
  const doc = document as Doc;
  const problems: string[] = [];
  const add = (path: string, message: string) => problems.push(`${path}: ${message}`);
  for (const [id, category] of Object.entries(doc.categories)) {
    for (const field of MONEY_FIELDS) {
      const value = category[field];
      if (isMoney(value) && value.amountMinor < 0) add(`categories.${id}.${field}`, "must be 0 or more");
    }
    const waiting = category["waiting"] as { perMin?: unknown; noShowFee?: unknown } | undefined;
    for (const field of ["perMin", "noShowFee"] as const) {
      const value = waiting?.[field];
      if (isMoney(value) && value.amountMinor < 0) add(`categories.${id}.waiting.${field}`, "must be 0 or more");
    }
    // A-O2 (owner decision): every ride starts at a real price.
    if (category.base.amountMinor === 0) add(`categories.${id}.base`, "the base fare must be above 0");
    if (category.maximum !== null && category.maximum.amountMinor > 0 && category.minimum.amountMinor > category.maximum.amountMinor) add(`categories.${id}.minimum`, "the minimum fare is higher than the maximum fare");
  }
  for (const [key, value] of Object.entries(doc.fees)) if (isMoney(value) && value.amountMinor < 0) add(`fees.${key}`, "fees must be 0 or more");
  for (const route of doc.fixedRoutes) {
    if (!route.from.trim() || !route.to.trim()) add(`fixedRoutes.${route.id}`, "a fixed route needs a from and a to place");
    if (!(route.price.amountMinor > 0)) add(`fixedRoutes.${route.id}`, "a fixed route needs a price above 0");
  }
  const smart = doc.surge.smart;
  if ((smart.activeFrom !== undefined && !TIME.test(smart.activeFrom)) || (smart.activeTo !== undefined && !TIME.test(smart.activeTo))) add("surge.smart.active", "active hours must be like 06:00");
  if (smart.profiles.filter((profile) => profile.isDefault).length !== 1) add("surge.smart.profiles", "smart surge needs exactly one Normal (fallback) profile");
  for (const profile of smart.profiles) {
    if (!profile.name.trim()) add(`surge.smart.${profile.id}`, "every time profile needs a name");
    if (!profile.isDefault && !profile.days.length) add(`surge.smart.${profile.id}`, "pick at least one day");
    if (profile.windows.some((window) => !TIME.test(window.from) || !TIME.test(window.to))) add(`surge.smart.${profile.id}`, "times must be like 07:00");
    profile.steps.forEach((step, index) => {
      const before = profile.steps[index - 1];
      if (before && (step.ratio <= before.ratio || step.multiplier < before.multiplier)) add(`surge.smart.${profile.id}.steps`, "each step must have a higher level and at least the same surge as the one before");
      if (step.multiplier > profile.cap) add(`surge.smart.${profile.id}.steps`, `a step is above the cap ×${profile.cap}`);
    });
  }
  for (const item of doc.surge.scheduled) {
    if (!(Date.parse(item.endsAt) > Date.parse(item.startsAt))) add(`surge.scheduled.${item.id}`, `scheduled surge "${item.name || "untitled"}" must end after it starts`);
  }
  return problems;
}
