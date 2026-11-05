import { sql } from "kysely";
import { ApiError, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import type { Executor, Trx } from "./db.js";
import type { TripsTable } from "./schema.js";
import type { Selectable } from "kysely";

/**
 * The trip write path shared by every trip command: lock the trip row, check expectedVersion, change it, then
 * append one realtime event (contract §4) and wake the streams. All inside the command's transaction, so an
 * event exists exactly when its change was committed.
 *
 * Lock order everywhere: trip, then offer, then driver. Location fixes never lock the driver row (they live in
 * driver_locations), so they cannot deadlock a command.
 */

export type TripRow = Selectable<TripsTable>;

/** The channel the realtime streams LISTEN on. The payload names the event; streams read it from trip_events. */
export const TRIP_EVENTS_CHANNEL = "movera_trip_events";
/** The channel the driver offer feeds LISTEN on ({ driverId, sequence }). */
export const OFFER_EVENTS_CHANNEL = "movera_offer_events";

export async function lockTrip(trx: Trx, tripId: string): Promise<TripRow> {
  const row = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).forUpdate().executeTakeFirst();
  if (row === undefined) throw notFound("No such trip.", "trip_not_found");
  return row;
}

/**
 * A stale expectedVersion is 409 version_mismatch with the current projection, so the app can redraw from it
 * and decide again (contract §1 Concurrency). `projection` is the view for the actor who asked.
 */
export function checkVersion(current: number, expectedVersion: number | undefined, projection: () => unknown): void {
  if (expectedVersion === undefined) {
    throw new ApiError("invalid_request", "Send expectedVersion with this change.", { reason: "expected_version_missing" });
  }
  if (expectedVersion !== current) {
    throw new ApiError("version_mismatch", "The trip changed since you last saw it.", { projection: projection() });
  }
}

export type TripEventKind =
  | "trip_projection"
  | "rider_cancelled"
  | "driver_cancelled"
  | "location"
  | "driver_arrived"
  | "rider_on_the_way"
  | "payment_updated"
  | "rating_updated"
  | "message"
  | "pickup_moved"
  | "call_ringing"
  | "call_answered"
  | "call_signal"
  | "call_ended"
  | "call_missed";

export type NewTripEvent = {
  tripId: string;
  kind: TripEventKind;
  /** The trip's version after the change (unchanged for a location fix). */
  version: number;
  occurredAt?: Date;
  projection?: unknown;
  location?: unknown;
  etaSeconds?: number;
  /** v0.18.7: TripEta on the ETA tick's location event. */
  eta?: unknown;
  cancelFee?: unknown;
  message?: unknown;
  /** v0.18.38 §62: CallView (call_ringing / answered / ended / missed) or the signal (call_signal). */
  call?: unknown;
};

export type AppendedEvent = { eventId: string; sequence: number };

/**
 * Takes the next sequence for the trip (the caller holds the trip row lock, or this statement takes it),
 * writes the event and queues a notification that PostgreSQL delivers only if the transaction commits.
 */
export async function appendTripEvent(trx: Trx, event: NewTripEvent): Promise<AppendedEvent> {
  const bumped = await trx
    .updateTable("trips")
    .set({ sequence: sql`sequence + 1` })
    .where("trip_id", "=", event.tripId)
    .returning(["sequence", "rider_id"])
    .executeTakeFirst();
  if (bumped === undefined) throw notFound("No such trip.", "trip_not_found");
  const sequence = Number(bumped.sequence);
  const eventId = newId("evt");
  const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
  await trx
    .insertInto("trip_events")
    .values({
      trip_id: event.tripId,
      sequence,
      event_id: eventId,
      kind: event.kind,
      version: event.version,
      occurred_at: event.occurredAt ?? new Date(),
      projection: json(event.projection),
      location: json(event.location),
      eta_seconds: event.etaSeconds ?? null,
      eta: json(event.eta),
      cancel_fee: json(event.cancelFee),
      message: json(event.message),
      ...(event.call !== undefined ? { call: json(event.call) } : {}),
    })
    .execute();
  await sql`SELECT pg_notify(${TRIP_EVENTS_CHANNEL}, ${JSON.stringify({ tripId: event.tripId, sequence, riderId: bumped.rider_id })})`.execute(trx);
  return { eventId, sequence };
}

/** Events after a cursor, oldest first (stream resume and catch-up). */
export async function tripEventsAfter(ex: Executor, tripId: string, afterSequence: number, limit = 500) {
  return ex
    .selectFrom("trip_events")
    .selectAll()
    .where("trip_id", "=", tripId)
    .where("sequence", ">", String(afterSequence))
    .orderBy("sequence")
    .limit(limit)
    .execute();
}
