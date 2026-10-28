/**
 * What the price depends on beyond the route (contract v0.7.1 §3.5, contract.json#pricing.requestExtras). The rider
 * sends only a fixed route (POST /quotes, repeated unchanged on POST /trips); the server adds whether the pickup and
 * the drop-off lie in an airport zone. The quote and the trip keep them and the fare at completion prices them
 * again. Seats are never sent: a Child Seat trip always includes its one seat.
 */

export type PriceExtras = {
  fixedRouteId?: string;
  pickupInAirportZone?: boolean;
  dropoffInAirportZone?: boolean;
};

const KEYS = ["fixedRouteId", "pickupInAirportZone", "dropoffInAirportZone"] as const;
/** What the rider sends and must repeat on POST /trips. */
const RIDER_KEYS = ["fixedRouteId"] as const;

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

/** The trip asks for what its quote was priced with (only the rider's own extras are compared). */
export function sameExtras(a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined): boolean {
  const x = extrasOf(a);
  const y = extrasOf(b);
  return RIDER_KEYS.every((key) => x[key] === y[key]);
}

/** v0.7.1: babySeats / childSeats (v0.6.0, read for one release) above 0 on any category but Child Seat. */
export function asksSeatOutsideChildSeat(body: Record<string, unknown> | null | undefined, categoryId: string): boolean {
  const n = (k: string) => (typeof body?.[k] === "number" ? (body[k] as number) : 0);
  return categoryId !== "child_seat" && (n("babySeats") > 0 || n("childSeats") > 0);
}

/** What the rider may set: only the fixed route (airport flags they send are ignored, v0.7.1). */
export function riderExtras(body: Record<string, unknown> | null | undefined): PriceExtras {
  const route = body?.["fixedRouteId"];
  return typeof route === "string" && route !== "" ? { fixedRouteId: route } : {};
}
