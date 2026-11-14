import { contractJson } from "../contract/contract.js";

/**
 * Money on the wire, CONTRACT.md §1 Wire rules "Money" and contract.json#wire.money:
 * `{ amountMinor: int, currency }`, an integer count of the currency's minor units. No floats and no display
 * strings on the wire; apps format locally.
 */

/** The currencies the contract knows (contract.json#currencies). */
export type CurrencyCode = "SEK" | "EUR" | "TND";

/** CONTRACT.md §1 "Money": `{ "amountMinor": int, "currency": "SEK" }`. */
export type Money = { amountMinor: number; currency: CurrencyCode };

export type CurrencyInfo = { readonly exponent: number; readonly symbol: string };

/** Every currency code, in the order contract.json#currencies lists them. */
export const CURRENCY_CODES: readonly CurrencyCode[] = Object.freeze(["SEK", "EUR", "TND"] as const);

function loadCurrencies(): Readonly<Record<CurrencyCode, CurrencyInfo>> {
  const raw = contractJson<{ currencies: Record<string, { exponent?: unknown; symbol?: unknown }> }>("contract.json").currencies;
  const keys = Object.keys(raw).sort();
  const expected = [...CURRENCY_CODES].sort();
  if (keys.join(",") !== expected.join(",")) {
    throw new Error(`contract.json#currencies has ${keys.join(", ")}, but CurrencyCode is ${expected.join(", ")}`);
  }
  const out = {} as Record<CurrencyCode, CurrencyInfo>;
  for (const code of CURRENCY_CODES) {
    const entry = raw[code];
    const exponent = entry?.exponent;
    const symbol = entry?.symbol;
    if (typeof exponent !== "number" || !Number.isInteger(exponent) || exponent < 0 || typeof symbol !== "string") {
      throw new Error(`contract.json#currencies.${code} needs an integer exponent >= 0 and a string symbol`);
    }
    out[code] = Object.freeze({ exponent, symbol });
  }
  return Object.freeze(out);
}

/**
 * Exponent (number of minor-unit digits) and display symbol per currency, read from contract.json#currencies:
 * SEK 2, EUR 2, TND 3 (CONTRACT.md §1 "Money"). Loading fails if contract.json and CurrencyCode disagree.
 */
export const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyInfo>> = loadCurrencies();

function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && Object.hasOwn(CURRENCIES, value);
}

/**
 * True when `value` is a valid wire Money (CONTRACT.md §1 "Money", contract.json#wire.money): a non-null,
 * non-array object whose `amountMinor` is a safe integer number and whose `currency` is exactly one of the
 * contract.json#currencies codes (case-sensitive, so "sek" is rejected). Both keys must be present. Extra keys
 * are not checked. Rejects every entry of fixtures/money.json "invalid".
 */
export function isMoney(value: unknown): value is Money {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.amountMinor === "number" && Number.isSafeInteger(v.amountMinor) && isCurrencyCode(v.currency);
}

/** The ISO 4217 exponent of `currency` from contract.json#currencies (SEK/EUR 2, TND 3; CONTRACT.md §1 "Money"). */
export function exponentOf(currency: CurrencyCode): number {
  if (!isCurrencyCode(currency)) throw new RangeError(`unknown currency: ${String(currency)}`);
  return CURRENCIES[currency].exponent;
}

/**
 * The amount in major units as a plain decimal string, as fixtures/money.json "major" and reference_check.py
 * compute it: "-" when negative, then the integer part, ".", and the remainder padded with zeros to the
 * currency's exponent (12675 SEK → "126.75", 12500 TND → "12.500", -2000 SEK → "-20.00").
 * For checks and logs only: CONTRACT.md §1 says display strings never go on the wire.
 */
export function toMajorString(m: Money): string {
  assertMoney(m);
  const n = exponentOf(m.currency);
  const sign = m.amountMinor < 0 ? "-" : "";
  const abs = Math.abs(m.amountMinor);
  if (n === 0) return `${sign}${abs}`;
  const scale = 10 ** n;
  const fraction = abs % scale;
  // (abs - fraction) is an exact multiple of scale, so this division is exact even near 2^53.
  const whole = (abs - fraction) / scale;
  return `${sign}${whole}.${String(fraction).padStart(n, "0")}`;
}

/**
 * Builds a Money (CONTRACT.md §1 "Money"). Throws a RangeError when `amountMinor` is not a safe integer
 * (12.5, NaN, Infinity, 2^53) or `currency` is not one of contract.json#currencies.
 */
export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`amountMinor must be a safe integer, got ${String(amountMinor)}`);
  }
  if (!isCurrencyCode(currency)) throw new RangeError(`unknown currency: ${String(currency)}`);
  return { amountMinor, currency };
}

function assertMoney(m: unknown): asserts m is Money {
  if (!isMoney(m)) throw new TypeError(`not a Money: ${JSON.stringify(m)}`);
}

function assertSameCurrency(a: Money, b: Money): void {
  assertMoney(a);
  assertMoney(b);
  if (a.currency !== b.currency) {
    throw new RangeError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

/**
 * a + b in the same currency. Throws on a currency mismatch (CONTRACT.md §1 "Payment methods": no conversion
 * between currencies) and when the sum is not a safe integer.
 */
export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

/**
 * a − b in the same currency. Throws on a currency mismatch (CONTRACT.md §1, no conversion) and when the
 * difference is not a safe integer.
 */
export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

/** -1, 0 or 1 as a is less than, equal to or greater than b. Throws on a currency mismatch (CONTRACT.md §1). */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

/**
 * Round half-up to a whole number: exactly reference_check.py's `_half_up(x) = int(math.floor(x + 0.5))`, used by
 * CONTRACT.md §3.2 / contract.json#pickupPay.rounding ("half_up(km × perKm) + half_up(minutes × perMin)").
 * A tie (.5) always goes toward +infinity, also for negatives: 2.5 → 3, -2.5 → -2, -0.5 → 0. Because it adds 0.5
 * in floating point it shares the reference's float quirks (0.49999999999999994 → 1). Throws a RangeError for
 * NaN or ±Infinity, where Python's math.floor also raises.
 */
export function halfUp(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`halfUp needs a finite number, got ${String(x)}`);
  return Math.floor(x + 0.5);
}

/**
 * Rounds a minor-unit amount to the nearest multiple of a price step, half-up (ties toward +infinity, like
 * halfUp): the zone's price step of CONTRACT.md §3.4 "Route-change pricing" ("rounded to the zone's price step").
 * Equal to halfUp(amountMinor / stepMinor) × stepMinor, but done in exact integer arithmetic.
 * Examples with step 50: 12675 → 12700, 12624 → 12600, -25 → 0. Throws a RangeError unless amountMinor is a safe
 * integer and stepMinor a positive safe integer, or when the result is not a safe integer.
 */
export function roundToStep(amountMinor: number, stepMinor: number): number {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError(`amountMinor must be a safe integer, got ${String(amountMinor)}`);
  if (!Number.isSafeInteger(stepMinor) || stepMinor <= 0) {
    throw new RangeError(`stepMinor must be a positive safe integer, got ${String(stepMinor)}`);
  }
  // Every intermediate stays within ±2^53: no `remainder + step` and no `amount - remainder` before the choice.
  let remainder = amountMinor % stepMinor; // sign of amountMinor
  if (remainder < 0) remainder += stepMinor; // 0 ≤ remainder < stepMinor
  const rounded = 2 * remainder >= stepMinor ? amountMinor + (stepMinor - remainder) : amountMinor - remainder;
  if (!Number.isSafeInteger(rounded)) throw new RangeError(`roundToStep result out of safe integer range`);
  return rounded === 0 ? 0 : rounded; // never -0
}

/** A Money whose currency is typed as a plain string (rows, documents); an unknown code throws a RangeError. */
export type MoneyLike = { amountMinor: number; currency: string };

/**
 * contract.json#moneyDisplay (v0.18.59 §81; owner 2026-11-14 "make sure rider and driver app show correct prices every
 * where"): the amount in major units as every app, admin page and server text writes it. The format follows the
 * currency, never the language: SEK and EUR with a comma and 2 decimals ("126,75"), TND with a dot and 3 decimals; a
 * space between thousands ("1 250.500", "2 900,00", as the admin writes them). Whole amounts keep their decimals
 * ("20,00", "5.000"). Never a fixed 100.
 */
export function majorText(m: MoneyLike): string {
  const text = groupThousands(toMajorString(m as Money));
  return m.currency === "TND" ? text : text.replace(".", ",");
}

/** v0.18.59 §81: a space between thousands of the integer part ("1250.500" → "1 250.500", "-2900.00" → "-2 900.00"). */
function groupThousands(text: string): string {
  const [whole = "", frac] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

/** The symbol of `currency` in money texts (contract.json#moneyDisplay patterns): "kr", "€", "DT", else the code. */
export function currencySymbol(currency: string): string {
  return currency === "SEK" ? "kr" : currency === "EUR" ? "€" : currency === "TND" ? "DT" : currency;
}

/** The one money text of every server text (push, bell, SMS, e-mail, error, Terms): "126,75 kr", "7,41 €", "12.350 DT", "35,00 kr". */
export function moneyText(m: MoneyLike): string {
  return `${majorText(m)} ${currencySymbol(m.currency)}`;
}

/**
 * The amount for a notice: since the owner's 2026-11-14 ruling the format follows the currency, not the language
 * ([majorText]); `lang` is kept so the notice callers stay unchanged.
 */
export function localAmount(m: MoneyLike, _lang: string): string {
  return majorText(m);
}

/** amountMinor in the currency's major unit as a number (for limits written in major units). */
export function toMajorNumber(m: MoneyLike): number {
  return m.amountMinor / 10 ** exponentOf(m.currency as CurrencyCode);
}

/**
 * v0.18.89 moneyDisplay.wholeAmounts (owner 2026-11-14 "whole amounts keep their decimals"): the shown text of an amount,
 * always with the currency's decimals and the format of the currency, not of the language — "65,00 kr", "8,00 €",
 * "5.000 DT", "1 250.000 DT" (a space between thousands). New notices use this; older texts still use localAmount.
 */
export function moneyShown(m: MoneyLike): string {
  return moneyText(m);
}
