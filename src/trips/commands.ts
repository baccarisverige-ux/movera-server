import type { Executor, Trx } from "../db/db.js";
import type { TripsTable } from "../db/schema.js";
import { appendTripEvent, lockTrip, type TripRow } from "../db/tripLog.js";
import { ApiError } from "../http/errors.js";
import { nextStatus, isTripStatus, TERMINAL, type Actor } from "../rules/transitions.js";
import { tripProjection, type Viewer } from "./projection.js";
import type { Updateable } from "kysely";

/**
 * Every lifecycle change goes through here (contract §3): the transition table decides (else 409
 * invalid_transition with the projection), the version goes up by one, and one trip_projection event with the
 * new projection is appended (§4). The caller holds the trip lock (lockTrip) and checked expectedVersion.
 */

const viewerOf = (actor: Actor): Viewer => (actor === "system" ? "admin" : actor);

export async function applyCommand(
  trx: Trx,
  trip: TripRow,
  input: { command: string; actor: Actor; now: Date; set?: Updateable<TripsTable> },
): Promise<TripRow> {
  if (!isTripStatus(trip.status)) throw new Error(`Trip ${trip.trip_id} has an unknown status ${trip.status}`);
  const to = nextStatus(trip.status, input.command, input.actor, trip.kind);
  if (to === null) {
    throw new ApiError("invalid_transition", `A ${input.actor} cannot ${input.command} a trip that is ${trip.status}.`, {
      projection: tripProjection(trip, viewerOf(input.actor)),
    });
  }
  const version = trip.version + 1;
  await trx
    .updateTable("trips")
    .set({ ...(input.set ?? {}), status: to, version, updated_at: input.now })
    .where("trip_id", "=", trip.trip_id)
    .execute();
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  // The stored event carries the full projection; each stream redacts it for its viewer (§4).
  const sequence = Number(updated.sequence) + 1;
  await appendTripEvent(trx, { tripId: trip.trip_id, kind: "trip_projection", version, occurredAt: input.now, projection: tripProjection(updated, "admin", { sequence }) });
  return { ...updated, sequence: String(sequence) };
}

/** Is this trip the caller's own? The rider who booked it, the driver on it now; admins and the server see every trip. */
export function ownsTrip(trip: Pick<TripRow, "rider_id" | "driver_id">, who: { actor: Actor; subjectId: string }): boolean {
  return (
    who.actor === "admin" || who.actor === "system" ||
    (who.actor === "rider" && trip.rider_id === who.subjectId) ||
    (who.actor === "driver" && trip.driver_id === who.subjectId)
  );
}

/** Lock a trip the caller may act on. Another rider's or driver's trip is 404, as if it did not exist (§3). */
export async function lockOwnTrip(trx: Trx, tripId: string, who: { actor: Actor; subjectId: string }): Promise<TripRow> {
  const trip = await lockTrip(trx, tripId);
  if (!ownsTrip(trip, who)) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
  return trip;
}

/** The same for a read, without the lock. */
export async function readOwnTrip(ex: Executor, tripId: string, who: { actor: Actor; subjectId: string }): Promise<TripRow> {
  const trip = await ex.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirst();
  if (trip === undefined || !ownsTrip(trip, who)) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
  return trip;
}

/** The optimistic-concurrency check with the caller's own view as the projection. */
export function expectVersion(trip: TripRow, expectedVersion: number, viewer: Viewer): void {
  if (trip.version !== expectedVersion) {
    throw new ApiError("version_mismatch", "The trip changed since you last saw it.", { projection: tripProjection(trip, viewer) });
  }
}


/**
 * A change that is not a lifecycle step (an admin's bonus, fare correction, refund): new version, one event.
 * After a terminal status only afterTerminal kinds pass the apps' gate (§4), so money changes then go out as
 * payment_updated.
 */
export async function touchTrip(trx: Trx, trip: TripRow, set: Updateable<TripsTable>, now: Date): Promise<TripRow> {
  const version = trip.version + 1;
  await trx.updateTable("trips").set({ ...set, version, updated_at: now }).where("trip_id", "=", trip.trip_id).execute();
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  const sequence = Number(updated.sequence) + 1;
  const kind = isTripStatus(updated.status) && TERMINAL.has(updated.status) ? "payment_updated" : "trip_projection";
  await appendTripEvent(trx, { tripId: trip.trip_id, kind, version, occurredAt: now, projection: tripProjection(updated, "admin", { sequence }) });
  return { ...updated, sequence: String(sequence) };
}
