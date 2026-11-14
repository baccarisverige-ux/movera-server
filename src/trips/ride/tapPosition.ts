import type { Trx } from "../../db/db.js";
import type { TripRow } from "../../db/tripLog.js";
import { ApiError } from "../../http/errors.js";
import { haversineKm } from "../../maps/routing.js";
import { tripProjection } from "../projection.js";
import { ARRIVE_MAX_METERS, positionMaxAge, type Place } from "./shared.js";

/**
 * A driver tap's position check: the pickup Arrived (steps.ts) and, v0.18.98 (job C9b, contract.json#autoArrive.stops.tap /
 * back), the stop tap. Deep fix 2026-11-02 (MED stale / fake GPS for arrive): a position counts only while it is at most
 * the zone's DriverAppConfig.waiting.positionMaxAgeSeconds old (default 60): the one sent with the tap when it says when it
 * was measured, else the server's latest fix. Only an old one → 409 position_stale (turn on location); none, or farther
 * than `maxMeters` from `target` → 409 invalid_transition with `reason` (not_at_pickup / not_at_stop).
 */
export async function tapPosition(
  trx: Trx,
  trip: TripRow,
  driverId: string,
  now: Date,
  location: Place | undefined,
  options: { legacyPosition?: boolean },
  target: { place: Place; maxMeters?: number; reason: string; message: string },
): Promise<Place> {
  const maxAge = options.legacyPosition ? Number.POSITIVE_INFINITY : await positionMaxAge(trx, trip.zone_id);
  const fresh = (at: unknown) => options.legacyPosition || (typeof at === "string" || at instanceof Date ? Math.abs(now.getTime() - new Date(at).getTime()) <= maxAge * 1000 : false);
  const sent = location && fresh((location as Place & { measuredAt?: string }).measuredAt) ? location : null;
  const stored = sent ? undefined : await trx.selectFrom("driver_locations").select(["lat", "lng", "measured_at"]).where("driver_id", "=", driverId).executeTakeFirst();
  const here = sent ?? (stored && fresh(stored.measured_at) ? stored : null);
  if (!here && (location || stored)) throw new ApiError("invalid_transition", "Your position is too old. Turn on location and try again.", { reason: "position_stale", projection: tripProjection(trip, "driver") });
  if (!here || haversineKm(here, target.place) * 1000 > (target.maxMeters ?? ARRIVE_MAX_METERS)) {
    throw new ApiError("invalid_transition", target.message, { reason: target.reason, projection: tripProjection(trip, "driver") });
  }
  return here;
}
