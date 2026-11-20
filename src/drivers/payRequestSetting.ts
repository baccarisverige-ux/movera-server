import { contract } from "../contract/contract.js";
import { badRequest } from "../http/errors.js";

/**
 * Contract v0.18.139 `driverPayRequest.setting`: CountryRules.driverPayRequest { enabled, dayOfMonth, payLink,
 * minAmount } and its save check. A leaf module (no database, no config service) so config/service.ts can import it.
 */

export type Money = { amountMinor: number; currency: string };
export type PayRequestSetting = { enabled: boolean; dayOfMonth: number; payLink: string; minAmount: Money | null };

export const DEFAULT_PAY_REQUEST: PayRequestSetting = (contract as unknown as { configDefaults: { driverPayRequest?: PayRequestSetting } }).configDefaults.driverPayRequest ?? { enabled: false, dayOfMonth: 1, payLink: "", minAmount: null };

export const PAY_LINK_MAX = 500;
/** Control characters, white space and invisible / direction-changing characters: never part of a payment link. */
const badLinkChar = (c: number): boolean =>
  c <= 0x20 || (c >= 0x7f && c <= 0xa0) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff;
const hasBadLinkChar = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) if (badLinkChar(value.charCodeAt(i))) return true;
  return false;
};

/**
 * A payment link the app may open as it is: https only, at most PAY_LINK_MAX characters, no white space, control or
 * invisible characters, a host, and no "user:password@" part (so what the admin reads is where the link goes).
 */
export const isPayLink = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > PAY_LINK_MAX || !value.startsWith("https://") || hasBadLinkChar(value) || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
};
export const isDay = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 28;
export const isAmount = (value: unknown, currency: string): value is Money =>
  typeof value === "object" && value !== null && Number.isInteger((value as Money).amountMinor) && (value as Money).amountMinor >= 0 && (value as Money).currency === currency;

/**
 * The save check of CountryRules.driverPayRequest (config/service.ts checkDocument): a wrong day or link is refused
 * (pay_request_invalid); switched on it needs a link (pay_request_needs_link) and a minimum amount of 0 or above in the
 * country's currency (pay_request_needs_amount). Off may keep or clear the link and the amount.
 */
export function checkPayRequestSetting(currency: string, document: unknown): void {
  const set = (document as { driverPayRequest?: unknown } | null)?.driverPayRequest;
  if (set === undefined) return;
  if (typeof set !== "object" || set === null || Array.isArray(set)) throw badRequest("The monthly pay request setting is not valid.", "pay_request_invalid");
  const s = set as Record<string, unknown>;
  if (typeof s["enabled"] !== "boolean") throw badRequest("The monthly pay request needs its on / off switch.", "pay_request_invalid");
  if (s["dayOfMonth"] !== undefined && !isDay(s["dayOfMonth"])) throw badRequest("The day of the month must be 1 to 28.", "pay_request_invalid");
  const link = s["payLink"];
  if (link !== undefined && link !== "" && !isPayLink(link)) throw badRequest(`The payment link must start with https:// and be at most ${PAY_LINK_MAX} characters.`, "pay_request_invalid");
  const min = s["minAmount"];
  if (min !== undefined && min !== null && !isAmount(min, currency)) throw badRequest(`The minimum amount must be 0 or above in ${currency}.`, s["enabled"] === true ? "pay_request_needs_amount" : "pay_request_invalid");
  if (s["enabled"] === true) {
    if (!isPayLink(link)) throw badRequest("Set the payment link to switch the monthly pay request on.", "pay_request_needs_link");
    if (!isAmount(min, currency)) throw badRequest(`Set a minimum amount in ${currency} to switch the monthly pay request on.`, "pay_request_needs_amount");
  }
}
