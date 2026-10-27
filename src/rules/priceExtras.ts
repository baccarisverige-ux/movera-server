/**
 * What the rider asks for that the price depends on (contract v0.6.0 §3.5, contract.json#pricing.requestExtras):
 * baby and child seats, airport pickup and drop-off, a fixed route. Sent on POST /quotes, repeated unchanged on
 * POST /trips, kept on the quote and the trip, and priced again at completion.
 */

export type PriceExtras = {
  babySeats?: number;
  childSeats?: number;
  airportPickup?: boolean;
  airportDropoff?: boolean;
  fixedRouteId?: string;
};

const KEYS = ["babySeats", "childSeats", "airportPickup", "airportDropoff", "fixedRouteId"] as const;

/** The extras of a request, without the ones left at their "nothing asked" value (0 seats, false, absent). */
export function extrasOf(body: Record<string, unknown> | null | undefined): PriceExtras {
  const out: Record<string, unknown> = {};
  for (const key of KEYS) {
    const value = body?.[key];
    if (value === undefined || value === null || value === 0 || value === false) continue;
    out[key] = value;
  }
  return out as PriceExtras;
}

/** Two requests ask for the same extras (0 seats = no seats, false = not sent). */
export function sameExtras(a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined): boolean {
  const x = extrasOf(a);
  const y = extrasOf(b);
  return KEYS.every((key) => x[key] === y[key]);
}

type ScheduledWindow = { id: string; multiplier: number; startsAt: string; endsAt: string };

/**
 * The surge of the pricing document at `at` (contract.json#pricing.surgeSource, after the zone's surge schedule):
 * the first `surge.scheduled` window in force (startsAt ≤ at < endsAt), else 1. Smart surge is not applied: its
 * algorithm is not normative in the contract. priceFare clamps the result to [1, surge.maxMultiplier].
 */
export function documentSurgeAt(surge: { scheduled?: ScheduledWindow[] } | undefined, at: Date): { multiplier: number; until?: string } {
  const now = at.getTime();
  for (const window of surge?.scheduled ?? []) {
    const start = Date.parse(window.startsAt);
    const end = Date.parse(window.endsAt);
    if (Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end) return { multiplier: window.multiplier, until: window.endsAt };
  }
  return { multiplier: 1 };
}
