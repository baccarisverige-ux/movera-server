import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { pickNoticeLanguage, type Lang } from "../notifications/noticeLanguage.js";

/**
 * Contract v0.18.135 (contract.json#smsSignIn; owner 2026-11-19 "Yes, build it now (Rec.)", Rules
 * decisions/session-2026-11-06.md, audits/impact/sms-sign-in.md): real sign-in codes by SMS.
 *
 * A number that is not a test number gets a code only when the server has an SMS sender (the 46elks keys), the number's
 * calling code is a served country's, and that country standard's CountryRules.smsSignIn.enabled is true (default
 * off). Otherwise it is answered sign_in_restricted exactly as before. This file holds the setting, the daily cost
 * guard (SMS pumping), the SMS text and the masks for the log; auth/service.ts runs the flow.
 */

type SmsSignInContract = {
  dailyCapRange: [number, number];
  sender: string;
  texts: { sms: Record<Lang, string> };
  alert: { nearPercent: number };
};
export const SMS_SIGN_IN = (contract as unknown as { smsSignIn: SmsSignInContract }).smsSignIn;
/** configDefaults.smsSignIn: off (the contract verify script holds it at false) and the default daily limit. */
const DEFAULTS = (contract as unknown as { configDefaults: { smsSignIn: { enabled: boolean; dailyCap: number } } }).configDefaults.smsSignIn;

export const SIGN_IN_SMS_KIND = "sign_in_code";
export const DAY_MS = 24 * 3_600_000;
export type SmsSignInSetting = { enabled: boolean; dailyCap: number };

const capOk = (value: unknown): value is number => {
  const [lo, hi] = SMS_SIGN_IN.dailyCapRange;
  return typeof value === "number" && Number.isInteger(value) && value >= lo && value <= hi;
};

/** CountryRules.smsSignIn as stored; anything missing or wrong reads as the default (off, the default cap). */
export function smsSignInOf(rules: unknown): SmsSignInSetting {
  const raw = (rules as { smsSignIn?: unknown } | null | undefined)?.smsSignIn;
  const value = (raw && typeof raw === "object" ? raw : {}) as { enabled?: unknown; dailyCap?: unknown };
  // Only the exact boolean true switches it on (fail closed).
  return { enabled: value.enabled === true, dailyCap: capOk(value.dailyCap) ? value.dailyCap : DEFAULTS.dailyCap };
}

/** The live setting of a country (its standard country_rules). Read from the table, never from a cache: a switch-off holds at once. */
export async function smsSignInFor(ex: Executor, country: string): Promise<SmsSignInSetting> {
  const row = await ex.selectFrom("config_live").select("document").where("doc", "=", "country_rules").where("zone_id", "=", `standard-${country}`).executeTakeFirst();
  return smsSignInOf(row?.document);
}

/** PUT country_rules: only the country standard carries it; enabled true / false, dailyCap inside its range, no other key. */
export function checkSmsSignIn(zoneKind: string, document: unknown): void {
  if (!document || typeof document !== "object" || !("smsSignIn" in document)) return;
  if (zoneKind !== "standard") throw new ApiError("invalid_request", "Real SMS sign-in codes are set per country, on the country standard.", { reason: "sms_sign_in_country_only" });
  const value = (document as Record<string, unknown>)["smsSignIn"];
  const bad = (message: string) => new ApiError("invalid_request", message, { reason: "invalid_document" });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("smsSignIn must be an object.");
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (key !== "enabled" && key !== "dailyCap") throw bad(`smsSignIn has no ${key.slice(0, 40)}.`);
  if ("enabled" in v && typeof v["enabled"] !== "boolean") throw bad("smsSignIn.enabled must be true or false.");
  if ("dailyCap" in v && !capOk(v["dailyCap"])) throw bad(`smsSignIn.dailyCap must be a whole number from ${SMS_SIGN_IN.dailyCapRange[0]} to ${SMS_SIGN_IN.dailyCapRange[1]}.`);
}

/** The calling code of a served country ("+46"), for the per-country count. */
export const callingCodeOf = (country: string): string | undefined => Object.entries((contract as unknown as { smsSignIn: { countries: Record<string, string> } }).smsSignIn.countries).find(([, cc]) => cc === country)?.[0];

/**
 * The cost guard's count: sign-in SMS to this country's numbers handed to the SMS company in the last 24 h (accepted,
 * or still being sent), and when the oldest of them was made. A failed send is not counted (it cost nothing).
 */
export async function signInSmsLastDay(ex: Executor, country: string, now: Date): Promise<{ count: number; oldest: Date | null }> {
  const prefix = callingCodeOf(country);
  if (prefix === undefined) return { count: 0, oldest: null };
  const row = await ex
    .selectFrom("sms_outbox")
    .select((eb) => [eb.fn.countAll<string>().as("n"), eb.fn.min("created_at").as("oldest")])
    .where("kind", "=", SIGN_IN_SMS_KIND)
    .where("status", "in", ["queued", "sent"])
    .where("created_at", ">", new Date(now.getTime() - DAY_MS))
    .where("phone", "like", `${prefix.replace(/[%_\\]/g, "")}%`)
    .executeTakeFirstOrThrow();
  return { count: Number(row.n), oldest: row.oldest ? new Date(row.oldest as Date | string) : null };
}

/** From this count the "near the limit" alert is open (contract smsSignIn.alert.nearPercent, rounded up). */
export const nearCap = (dailyCap: number): number => Math.ceil((dailyCap * SMS_SIGN_IN.alert.nearPercent) / 100);

/** contract.json#smsSignIn.language: the request's locale when sv / fr / en, else the country's language, else en. */
export const smsLanguage = (locale: string | null | undefined, country: string): Lang => pickNoticeLanguage(locale, country);

/** The SMS: the app name and the code, no link (contract.json#smsSignIn.texts.sms). */
export function signInSmsText(lang: Lang, code: string): string {
  return (SMS_SIGN_IN.texts.sms[lang] ?? SMS_SIGN_IN.texts.sms.en).replace("{code}", () => code);
}

/** What sms_outbox keeps: the same text with the code as dots (the code is never stored readable). */
export const storedSmsText = (lang: Lang, codeLength: number): string => signInSmsText(lang, "•".repeat(codeLength));

/** For the log: the calling code and the last two digits at most ("+46…08"); never the full number. */
export function maskPhone(phone: string): string {
  const prefix = Object.keys((contract as unknown as { smsSignIn: { countries: Record<string, string> } }).smsSignIn.countries).find((p) => phone.startsWith(p));
  return `${prefix ?? "+"}…${phone.slice(-2)}`;
}
