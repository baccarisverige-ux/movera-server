import { appendTripEvent } from "../db/tripLog.js";
import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import { schemaProblem } from "../contract/schemas.js";
import type { Executor, Trx } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { nextStatus, TERMINAL, type TripStatus } from "../rules/transitions.js";
import { sameExtras } from "../rules/priceExtras.js";
import { fixView } from "../drivers/service.js";
import { haversineKm } from "../maps/routing.js";
import { DISPATCH } from "../dispatch/engine.js";
import { afterRiderCancel, bookingRulesFor, riderCancelFee, riderFeeColumns } from "./ride.js";
import type { PricingDocument } from "../rules/fare.js";
import { applyCommand, expectVersion, lockOwnTrip, readOwnTrip } from "./commands.js";
import { startSearch, stopSearch } from "../dispatch/runtime.js";
import { tripProjection, type Viewer } from "./projection.js";

/** Trip requests, reads and the rider's cancel (contract §3, §7). */

const RIDER_REASONS: readonly string[] = (contract as unknown as { cancelReasons: { rider: string[] } }).cancelReasons.rider;
/** contract.json#dispatch.raisePrice (owner decision 25): the new fare may not pass maxFactor × the quoted fare. */
const RAISE_MAX_FACTOR: number = (contract as unknown as { dispatch: { raisePrice: { maxFactor: number } } }).dispatch.raisePrice.maxFactor;

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

/** The pricing document a quote was priced with (its version in its scope's history), or null. */
async function quotedPricing(ex: Executor, quote: { zone_id: string; pricing_version: number; pricing_scope: string | null }): Promise<PricingDocument | null> {
  const row = await ex.selectFrom("config_history").select("document").where("doc", "=", "pricing").where("zone_id", "=", quote.pricing_scope ?? quote.zone_id).where("version", "=", quote.pricing_version).executeTakeFirst();
  return (row?.document as PricingDocument | undefined) ?? null;
}

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
    quotedStops.every((stop, i) => samePlace(stop, body.stops[i]!)) &&
    // v0.6.0 (§3.5): seats, airport and fixed route repeat the quote's.
    sameExtras(quote.price_extras, request as Record<string, unknown>);
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
        price_extras: JSON.stringify(quote.price_extras ?? {}),
        pricing_version: quote.pricing_version,
        pricing_scope: quote.pricing_scope,
        // v0.8.0 (contract.json#bookingSnapshot): the trip keeps every rule of booking time.
        booking_rules: JSON.stringify(await bookingRulesFor(trx, quote.zone_id, body.kind, body.categoryId, await quotedPricing(trx, quote))),
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
  const trip = await readOwnTrip(ex, tripId, who);
  return withDriverPosition(ex, trip, tripProjection(trip, who.actor));
}

const TO_PICKUP: readonly string[] = ["accepted", "driver_to_pickup"];
const ON_BOARD: readonly string[] = ["rider_onboard", "in_trip", "approaching_dropoff"];
/** Roads are longer than the straight line (the same factor as the driven distance in ride.ts). */
const ROAD_FACTOR = 1.25;

/**
 * TripProjection.driverLocation and etaSeconds (contract §2) on a read of the trip: the driver's last fix while the
 * trip has a driver and goes on (the rider's map follows the car; the rider app's Ride check watches the route),
 * and, once the trip has ended, the fix from before the end, which is where the car stopped (Ride check measures
 * it against the drop-off). A fix from after the end is the driver's own business and is never sent. The ETA is
 * the road distance to the pickup (before boarding) or to the drop-off (on board) at dispatch's pickup speed.
 */
export async function withDriverPosition(ex: Executor, trip: TripRow, projection: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!trip.driver_id) return projection;
  const fix = await ex.selectFrom("driver_locations").selectAll().where("driver_id", "=", trip.driver_id).executeTakeFirst();
  if (fix === undefined) return projection;
  const over = TERMINAL.has(trip.status as TripStatus);
  if (over && (trip.ended_at === null || fix.measured_at.getTime() > trip.ended_at.getTime())) return projection;
  const out: Record<string, unknown> = { ...projection, driverLocation: fixView(fix) };
  const target = ON_BOARD.includes(trip.status) ? (trip.dropoff as Place) : TO_PICKUP.includes(trip.status) ? (trip.pickup as Place) : null;
  if (target !== null) out["etaSeconds"] = Math.max(60, Math.round(((haversineKm(fix, target) * ROAD_FACTOR) / DISPATCH.score.pickupKmh) * 3600));
  return out;
}

/**
 * The rider raises their offer while the search is on (contract v0.5.5, §3.6, owner decision 25): the fare grows by the
 * increase as a `rider_raise` line and the whole raise goes to the driver (Movera's share is unchanged), so the drivers
 * see a better price, not Movera. Open offers are withdrawn and a new search starts in which the drivers who already
 * declined are asked again, since the price they said no to is gone.
 */
export async function raisePrice(trx: Trx, riderId: string, tripId: string, body: { expectedVersion: number; increase: { amountMinor: number; currency: string } }, now: Date): Promise<TripRow> {
  const problem = schemaProblem("RaisePriceCommand", body);
  if (problem !== null) throw badRequest(`The request is not valid: ${problem}.`, "invalid_body");
  const trip = await lockOwnTrip(trx, tripId, { actor: "rider", subjectId: riderId });
  expectVersion(trip, body.expectedVersion, "rider");
  if (nextStatus(trip.status as never, "raise_price", "rider", trip.kind) === null) {
    throw new ApiError("invalid_transition", `A rider cannot raise the offer of a trip that is ${trip.status}.`, { projection: tripProjection(trip, "rider") });
  }
  const increase = body.increase;
  if (increase.currency !== trip.currency) throw badRequest(`The raise must be in ${trip.currency}.`, "currency_mismatch");
  if (increase.amountMinor <= 0) throw badRequest("The raise must be more than nothing.", "increase_not_positive");
  const fareMinor = Number(trip.fare_minor) + increase.amountMinor;
  const booked = Number(trip.booked_fare_minor);
  if (fareMinor > booked * RAISE_MAX_FACTOR) {
    throw badRequest(`The fare can be raised to at most ${RAISE_MAX_FACTOR} times the quoted price.`, "raise_too_high");
  }
  // The offers out there carry the old price: withdrawn, and the drivers who declined it may be asked again.
  await stopSearch(trx, trip, now);
  await trx.updateTable("searches").set({ state: sql`state - 'asked'` }).where("trip_id", "=", tripId).execute();
  const lines = [...((trip.fare_lines as Array<{ code: string; amount: unknown }>) ?? []), { code: "rider_raise", amount: increase }];
  const raised = await applyCommand(trx, trip, {
    command: "raise_price",
    actor: "rider",
    now,
    set: {
      fare_minor: fareMinor,
      fare_lines: JSON.stringify(lines),
      driver_earnings_minor: Number(trip.driver_earnings_minor ?? 0) + increase.amountMinor,
      search_step: null,
      search_started_at: now,
    },
  });
  await startSearch(trx, raised, now);
  return raised;
}

/** The rider's cancel (contract §3): free before a driver accepted; after that the fee rules apply (§3, §5). */
export async function riderCancel(
  trx: Trx,
  riderId: string,
  tripId: string,
  body: { expectedVersion: number; reasonCode: string; note?: string },
  now: Date,
): Promise<TripRow> {
  if (!RIDER_REASONS.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not a rider cancel reason.`, "invalid_reason_code");
  const trip = await lockOwnTrip(trx, tripId, { actor: "rider", subjectId: riderId });
  expectVersion(trip, body.expectedVersion, "rider");
  // Only a row of the transition table may charge; anything else is refused by applyCommand below.
  const charged = nextStatus(trip.status as never, "cancel", "rider", trip.kind) === null ? null : await riderCancelFee(trx, trip, now);
  const cancellation = {
    actor: "rider",
    reasonCode: body.reasonCode,
    at: now.toISOString(),
    fee: charged,
    ...(charged ? { feeStatus: "owed" } : {}),
    ...(body.note ? { note: body.note } : {}),
  };
  // The fee is the trip's money in the same change, so the one trip_projection event shows it (§4).
  const money = charged ? await riderFeeColumns(trx, trip, charged) : {};
  const cancelled = await applyCommand(trx, trip, { command: "cancel", actor: "rider", now, set: { ...money, cancellation: JSON.stringify(cancellation), ended_by_command: "cancel", ended_at: now, search_step: null } });
  await stopSearch(trx, cancelled, now);
  await afterRiderCancel(trx, trip, cancelled, charged, now);
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

/**
 * POST /trips/{tripId}/on-the-way (contract v0.5.4, §4): the rider's "I'm on the way" reaches the driver as a
 * rider_on_the_way event with the current projection. Not a lifecycle change: status and version stay.
 */
const ON_THE_WAY_FROM = new Set(["accepted", "driver_to_pickup", "arrived"]);
export async function riderOnTheWay(trx: Trx, riderId: string, tripId: string, now: Date): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, { actor: "rider", subjectId: riderId });
  if (!ON_THE_WAY_FROM.has(trip.status)) {
    throw new ApiError("invalid_transition", "You can tell the driver once a driver is on the way.", { projection: tripProjection(trip, "rider") });
  }
  await appendTripEvent(trx, { tripId, kind: "rider_on_the_way", version: trip.version, occurredAt: now, projection: tripProjection(trip, "admin", { sequence: Number(trip.sequence) + 1 }) });
  return trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
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
