import type { Executor } from "../db/db.js";
import { contract } from "../contract/contract.js";
import { ApiError } from "../http/errors.js";
import { liveDocument, standardKey } from "./service.js";

/**
 * v0.18.57 §79 (contract.json#emergencyNumbers, owner 2026-11-10): the emergency numbers of a country, set in admin
 * (CountryRules.emergencyNumbers of the COUNTRY STANDARD only), copied into RiderAppConfig / DriverAppConfig.
 */
export type EmergencyNumber = { kind: string; number: string; label: { sv: string; fr: string; en: string } };

const EN = contract as unknown as { emergencyNumbers: { kinds: string[] }; configDefaults: { emergencyNumbers: Record<string, EmergencyNumber[]> } };
export const EMERGENCY_KINDS: readonly string[] = EN.emergencyNumbers.kinds;
export const EMERGENCY_DEFAULTS: Record<string, EmergencyNumber[]> = EN.configDefaults.emergencyNumbers;
const FALLBACK: EmergencyNumber[] = [{ kind: "general", number: "112", label: { sv: "Nödnummer", fr: "Numéro d’urgence", en: "Emergency number" } }];
const NUMBER = /^\+?[0-9]{2,15}$/;

/** Why a list is not valid, or null. */
export function emergencyNumbersProblem(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 6) return "1 to 6 numbers";
  for (const [i, row] of raw.entries()) {
    const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    if (typeof r["kind"] !== "string" || !EMERGENCY_KINDS.includes(r["kind"])) return `row ${i + 1}: kind`;
    if (typeof r["number"] !== "string" || !NUMBER.test(r["number"])) return `row ${i + 1}: number`;
    const label = (r["label"] && typeof r["label"] === "object" ? r["label"] : {}) as Record<string, unknown>;
    for (const lang of ["sv", "fr", "en"]) {
      const t = label[lang];
      if (typeof t !== "string" || t.trim().length < 1 || t.length > 40) return `row ${i + 1}: label ${lang}`;
    }
  }
  return null;
}

/** PUT country_rules: a zone's own rules never carry the field; a bad list is 400 invalid_emergency_numbers. */
export function checkEmergencyNumbers(zoneKind: string, document: unknown): void {
  if (!document || typeof document !== "object" || !("emergencyNumbers" in document)) return;
  const raw = (document as Record<string, unknown>)["emergencyNumbers"];
  if (zoneKind !== "standard") throw new ApiError("invalid_request", "Emergency numbers are set per country, on the country standard.", { reason: "emergency_numbers_country_only" });
  const problem = emergencyNumbersProblem(raw);
  if (problem !== null) throw new ApiError("invalid_request", `The emergency numbers are not valid: ${problem}.`, { reason: "invalid_emergency_numbers" });
}

/** A stored list (or nothing) for a country: the stored list, else the default, else 112. */
export function emergencyNumbersOf(raw: unknown, country: string): EmergencyNumber[] {
  if (raw !== undefined && emergencyNumbersProblem(raw) === null) return raw as EmergencyNumber[];
  return EMERGENCY_DEFAULTS[country] ?? FALLBACK;
}

/** The live list of a country (its standard country_rules). */
export async function emergencyNumbersFor(ex: Executor, country: string): Promise<EmergencyNumber[]> {
  const rules = await liveDocument<{ emergencyNumbers?: unknown }>(ex, "country_rules", standardKey(country));
  return emergencyNumbersOf(rules?.document.emergencyNumbers, country);
}
