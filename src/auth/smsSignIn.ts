import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { pickNoticeLanguage, type Lang } from "../notifications/noticeLanguage.js";

/**
 * Contract v0.18.133 (contract.json#smsSignIn; owner 2026-11-19 "Yes, build it now (Rec.)", Rules
 * decisions/session-2026-11-06.md, audits/impact/sms-sign-in.md): real sign-in codes by SMS.
 *
 * A number that is not a test number gets a code only when the server has an SMS sender (the 46elks keys), the number's
 * calling code is a served country's, and that country standard's CountryRules.smsSignIn.enabled is true (default
 * off). Otherwise it is answered sign_in_restricted exactly as before. This file holds the setting, the daily cost
 * guard (SMS pumping), the SMS text and the masks for the log; auth/service.ts runs the flow.
 */

type SmsSignInContract = {
  countries: Record<string, string>;
  mobileNumbers: Record<string, string>;
  dailyCapRange: [number, number];
  sender: string;
  codeLength: number;
  texts: { sms: Record<Lang, string> };
  alert: { nearPercent: number };
  otherCountries: { homeCountry: string; fixedLines: Record<string, string>; callingCodes: string[]; perCodeDailyCapRange: [number, number]; perMinuteCapRange: [number, number] };
};
export const SMS_SIGN_IN = (contract as unknown as { smsSignIn: SmsSignInContract }).smsSignIn;
/** configDefaults.smsSignIn: off (the contract verify script holds it at false) and the default daily limit. */
const DEFAULTS = (contract as unknown as { configDefaults: { smsSignIn: { enabled: boolean; dailyCap: number } } }).configDefaults.smsSignIn;

/**
 * How many digits a code sent by SMS has (contract.json#smsSignIn.codeLength: 6; owner 2026-11-19 "6 digits (Rec.)",
 * which replaces "Keep 4 digits" for REAL SMS codes only). The fixed test code of a test number keeps
 * auth.otp.codeLength (4).
 */
export const SMS_CODE_LENGTH = SMS_SIGN_IN.codeLength;

export const SIGN_IN_SMS_KIND = "sign_in_code";
/** v0.18.151 (contract.json#sosContactsSms.send.dailyCap): the SOS contacts SMS count in the same daily limit. */
export const SOS_CONTACT_SMS_KIND = "sos_contact";
const CAP_KINDS = [SIGN_IN_SMS_KIND, SOS_CONTACT_SMS_KIND];
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
export const callingCodeOf = (country: string): string | undefined => Object.entries(SMS_SIGN_IN.countries).find(([, cc]) => cc === country)?.[0];

const MOBILE = new Map(Object.entries(SMS_SIGN_IN.mobileNumbers).map(([country, pattern]) => [country, new RegExp(pattern)]));
/**
 * contract.json#smsSignIn.mobileNumbers: the served country whose MOBILE number this is, or null. Only such a number
 * can ever get an SMS (the same rule as the apps' phone field), so a landline, a premium or service number, a wrong
 * length or another country never costs an SMS.
 */
export function smsCountryOf(phone: string): string | null {
  const country = Object.entries(SMS_SIGN_IN.countries).find(([prefix]) => phone.startsWith(prefix))?.[1];
  return country !== undefined && MOBILE.get(country)?.test(phone) === true ? country : null;
}

/* ------------------------------------------------- v0.18.157 numbers from every other country */

/**
 * Contract v0.18.157 (contract.json#smsSignIn.otherCountries; owner 2026-11-24 "SMS sign-in codes must work for ANY phone
 * number from ANY country"): one server-wide switch and daily limit for every number whose country is not SERVED here
 * (no published country standard). Kept on the home country standard (standard-SE), super admins only; default on (rider app).
 */
export const OTHER_HOME = SMS_SIGN_IN.otherCountries.homeCountry;
export type OtherSetting = SmsSignInSetting & { perCodeDailyCap: number; perMinuteCap: number; blockedCallingCodes: string[] };
const OTHER_DEFAULTS = (contract as unknown as { configDefaults: { smsSignInOtherCountries: OtherSetting } }).configDefaults.smsSignInOtherCountries;
const OC = SMS_SIGN_IN.otherCountries;
const inRange = (value: unknown, [lo, hi]: [number, number]): value is number => typeof value === "number" && Number.isInteger(value) && value >= lo && value <= hi;
/** Calling codes, longest first (contract.json#smsSignIn.otherCountries.callingCodes). */
const CALLING_CODES = [...OC.callingCodes].sort((a, b) => b.length - a.length);
/** contract guards.callingCode: the longest calling code the number starts with ("+" + its first digit when unknown). */
export const callingCodeOfPhone = (phone: string): string => CALLING_CODES.find((cc) => phone.startsWith(cc)) ?? phone.slice(0, 2);
const blockedOk = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 50 && new Set(value).size === value.length && value.every((v) => typeof v === "string" && OC.callingCodes.includes(v));
export const OTHER_BUCKET = "other";
const E164 = /^\+[1-9][0-9]{7,14}$/;
/** Ranges that are landline for certain, by calling code (contract.json#smsSignIn.otherCountries.fixedLines). */
const FIXED_LINES: Array<[string, RegExp]> = Object.entries(SMS_SIGN_IN.otherCountries.fixedLines).map(([cc, pattern]) => [cc, new RegExp(pattern)] as [string, RegExp]);

/** CountryRules.smsSignInOtherCountries as stored; anything missing or wrong reads as the default (on, 50). */
export function smsSignInOtherOf(rules: unknown): OtherSetting {
  const raw = (rules as { smsSignInOtherCountries?: unknown } | null | undefined)?.smsSignInOtherCountries;
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // Default ON for the rider app (owner 2026-11-24); only the exact boolean false switches it off.
  return {
    enabled: typeof value["enabled"] === "boolean" ? value["enabled"] : OTHER_DEFAULTS.enabled,
    dailyCap: capOk(value["dailyCap"]) ? value["dailyCap"] : OTHER_DEFAULTS.dailyCap,
    perCodeDailyCap: inRange(value["perCodeDailyCap"], OC.perCodeDailyCapRange) ? value["perCodeDailyCap"] : OTHER_DEFAULTS.perCodeDailyCap,
    perMinuteCap: inRange(value["perMinuteCap"], OC.perMinuteCapRange) ? value["perMinuteCap"] : OTHER_DEFAULTS.perMinuteCap,
    blockedCallingCodes: blockedOk(value["blockedCallingCodes"]) ? value["blockedCallingCodes"] : [...OTHER_DEFAULTS.blockedCallingCodes],
  };
}

/** The live other-countries setting (home country standard), read from the table each time (a switch-off holds at once). */
export async function smsSignInOtherFor(ex: Executor): Promise<OtherSetting> {
  const row = await ex.selectFrom("config_live").select("document").where("doc", "=", "country_rules").where("zone_id", "=", `standard-${OTHER_HOME}`).executeTakeFirst();
  return smsSignInOtherOf(row?.document);
}

/** PUT country_rules: smsSignInOtherCountries only on the home country standard; same shape rules as smsSignIn. */
export function checkSmsSignInOther(zoneKind: string, zoneCountry: string, document: unknown): void {
  if (!document || typeof document !== "object" || !("smsSignInOtherCountries" in document)) return;
  if (zoneKind !== "standard" || zoneCountry !== OTHER_HOME) {
    throw new ApiError("invalid_request", `SMS sign-in for other countries is set once, on the ${OTHER_HOME} country standard.`, { reason: "sms_sign_in_other_home_only" });
  }
  const value = (document as Record<string, unknown>)["smsSignInOtherCountries"];
  const bad = (message: string) => new ApiError("invalid_request", message, { reason: "invalid_document" });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("smsSignInOtherCountries must be an object.");
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!["enabled", "dailyCap", "perCodeDailyCap", "perMinuteCap", "blockedCallingCodes"].includes(key)) throw bad(`smsSignInOtherCountries has no ${key.slice(0, 40)}.`);
  if ("perCodeDailyCap" in v && !inRange(v["perCodeDailyCap"], OC.perCodeDailyCapRange)) throw bad(`smsSignInOtherCountries.perCodeDailyCap must be a whole number from ${OC.perCodeDailyCapRange[0]} to ${OC.perCodeDailyCapRange[1]}.`);
  if ("perMinuteCap" in v && !inRange(v["perMinuteCap"], OC.perMinuteCapRange)) throw bad(`smsSignInOtherCountries.perMinuteCap must be a whole number from ${OC.perMinuteCapRange[0]} to ${OC.perMinuteCapRange[1]}.`);
  if ("blockedCallingCodes" in v && !blockedOk(v["blockedCallingCodes"])) throw bad("smsSignInOtherCountries.blockedCallingCodes must be up to 50 different calling codes like +882.");
  if ("enabled" in v && typeof v["enabled"] !== "boolean") throw bad("smsSignInOtherCountries.enabled must be true or false.");
  if ("dailyCap" in v && !capOk(v["dailyCap"])) throw bad(`smsSignInOtherCountries.dailyCap must be a whole number from ${SMS_SIGN_IN.dailyCapRange[0]} to ${SMS_SIGN_IN.dailyCapRange[1]}.`);
}

/** The stored other-countries value of a document, for the super-admin check (undefined when absent). */
export const otherSettingIn = (document: unknown): string | undefined => {
  const value = (document as { smsSignInOtherCountries?: unknown } | null | undefined)?.smsSignInOtherCountries;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const v = value as Record<string, unknown>;
  return JSON.stringify(Object.keys(v).sort().map((key) => [key, v[key]]));
};

/**
 * contract.json#smsSignIn.otherCountries.numberCheck (owner 2026-11-24 "ALL numbers"): refused only when not strict
 * E.164 or a certain landline range; an unknown number type is never a reason to refuse.
 */
export function otherCountryMobile(phone: string): boolean {
  return E164.test(phone) && !FIXED_LINES.some(([cc, pattern]) => phone.startsWith(cc) && pattern.test(phone));
}

/** The countries served on this server: the home country and those with a published country standard country_rules. */
export async function servedCountries(ex: Executor): Promise<string[]> {
  const rows = await ex.selectFrom("config_live").select("zone_id").where("doc", "=", "country_rules").where("zone_id", "like", "standard-%").execute();
  // The home country is always served: its numbers never fall into the other-countries bucket, even before its standard exists.
  return [...new Set([OTHER_HOME, ...rows.map((r) => r.zone_id.slice("standard-".length))])];
}

/** Which daily bucket a number belongs to and its live setting, or null when no SMS may ever go to it. */
export type SmsBucket = { bucket: string; country: string | null; setting: SmsSignInSetting; other?: OtherSetting };
export async function smsBucketOf(ex: Executor, phone: string, app: string): Promise<SmsBucket | null> {
  const prefixCountry = Object.entries(SMS_SIGN_IN.countries).find(([prefix]) => phone.startsWith(prefix))?.[1];
  if (prefixCountry !== undefined && (await servedCountries(ex)).includes(prefixCountry)) {
    // A served country keeps its own switch, cap and mobile pattern; otherCountries never opens it.
    return smsCountryOf(phone) === null ? null : { bucket: prefixCountry, country: prefixCountry, setting: await smsSignInFor(ex, prefixCountry) };
  }
  // The other-countries rule is for the rider app only (owner 2026-11-24); the driver app keeps the served countries.
  if (app !== "rider" || !otherCountryMobile(phone)) return null;
  const other = await smsSignInOtherFor(ex);
  // guards.blockedCallingCodes: an admin-blocked calling code never gets an SMS.
  if (other.blockedCallingCodes.includes(callingCodeOfPhone(phone))) return null;
  return { bucket: OTHER_BUCKET, country: null, setting: other, other };
}

/** The other-countries count: like signInSmsLastDay, every number whose calling code is not a served country's. */
export async function otherSmsLastDay(ex: Executor, now: Date): Promise<{ count: number; oldest: Date | null }> {
  const prefixes = (await servedCountries(ex)).map(callingCodeOf).filter((p): p is string => p !== undefined);
  let q = ex
    .selectFrom("sms_outbox")
    .select((eb) => [eb.fn.countAll<string>().as("n"), eb.fn.min("created_at").as("oldest")])
    .where("kind", "in", CAP_KINDS)
    .where((eb) => eb.or([eb("status", "in", ["queued", "sent"]), eb.and([eb("status", "=", "failed"), eb.or([eb("error", "=", SMS_NO_ANSWER), eb("error", "like", "http\\_5__")])])]))
    .where("created_at", ">", new Date(now.getTime() - DAY_MS));
  for (const prefix of prefixes) q = q.where("phone", "not like", `${prefix.replace(/[%_\\]/g, "")}%`);
  const row = await q.executeTakeFirstOrThrow();
  return { count: Number(row.n), oldest: row.oldest ? new Date(row.oldest as Date | string) : null };
}

/** The count of a bucket (a served country or the other-countries one). */
export const bucketSmsLastDay = (ex: Executor, bucket: string, now: Date) => (bucket === OTHER_BUCKET ? otherSmsLastDay(ex, now) : signInSmsLastDay(ex, bucket, now));

/** guards: sign-in SMS counted like the daily caps (accepted, queued, maybe-sent) since `since`, optionally to one prefix. */
async function countSince(ex: Executor, since: Date, prefix?: string): Promise<{ count: number; oldest: Date | null }> {
  let q = ex
    .selectFrom("sms_outbox")
    .select((eb) => [eb.fn.countAll<string>().as("n"), eb.fn.min("created_at").as("oldest")])
    .where("kind", "in", CAP_KINDS)
    .where((eb) => eb.or([eb("status", "in", ["queued", "sent"]), eb.and([eb("status", "=", "failed"), eb.or([eb("error", "=", SMS_NO_ANSWER), eb("error", "like", "http\\_5__")])])]))
    .where("created_at", ">", since);
  if (prefix !== undefined) q = q.where("phone", "like", `${prefix.replace(/[%_\\]/g, "")}%`);
  const row = await q.executeTakeFirstOrThrow();
  return { count: Number(row.n), oldest: row.oldest ? new Date(row.oldest as Date | string) : null };
}
/** guards.perCodeDailyCap: the last 24 h to one calling code. */
export const codeSmsLastDay = (ex: Executor, code: string, now: Date) => countSince(ex, new Date(now.getTime() - DAY_MS), code);
/** guards.perMinuteCap: every sign-in SMS of the server in the last 60 s. */
export const smsLastMinute = (ex: Executor, now: Date) => countSince(ex, new Date(now.getTime() - 60_000));

/** sms_outbox.error of a send the SMS company never answered (time-out, broken connection): it may still have gone out. */
export const SMS_NO_ANSWER = "no_answer";

/**
 * The cost guard's count: sign-in SMS (and, v0.18.151, SOS contacts SMS) to this country's numbers handed to the SMS company in the last 24 h, and when
 * the oldest of them was made. Counted: accepted (`sent`), still being sent (`queued`, also a row left by a crash),
 * and a send the company did not answer or answered with a server error (`failed` with no_answer or http_5xx: it may
 * still have sent and billed it). Only a send the company refused (a 4xx answer) is free and not counted. Fail closed.
 */
export async function signInSmsLastDay(ex: Executor, country: string, now: Date): Promise<{ count: number; oldest: Date | null }> {
  const prefix = callingCodeOf(country);
  if (prefix === undefined) return { count: 0, oldest: null };
  const row = await ex
    .selectFrom("sms_outbox")
    .select((eb) => [eb.fn.countAll<string>().as("n"), eb.fn.min("created_at").as("oldest")])
    .where("kind", "in", CAP_KINDS)
    .where((eb) => eb.or([eb("status", "in", ["queued", "sent"]), eb.and([eb("status", "=", "failed"), eb.or([eb("error", "=", SMS_NO_ANSWER), eb("error", "like", "http\\_5__")])])]))
    .where("created_at", ">", new Date(now.getTime() - DAY_MS))
    .where("phone", "like", `${prefix.replace(/[%_\\]/g, "")}%`)
    .executeTakeFirstOrThrow();
  return { count: Number(row.n), oldest: row.oldest ? new Date(row.oldest as Date | string) : null };
}

/** From this count the "near the limit" alert is open (contract smsSignIn.alert.nearPercent, rounded up). */
export const nearCap = (dailyCap: number): number => Math.ceil((dailyCap * SMS_SIGN_IN.alert.nearPercent) / 100);

/** contract.json#smsSignIn.language: the request's locale when sv / fr / en, else the country's language, else en. */
export const smsLanguage = (locale: string | null | undefined, country: string | null): Lang => pickNoticeLanguage(locale, country);

/** The SMS: the app name and the code, no link (contract.json#smsSignIn.texts.sms). */
export function signInSmsText(lang: Lang, code: string): string {
  return (SMS_SIGN_IN.texts.sms[lang] ?? SMS_SIGN_IN.texts.sms.en).replace("{code}", () => code);
}

/** What sms_outbox keeps: the same text with the code as dots (the code is never stored readable). */
export const storedSmsText = (lang: Lang): string => signInSmsText(lang, "•".repeat(SMS_CODE_LENGTH));

/** For the log: the calling code and the last two digits at most ("+46…08"); never the full number. */
export function maskPhone(phone: string): string {
  const prefix = Object.keys(SMS_SIGN_IN.countries).find((p) => phone.startsWith(p));
  return `${prefix ?? "+"}…${phone.slice(-2)}`;
}
