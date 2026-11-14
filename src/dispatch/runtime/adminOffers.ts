import { driversWithCategoryOff } from "../../accounts/phoneData.js";
import { overOwesLimit, owesDetails, owesLimitOf } from "../../drivers/owes.js";
import { aheadOf, notifyOffered, currentTripOf } from "../../reservations/service.js";
import { scopeCovers, sideOfKind, type BonusScope } from "../bonusScope.js";
import type { Trx } from "../../db/db.js";
import type { TripRow } from "../../db/tripLog.js";
import { ApiError } from "../../http/errors.js";
import { newId } from "../../ids.js";
import { scheduleTimer } from "../../jobs/timers.js";
import { liveDocument } from "../../config/service.js";
import { DISPATCH_FIX_MAX_AGE_SECONDS, STALE_AFTER_SECONDS } from "../../drivers/service.js";
import { pickupPayMinor, type PickupPayRate } from "../../rules/pickupPay.js";
import { dispatchKm, type DispatchDoc } from "../engine.js";
import { ROUND, type Place, PICKUP_KMH } from "./shared.js";
import { loadOffer, offerView, riderRatingForOffer, FeedQueue } from "./offers.js";
import { loadSearch } from "./rounds.js";

/* ---------------------------------------------------------------- admin offers (§3.1) */

/** The first whole number of seconds above 0; an offer never runs on a 0 s timer. */
export function positiveSeconds(...candidates: (number | null | undefined)[]): number {
  for (const value of candidates) if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.round(value);
  return 15;
}


/**
 * Direct assign (kind assigned, one driver) or a radar group (kind radar, 1–10 drivers, one groupId), sent by an
 * admin. The caller holds the trip lock and has applied `assign`. Drivers must be active, online and free.
 * The search keeps running: its next round waits until these offers are answered or run out.
 * A chosen driver who already has an open offer for the trip keeps it (`kept`, no duplicate; the caller refreshes it
 * with the new money), and a chosen driver who cannot take a ride now is left out. Only when nobody gets or keeps an
 * offer is it a 409 (driver_on_trip / driver_not_available).
 */
export async function sendAdminOffers(trx: Trx, trip: TripRow, driverIds: string[], kind: "assigned" | "radar", now: Date, secondsOverride?: number): Promise<{ offers: Record<string, unknown>[]; kept: Record<string, unknown>[]; skipped: { driverId: string; reason: string }[]; expiresAt: Date; groupId: string | null }> {
  const driverDoc = await liveDocument<{ offers?: { radarSeconds?: number; exclusiveSeconds?: number; assignAcceptSeconds?: number }; pickupPay?: { offers?: Record<string, boolean>; byCategory?: Record<string, PickupPayRate> } }>(trx, "driver_app_config", trip.zone_id);
  const dispatchDoc = await liveDocument<DispatchDoc>(trx, "dispatch", trip.zone_id);
  const offersDoc = driverDoc?.document.offers ?? {};
  // v0.18.6 (G4-F4): a radar zone rule gives its own seconds.
  // Owner live test 2026-11-01: a document with 0 s sent an offer that expired unseen. 0 / missing / not a number
  // falls through to the next source, then the contract default (assign 30 s, radar 15 s).
  // Job 1 (fix plan L17): an offer the admin sends runs on the SAME timer as the automatic one of its kind — the zone's
  // dispatch radar.seconds / exclusive.seconds first; the app document's numbers only when the zone has no dispatch rules.
  const seconds = kind === "radar"
    ? positiveSeconds(secondsOverride, dispatchDoc?.document.radar.seconds, offersDoc.radarSeconds, 15)
    : positiveSeconds(secondsOverride, dispatchDoc?.document.exclusive.seconds, offersDoc.assignAcceptSeconds, offersDoc.exclusiveSeconds, 30);
  const search = await loadSearch(trx, trip.trip_id);
  const end = search && ["searching", "offered"].includes(trip.status) ? search.end_at.getTime() : Infinity;
  // v0.18.19 (contract.json#bookLater.liveFixes.offlineGive, live MED 7): a booked ride hours ahead may be given to an
  // offline driver; the offer stays open until the ride's search would start, and he gets a notice.
  const aheadUntil = aheadOf(trip, now);
  const expiresAt = aheadUntil ?? new Date(Math.min(now.getTime() + seconds * 1000, end));
  const rate = driverDoc?.document.pickupPay?.byCategory?.[trip.category_id];
  const kinds = driverDoc?.document.pickupPay?.offers ?? {};
  const groupId = kind === "radar" ? newId("grp", now.getTime()) : null;
  const riderRating = await riderRatingForOffer(trx, trip);
  const sorted = [...driverIds].sort();
  // Lock order: trip (held), then drivers by id.
  const rows = await trx.selectFrom("drivers").selectAll().where("driver_id", "in", sorted).orderBy("driver_id").forUpdate().execute();
  const queue = new FeedQueue();
  const made: Record<string, unknown>[] = [];
  const kept: Record<string, unknown>[] = [];
  const skipped: { driverId: string; reason: string; name: string; details?: string[] }[] = [];
  // S5 J8 (contract v0.18.84 debtModel.driverOwes.cashOffers): a pay-in-car trip skips a driver at or over the owes-limit
  // (a radar group leaves him out; a direct assign to him alone is 409 driver_owes_movera with owed / limit).
  const owing = await overOwesLimit(trx, trip, sorted);
  const owesLimit = owing.size > 0 ? (await owesLimitOf(trx, (await trx.selectFrom("zones").select("country").where("zone_id", "=", trip.zone_id).executeTakeFirst())?.country ?? null)).max : null;
  // v0.18.26 (owner 2026-11-04 "Yes, respect it"): a driver who switched the trip's category off in Ride preferences
  // is skipped here too; the admin sees the reason category_switched_off.
  const switchedOff = await driversWithCategoryOff(trx, sorted, trip.category_id);
  for (const driverId of driverIds) {
    const d = rows.find((r) => r.driver_id === driverId);
    if (!d) throw new ApiError("not_found", "No such driver.", { reason: "driver_not_found" });
    const owed = owing.get(driverId);
    if (owed !== undefined && owesLimit) {
      skipped.push({ driverId, name: d.first_name || driverId, reason: "driver_owes_movera", details: owesDetails(owed, owesLimit) });
      continue;
    }
    if (switchedOff.has(driverId)) {
      skipped.push({ driverId, name: d.first_name || driverId, reason: "category_switched_off" });
      continue;
    }
    const busy = await currentTripOf(trx, driverId);
    const fix = await trx.selectFrom("driver_locations").select(["lat", "lng", "received_at", "measured_at"]).where("driver_id", "=", driverId).executeTakeFirst();
    const fresh = fix && now.getTime() - fix.received_at.getTime() <= STALE_AFTER_SECONDS * 1000 && now.getTime() - fix.measured_at.getTime() <= DISPATCH_FIX_MAX_AGE_SECONDS * 1000;
    const already = await trx.selectFrom("offers").select("offer_id").where("trip_id", "=", trip.trip_id).where("driver_id", "=", driverId).where("status", "=", "open").where("expires_at", ">", now).executeTakeFirst();
    if (already && kind === "radar" && d.account_status === "active" && d.online_status === "online" && !busy) {
      let mine = (await loadOffer(trx, already.offer_id))!;
      if (mine.kind !== "radar") {
        // Owner bug 2026-11-01: the admin sent him Radar, so his kept automatic exclusive offer becomes a radar one and
        // shows the radar money (money is kept per kind of offer, bonusScope.ts).
        await trx.updateTable("offers").set({ kind: "radar", version: mine.version + 1 }).where("offer_id", "=", mine.offer_id).execute();
        mine = { ...mine, kind: "radar", version: mine.version + 1 };
        queue.push(driverId, "offer_updated", offerView(mine, trip));
      }
      kept.push(offerView(mine, trip));
      continue;
    }
    // Coordinator LOW (v0.18.19 offlineGive): a ride hours ahead already offered to him stays that one offer: no second
    // offer and no second notice when the admin sends it again.
    if (already && aheadUntil !== null) {
      kept.push(offerView((await loadOffer(trx, already.offer_id))!, trip));
      continue;
    }
    const offlineOk = aheadUntil !== null && d.account_status === "active" && !busy;
    if (!offlineOk && (d.account_status !== "active" || d.online_status !== "online" || busy || !fresh || (already && kind === "radar"))) {
      skipped.push({ driverId, name: d.first_name || driverId, reason: busy ? "driver_on_trip" : "driver_not_available" });
      continue;
    }
    if (already) {
      // An exclusive assign replaces the driver's open (automatic) offer: withdrawn, then the admin's exclusive one.
      const old = (await loadOffer(trx, already.offer_id, true))!;
      await trx.updateTable("offers").set({ status: "withdrawn", version: old.version + 1, answered_at: now }).where("offer_id", "=", old.offer_id).execute();
      queue.push(driverId, "offer_withdrawn", offerView({ ...old, status: "withdrawn", version: old.version + 1 }, trip));
    }
    const km = fix ? dispatchKm(fix, trip.pickup as Place) : 0;
    const etaSeconds = Math.max(60, Math.round((km / PICKUP_KMH) * 3600));
    const pickupPay = rate ? pickupPayMinor(rate, kinds, kind, km, etaSeconds / 60) : 0;
    const offer = {
      offer_id: newId("ofr", now.getTime()),
      trip_id: trip.trip_id,
      driver_id: driverId,
      kind,
      round: 0,
      source: "admin" as const,
      group_id: groupId,
      reason_code: null,
      currency: trip.currency,
      fare_minor: Number(trip.fare_minor),
      driver_earnings_minor: Number(trip.driver_earnings_minor ?? 0),
      pickup_pay_minor: pickupPay,
      pickup_meters: Math.round(km * 1000),
      pickup_eta_seconds: etaSeconds,
      sent_at: now,
      expires_at: expiresAt,
      answered_at: null,
      decline_reason: null,
      rider_rating: riderRating,
    };
    await trx.insertInto("offers").values(offer).execute();
    const view = offerView((await loadOffer(trx, offer.offer_id))!, trip);
    queue.push(driverId, "offer_created", view);
    made.push(view);
    if (aheadUntil !== null) await notifyOffered(trx, trip, driverId, now);
  }
  if (made.length === 0 && kept.length === 0) {
    const first = skipped[0]!;
    throw new ApiError("conflict", first.reason === "driver_owes_movera" ? `${first.name} owes Movera over the limit and gets no pay-in-car trips.` : `${first.name} cannot take a ride now.`, { reason: first.reason, ...(first.details ? { details: first.details } : {}) });
  }
  await queue.flush(trx, now);
  // The round timer expires these offers (and lets the search go on) when they run out.
  if (search && made.length > 0) await scheduleTimer(trx, { kind: ROUND, refId: trip.trip_id, dueAt: expiresAt, payload: {} });
  return { offers: made, kept, skipped: skipped.map(({ driverId, reason }) => ({ driverId, reason })), expiresAt, groupId };
}

/**
 * Open offers of a trip are sent again with the trip's new money (a bonus was added) — only the kinds the money is for
 * (owner bug 2026-11-01: "Exclusive" money must not show on Radar offers). Answers how many of each kind were refreshed.
 */
export async function refreshOpenOffers(trx: Trx, trip: TripRow, now: Date, scope: BonusScope = "both"): Promise<{ exclusive: number; radar: number }> {
  const all = await trx.selectFrom("offers").selectAll().where("trip_id", "=", trip.trip_id).where("status", "=", "open").where("expires_at", ">", now).orderBy("offer_id").forUpdate().execute();
  const open = all.filter((offer) => scopeCovers(scope, sideOfKind(offer.kind)));
  const queue = new FeedQueue();
  const counts = { exclusive: 0, radar: 0 };
  for (const offer of open) {
    counts[sideOfKind(offer.kind)] += 1;
    await trx.updateTable("offers").set({ version: offer.version + 1 }).where("offer_id", "=", offer.offer_id).execute();
    queue.push(offer.driver_id, "offer_updated", offerView({ ...offer, version: offer.version + 1 }, trip));
  }
  await queue.flush(trx, now);
  return counts;
}
