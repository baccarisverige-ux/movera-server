import type { Trx } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { ApiError } from "../http/errors.js";
import { expectVersion, lockOwnTrip, touchTrip } from "./commands.js";
import { tripProjection } from "./projection.js";
import { chargedStopSeconds } from "./waitingRules.js";

/**
 * Waiting at a middle stop (contract v0.7.1 §3.8, contract.json#stopWaits; owner 2026-10-27): no free minutes. The
 * driver app taps "Framme vid stoppet" (arrive) and, when the trip goes on, leave; stop_waiting runs from one to
 * the other and is 100 % the driver's.
 */

export type StopVisit = { stopIndex: number; arrivedAt: string; leftAt?: string };

const ON_THE_WAY = new Set(["in_trip", "approaching_dropoff"]);

export const visitsOf = (trip: Pick<TripRow, "stop_visits">): StopVisit[] => ((trip.stop_visits as StopVisit[] | null) ?? []).slice().sort((a, b) => a.stopIndex - b.stopIndex);

/**
 * Seconds charged at each extra stop, one entry per stop: arrival to leaving (an open stop until `end`), less the zone's
 * free minutes at each stop kept on the trip (v0.18.8, contract.json#arrivedWaiting.rules.stops; 0 before v0.18.8).
 */
export function stopWaitSeconds(trip: Pick<TripRow, "stop_visits" | "stops"> & { booking_rules?: unknown }, end: Date): number[] {
  const visits = visitsOf(trip);
  const kept = (trip.booking_rules as { stopFreeWaitMin?: unknown } | null | undefined)?.stopFreeWaitMin;
  const free = typeof kept === "number" && kept > 0 ? kept : 0;
  return ((trip.stops as unknown[]) ?? []).map((_, index) => {
    const visit = visits.find((v) => v.stopIndex === index);
    if (!visit) return 0;
    const until = visit.leftAt ? Date.parse(visit.leftAt) : end.getTime();
    return chargedStopSeconds(Math.max(0, Math.floor((until - Date.parse(visit.arrivedAt)) / 1000)), free);
  });
}

export async function stopCommand(trx: Trx, driverId: string, tripId: string, stopIndex: number, verb: "arrive" | "leave", expectedVersion: number, now: Date): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, { actor: "driver", subjectId: driverId });
  expectVersion(trip, expectedVersion, "driver");
  const refuse = (reason: string, message: string) => {
    throw new ApiError("invalid_transition", message, { reason, projection: tripProjection(trip, "driver") });
  };
  if (!ON_THE_WAY.has(trip.status)) refuse("not_on_trip", "Stops are reported once the trip has started.");
  const stops = (trip.stops as unknown[]) ?? [];
  if (stopIndex >= stops.length) throw new ApiError("not_found", "This trip has no such stop.", { reason: "stop_not_found" });
  const visits = visitsOf(trip);
  const visit = visits.find((v) => v.stopIndex === stopIndex);
  let next: StopVisit[];
  if (verb === "arrive") {
    if (visit) refuse("stop_already_arrived", "You already arrived at this stop.");
    if (stopIndex > 0 && !visits.some((v) => v.stopIndex === stopIndex - 1)) refuse("stop_out_of_order", "Arrive at the stops in order.");
    // Arriving at the next stop closes an earlier one the driver forgot to leave.
    next = [...visits.map((v) => (v.leftAt ? v : { ...v, leftAt: now.toISOString() })), { stopIndex, arrivedAt: now.toISOString() }];
  } else {
    if (!visit) refuse("stop_not_arrived", "Tap arrived at this stop first.");
    if (visit!.leftAt) refuse("stop_already_left", "You already left this stop.");
    next = visits.map((v) => (v.stopIndex === stopIndex ? { ...v, leftAt: now.toISOString() } : v));
  }
  return touchTrip(trx, trip, { stop_visits: JSON.stringify(next) }, now);
}
