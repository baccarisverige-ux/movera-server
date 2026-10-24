import { contract } from "../contract/contract.js";
import type { Db, Trx } from "../db/db.js";
import { schemaProblem } from "../contract/schemas.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { liveDocument } from "../config/service.js";
import { zoneAt } from "../config/zoneLookup.js";
import type { LatLng, Router } from "../maps/routing.js";
import { FareError, priceFare, type FareLine, type PricingDocument } from "../rules/fare.js";

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
export type QuoteRequest = { pickup: Place; dropoff: Place; stops: Place[]; categoryIds?: string[]; kind?: "live" | "scheduled"; scheduledAt?: string; paymentMethod?: string };

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
};

export type QuoteList = { quotes: QuoteView[]; zoneId: string; serverTime: string };

export async function createQuotes(trx: Trx, deps: { router: Router }, riderId: string, request: unknown, now: Date): Promise<QuoteList> {
  const problem = schemaProblem("QuoteRequest", request);
  if (problem !== null) throw badRequest(`The quote request is not valid: ${problem}.`, "invalid_body");
  const body = request as QuoteRequest;
  const kind = body.kind ?? "live";
  if (kind === "scheduled" && body.scheduledAt === undefined) throw badRequest("A scheduled ride needs scheduledAt.", "scheduled_at_missing");

  const zone = await zoneAt(trx, body.pickup);
  // Rides start only in the open zones (owner decision 15); anywhere else is "not available here yet".
  if (zone === null || !zone.open) throw new ApiError("forbidden", "Movera is not available here yet.", { reason: "service_not_available" });
  const pricing = await liveDocument<PricingDocument>(trx, "pricing", zone.zoneId);
  if (pricing === null) throw new ApiError("unavailable", "Prices are not set for this area yet.", { reason: "pricing_not_published", retryAfterSeconds: 60 });

  const points: LatLng[] = [body.pickup, ...body.stops, body.dropoff].map((p) => ({ lat: p.lat, lng: p.lng }));
  const leg = await deps.router.route(points);
  const km = leg.distanceMeters / 1000;
  const minutes = leg.durationSeconds / 60;

  const wanted = body.categoryIds ?? Object.keys(pricing.document.categories).sort(byCatalogOrder);
  const quotes: QuoteView[] = [];
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_SECONDS * 1000);
  for (const categoryId of wanted) {
    const category = pricing.document.categories[categoryId];
    if (category === undefined || !category.enabled) {
      if (body.categoryIds !== undefined) throw badRequest(`${categoryId} is not offered here.`, "category_not_offered");
      continue;
    }
    let fare;
    try {
      // Stops are quoted with no waiting; the fare at the end adds what really happened.
      fare = priceFare(pricing.document, { categoryId, km, minutes, kind, stopWaitSeconds: body.stops.map(() => 0) });
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
        currency: fare.total.currency,
        total_minor: fare.total.amountMinor,
        fare_lines: JSON.stringify(fare.fareLines),
        driver_earnings_minor: fare.driverEarnings.amountMinor,
        pricing_version: pricing.version,
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
    });
  }
  return { quotes, zoneId: zone.zoneId, serverTime: now.toISOString() };
}

/** Sweeps quotes nobody used, a day after they expired. */
export async function sweepQuotes(db: Db, before: Date): Promise<number> {
  const result = await db.deleteFrom("quotes").where("expires_at", "<", before).where("used_at", "is", null).executeTakeFirst();
  return Number(result.numDeletedRows);
}
