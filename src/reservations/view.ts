import { sql } from "kysely";

/** v0.18.17 (contract.json#bookLater.rider.projection): TripProjection.reservation, from trips.reservation. No imports: projection.ts reads it. */
type State = { mode: "now" | "list"; dispatchAt: string; freeChangeUntil: string; noDriver: boolean; mustBeOnlineAt?: string; overdue?: boolean; notStarted?: boolean; atRisk?: boolean; leaveAt?: string; driveSeconds?: number; changeAsk?: { until: string; previousAt: string } | null };

export function reservationView(trip: { kind: string; reservation: unknown }, viewer: "rider" | "driver" | "admin"): Record<string, unknown> | null {
  const state = trip.kind === "scheduled" ? ((trip.reservation as State | null) ?? null) : null;
  if (!state) return null;
  return {
    mode: state.mode,
    dispatchAt: state.dispatchAt,
    freeChangeUntil: state.freeChangeUntil,
    noDriver: state.noDriver,
    overdue: state.overdue === true,
    notStarted: state.notStarted === true,
    ...(state.changeAsk ? { changeAsk: state.changeAsk } : {}),
    ...(viewer !== "rider" && state.mustBeOnlineAt ? { mustBeOnlineAt: state.mustBeOnlineAt } : {}),
    ...(viewer !== "rider" && state.leaveAt ? { leaveAt: state.leaveAt, driveSeconds: state.driveSeconds ?? 0 } : {}),
    ...(viewer !== "rider" ? { atRisk: state.atRisk === true } : {}),
  };
}

/**
 * Owner checker H1: a booked ride a driver holds FOR LATER (taken from Scheduled rides or assigned early,
 * trips.reservation.held true) is not his current trip. One accepted through a normal offer (now mode, or
 * dispatched before pickup) is. Use with trips in the query (alias trips).
 */
// v0.18.33: a live trip queued behind the driver's current trip (next_after_trip_id) is not his current trip either.
export const NOT_HELD = sql<boolean>`(NOT (trips.kind = 'scheduled' AND trips.status = 'accepted' AND coalesce(trips.reservation->>'held', 'false') = 'true') AND trips.next_after_trip_id IS NULL)`;
