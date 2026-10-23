import { isMoney, money, type Money } from "./money.js";

/**
 * Rider cancel fee rules: CONTRACT.md §6 "FeeRule" (rider.cancelFees.live / .reservation per category, set in
 * Admin as §5 "Live cancel fees per category" and "Reservation cancel fees per category"), with the cases in
 * fixtures/cancel_fees.json. The oracle is the cancel_fees loop of contracts/reference_check.py; cancelFee gives
 * the same amount for every input it accepts.
 */

/**
 * CONTRACT.md §6 `FeeRule { freeMin: int, type: fixed | percent, value: number, min: Money | null, max: Money | null }`.
 * live: freeMin is minutes after accept (counted from TripProjection.acceptedAt, §3 "Live free cancel", owner Q12).
 * reservation: freeMin is minutes before pickup.
 * fixed: value is the fee in minor units. percent: value is 0–100 of the fare.
 */
export type FeeRule = {
  freeMin: number;
  type: "fixed" | "percent";
  value: number;
  min: Money | null;
  max: Money | null;
};

export type CancelFeeInput = {
  kind: "live" | "reservation";
  rule: FeeRule;
  fare: Money;
  /** Needed when kind is "live": minutes from acceptedAt to the cancel. */
  minutesSinceAccept?: number;
  /** Needed when kind is "reservation": minutes from the cancel to the scheduled pickup. */
  minutesBeforePickup?: number;
};

function requireMinutes(name: string, value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number of minutes, got ${String(value)}`);
  }
  return value;
}

/**
 * True while the cancel is inside the rule's free window (CONTRACT.md §6 FeeRule comments, fixtures/cancel_fees.json
 * "note", reference_check.py `free = ...`):
 * - live: free while minutesSinceAccept < freeMin, so cancelling at exactly freeMin minutes is charged;
 * - reservation: free while minutesBeforePickup >= freeMin, so cancelling exactly freeMin minutes before is free.
 * Minutes may be whole or fractional. Because freeMin is a whole number, passing the floor of the elapsed minutes
 * gives the same answer as passing the exact value (but rounding up would not).
 * Throws a RangeError when the minutes this kind needs are missing or not finite; the other field is ignored.
 */
export function isFreeCancel(input: Pick<CancelFeeInput, "kind" | "rule" | "minutesSinceAccept" | "minutesBeforePickup">): boolean {
  const { kind, rule } = input;
  if (typeof rule.freeMin !== "number" || !Number.isFinite(rule.freeMin)) {
    throw new RangeError(`FeeRule.freeMin must be a finite number, got ${String(rule.freeMin)}`);
  }
  if (kind === "live") return requireMinutes("minutesSinceAccept", input.minutesSinceAccept) < rule.freeMin;
  if (kind === "reservation") return requireMinutes("minutesBeforePickup", input.minutesBeforePickup) >= rule.freeMin;
  throw new RangeError(`kind must be "live" or "reservation", got ${String(kind)}`);
}

/**
 * The percent part of a FeeRule: `value` percent of `fareMinor`, rounded half-up to a whole minor unit
 * (CONTRACT.md §6 FeeRule "percent: value is 0–100 of the fare, rounded half-up to a whole minor unit").
 *
 * Computed as reference_check.py does, `(fare * value * 2 + 100) // 200`, which is floor(fare × value / 100 + 0.5)
 * done without dividing first: 12345 × 15% = 1851.75 → 1852, 10 × 5% = 0.5 → 1, 9 × 5% = 0.45 → 0.
 * Math.floor is floor division just like Python's `//` (also for negative numbers). The match is exact as long as
 * the numerator is a safe integer or a float below 2^53, so this throws a RangeError when
 * |fare × value × 2 + 100| > Number.MAX_SAFE_INTEGER, where Python's big integers would give a different answer.
 * A fractional percent (12.5) works the same way, in the same float arithmetic Python uses.
 */
export function percentOfFareHalfUp(fareMinor: number, value: number): number {
  if (!Number.isSafeInteger(fareMinor)) throw new RangeError(`fare must be a safe integer, got ${String(fareMinor)}`);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`percent FeeRule.value must be a finite number, got ${String(value)}`);
  }
  const numerator = fareMinor * value * 2 + 100;
  if (Math.abs(fareMinor * value * 2) > Number.MAX_SAFE_INTEGER || Math.abs(numerator) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`percent fee of ${fareMinor} × ${value}% is too large to compute exactly`);
  }
  return Math.floor(numerator / 200);
}

function boundAmount(name: "min" | "max", bound: Money | null | undefined, fare: Money): number | null {
  if (bound === null || bound === undefined) return null;
  if (!isMoney(bound)) throw new TypeError(`FeeRule.${name} is not a Money: ${JSON.stringify(bound)}`);
  if (bound.currency !== fare.currency) {
    throw new RangeError(`FeeRule.${name} is in ${bound.currency} but the fare is in ${fare.currency}`);
  }
  return bound.amountMinor;
}

/**
 * The rider's cancel fee for a live ride or a reservation (CONTRACT.md §6 FeeRule; §5 "Live cancel fees per
 * category" / "Reservation cancel fees per category"; contract.json#transitions `fee: "riderCancelFee"`), exactly
 * as reference_check.py computes it for fixtures/cancel_fees.json:
 * 1. Inside the free window (see isFreeCancel) the fee is 0 and min/max are not applied.
 * 2. Otherwise the fee is `value` minor units (fixed) or `value` percent of the fare rounded half-up (percent,
 *    see percentOfFareHalfUp).
 * 3. Then it is raised to `min` when set, then lowered to `max` when set (so if min > max, max wins).
 * The result is in the fare's currency. A fixed fee is not capped at the fare.
 *
 * Throws a RangeError when the minutes this kind needs are missing, when a fixed `value` is not a whole number of
 * minor units, when min/max are in another currency than the fare, or when the fee is not a safe integer;
 * a TypeError when the fare, min or max is not a valid Money. Does not change its input.
 */
export function cancelFee(input: CancelFeeInput): Money {
  const { rule, fare } = input;
  if (!isMoney(fare)) throw new TypeError(`fare is not a Money: ${JSON.stringify(fare)}`);
  if (isFreeCancel(input)) return money(0, fare.currency);

  let fee: number;
  if (rule.type === "fixed") {
    if (!Number.isSafeInteger(rule.value)) {
      throw new RangeError(`fixed FeeRule.value must be whole minor units, got ${String(rule.value)}`);
    }
    fee = rule.value;
  } else if (rule.type === "percent") {
    fee = percentOfFareHalfUp(fare.amountMinor, rule.value);
  } else {
    throw new RangeError(`FeeRule.type must be "fixed" or "percent", got ${String(rule.type)}`);
  }

  const min = boundAmount("min", rule.min, fare);
  const max = boundAmount("max", rule.max, fare);
  if (min !== null) fee = Math.max(fee, min);
  if (max !== null) fee = Math.min(fee, max);
  return money(fee, fare.currency);
}
