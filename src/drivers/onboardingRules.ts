import { contract } from "../contract/contract.js";

/**
 * The rules of contract v0.5.3 §14 (contract.json#driverOnboarding), read from the contract copy so a contract
 * bump changes them here: account types, open countries and their cities, the minimum age, the fleet code and
 * the documents each country and account type needs.
 */
type City = { cityId: string; name: string; zoneId: string };
type Onboarding = {
  accountTypes: string[];
  minAge: number;
  countries: Record<string, { open: boolean; cities: City[] }>;
  fleetCode: { prefix: string; length: number; alphabet: string; joinAttemptsPerHour: number };
  documents: {
    types: Record<string, { owner: "driver" | "vehicle"; kind: "file" | "acceptance" | "admin_check"; name: Record<string, string> }>;
    required: Record<string, { driver: string[]; fleet: string[]; vehicle: string[] }>;
    upload: { maxBytes: number; mediaTypes: string[] };
  };
};

export const ONBOARDING = (contract as unknown as { driverOnboarding: Onboarding }).driverOnboarding;

export type AccountType = "driver" | "fleet";
export type DocumentScope = "driver" | "fleet" | "vehicle";

export function cityOf(country: string, cityId: string): City | undefined {
  return ONBOARDING.countries[country]?.cities.find((c) => c.cityId === cityId);
}

type DefaultSettings = { defaults: Record<string, { documents: Record<DocumentScope, string[]>; vehicles: { photosNeeded: boolean } }>; photoTypes: string[] };
const SETTINGS_DEFAULTS = (contract as unknown as { driverOnboarding: { settings: DefaultSettings } }).driverOnboarding.settings;

/**
 * The document types a person (`driver`), a company (`fleet`) or a car (`vehicle`) must have in `country` with the
 * contract defaults (v0.18.0: a car also needs the four photos). The live lists are the admin's onboarding document:
 * liveRequiredDocuments in onboardingSettings.ts; this one serves seeds and tests.
 */
export function requiredDocuments(country: string | null | undefined, scope: DocumentScope): string[] {
  if (!country) return [];
  const d = SETTINGS_DEFAULTS.defaults[country];
  if (d === undefined) return [];
  const list = d.documents[scope] ?? [];
  return scope === "vehicle" && d.vehicles.photosNeeded ? [...list, ...SETTINGS_DEFAULTS.photoTypes] : [...list];
}

export function documentKind(type: string): "file" | "acceptance" | "admin_check" | undefined {
  return ONBOARDING.documents.types[type]?.kind;
}

/** Whole years between the birth date and `now`. */
export function ageAt(dateOfBirth: string, now: Date): number {
  const [y, m, d] = dateOfBirth.split("-").map(Number) as [number, number, number];
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age -= 1;
  return age;
}

/** The time zone of a country's cities (the zones' clock), for the fleet earnings periods. */
export const COUNTRY_TIME_ZONE: Record<string, string> = { SE: "Europe/Stockholm", FR: "Europe/Paris", TN: "Africa/Tunis" };
export const COUNTRY_CURRENCY: Record<string, string> = { SE: "SEK", FR: "EUR", TN: "TND" };

/** "MV-7K3Q9" style; the alphabet has no 0 / O / 1 / I. */
export function makeFleetCode(random: (max: number) => number): string {
  const { prefix, length, alphabet } = ONBOARDING.fleetCode;
  let body = "";
  for (let i = 0; i < length; i++) body += alphabet[random(alphabet.length)]!;
  return `${prefix}${body}`;
}

/** What a driver typed as a code, in the stored form: upper case, no spaces or dashes, the MV- prefix added when missing. */
export function normalizeFleetCode(typed: string): string {
  const flat = typed.toUpperCase().replace(/[\s-]+/g, "");
  const body = flat.startsWith("MV") && flat.length > ONBOARDING.fleetCode.length ? flat.slice(2) : flat;
  return `${ONBOARDING.fleetCode.prefix}${body}`;
}

/** Names compared loosely: case, extra spaces and the order of first and last name are forgiven. */
export function sameName(typed: string, firstName: string, lastName: string): boolean {
  const norm = (v: string) => v.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const a = norm(typed);
  return a === norm(`${firstName} ${lastName}`) || a === norm(`${lastName} ${firstName}`);
}

export const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
