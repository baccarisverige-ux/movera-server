import { checkTripLength, checkWindow } from "../reservations/service.js";
import { checkMaxStops } from "../trips/onTripSettings.js";
import { contract } from "../contract/contract.js";
import type { Db, Trx } from "../db/db.js";
import { schemaProblem } from "../contract/schemas.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { liveDocument } from "../config/service.js";
import { zoneAt } from "../config/zoneLookup.js";
import { legKey, type LatLng, type RouteLeg, type Router } from "../maps/routing.js";
import { FareError, priceFare, type FareLine, type PricingDocument } from "../rules/fare.js";
import { asksSeatOutsideChildSeat, riderExtras, type PriceExtras } from "../rules/priceExtras.js";
import { airportExtras } from "../pricing/airport.js";
import { surgeFor, type DocSurge } from "../pricing/surge.js";
import { haversineKm } from "../maps/routing.js";
import { checkMinTrip, minTripMetersOf } from "./minTrip.js";

/**
 * POST /quotes (contract §3.5, §7): a price per category for one route, from the pickup zone's published pricing
 * document and the server's own route. Each quote is stored with what it was priced from, so the trip and the
 * final fare use the same numbers, and is valid for QUOTE_TTL_SECONDS.
 */

export const QUOTE_TTL_SECONDS = 300;

const SEED: readonly string[] = (contract as unknown as { categories: { seed: string[] } }).categories.seed;
/** The contract's category order (categories.seed), then any other category by id; jsonb does not keep key order. */
function byCatalogOrder(a: string, b: string): number {
  const ia = SEED.indexOf(a);
  const ib = SEED.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
  return a < b ? -1 : a > b ? 1 : 0;
}

type Place = { address?: string; lat: number; lng: number };
export type QuoteRequest = { pickup: Place; dropoff: Place; stops: Place[]; categoryIds?: string[]; kind?: "live" | "scheduled"; scheduledAt?: string; paymentMethod?: string } & PriceExtras;

export type QuoteView = {
  quoteId: string;
  categoryId: string;
  total: { amountMinor: number; currency: string };
  fareLines: FareLine[];
  expiresAt: string;
  pickup: Place;
  dropoff: Place;
  stops: Place[];
  surgeMultiplier: number;
  surge?: { multiplier: number; until?: string };
  /** v0.18.30 (contract.json#smallFixes.quotePickupTime, owner Q8): the booked pickup time; null on a live quote. */
  pickupAt: string | null;
};

export type QuoteWarning = { reason: "same_pickup_dropoff"; meters: number; limitMeters: number };
export type QuoteList = { quotes: QuoteView[]; zoneId: string; serverTime: string; warnings?: QuoteWarning[] };

/** contract.json#configDefaults.samePointWarnMeters: the owner's Q9 default. */
export const SAME_POINT_WARN_DEFAULT = 100;

/**
 * v0.18.30 (contract.json#smallFixes.samePoint, owner Q9 "Warn him but can accept booking"): the zone's
 * booking.samePointWarnMeters (driver document, admin Dispatch › Rides "Shortest ride (m)"), 0-1000, 0 = never warn.
 */
async function samePointWarnMeters(trx: Trx, zoneId: string): Promise<number> {
  const doc = await liveDocument<{ booking?: { samePointWarnMeters?: unknown } }>(trx, "driver_app_config", zoneId);
  const value = doc?.document.booking?.samePointWarnMeters;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1000 ? value : SAME_POINT_WARN_DEFAULT;
}

/** A warning (never an error) when pickup and drop-off are this close and there are no stops. */
export async function samePointWarning(trx: Trx, zoneId: string, body: Pick<QuoteRequest, "pickup" | "dropoff" | "stops">): Promise<QuoteWarning | null> {
  if (body.stops.length > 0) return null;
  const limitMeters = await samePointWarnMeters(trx, zoneId);
  if (limitMeters === 0) return null;
  const meters = Math.round(haversineKm(body.pickup, body.dropoff) * 1000);
  return meters <= limitMeters ? { reason: "same_pickup_dropoff", meters, limitMeters } : null;
}

/**
 * Fix plan rerun 2026-11-05 (proof job Q1): the road route is asked BEFORE the idempotency transaction, so a quote
 * never holds a pooled database connection while it waits up to 2.5 s for the route service (as trips/eta.ts does).
 * Only a valid request is routed (an invalid one is refused inside, as before, with no route call). The returned
 * router hands createQuotes that same leg for the same points (or the same error at the same step), so the answer,
 * the stored quote and the idempotency behaviour are unchanged; any other points still go to the real router.
 */
export async function routeBeforeTransaction(router: Router, request: unknown): Promise<Router> {
  if (schemaProblem("QuoteRequest", request) !== null) return router;
  const body = request as QuoteRequest;
  const wanted = legKey(quotePoints(body));
  const result: { leg: RouteLeg } | { error: unknown } = await router.route(quotePoints(body)).then(
    (leg) => ({ leg }),
    (error: unknown) => ({ error }),
  );
  return {
    async route(points: LatLng[]): Promise<RouteLeg> {
      if (legKey(points) !== wanted) return router.route(points);
      if ("error" in result) throw result.error;
      return result.leg;
    },
  };
}

function quotePoints(body: QuoteRequest): LatLng[] {
  return [body.pickup, ...body.stops, body.dropoff].map((p) => ({ lat: p.lat, lng: p.lng }));
}

export async function createQuotes(trx: Trx, deps: { router: Router }, riderId: string, request: unknown, now: Date): Promise<QuoteList> {
  const problem = schemaProblem("QuoteRequest", request);
  if (problem !== null) throw badRequest(`The quote request is not valid: ${problem}.`, "invalid_body");
  const body = request as QuoteRequest;
  const kind = body.kind ?? "live";
  if (kind === "scheduled" && body.scheduledAt === undefined) throw badRequest("A scheduled ride needs scheduledAt.", "scheduled_at_missing");

  const zone = await zoneAt(trx, body.pickup);
  // Rides start only in the open zones (owner decision 15); anywhere else is "not available here yet".
  if (zone === null || !zone.open) throw new ApiError("forbidden", "Movera is not available here yet.", { reason: "service_not_available" });
  // v0.18.9 (contract.json#onTrip.maxStops, owner G7 decision 5): the zone's max stops, checked by the server.
  await checkMaxStops(trx, zone.zoneId, body.stops.length);
  // v0.18.17 (contract.json#bookLater.window, owner Q1): 15 min to 90 days ahead by default, the zone's admin setting.
  if (kind === "scheduled") await checkWindow(trx, zone.zoneId, new Date(body.scheduledAt!), now);
  const pricing = await liveDocument<PricingDocument>(trx, "pricing", zone.zoneId);
  if (pricing === null) throw new ApiError("unavailable", "Prices are not set for this area yet.", { reason: "pricing_not_published", retryAfterSeconds: 60 });
  // v0.18.42 §67 (contract.json#sameAddress): a drop-off closer than the zone's minTripMeters is refused before routing.
  checkMinTrip(minTripMetersOf(pricing.document), body);

  const leg = await deps.router.route(quotePoints(body));
  const km = leg.distanceMeters / 1000;
  // v0.18.17 (contract.json#bookLater.window): the zone's longest booked ride (demo admin: 60 km).
  if (kind === "scheduled") await checkTripLength(trx, zone.zoneId, km);
  const minutes = leg.durationSeconds / 60;

  // An unpaid cash fee from an earlier trip rides along on the next price (§3.7, owner decision 7).
  // v0.18.7 (Q3, contract.json#pickupWaiting.debtByCurrency): only the fees owed in THIS zone's currency; 100 kr owed in
  // Stockholm never becomes 100 € on a Paris quote (the debt waits for the next Swedish trip).
  const owedHere = await trx
    .selectFrom("rider_fees")
    .select(["trip_id", "amount_minor"])
    .where("rider_id", "=", riderId)
    .where("status", "=", "owed")
    .where("currency", "=", pricing.document.currency)
    .orderBy("created_at")
    .orderBy("trip_id")
    .execute();
  const owed = owedHere.reduce((sum, f) => sum + Number(f.amount_minor), 0);
  const outstanding = owed > 0 ? { outstandingFee: { amountMinor: owed, currency: pricing.document.currency }, outstandingSourceTripId: owedHere[0]!.trip_id } : {};

  // v0.7.1 (§3.5, §16): the rider's fixed route; the airport fees from the airport zones (the server decides).
  const extras: PriceExtras = { ...riderExtras(body as unknown as Record<string, unknown>), ...(await airportExtras(trx, body.pickup, body.dropoff)) };
  const docSurge = (pricing.document as unknown as { surge?: DocSurge }).surge;

  const wanted = body.categoryIds ?? Object.keys(pricing.document.categories).sort(byCatalogOrder);
  const quotes: QuoteView[] = [];
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_SECONDS * 1000);
  for (const categoryId of wanted) {
    const category = pricing.document.categories[categoryId];
    if (category === undefined || !category.enabled) {
      if (body.categoryIds !== undefined) throw badRequest(`${categoryId} is not offered here.`, "category_not_offered");
      continue;
    }
    // v0.7.1: one seat fee, only on Child Seat; a seat asked for on another car type is refused.
    if (asksSeatOutsideChildSeat(body as unknown as Record<string, unknown>, categoryId)) throw badRequest(`${categoryId} has no child seat; book Child Seat.`, "seat_not_offered");
    // The surge in force now: the manual surge, else the highest planned window, else smart surge.
    const surge = await surgeFor(trx, zone.zoneId, docSurge, categoryId, now);
    let fare;
    try {
      // Stops are quoted with no waiting; the fare at the end adds what really happened.
      fare = priceFare(pricing.document, { categoryId, km, minutes, kind, stopWaitSeconds: body.stops.map(() => 0), surgeMultiplier: surge.multiplier, ...extras, ...outstanding });
    } catch (error) {
      if (error instanceof FareError) throw new ApiError("unavailable", "Prices for this area are not usable right now.", { reason: "pricing_invalid" });
      throw error;
    }
    const quoteId = newId("qte", now.getTime());
    await trx
      .insertInto("quotes")
      .values({
        quote_id: quoteId,
        rider_id: riderId,
        zone_id: zone.zoneId,
        category_id: categoryId,
        kind,
        scheduled_at: body.scheduledAt ?? null,
        pickup: JSON.stringify(body.pickup),
        dropoff: JSON.stringify(body.dropoff),
        stops: JSON.stringify(body.stops),
        distance_meters: leg.distanceMeters,
        duration_seconds: leg.durationSeconds,
        route_source: leg.source,
        surge_multiplier: fare.surgeMultiplier,
        price_extras: JSON.stringify(extras),
        currency: fare.total.currency,
        total_minor: fare.total.amountMinor,
        fare_lines: JSON.stringify(fare.fareLines),
        driver_earnings_minor: fare.driverEarnings.amountMinor,
        pricing_version: pricing.version,
        pricing_scope: pricing.scope,
        payment_method: body.paymentMethod ?? null,
        expires_at: expiresAt,
        used_at: null,
        created_at: now,
      })
      .execute();
    quotes.push({
      quoteId,
      categoryId,
      total: fare.total,
      fareLines: fare.fareLines,
      expiresAt: expiresAt.toISOString(),
      pickup: body.pickup,
      dropoff: body.dropoff,
      stops: body.stops,
      surgeMultiplier: fare.surgeMultiplier,
      pickupAt: kind === "scheduled" ? new Date(body.scheduledAt!).toISOString() : null,
      ...(fare.surgeMultiplier > 1 ? { surge: { multiplier: fare.surgeMultiplier, ...(surge.until ? { until: surge.until } : {}) } } : {}),
    });
  }
  const warning = await samePointWarning(trx, zone.zoneId, body);
  return { quotes, zoneId: zone.zoneId, serverTime: now.toISOString(), ...(warning ? { warnings: [warning] } : {}) };
}

/** Sweeps quotes nobody used, a day after they expired. */
export async function sweepQuotes(db: Db, before: Date): Promise<number> {
  const result = await db.deleteFrom("quotes").where("expires_at", "<", before).where("used_at", "is", null).executeTakeFirst();
  return Number(result.numDeletedRows);
}
