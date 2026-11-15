import type { Trx } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { ApiError } from "../http/errors.js";
import { haversineKm } from "../maps/routing.js";
import { expectVersion, lockOwnTrip, touchTrip } from "./commands.js";
import { tripProjection } from "./projection.js";
import { chargedStopSeconds } from "./waitingRules.js";
import { tripGeofence } from "./ride/geofence.js";
import { ARRIVE_MAX_METERS, type Place } from "./ride/shared.js";
import { arriveAtStop, stopBackAt, stopWaitedSeconds, visitsOf, type StopVisit } from "./ride/stopClock.js";
import { tapPosition } from "./ride/tapPosition.js";

/**
 * Waiting at a middle stop (contract v0.7.1 §3.8, contract.json#stopWaits; owner 2026-10-27): no free minutes. The
 * driver app taps "Framme vid stoppet" (arrive) and, when the trip goes on, leave; stop_waiting runs from one to
 * the other and is 100 % the driver's. v0.18.98 (job C9b): the server also marks the next stop arrived and stops the
 * wait while the driver is away (ride/geofence.ts, ride/stopClock.ts).
 */

export type { StopVisit } from "./ride/stopClock.js";
export { visitsOf } from "./ride/stopClock.js";

const ON_THE_WAY = new Set(["in_trip", "approaching_dropoff"]);

/**
 * Seconds charged at each extra stop, one entry per stop: arrival to leaving (an open stop until `end`), less the zone's
 * free minutes at each stop kept on the trip (v0.18.8, contract.json#arrivedWaiting.rules.stops; 0 before v0.18.8).
 * v0.18.98 (job C9b, contract.json#stopWaits.charge): less the stop's pausedSeconds, and frozen at away.since while the
 * driver is away (also on a stop left, or a trip completed, while away): time away never costs the rider.
 */
export function stopWaitSeconds(trip: Pick<TripRow, "stop_visits" | "stops"> & { booking_rules?: unknown }, end: Date): number[] {
  const visits = visitsOf(trip);
  const kept = (trip.booking_rules as { stopFreeWaitMin?: unknown } | null | undefined)?.stopFreeWaitMin;
  const free = typeof kept === "number" && kept > 0 ? kept : 0;
  return ((trip.stops as unknown[]) ?? []).map((_, index) => {
    const visit = visits.find((v) => v.stopIndex === index);
    return visit ? chargedStopSeconds(stopWaitedSeconds(visit, end), free) : 0;
  });
}

/** v0.18.98 (contract.json#autoArrive.stops.tap): the first stop tap's server limit (as the pickup tap, ARRIVE_MAX_METERS). */
export const STOP_TAP_MAX_METERS = ARRIVE_MAX_METERS;
const NOT_AT_STOP = { reason: "not_at_stop", message: "You are not at the stop yet." };

/**
 * POST /driver/trips/{tripId}/stops/{i}/arrive | leave. v0.18.98 (job C9b, contract.json#stopWaits.arrive,
 * #autoArrive.stops.tap / back): `checkPosition` (driver apps on X-Contract-Version ≥ 0.18.98) — the first tap needs a
 * fresh position within 300 m of stops[i], else 409 position_stale / not_at_stop; older apps (supervisor S1): the stored
 * fix, any age, within 300 m when there is one.
 * While stops[i].away is set, arrive is the back tap (any app): fresh position within the trip's leaveMeters, else 409
 * not_at_stop and the wait stays stopped. Leave while away: leftAt = now (the charge stops at away.since).
 */
export async function stopCommand(
  trx: Trx,
  driverId: string,
  tripId: string,
  stopIndex: number,
  verb: "arrive" | "leave",
  expectedVersion: number,
  now: Date,
  options: { location?: Place; checkPosition?: boolean } = {},
): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, { actor: "driver", subjectId: driverId });
  expectVersion(trip, expectedVersion, "driver");
  const refuse = (reason: string, message: string) => {
    throw new ApiError("invalid_transition", message, { reason, projection: tripProjection(trip, "driver") });
  };
  if (!ON_THE_WAY.has(trip.status)) refuse("not_on_trip", "Stops are reported once the trip has started.");
  const stops = (trip.stops as Place[]) ?? [];
  if (stopIndex >= stops.length) throw new ApiError("not_found", "This trip has no such stop.", { reason: "stop_not_found" });
  const visits = visitsOf(trip);
  const visit = visits.find((v) => v.stopIndex === stopIndex);
  let next: StopVisit[];
  if (verb === "arrive") {
    if (visit?.away && !visit.leftAt) {
      // The back tap (contract.json#autoArrive.stops.back): within the trip's leaveMeters, not the first tap's 300 m.
      const { leaveMeters } = await tripGeofence(trx, trip);
      await tapPosition(trx, trip, driverId, now, options.location, {}, { place: stops[stopIndex]!, maxMeters: leaveMeters, ...NOT_AT_STOP });
      next = visits.map((v) => (v.stopIndex === stopIndex ? stopBackAt(v, now, now) : v));
      return touchTrip(trx, trip, { stop_visits: JSON.stringify(next) }, now);
    }
    if (visit) refuse("stop_already_arrived", "You already arrived at this stop.");
    if (stopIndex > 0 && !visits.some((v) => v.stopIndex === stopIndex - 1)) refuse("stop_out_of_order", "Arrive at the stops in order.");
    if (options.checkPosition) await tapPosition(trx, trip, driverId, now, options.location, {}, { place: stops[stopIndex]!, maxMeters: STOP_TAP_MAX_METERS, ...NOT_AT_STOP });
    else {
      // Supervisor S1 (Rules audits/impact/c9b-middle-stops-supervisor.md): the header is the client's, so an older app
      // (no X-Contract-Version, or lower) is checked against the server's stored fix, any age, as the pickup's old path;
      // refused only when a stored fix exists and is farther than 300 m (no stored fix: accepted, never stuck).
      const stored = await trx.selectFrom("driver_locations").select(["lat", "lng"]).where("driver_id", "=", driverId).executeTakeFirst();
      if (stored && haversineKm(stored, stops[stopIndex]!) * 1000 > STOP_TAP_MAX_METERS) refuse(NOT_AT_STOP.reason, NOT_AT_STOP.message);
    }
    // Arriving at the next stop closes an earlier one the driver forgot to leave.
    next = arriveAtStop(visits, stopIndex, now, "tap");
  } else {
    if (!visit) refuse("stop_not_arrived", "Tap arrived at this stop first.");
    if (visit!.leftAt) refuse("stop_already_left", "You already left this stop.");
    next = visits.map((v) => (v.stopIndex === stopIndex ? { ...v, leftAt: now.toISOString() } : v));
  }
  return touchTrip(trx, trip, { stop_visits: JSON.stringify(next) }, now);
}
