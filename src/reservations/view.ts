import { sql } from "kysely";

/** v0.18.17 (contract.json#bookLater.rider.projection): TripProjection.reservation, from trips.reservation. No imports: projection.ts reads it. */
type State = { mode: "now" | "list"; dispatchAt: string; freeChangeUntil: string; noDriver: boolean; mustBeOnlineAt?: string; overdue?: boolean; notStarted?: boolean; noDriverFound?: boolean; atRisk?: boolean; leaveAt?: string; driveSeconds?: number; takenBack?: { driverId: string; at: string } | null; changeAsk?: { until: string; previousAt: string } | null };

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
    // v0.18.39 §63 (P17): the server ended it, no driver found (no fee).
    ...(state.noDriverFound ? { noDriverFound: true } : {}),
    ...(state.changeAsk ? { changeAsk: state.changeAsk } : {}),
    ...(viewer !== "rider" && state.mustBeOnlineAt ? { mustBeOnlineAt: state.mustBeOnlineAt } : {}),
    ...(viewer !== "rider" && state.leaveAt ? { leaveAt: state.leaveAt, driveSeconds: state.driveSeconds ?? 0 } : {}),
    ...(viewer !== "rider" ? { atRisk: state.atRisk === true } : {}),
    // v0.18.35 job 4 (contract.json#bookedTakeBack): admin only, until a new driver takes the ride.
    ...(viewer === "admin" && state.takenBack ? { takenBack: state.takenBack } : {}),
  };
}

/**
 * Owner checker H1: a booked ride a driver holds FOR LATER (taken from Scheduled rides or assigned early,
 * trips.reservation.held true) is not his current trip. One accepted through a normal offer (now mode, or
 * dispatched before pickup) is. Use with trips in the query (alias trips).
 */
// v0.18.33: a live trip queued behind the driver's current trip (next_after_trip_id) is not his current trip either.
export const NOT_HELD = sql<boolean>`(NOT (trips.kind = 'scheduled' AND trips.status = 'accepted' AND coalesce(trips.reservation->>'held', 'false') = 'true') AND trips.next_after_trip_id IS NULL)`;

/**
 * v0.18.152 (contract.json#bookedRideSeen.searchSeen; owner 2026-11-21 15:00 (A), owner Q2 2026-11-05): whether a list
 * driver holds this booked ride or ever held it (taken from Booked rides, an early admin offer, or held as an on-trip
 * driver's next trip). Such a ride stays the rider's booked card (driver assigned, no driver details) until a driver
 * drives to the pickup; one no list driver ever held is shown like a normal ride from its search on.
 * `reservation.listHeld` is written at every accept of a booked ride (true when a list driver takes it, kept true once
 * true). A driver on a trip who takes the searched ride as an Exclusive offer holds it as his next trip (held, owner Q7)
 * but is no list driver: listHeld stays false, the rider sees him like a normal ride. A trip saved before v0.18.152 has
 * no listHeld: then held, a take-back, or a driver told about the ride who is not its driver now, means it was held.
 */
type HeldState = { held?: boolean; listHeld?: boolean; toldDrivers?: string[]; takenBack?: unknown };
export function listHeldOf(trip: { kind: string; reservation: unknown; driver_id?: string | null }): boolean {
  const state = trip.kind === "scheduled" ? ((trip.reservation as HeldState | null) ?? null) : null;
  if (!state) return false;
  if (typeof state.listHeld === "boolean") return state.listHeld;
  return state.held === true || Boolean(state.takenBack) || (state.toldDrivers ?? []).some((d) => d !== (trip.driver_id ?? null));
}

/** listHeldOf in SQL (alias trips). */
export const LIST_HELD = sql<boolean>`(CASE WHEN jsonb_typeof(trips.reservation->'listHeld') = 'boolean' THEN (trips.reservation->>'listHeld') = 'true' ELSE coalesce(coalesce(trips.reservation->>'held', 'false') = 'true' OR jsonb_typeof(trips.reservation->'takenBack') = 'object' OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(trips.reservation->'toldDrivers') = 'array' THEN trips.reservation->'toldDrivers' ELSE '[]'::jsonb END) AS told(driver_id) WHERE told.driver_id IS DISTINCT FROM trips.driver_id), false) END)`;
