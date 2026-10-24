import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import { schemaProblem } from "../contract/schemas.js";
import type { Executor, Trx } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { TERMINAL } from "../rules/transitions.js";
import { applyCommand, expectVersion, lockOwnTrip } from "./commands.js";
import { startSearch, stopSearch } from "../dispatch/runtime.js";
import { tripProjection, type Viewer } from "./projection.js";

/** Trip requests, reads and the rider's cancel (contract §3, §7). */

const RIDER_REASONS: readonly string[] = (contract as unknown as { cancelReasons: { rider: string[] } }).cancelReasons.rider;

type Place = { address?: string; lat: number; lng: number };
type CreateTrip = {
  quoteId: string;
  categoryId: string;
  pickup: Place;
  dropoff: Place;
  stops: Place[];
  kind: "live" | "scheduled";
  scheduledAt?: string;
  paymentMethod: string;
  paymentMethodId?: string;
  notes?: string;
};

const samePlace = (a: Place, b: Place) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;

/**
 * POST /trips: books the rider's quote. The trip starts `quoted` with the quote's price, takes `request`, and a
 * live trip takes `start_search` at once (a scheduled one stays `requested` until its time, §6.1). Dispatch starts
 * from the search started in the same transaction (dispatch/runtime.ts).
 */
export async function createTrip(trx: Trx, riderId: string, request: unknown, options: { paymentMethods: readonly string[]; now: Date }): Promise<TripRow> {
  const problem = schemaProblem("CreateTripRequest", request);
  if (problem !== null) throw badRequest(`The trip request is not valid: ${problem}.`, "invalid_body");
  const body = request as CreateTrip;
  const now = options.now;

  const quote = await trx.selectFrom("quotes").selectAll().where("quote_id", "=", body.quoteId).forUpdate().executeTakeFirst();
  if (quote === undefined || quote.rider_id !== riderId) throw new ApiError("not_found", "No such quote.", { reason: "quote_not_found" });
  if (quote.used_at !== null) throw new ApiError("conflict", "This price was already used for a ride.", { reason: "quote_used" });
  if (quote.expires_at.getTime() <= now.getTime()) throw new ApiError("conflict", "This price expired. Ask for a new one.", { reason: "quote_expired" });
  const quotedStops = (quote.stops as Place[]) ?? [];
  const matches =
    quote.category_id === body.categoryId &&
    quote.kind === body.kind &&
    samePlace(quote.pickup as Place, body.pickup) &&
    samePlace(quote.dropoff as Place, body.dropoff) &&
    quotedStops.length === body.stops.length &&
    quotedStops.every((stop, i) => samePlace(stop, body.stops[i]!));
  if (!matches) throw badRequest("The ride does not match its price. Ask for a new one.", "quote_mismatch");
  if (!options.paymentMethods.includes(body.paymentMethod)) {
    throw badRequest(`${body.paymentMethod} is not available; pay with ${options.paymentMethods.join(" or ")}.`, "payment_method_not_available");
  }
  const rider = await trx.selectFrom("riders").select(["status"]).where("rider_id", "=", riderId).executeTakeFirstOrThrow();
  if (rider.status !== "active") throw new ApiError("forbidden", "This account is suspended.", { reason: "account_suspended" });

  const tripId = newId("trp", now.getTime());
  const driverEarnings = Number(quote.driver_earnings_minor);
  try {
    await trx
      .insertInto("trips")
      .values({
        trip_id: tripId,
        rider_id: riderId,
        driver_id: null,
        vehicle_id: null,
        zone_id: quote.zone_id,
        kind: body.kind,
        category_id: body.categoryId,
        status: "quoted",
        ended_by_command: null,
        scheduled_at: quote.scheduled_at,
        accepted_at: null,
        search_started_at: null,
        pickup: JSON.stringify(quote.pickup),
        dropoff: JSON.stringify(quote.dropoff),
        stops: JSON.stringify(quotedStops),
        quote_id: quote.quote_id,
        quote_expires_at: quote.expires_at,
        currency: quote.currency,
        fare_minor: quote.total_minor,
        fare_lines: JSON.stringify(quote.fare_lines),
        booked_fare_minor: quote.total_minor,
        driver_earnings_minor: driverEarnings,
        commission_minor: Number(quote.total_minor) - driverEarnings,
        payment_method: body.paymentMethod,
        payment_method_id: body.paymentMethodId ?? null,
        payment_status: null,
        waiting: null,
        cancellation: null,
        distance_meters: quote.distance_meters,
        duration_seconds: quote.duration_seconds,
        surge_multiplier: quote.surge_multiplier,
        pricing_version: quote.pricing_version,
        notes: body.notes ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  } catch (error) {
    if ((error as { constraint?: string }).constraint === "trips_one_live_per_rider") {
      throw new ApiError("conflict", "You already have a ride going.", { reason: "active_trip_exists" });
    }
    throw error;
  }
  await trx.updateTable("quotes").set({ used_at: now }).where("quote_id", "=", quote.quote_id).execute();

  let trip = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  trip = await applyCommand(trx, trip, { command: "request", actor: "rider", now });
  if (trip.kind === "live") {
    trip = await applyCommand(trx, trip, { command: "start_search", actor: "system", now, set: { search_started_at: now } });
    await startSearch(trx, trip, now);
  }
  return trip;
}

export async function getTrip(ex: Executor, tripId: string, who: { actor: "rider" | "driver" | "admin"; subjectId: string }): Promise<Record<string, unknown>> {
  const trip = await ex.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirst();
  const own = trip !== undefined && (who.actor === "admin" || (who.actor === "rider" && trip.rider_id === who.subjectId) || (who.actor === "driver" && trip.driver_id === who.subjectId));
  if (!own) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
  return tripProjection(trip, who.actor);
}

/** The rider's cancel (contract §3): free before a driver accepted; after that the fee rules apply (§3, §5). */
export async function riderCancel(
  trx: Trx,
  riderId: string,
  tripId: string,
  body: { expectedVersion: number; reasonCode: string; note?: string },
  now: Date,
  fee: (trip: TripRow) => Promise<{ amountMinor: number; currency: string } | null>,
): Promise<TripRow> {
  if (!RIDER_REASONS.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not a rider cancel reason.`, "invalid_reason_code");
  const trip = await lockOwnTrip(trx, tripId, { actor: "rider", subjectId: riderId });
  expectVersion(trip, body.expectedVersion, "rider");
  const charged = trip.accepted_at === null ? null : await fee(trip);
  const cancellation = {
    actor: "rider",
    reasonCode: body.reasonCode,
    at: now.toISOString(),
    fee: charged,
    ...(body.note ? { note: body.note } : {}),
  };
  const cancelled = await applyCommand(trx, trip, { command: "cancel", actor: "rider", now, set: { cancellation: JSON.stringify(cancellation), ended_by_command: "cancel", search_step: null } });
  await stopSearch(trx, cancelled, now);
  return cancelled;
}

/** POST /trips/{id}/cancel-reason (v0.4.4): the reason after a cancel-first; no version change, no event. */
export async function setCancelReason(trx: Trx, riderId: string, tripId: string, body: { reasonCode: string; note?: string }): Promise<TripRow> {
  if (!RIDER_REASONS.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not a rider cancel reason.`, "invalid_reason_code");
  const trip = await lockOwnTrip(trx, tripId, { actor: "rider", subjectId: riderId });
  const cancellation = trip.cancellation as { actor?: string; reasonCode?: string } | null;
  if (trip.status !== "cancelled_by_rider" || cancellation?.reasonCode !== "something_else") {
    throw new ApiError("invalid_transition", "The reason can only be told once, after a cancel.", { projection: tripProjection(trip, "rider") });
  }
  const next = { ...cancellation, reasonCode: body.reasonCode, ...(body.note ? { note: body.note } : {}) };
  await trx.updateTable("trips").set({ cancellation: JSON.stringify(next) }).where("trip_id", "=", tripId).execute();
  return { ...trip, cancellation: next };
}

const NOT_OVER = [...TERMINAL];

/** GET /rider/trips/active: the rider's live trip that is not over (204 when none). */
export async function activeTrip(ex: Executor, riderId: string): Promise<TripRow | undefined> {
  return ex
    .selectFrom("trips")
    .selectAll()
    .where("rider_id", "=", riderId)
    .where("kind", "=", "live")
    .where("status", "not in", NOT_OVER)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
}

/** GET /rider/trips: newest first, cursor = (createdAt, tripId). */
export async function riderTrips(
  ex: Executor,
  riderId: string,
  input: { cursor?: string; limit: number; statuses?: string[]; kind?: string; from?: string; to?: string },
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  let query = ex.selectFrom("trips").selectAll().where("rider_id", "=", riderId);
  if (input.statuses?.length) query = query.where("status", "in", input.statuses);
  if (input.kind) query = query.where("kind", "=", input.kind as "live" | "scheduled");
  if (input.from) query = query.where("created_at", ">=", new Date(input.from));
  if (input.to) query = query.where("created_at", "<", new Date(input.to));
  if (input.cursor) {
    const [at, id] = Buffer.from(input.cursor, "base64url").toString("utf8").split("|");
    if (!at || !id || Number.isNaN(Date.parse(at))) throw badRequest("The cursor is not valid.", "invalid_cursor");
    query = query.where(sql<boolean>`(created_at, trip_id) < (${new Date(at)}, ${id})`);
  }
  const rows = await query.orderBy("created_at", "desc").orderBy("trip_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => tripProjection(row, "rider")),
    nextCursor: rows.length > input.limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.trip_id}`).toString("base64url") : null,
  };
}

export const viewerFor = (actor: string): Viewer => (actor === "rider" || actor === "driver" ? actor : "admin");
