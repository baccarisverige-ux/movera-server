import { commissionOf } from "../rules/commission.js";
import type { TripRow } from "../db/tripLog.js";

/**
 * Owner bug 2026-11-01 (admin "Add money", Apply to: Exclusive → the driver saw it on a Radar offer). The money an
 * admin adds for the driver applies to one kind of offer: "exclusive" (the admin's exclusive offer and the automatic
 * exclusive one), "radar" (every radar offer), or "both". A trip from before keeps one bonus for both kinds.
 */
export type BonusScope = "exclusive" | "radar" | "both";
export type OfferSide = "exclusive" | "radar";

export const sideOfKind = (kind: string): OfferSide => (kind === "radar" ? "radar" : "exclusive");
export const scopeCovers = (scope: BonusScope, side: OfferSide) => scope === "both" || scope === side;

type BonusCols = Pick<TripRow, "driver_bonus_minor" | "priority" | "bonus_exclusive_minor" | "bonus_radar_minor" | "priority_exclusive" | "priority_radar">;

/** The money for the driver on an offer of this kind. */
export function bonusFor(trip: BonusCols, kind: string): number {
  const own = sideOfKind(kind) === "radar" ? trip.bonus_radar_minor : trip.bonus_exclusive_minor;
  return Number(own ?? trip.driver_bonus_minor ?? 0);
}

/** The "Priority" badge on an offer of this kind. */
export function priorityFor(trip: BonusCols, kind: string): boolean {
  const own = sideOfKind(kind) === "radar" ? trip.priority_radar : trip.priority_exclusive;
  return Boolean(own ?? trip.priority);
}

/**
 * The columns after adding `addMinor` (and the badge) for `scope`. driver_bonus_minor is the larger of the two until a
 * driver accepts (the limit and Movera's commission count the most it may pay); accept sets it to the kind he took.
 */
export function addBonus(trip: BonusCols & Pick<TripRow, "fare_minor" | "fare_lines" | "driver_earnings_minor" | "pickup_pay_minor">, addMinor: number, scope: BonusScope, priority?: boolean) {
  const exclusive = bonusFor(trip, "exclusive") + (scopeCovers(scope, "exclusive") ? addMinor : 0);
  const radar = bonusFor(trip, "radar") + (scopeCovers(scope, "radar") ? addMinor : 0);
  const pick = (side: OfferSide) => (priority !== undefined && scopeCovers(scope, side) ? priority : priorityFor(trip, side));
  const priorityExclusive = pick("exclusive");
  const priorityRadar = pick("radar");
  const bonus = Math.max(exclusive, radar);
  return {
    bonus_exclusive_minor: exclusive,
    bonus_radar_minor: radar,
    priority_exclusive: priorityExclusive,
    priority_radar: priorityRadar,
    priority: priorityExclusive || priorityRadar,
    driver_bonus_minor: bonus,
    commission_minor: commissionOf(Number(trip.fare_minor), trip.fare_lines, Number(trip.driver_earnings_minor ?? 0), Number(trip.pickup_pay_minor ?? 0), bonus),
  };
}
