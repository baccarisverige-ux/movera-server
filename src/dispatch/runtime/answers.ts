import { tellDriverFound, afterHeldAccept, currentTripOf, heldForLater } from "../../reservations/service.js";
import { commissionOf } from "../../rules/commission.js";
import { bonusFor, priorityFor } from "../bonusScope.js";
import { driverPhotoUrl } from "../../trips/driverPhoto.js";
import { startEta } from "../../trips/eta.js";
import type { Trx } from "../../db/db.js";
import { lockTrip, type TripRow } from "../../db/tripLog.js";
import { ApiError } from "../../http/errors.js";
import { scheduleTimer } from "../../jobs/timers.js";
import { endTripSends } from "../radarSends.js";
import { applyCommand } from "../../trips/commands.js";
import { ROUND, WITHDRAW } from "./shared.js";
import { type OfferRow, loadOffer, offerView, riderRatingForOffer, FeedQueue, closeOpenOffers } from "./offers.js";
import { endSearchTimers } from "./end.js";
import { bookedNextFits } from "./candidates.js";

/* ---------------------------------------------------------------- driver answers */

function staleOffer(offer: NonNullable<OfferRow>, trip: TripRow) {
  return new ApiError("version_mismatch", "This offer changed.", { projection: offerView(offer, trip) });
}

/** POST /offers/{offerId}/accept (contract: expectedVersion is the offer's). */
export async function acceptOffer(trx: Trx, driverId: string, offerId: string, expectedVersion: number, now: Date): Promise<TripRow> {
  const head = await trx.selectFrom("offers").select(["trip_id", "driver_id"]).where("offer_id", "=", offerId).executeTakeFirst();
  if (!head || head.driver_id !== driverId) throw new ApiError("not_found", "No such offer.", { reason: "offer_not_found" });
  let trip = await lockTrip(trx, head.trip_id);
  const offer = (await loadOffer(trx, offerId, true))!;
  // Job 1 (stress M1: 28 % of accepts got 409 version_mismatch): while an offer is OPEN its version only moves for
  // money / badge refreshes (offer_updated), never for its status — those always raise the driver's pay. An accept that
  // names an older version of a still-open offer goes through; a newer-than-real version is still refused.
  if (offer.version !== expectedVersion && !(offer.status === "open" && expectedVersion < offer.version)) throw staleOffer(offer, trip);
  if (offer.status !== "open" || offer.expires_at.getTime() <= now.getTime()) {
    const status = offer.status === "open" ? "expired" : offer.status;
    throw new ApiError("conflict", status === "claimed_elsewhere" ? "Another driver took this ride." : "This offer is no longer open.", { reason: `offer_${status}`, projection: offerView({ ...offer, status }, trip) });
  }
  const queue = new FeedQueue();
  // The trip's other offers are closed first (trip → offer), then every driver to tell is locked in id order.
  await closeOpenOffers(trx, trip, "claimed_elsewhere", now, queue, offerId);
  queue.push(driverId, "offer_updated", offerView({ ...offer, status: "claimed", version: offer.version + 1 }, trip));
  await queue.flush(trx, now, [driverId]);
  const driver = await trx.selectFrom("drivers").selectAll().where("driver_id", "=", driverId).executeTakeFirstOrThrow();
  // Only an active, online driver with no trip can take one (a driver who went offline keeps no offer, §3.6).
  const busy = await currentTripOf(trx, driverId);
  // v0.18.17: an admin-assigned booked ride taken before its dispatch time is held for later (no on_trip, no ETA yet).
  // v0.18.33 (fix job 5, owner Q7, contract.json#afterTestRules.bookedNext): a driver on a trip may take a booked ride
  // offered to him as Exclusive when he still reaches it in time; it is held as his next trip (he stays on this one).
  const next = Boolean(busy) && trip.kind === "scheduled" && offer.kind === "exclusive" && driver.online_status === "on_trip" && driver.account_status === "active" && (await bookedNextFits(trx, trip, driverId, now));
  const held = next || heldForLater(trip, now);
  if (!next && (driver.account_status !== "active" || driver.online_status !== "online" || busy)) {
    throw new ApiError("conflict", busy ? "You already have a trip." : "Go online to take rides.", { reason: busy ? "driver_on_trip" : "driver_not_available", projection: offerView(offer, trip) });
  }
  await trx.updateTable("offers").set({ status: "claimed", version: offer.version + 1, answered_at: now }).where("offer_id", "=", offerId).execute();
  const vehicle = driver.vehicle_id ? await trx.selectFrom("vehicles").selectAll().where("vehicle_id", "=", driver.vehicle_id).executeTakeFirst() : undefined;
  const summary = {
    driverId,
    firstName: driver.first_name || "Driver",
    ...(driver.rating_count > 0 ? { rating: Math.round((driver.rating_sum / driver.rating_count) * 100) / 100 } : {}),
    vehicle: vehicle ? { vehicleId: vehicle.vehicle_id, make: vehicle.make, model: vehicle.model, color: vehicle.color, plate: vehicle.plate, categoryId: trip.category_id } : {},
  };
  // v0.18.5 (G2-D3): the rider's link to the driver's approved photo, only when he has one.
  const photoUrl = await driverPhotoUrl(trx, driverId, trip.trip_id, now);
  if (photoUrl) Object.assign(summary, { photoUrl });
  // v0.18.7 (Q1, contract.json#pickupWaiting.riderSummary): the rider as the driver sees him, first name + rating when the
  // zone shows ratings (the same switch as the offer card); no surname, no phone.
  const riderRow = await trx.selectFrom("riders").select("first_name").where("rider_id", "=", trip.rider_id).executeTakeFirstOrThrow();
  const riderRating = await riderRatingForOffer(trx, trip);
  const riderSummary = { firstName: riderRow.first_name || "Rider", ...(riderRating !== null ? { rating: riderRating } : {}) };
  const earnings = Number(offer.driver_earnings_minor);
  const pickupPay = Number(offer.pickup_pay_minor);
  trip = await applyCommand(trx, trip, {
    command: "accept",
    actor: "driver",
    now,
    set: {
      driver_id: driverId,
      vehicle_id: driver.vehicle_id,
      accepted_at: now,
      driver_earnings_minor: earnings,
      pickup_pay_minor: pickupPay,
      // Movera keeps fare − driverEarnings − pickupPay (§3.2).
      // The money the admin added for the kind of offer he took (owner bug 2026-11-01), not the other kind's.
      driver_bonus_minor: bonusFor(trip, offer.kind),
      priority: priorityFor(trip, offer.kind),
      commission_minor: commissionOf(Number(trip.fare_minor), trip.fare_lines, earnings, pickupPay, bonusFor(trip, offer.kind)),
      driver_summary: JSON.stringify(summary),
      rider_summary: JSON.stringify(riderSummary),
      eta: null,
      search_step: null,
      // Where the driver started from: the rider cancel "came closer" check measures against it.
      accept_pickup_meters: offer.pickup_meters,
      // v0.18.33 (owner Q7): held in the same change, so it never counts as a second current trip (trips_one_active_per_driver).
      ...(next ? { reservation: JSON.stringify({ ...((trip.reservation as Record<string, unknown> | null) ?? {}), held: true }) } : {}),
    },
  });
  // v0.18.19: a booked ride tells its rider "driver found" once per driver.
  if (trip.kind === "scheduled") await tellDriverFound(trx, trip, now);
  if (held) {
    await afterHeldAccept(trx, trip, now);
  } else {
    await trx.updateTable("drivers").set({ online_status: "on_trip", version: driver.version + 1, updated_at: now }).where("driver_id", "=", driverId).execute();
    // v0.18.7 (Q4): the server's road-route ETA starts ticking now (trips/eta.ts).
    await startEta(trx, trip.trip_id, now);
  }
  await endSearchTimers(trx, trip.trip_id);
  // v0.18.6 (G4-F4): a repeating radar-zone send ends the moment a driver takes the trip.
  await endTripSends(trx, trip.trip_id, "accepted", null, now);
  // The driver's offers for other trips are withdrawn by a job that locks each of those trips in turn.
  await scheduleTimer(trx, { kind: WITHDRAW, refId: driverId, dueAt: now, payload: {} });
  return trip;
}

/** POST /offers/{offerId}/decline: the round moves on at once when nobody else still holds it. */
export async function declineOffer(trx: Trx, driverId: string, offerId: string, expectedVersion: number, reasonCode: string | undefined, now: Date) {
  const head = await trx.selectFrom("offers").select(["trip_id", "driver_id"]).where("offer_id", "=", offerId).executeTakeFirst();
  if (!head || head.driver_id !== driverId) throw new ApiError("not_found", "No such offer.", { reason: "offer_not_found" });
  const trip = await lockTrip(trx, head.trip_id);
  const offer = (await loadOffer(trx, offerId, true))!;
  // Deep fix 2026-11-02 (live sweep M-4 "decline → 409"): a decline never needs the newest version (an Exclusive that
  // became a Radar offer moved its version under the driver's card); and an offer that is no longer open answers 200
  // with how it is now, so the card always closes.
  void expectedVersion;
  if (offer.status !== "open") return offerView(offer, trip);
  await trx.updateTable("offers").set({ status: "declined", version: offer.version + 1, answered_at: now, decline_reason: reasonCode ?? null }).where("offer_id", "=", offerId).execute();
  const declined = { ...offer, status: "declined" as const, version: offer.version + 1 };
  const queue = new FeedQueue();
  queue.push(driverId, "offer_updated", offerView(declined, trip));
  await queue.flush(trx, now);
  const left = await trx.selectFrom("offers").select((eb) => eb.fn.countAll<string>().as("n")).where("trip_id", "=", trip.trip_id).where("status", "=", "open").executeTakeFirstOrThrow();
  if (Number(left.n) === 0) await scheduleTimer(trx, { kind: ROUND, refId: trip.trip_id, dueAt: now, payload: {} });
  return offerView(declined, trip);
}
