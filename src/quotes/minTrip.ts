import type { Executor } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { liveDocument } from "../config/service.js";
import { haversineKm, type LatLng } from "../maps/routing.js";

/**
 * Same-address fix (contract v0.18.42 §67, contract.json#sameAddress.minTripMeters): the zone pricing document's
 * minTripMeters (admin Pricing page, 0-5000 m, 0 = off, missing = 0 = off per owner Q9). Read from the zone's live pricing document in the
 * database (the shared config read, same as the prices), so every server copy applies the same value (rule 33).
 */
/** Owner Q9 (v0.18.30, "Warn him but can accept booking") overrides the boss 300 m: off unless the zone turns it on. */
export const MIN_TRIP_METERS_DEFAULT = 0;

export function minTripMetersOf(document: unknown): number {
  const value = (document as { minTripMeters?: unknown } | null | undefined)?.minTripMeters;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 5000 ? value : MIN_TRIP_METERS_DEFAULT;
}

/** Refuses (400 invalid_request, reason dropoff_too_close) a drop-off closer than the limit to the pickup; trips with stops are not checked. */
export function checkMinTrip(limitMeters: number, trip: { pickup: LatLng; dropoff: LatLng; stops: readonly unknown[] }): void {
  if (limitMeters === 0 || trip.stops.length > 0) return;
  const meters = Math.round(haversineKm(trip.pickup, trip.dropoff) * 1000);
  if (meters >= limitMeters) return;
  throw new ApiError("invalid_request", "Drop-off is too close to pickup.", { reason: "dropoff_too_close", details: [`meters=${meters}`, `limitMeters=${limitMeters}`] });
}

/** /trips: the zone's live value (the admin may have raised it since the quote). */
export async function checkMinTripLive(ex: Executor, zoneId: string, trip: { pickup: LatLng; dropoff: LatLng; stops: readonly unknown[] }): Promise<void> {
  const pricing = await liveDocument<unknown>(ex, "pricing", zoneId);
  checkMinTrip(minTripMetersOf(pricing?.document), trip);
}
