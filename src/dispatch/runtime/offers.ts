import { bonusFor, priorityFor } from "../bonusScope.js";
import { sql } from "kysely";
import type { Executor, Trx } from "../../db/db.js";
import { OFFER_EVENTS_CHANNEL, type TripRow } from "../../db/tripLog.js";
import { newId } from "../../ids.js";
import { liveDocument } from "../../config/service.js";
import { autoOfflineIfDue, COUNTING_KINDS, countsAsIgnored } from "../autoOffline.js";
import { queueOfferPush } from "../offerPush.js";

/* ---------------------------------------------------------------- offers */

export type OfferRow = Awaited<ReturnType<typeof loadOffer>>;
export async function loadOffer(ex: Executor, offerId: string, lock = false) {
  let query = ex.selectFrom("offers").selectAll().where("offer_id", "=", offerId);
  if (lock) query = query.forUpdate();
  return query.executeTakeFirst();
}

export function offerView(offer: NonNullable<OfferRow>, trip: TripRow): Record<string, unknown> {
  const money = (minor: string | number) => ({ amountMinor: Number(minor), currency: offer.currency });
  // A Movera bonus is inside the fare and earnings the driver sees (contract.json#adminDispatch.driverBonus).
  // Owner bug 2026-11-01: only the money (and badge) the admin added for this kind of offer (bonusScope.ts).
  const bonus = bonusFor(trip, offer.kind);
  return {
    offerId: offer.offer_id,
    tripId: offer.trip_id,
    kind: offer.kind,
    status: offer.status,
    version: offer.version,
    expiresAt: offer.expires_at.toISOString(),
    fare: money(Number(offer.fare_minor) + bonus),
    driverEarnings: money(Number(offer.driver_earnings_minor) + bonus),
    ...(bonus > 0 ? { driverBonus: money(bonus) } : {}),
    ...(Number(offer.pickup_pay_minor) > 0 ? { pickupPay: money(offer.pickup_pay_minor) } : {}),
    // v0.18.89 §90 (contract.json#priceDisplay.offer): what the driver gets = driverEarnings (bonus inside) + pickupPay, the
    // only number on the offer card; and the cash the rider pays in the car as booked (rider fare − wallet part; else 0).
    driverTotal: money(Number(offer.driver_earnings_minor) + bonus + Number(offer.pickup_pay_minor)),
    cashToCollect: money(trip.payment_method === "cash" ? Math.max(0, Number(offer.fare_minor) - Number(trip.wallet_applied_minor ?? 0)) : 0),
    priority: priorityFor(trip, offer.kind),
    source: offer.source,
    ...(offer.group_id ? { groupId: offer.group_id } : {}),
    pickup: trip.pickup,
    dropoff: trip.dropoff,
    stops: trip.stops ?? [],
    categoryId: trip.category_id,
    paymentMethod: trip.payment_method,
    pickupEtaSeconds: offer.pickup_eta_seconds,
    pickupMeters: offer.pickup_meters,
    tripSeconds: trip.duration_seconds ?? 0,
    tripMeters: trip.distance_meters ?? 0,
    // v0.18.168 (contract.json#offerRouteLine, owner 2026-11-26 "Route in driver !!"): the trip's stored Google route
    // (from its quote, no new call), so the offer card draws the road; only while the offer is open (closed offers and
    // their feed events stay small). Never in the push (offerPush.ts reads ids only).
    ...(offer.status === "open" && trip.route_polyline ? { routePolyline: trip.route_polyline } : {}),
    ...(trip.scheduled_at ? { scheduledAt: trip.scheduled_at.toISOString() } : {}),
    // v0.18.19 (owner): a booked ride's offer always carries the reservation badge flag (Exclusive and Radar alike).
    ...(trip.kind === "scheduled" ? { reservation: true } : {}),
    // v0.18.6 (G4 decision 3): the rider's real rating when the offer was sent; none without one (never made up).
    ...(offer.rider_rating !== null && offer.rider_rating !== undefined ? { riderRating: offer.rider_rating } : {}),
    // v0.18.6 (owner G4-E7 "Remove short line explain"): Offer.reasonCode is no longer sent (no "why you" line).
  };
}

/**
 * v0.18.6 (G4 decision 3, contract.json#driverOffers.riderRating): the rider's average of visible ratings, 2 decimals,
 * or null when he has none or the trip's zone switched it off (DriverAppConfig.offers.offerCard.riderRating false).
 */
export async function riderRatingForOffer(ex: Executor, trip: TripRow): Promise<number | null> {
  const doc = await liveDocument<{ offers?: { offerCard?: { riderRating?: unknown } } }>(ex, "driver_app_config", trip.zone_id);
  if (doc?.document.offers?.offerCard?.riderRating === false) return null;
  const rider = await ex.selectFrom("riders").select(["rating_sum", "rating_count"]).where("rider_id", "=", trip.rider_id).executeTakeFirst();
  if (rider === undefined || rider.rating_count <= 0) return null;
  return Math.round((rider.rating_sum / rider.rating_count) * 100) / 100;
}

type FeedKind = "offer_created" | "offer_updated" | "offer_withdrawn";

/**
 * Offer feed events of one transaction, written at its end: the driver rows are locked once, sorted by id, so two
 * transactions feeding the same drivers in another order wait instead of deadlocking. Each driver's sequence is
 * contiguous (drivers.offer_seq, bumped under that lock).
 */
export class FeedQueue {
  private readonly events: Array<{ driverId: string; kind: FeedKind; offer: Record<string, unknown> }> = [];
  push(driverId: string, kind: FeedKind, offer: Record<string, unknown>) {
    this.events.push({ driverId, kind, offer });
  }
  drivers(): string[] {
    return [...new Set(this.events.map((e) => e.driverId))].sort();
  }
  async flush(trx: Trx, now: Date, alsoLock: string[] = []): Promise<void> {
    const ids = [...new Set([...this.drivers(), ...alsoLock])].sort();
    if (ids.length === 0) return;
    await trx.selectFrom("drivers").select("driver_id").where("driver_id", "in", ids).orderBy("driver_id").forUpdate().execute();
    // v0.8.0 (contract.json#autoOffline): an expired Exclusive offer may end a run that sets the driver offline;
    // v0.18.6 (owner G4-E3 "Count them"): a hand-sent (assigned) one too. v0.18.120 (owner 2026-11-16 "It count when
    // driver ignore"): a DECLINED offer never counts, so it never runs the check (and never carries driverOffline).
    for (const e of this.events) {
      const missed = COUNTING_KINDS.includes(e.offer["kind"] as string) && countsAsIgnored(e.offer["status"]);
      if (missed && (await autoOfflineIfDue(trx, e.driverId, e.offer["tripId"] as string, now))) e.offer = { ...e.offer, driverOffline: true };
    }
    for (const e of this.events) {
      const bumped = await trx.updateTable("drivers").set({ offer_seq: sql`offer_seq + 1` }).where("driver_id", "=", e.driverId).returning("offer_seq").executeTakeFirstOrThrow();
      const sequence = Number(bumped.offer_seq);
      await trx.insertInto("offer_events").values({ driver_id: e.driverId, sequence, event_id: newId("evt", now.getTime()), kind: e.kind, offer: JSON.stringify(e.offer), occurred_at: now }).execute();
      await sql`SELECT pg_notify(${OFFER_EVENTS_CHANNEL}, ${JSON.stringify({ driverId: e.driverId, sequence })})`.execute(trx);
      // v0.18.6 (G4 decision 1, E6): a new offer also goes as a push (sound + vibration for Exclusive / assigned, Radar quiet).
      if (e.kind === "offer_created") await queueOfferPush(trx, e.driverId, e.offer, now);
    }
    this.events.length = 0;
  }
}

/** Closes every open offer of a trip with `status` and tells each driver. */
export async function closeOpenOffers(trx: Trx, trip: TripRow, status: "claimed_elsewhere" | "expired" | "withdrawn", now: Date, queue: FeedQueue, exceptOfferId?: string) {
  const open = await trx.selectFrom("offers").selectAll().where("trip_id", "=", trip.trip_id).where("status", "=", "open").orderBy("offer_id").forUpdate().execute();
  for (const offer of open) {
    if (offer.offer_id === exceptOfferId) continue;
    await trx.updateTable("offers").set({ status, version: offer.version + 1, answered_at: now }).where("offer_id", "=", offer.offer_id).execute();
    queue.push(offer.driver_id, "offer_withdrawn", offerView({ ...offer, status, version: offer.version + 1 }, trip));
  }
}
