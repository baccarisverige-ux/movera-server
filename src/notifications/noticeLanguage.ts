import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";

/**
 * v0.18.66 §87 (contract.json#noticeLanguage, owner 2026-11-11 "French for TN"): ONE language rule for every push and
 * every Notifications-list notice (bell) the server writes: the person's own language (account language) when set;
 * else the language of the country (configDefaults.countries.<country>.defaultLanguage: SE sv, FR fr, TN fr); else en.
 * The country is the trip zone's country for a trip notice, otherwise the person's zone's country.
 *
 * It replaces the shorter "SE sv, FR fr, else en" lists (Tunisian notices were English) and the receipt / wallet
 * notices that fell back to Swedish whatever the country. Not the apps' first language before sign-in (§82).
 */
export type Lang = "sv" | "fr" | "en";
export const isLang = (value: unknown): value is Lang => value === "sv" || value === "fr" || value === "en";

const COUNTRIES = (contract as unknown as { configDefaults: { countries: Record<string, { defaultLanguage?: unknown }> } }).configDefaults.countries;

/** The country's language from the contract defaults (SE sv, FR fr, TN fr); undefined for an unknown country. */
export function countryLanguage(country: string | null | undefined): Lang | undefined {
  const lang = country ? COUNTRIES[country]?.defaultLanguage : undefined;
  return isLang(lang) ? lang : undefined;
}

/** A stored account language ("sv", "fr", "en"; a longer tag such as "fr-FR" reads by its first two letters). */
export function ownLanguage(value: unknown): Lang | undefined {
  if (typeof value !== "string") return undefined;
  const two = value.slice(0, 2).toLowerCase();
  return isLang(two) ? two : undefined;
}

/** The rule itself, for a caller that already has both facts: own language, else the country's, else en. */
export function pickNoticeLanguage(own: unknown, country: string | null | undefined): Lang {
  return ownLanguage(own) ?? countryLanguage(country) ?? "en";
}

export async function zoneCountry(ex: Executor, zoneId: string | null | undefined): Promise<string | null> {
  if (!zoneId) return null;
  return (await ex.selectFrom("zones").select("country").where("zone_id", "=", zoneId).executeTakeFirst())?.country ?? null;
}

/** A trip's zone (for a trip notice whose caller has only the trip id). */
export async function tripZoneId(ex: Executor, tripId: string): Promise<string | null> {
  return (await ex.selectFrom("trips").select("zone_id").where("trip_id", "=", tripId).executeTakeFirst())?.zone_id ?? null;
}

/** The person's zone's country: a driver's country (else his first zone's), a rider's last seen zone's. */
export async function personCountry(ex: Executor, actor: "rider" | "driver", id: string): Promise<string | null> {
  if (actor === "driver") {
    const d = await ex.selectFrom("drivers").select(["country", "zone_ids"]).where("driver_id", "=", id).executeTakeFirst();
    return d?.country ?? (await zoneCountry(ex, d?.zone_ids[0]));
  }
  const r = await ex.selectFrom("riders").select("last_seen_zone_id").where("rider_id", "=", id).executeTakeFirst();
  return zoneCountry(ex, r?.last_seen_zone_id);
}

async function storedLanguage(ex: Executor, actor: "rider" | "driver", id: string): Promise<string | null> {
  const row = actor === "rider"
    ? await ex.selectFrom("riders").select("language").where("rider_id", "=", id).executeTakeFirst()
    : await ex.selectFrom("drivers").select("language").where("driver_id", "=", id).executeTakeFirst();
  return row?.language ?? null;
}

/**
 * The notice language of a rider or driver. `language`: the account language when the caller already read the row
 * (null = none set); left out, it is read here. `zoneId`: the trip's zone for a trip notice; left out (or null), the
 * person's own zone's country is used.
 */
export async function noticeLanguage(ex: Executor, to: { actor: "rider" | "driver"; id: string; language?: string | null }, zoneId?: string | null): Promise<Lang> {
  const own = ownLanguage(to.language !== undefined ? to.language : await storedLanguage(ex, to.actor, to.id));
  if (own) return own;
  const country = zoneId ? await zoneCountry(ex, zoneId) : await personCountry(ex, to.actor, to.id);
  return countryLanguage(country) ?? "en";
}
