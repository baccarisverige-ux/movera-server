import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";

/**
 * Deep fix 2026-11-02 (owner rule 16; g1-g3 H2, M2, M6): admin limits per country in CountryRules.limits
 * (contract.json#countryLimits): wrong sign-in codes per number per day (the number is locked until the oldest leaves
 * the 24 h window), sign-in codes per client address (one wifi) per hour, document uploads per driver per hour.
 * A missing value, or one outside its range, reads as the default.
 */
export type CountryLimits = {
  wrongCodesPerDay: number;
  codesPerAddressPerHour: number;
  codesPerPhonePerHour: number;
  uploadsPerHour: number;
  /** v0.18.24 (owner 2026-11-04 "Yes, admin setting"): the general write limit (http/rateLimit.ts). */
  writesPerUserPerMinute: number;
  writesPerAddressPerMinute: number;
  savedPlacesPerPerson: number;
  emergencyContactsPerPerson: number;
  /** v0.18.138 (owner 2026-11-20 "Ok", contract.json#deviceCheck.deviceLimit): sign-in codes per app install per hour. */
  codesPerDevicePerHour: number;
};
type Spec = { defaults: CountryLimits; ranges: Record<keyof CountryLimits, [number, number]> };
export const COUNTRY_LIMITS = (contract as unknown as { countryLimits: Spec }).countryLimits;

/** Country calling codes of the countries Movera serves: the phone's country decides which limits apply at sign-in. */
const DIAL: Array<[string, string]> = [["+46", "SE"], ["+33", "FR"], ["+216", "TN"]];
export const countryOfPhone = (phone: string): string | null => DIAL.find(([prefix]) => phone.startsWith(prefix))?.[1] ?? null;

export function countryLimitsOf(rules: unknown): CountryLimits {
  const raw = (rules as { limits?: Record<string, unknown> } | null | undefined)?.limits ?? {};
  const out = { ...COUNTRY_LIMITS.defaults };
  for (const key of Object.keys(out) as Array<keyof CountryLimits>) {
    const v = raw[key];
    const [lo, hi] = COUNTRY_LIMITS.ranges[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi) out[key] = v;
  }
  return out;
}

/** The live limits of a country (its standard country_rules); no country: the defaults. */
export async function countryLimitsFor(ex: Executor, country: string | null | undefined): Promise<CountryLimits> {
  if (!country) return countryLimitsOf(null);
  const row = await ex.selectFrom("config_live").select("document").where("doc", "=", "country_rules").where("zone_id", "=", `standard-${country}`).executeTakeFirst();
  return countryLimitsOf(row?.document);
}
