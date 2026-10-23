import { halfUp, type Money } from "./money.js";

/**
 * Pickup pay, CONTRACT.md §3.2 and contract.json#pickupPay. Two separate sides:
 * - the driver's pickup pay, paid by Movera for the drive to the pickup (pickupPayMinor), and
 * - the rider's fixed pickup fee, the `pickup_fee` fare line (riderPickupFee).
 *
 * The maths mirrors reference_check.py `pickup_pay` exactly, including where it uses floats.
 */

/**
 * One km range of a pickup pay rate, contract.json#pickupPay.ranges.note:
 * `PickupRange { fromKm, toKm: number | null, perKm: Money, perMin: Money }`.
 */
export type PickupRange = { fromKm: number; toKm: number | null; perKm: Money; perMin: Money };

/**
 * A category's pickup pay settings, CONTRACT.md §3.2 "Driver side" and §6 (DriverAppConfig.pickupPay.byCategory):
 * `PickupPayRate { enabled, maxPerRide: Money | null, ranges: PickupRange[], riderFee }`.
 */
export type PickupPayRate = {
  enabled: boolean;
  maxPerRide: Money | null;
  ranges: PickupRange[];
  riderFee: { live: Money | null; reservation: Money | null };
};

/**
 * The offer kind that decides whether pickup pay applies: contract.json#pickupPay.offerKinds plus its
 * `neverPaid` list ("scheduled" = a reservation the driver took from the Scheduled rides list).
 */
export type PickupOfferKind = "radar" | "exclusive" | "exclusiveReservation" | "assigned" | "nextTrip" | "scheduled";

// Python's max(0.0, x): keeps 0 unless x > 0, so NaN and -0 become 0 (Math.max would return NaN).
function atLeastZero(x: number): number {
  return x > 0 ? x : 0;
}

// Python's min(a, b): keeps a unless b < a.
function pyMin(a: number, b: number): number {
  return b < a ? b : a;
}

/**
 * The driver's pickup pay in minor units, CONTRACT.md §3.2 "Driver side" / "Which offers" and
 * contract.json#pickupPay (ranges.note, ranges.rounding, neverPaid). Same result as reference_check.py
 * `pickup_pay` for every input.
 *
 * Returns 0 when `kind` is "scheduled", when `offers[kind]` is not true, when the rate is disabled, or when it
 * has no ranges. Otherwise, with km and minutes below 0 (or NaN) taken as 0, each range adds
 * `halfUp(kmInRange × perKm) + halfUp(minutes × kmShare × perMin)`, and the sum is capped at `maxPerRide`
 * when one is set.
 *
 * What it assumes about `ranges` (it does not check, sort or repair them):
 * - they are in ascending order and touch: the first starts at 0, each next one starts at the previous `toKm`;
 * - the LAST entry in the array is open-ended, even if its `toKm` is set (a leg beyond a closed last range is
 *   paid at the last range's rate), and any entry with `toKm` null is also open-ended;
 * - with 0 km, all minutes go to the FIRST entry in the array.
 * Ranges given out of order are walked in the given order, so they give a different (wrong) amount.
 *
 * All Money in `rate` is taken to share one currency; the result is in that currency. Throws a RangeError when an
 * intermediate amount is not finite (e.g. km = Infinity), as the reference does.
 */
export function pickupPayMinor(
  rate: PickupPayRate,
  offers: Record<string, boolean>,
  kind: PickupOfferKind,
  km: number,
  minutes: number,
): number {
  if (kind === "scheduled" || !(Object.hasOwn(offers, kind) && offers[kind]) || !rate.enabled || rate.ranges.length === 0) {
    return 0;
  }
  const legKm = atLeastZero(km);
  const legMinutes = atLeastZero(minutes);
  const ranges = rate.ranges;
  let total = 0;
  ranges.forEach((r, i) => {
    const end = r.toKm === null || i === ranges.length - 1 ? Infinity : r.toKm;
    const inRange = atLeastZero(pyMin(legKm, end) - r.fromKm);
    const share = legKm > 0 ? inRange / legKm : i === 0 ? 1 : 0;
    if (inRange <= 0 && share <= 0) return;
    total += halfUp(inRange * r.perKm.amountMinor) + halfUp(legMinutes * share * r.perMin.amountMinor);
  });
  return rate.maxPerRide !== null ? pyMin(total, rate.maxPerRide.amountMinor) : total;
}

/**
 * The rider's fixed pickup fee, CONTRACT.md §3.2 "Rider side" and contract.json#pickupPay.riderFee:
 * `riderFee.reservation` for a reservation, `riderFee.live` for a live ride (Radar and Exclusive); null = off,
 * so no `pickup_fee` fare line. It never depends on the driver, the distance or the rate's `enabled` switch,
 * which belongs to the driver side.
 */
export function riderPickupFee(rate: PickupPayRate, reservation: boolean): Money | null {
  return reservation ? rate.riderFee.reservation : rate.riderFee.live;
}
