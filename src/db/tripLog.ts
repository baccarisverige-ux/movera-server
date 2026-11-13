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
  // S5 (sup1 P11): FOR NO KEY UPDATE. Against every other trip writer it is the same lock as FOR UPDATE (two commands, a
  // timer's lockTripNow and any UPDATE of the row still wait for each other), but an insert of a child row that only
  // takes KEY SHARE through its foreign key (the GPS trace in trip_locations) no longer waits for the whole command.
  // test/db/tripLog.test.ts proves both. It is safe only because no code changes trip_id or deletes a trip row.
  // RULE: any future DELETE of a trip row (or change of trip_id) must lock it FOR UPDATE itself, never through lockTrip.
  const row = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).forNoKeyUpdate().executeTakeFirst();
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
  /**
   * v0.18.51 §73 (contract.json#driverReservationsLive.when, S4 ISSUE 1): this change moves a booked ride on or off the
   * drivers' lists or changes a listed ride (created, accepted, released, cancelled, rescheduled, started). Only then
   * do the zone's driver streams get driver_reservations_changed; a location fix, message, call, search step or island
   * alert leaves it unset.
   */
  reservations?: boolean;
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
    .returning(["sequence", "rider_id", "zone_id", "scheduled_at", "driver_id"])
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
  await sql`SELECT pg_notify(${TRIP_EVENTS_CHANNEL}, ${JSON.stringify(tripNotice(event.tripId, sequence, bumped, event.reservations === true))})`.execute(trx);
  return { eventId, sequence };
}

/**
 * The movera_trip_events NOTIFY payload. v0.18.45 §68 (contract.json#driverReservationsLive) only ADDS zoneId,
 * scheduled and (when set) driverId; tripId, sequence and riderId are unchanged (rider_trip_changed reads them).
 * v0.18.51 §73 adds reservations: true on a booked ride's list change (NewTripEvent.reservations).
 */
export function tripNotice(
  tripId: string,
  sequence: number,
  row: { rider_id: string; zone_id: string; scheduled_at: unknown; driver_id: string | null },
  reservations = false,
): Record<string, unknown> {
  const scheduled = row.scheduled_at !== null && row.scheduled_at !== undefined;
  return {
    tripId,
    sequence,
    riderId: row.rider_id,
    zoneId: row.zone_id,
    scheduled,
    ...(row.driver_id !== null ? { driverId: row.driver_id } : {}),
    ...(scheduled && reservations ? { reservations: true } : {}),
  };
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
