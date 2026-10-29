import type { Executor } from "../db/db.js";
import { contract } from "../contract/contract.js";
import { ONBOARDING, type DocumentScope } from "./onboardingRules.js";

/**
 * Contract v0.17.0 §25 (contract.json#driverOnboarding.settings, owner decisions of 2026-10-29, items 10 and 11 and
 * the note check): the admin's Drivers › Onboarding and Vehicles › Rules settings, one `onboarding` config document
 * per country (stored under standard-<CC> like every country document). Nothing published = the contract defaults,
 * which are the admin's own defaults (Sweden base year 2015, France 2016, Tunisia closed with no documents).
 */

export type Fuel = "petrol" | "diesel" | "hybrid" | "electric";
export type CategoryRule = { category: string; on: boolean; minYear: number; minSeats: number; fuels: Fuel[] };
export type OnboardingSettings = {
  version: number;
  publishedAt?: string;
  country: string;
  documents: { driver: string[]; fleet: string[]; vehicle: string[] };
  expiringTypes: string[];
  steps: Array<{ id: string; on: boolean; days: number }>;
  signUpReminders: { on: boolean; everyDays: number; stuckAfterDays: number };
  expiry: { warnDays: number[]; blockAtExpiry: boolean };
  vehicles: { categories: CategoryRule[]; warnDays: number; autoHold: boolean; photosNeeded: boolean };
};

type SettingsContract = {
  defaults: Record<string, Omit<OnboardingSettings, "version" | "country" | "publishedAt">>;
  stepIds: string[];
  fuels: Fuel[];
  photoTypes: string[];
  limits: Record<"stepDays" | "remindEveryDays" | "stuckAfterDays" | "warnDays" | "vehicleWarnDays" | "minYear" | "minSeats", [number, number]>;
};

export const SETTINGS = (contract as unknown as { driverOnboarding: { settings: SettingsContract } }).driverOnboarding.settings;
export const PHOTO_TYPES: readonly string[] = SETTINGS.photoTypes;
const CATEGORY_SEED: readonly string[] = (contract as unknown as { categories: { seed: string[] } }).categories.seed;

const EMPTY = { driver: [], fleet: [], vehicle: [] };

/** The contract defaults of a country (version 0). A country the contract does not know has no documents. */
export function defaultSettings(country: string): OnboardingSettings {
  const base = SETTINGS.defaults[country] ?? { ...structuredClone(SETTINGS.defaults["SE"]!), documents: EMPTY, expiringTypes: [] };
  return { version: 0, country, ...structuredClone(base) };
}

/** The live settings of a country: the published onboarding document, else the defaults. */
export async function onboardingSettings(ex: Executor, country: string | null | undefined): Promise<OnboardingSettings> {
  if (!country) return { ...defaultSettings("--"), documents: { ...EMPTY }, expiringTypes: [] };
  const row = await ex.selectFrom("config_live").select("document").where("doc", "=", "onboarding").where("zone_id", "=", `standard-${country}`).executeTakeFirst();
  return row === undefined ? defaultSettings(country) : (row.document as OnboardingSettings);
}

/** The required documents of a scope; a car also needs the four photos while photosNeeded is on (item 11). */
export function requiredOf(settings: OnboardingSettings, scope: DocumentScope): string[] {
  const list = settings.documents[scope] ?? [];
  return scope === "vehicle" && settings.vehicles.photosNeeded ? [...list, ...PHOTO_TYPES.filter((t) => !list.includes(t))] : [...list];
}

export async function liveRequiredDocuments(ex: Executor, country: string | null | undefined, scope: DocumentScope): Promise<string[]> {
  if (!country) return [];
  return requiredOf(await onboardingSettings(ex, country), scope);
}

/** Whole days until `expiresAt`, rounded up; 0 once it has passed. */
export function daysLeft(expiresAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000));
}

/* ---------------------------------------------------------------- checks of a document the admin saves */

const within = (value: unknown, [min, max]: [number, number]) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** contract.json#driverOnboarding.settings.rules: what the schema cannot say. Empty = fine. */
export function settingsProblems(document: unknown): string[] {
  const d = document as OnboardingSettings;
  const problems: string[] = [];
  const types = ONBOARDING.documents.types;
  for (const [scope, owner] of [["driver", "driver"], ["fleet", "driver"], ["vehicle", "vehicle"]] as const) {
    for (const type of d.documents[scope]) {
      if (types[type] === undefined) problems.push(`documents.${scope}: unknown type ${type}`);
      else if (types[type]!.owner !== owner) problems.push(`documents.${scope}: ${type} belongs to a ${types[type]!.owner === "vehicle" ? "car" : "person"}`);
    }
    if (new Set(d.documents[scope]).size !== d.documents[scope].length) problems.push(`documents.${scope}: a type is listed twice`);
  }
  if (ONBOARDING.countries[d.country]?.open && !d.documents.driver.includes("driving_license")) problems.push("documents.driver: the driving licence is always needed");
  for (const type of d.expiringTypes) if (types[type] === undefined) problems.push(`expiringTypes: unknown type ${type}`);
  const ids = d.steps.map((s) => s.id);
  if (ids.length !== SETTINGS.stepIds.length || SETTINGS.stepIds.some((id) => !ids.includes(id))) problems.push(`steps: list each of ${SETTINGS.stepIds.join(", ")} once`);
  if (!d.steps.some((s) => s.on)) problems.push("steps: keep at least one step on");
  if (d.steps.some((s) => !within(s.days, SETTINGS.limits.stepDays))) problems.push("steps: 1 to 60 days");
  if (!within(d.signUpReminders.everyDays, SETTINGS.limits.remindEveryDays)) problems.push("signUpReminders.everyDays: 1 to 30");
  if (!within(d.signUpReminders.stuckAfterDays, SETTINGS.limits.stuckAfterDays)) problems.push("signUpReminders.stuckAfterDays: 2 to 90");
  const warn = d.expiry.warnDays;
  if (warn.some((day) => !within(day, SETTINGS.limits.warnDays))) problems.push("expiry.warnDays: 1 to 90 days");
  if (warn.some((day, i) => i > 0 && day >= warn[i - 1]!)) problems.push("expiry.warnDays: largest first, each fewer days than the one before");
  const cats = d.vehicles.categories.map((r) => r.category);
  if (new Set(cats).size !== cats.length) problems.push("vehicles.categories: a category is listed twice");
  for (const rule of d.vehicles.categories) {
    if (!CATEGORY_SEED.includes(rule.category)) problems.push(`vehicles.categories: unknown category ${rule.category}`);
    if (!within(rule.minYear, SETTINGS.limits.minYear)) problems.push(`vehicles.${rule.category}: the year must be 1990 to 2030`);
    if (!within(rule.minSeats, SETTINGS.limits.minSeats)) problems.push(`vehicles.${rule.category}: seats must be 1 to 9`);
    if (rule.on && rule.fuels.length === 0) problems.push(`vehicles.${rule.category}: allow at least one fuel`);
  }
  if (!within(d.vehicles.warnDays, SETTINGS.limits.vehicleWarnDays)) problems.push("vehicles.warnDays: 1 to 120");
  return problems;
}

/* ---------------------------------------------------------------- car rules (item 11) */

export type CarFacts = { year: number; seats: number; fuel: Fuel | null };

/** Why a car does not fit a category (contract.json#driverOnboarding.vehicleRules.problems), or null. No rule = not checked. */
export function categoryProblem(car: CarFacts, settings: OnboardingSettings, category: string): string | null {
  const rule = settings.vehicles.categories.find((r) => r.category === category);
  if (rule === undefined) return null;
  if (!rule.on) return "category_off";
  if (car.year < rule.minYear) return "year_too_old";
  if (car.seats < rule.minSeats) return "too_few_seats";
  if (car.fuel === null) return SETTINGS.fuels.every((f) => rule.fuels.includes(f)) ? null : "fuel_required";
  if (!rule.fuels.includes(car.fuel)) return "fuel_not_allowed";
  return null;
}
