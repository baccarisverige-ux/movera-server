import { smartOrder } from "../../reservations/service.js";
import type { Trx } from "../../db/db.js";
import { newId } from "../../ids.js";
import { scheduleTimer, type TimerHandler } from "../../jobs/timers.js";
import { liveDocument } from "../../config/service.js";
import { pickupPayMinor, type PickupPayRate } from "../../rules/pickupPay.js";
import { applyCommand } from "../../trips/commands.js";
import { newSearch, planRound, rank, startOf, type DispatchDoc, type SearchState } from "../engine.js";
import { ROUND, OPEN_STATUSES, lockTripNow, localTime, controlOf } from "./shared.js";
import { candidatesFor } from "./candidates.js";
import { loadOffer, offerView, riderRatingForOffer, FeedQueue } from "./offers.js";
import { positiveSeconds } from "./adminOffers.js";

/* ---------------------------------------------------------------- rounds */

export async function loadSearch(trx: Trx, tripId: string) {
  return trx.selectFrom("searches").selectAll().where("trip_id", "=", tripId).forUpdate().executeTakeFirst();
}

/** dispatch_round: expire what lapsed, then send the next round (or wait). */
export const roundHandler: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  const queue = new FeedQueue();
  await runRound(trx, timer.refId, now, queue);
  await queue.flush(trx, now);
};

export async function runRound(trx: Trx, tripId: string, now: Date, queue: FeedQueue): Promise<void> {
  const locked = await lockTripNow(trx, tripId);
  if (!locked) return;
  let trip = locked;
  const search = await loadSearch(trx, tripId);
  if (!search || !OPEN_STATUSES.includes(trip.status)) return;

  // 1. Open offers that ran out are expired; when none is left open the trip lapses back to searching.
  const open = await trx.selectFrom("offers").selectAll().where("trip_id", "=", tripId).where("status", "=", "open").forUpdate().execute();
  for (const offer of open.filter((o) => o.expires_at.getTime() <= now.getTime())) {
    await trx.updateTable("offers").set({ status: "expired", version: offer.version + 1, answered_at: now }).where("offer_id", "=", offer.offer_id).execute();
    queue.push(offer.driver_id, "offer_withdrawn", offerView({ ...offer, status: "expired", version: offer.version + 1 }, trip));
  }
  const stillOpen = open.filter((o) => o.expires_at.getTime() > now.getTime());
  if (stillOpen.length > 0) {
    const next = new Date(Math.min(...stillOpen.map((o) => o.expires_at.getTime())));
    await scheduleTimer(trx, { kind: ROUND, refId: tripId, dueAt: next, payload: {} });
    return;
  }
  if (trip.status === "offered") trip = await applyCommand(trx, trip, { command: "offer_lapsed", actor: "system", now });

  // 2. The next round, unless the search is over, paused, or has no rules.
  if (now.getTime() >= search.end_at.getTime() || search.doc_version === 0) return;
  const doc = search.document as DispatchDoc;
  const control = await controlOf(trx, trip.zone_id);
  if (control.paused) {
    // Paused: no new offers; look again later (the waiting steps and the end keep running).
    await scheduleTimer(trx, { kind: ROUND, refId: tripId, dueAt: new Date(now.getTime() + positiveSeconds(doc.radar.seconds, 15) * 1000), payload: {} });
    return;
  }
  let state = search.state as SearchState | null;
  if (state === null) {
    // The search started while the zone was paused: it starts its steps now that offers may go out.
    const start = startOf(doc, control, Number(search.busy), localTime(doc.timeZone, now));
    if (start === null) return;
    state = newSearch(start.mode, start.pending);
  }
  const pool = await candidatesFor(trx, trip, doc, now);
  // Owner smart assign (v0.18.19): a booked ride asks first the drivers who can arrive early.
  const planned = planRound(doc, state, await smartOrder(trx, trip, rank(doc, pool.candidates, trip.category_id), now));
  await trx.updateTable("searches").set({ state: JSON.stringify(planned.state), rounds: search.rounds + 1, updated_at: now }).where("trip_id", "=", tripId).execute();
  const round = planned.round;
  if (round.type === "wait") {
    // A wait is radar.seconds (exclusive.seconds with Radar off), contract.json ranges radar.seconds 5–120: 0 s is not a
    // contract value and would spin the round timer, so the same guard applies (checker M2, 2026-11-01).
    await scheduleTimer(trx, { kind: ROUND, refId: tripId, dueAt: new Date(Math.min(now.getTime() + positiveSeconds(round.seconds, 15) * 1000, search.end_at.getTime())), payload: {} });
    return;
  }
  const expiryOf = (kind: "radar" | "exclusive") => new Date(Math.min(now.getTime() + positiveSeconds(doc[kind].seconds, 15) * 1000, search.end_at.getTime()));
  const expiresAt = expiryOf(round.kind);
  const driverDoc = await liveDocument<{ pickupPay?: { offers?: Record<string, boolean>; byCategory?: Record<string, PickupPayRate> } }>(trx, "driver_app_config", trip.zone_id);
  const rate = driverDoc?.document.pickupPay?.byCategory?.[trip.category_id];
  const kinds = driverDoc?.document.pickupPay?.offers ?? {};
  const riderRating = await riderRatingForOffer(trx, trip);
  // v0.18.9 start "both": the Exclusive offer and a Radar round to the next drivers go out together; the first accept
  // wins and acceptOffer withdraws every other open offer (claimed_elsewhere).
  const sends: Array<{ kind: "radar" | "exclusive"; driverIds: string[]; reasonCode: string | null; expiresAt: Date; groupId: string | null }> = [
    { kind: round.kind, driverIds: round.driverIds, reasonCode: round.reasonCode ?? null, expiresAt, groupId: round.kind === "radar" ? newId("grp", now.getTime()) : null },
  ];
  if (round.alsoRadar) sends.push({ kind: "radar", driverIds: round.alsoRadar.driverIds, reasonCode: null, expiresAt: expiryOf("radar"), groupId: newId("grp", now.getTime()) });
  for (const send of sends) for (const driverId of send.driverIds) {
    const meta = pool.meta.get(driverId)!;
    const pickupPay = rate ? pickupPayMinor(rate, kinds, send.kind, meta.km, meta.etaSeconds / 60) : 0;
    const offer = {
      offer_id: newId("ofr", now.getTime()),
      trip_id: tripId,
      driver_id: driverId,
      kind: send.kind,
      round: search.rounds + 1,
      group_id: send.groupId,
      reason_code: send.reasonCode,
      currency: trip.currency,
      fare_minor: Number(trip.fare_minor),
      // Pickup pay is Movera's, on top of the driver's share: the card shows fare + pickupPay (§3.2).
      driver_earnings_minor: Number(trip.driver_earnings_minor ?? 0),
      pickup_pay_minor: pickupPay,
      pickup_meters: meta.meters,
      pickup_eta_seconds: meta.etaSeconds,
      sent_at: now,
      expires_at: send.expiresAt,
      answered_at: null,
      decline_reason: null,
      rider_rating: riderRating,
    };
    await trx.insertInto("offers").values(offer).execute();
    const row = (await loadOffer(trx, offer.offer_id))!;
    queue.push(driverId, "offer_created", offerView(row, trip));
  }
  trip = await applyCommand(trx, trip, { command: "send_offer", actor: "system", now });
  await scheduleTimer(trx, { kind: ROUND, refId: tripId, dueAt: new Date(Math.min(...sends.map((x) => x.expiresAt.getTime()))), payload: {} });
}
