import { exclusiveOnly, smartOrder } from "../../reservations/service.js";
import type { Trx } from "../../db/db.js";
import { newId } from "../../ids.js";
import { scheduleTimer, type TimerHandler } from "../../jobs/timers.js";
import { liveDocument } from "../../config/service.js";
import { pickupPayMinor, type PickupPayRate } from "../../rules/pickupPay.js";
import { applyCommand } from "../../trips/commands.js";
import { sql } from "kysely";
import { certainWait, farDoc, farReachKm, maxPickupKm, newSearch, nobodyNew, planRound, rank, reaskLimitOf, startOf, type DispatchDoc, type SearchState } from "../engine.js";
import { ROUND, OPEN_STATUSES, lockTripNow, localTime, controlOf } from "./shared.js";
import { candidatesFrom, freeRowsAsCandidates, lockAndRecheck, poolRows, type PoolRows } from "./candidates.js";
import { exclusiveOnlyDoc } from "./start.js";
import { loadOffer, offerView, riderRatingForOffer, FeedQueue } from "./offers.js";
import { positiveSeconds } from "./adminOffers.js";
import { QUEUE_REASON, queueMayPick, queuePick } from "../../airportQueue/service.js";

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

/** `readFactsAlways` (tests only): never take the B1.29 sure-wait path, to compare it with the full read. */
export async function runRound(trx: Trx, tripId: string, now: Date, queue: FeedQueue, options: { readFactsAlways?: boolean } = {}): Promise<void> {
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
  let doc = search.document as DispatchDoc;
  let forcedNow = false;
  if (exclusiveOnly(trip, now) && (doc.radar.on || !doc.exclusive.on)) {
    // Job 1 (fix plan R9, owner BL-Q7): a booked ride whose search began before its pickup time and is still running
    // after it goes on as Exclusive offers only, from this round on (it never gets Radar again).
    doc = exclusiveOnlyDoc(doc);
    forcedNow = true;
    await trx.updateTable("searches").set({ document: JSON.stringify(doc), updated_at: now }).where("trip_id", "=", tripId).execute();
  }
  const control = await controlOf(trx, trip.zone_id);
  if (control.paused) {
    // Paused: no new offers; look again later (the waiting steps and the end keep running).
    await scheduleTimer(trx, { kind: ROUND, refId: tripId, dueAt: new Date(now.getTime() + positiveSeconds(doc.radar.seconds, 15) * 1000), payload: {} });
    return;
  }
  let state = search.state as SearchState | null;
  if (state !== null && forcedNow) {
    // Carry on where the search is, as Exclusive; a pending "both" start would send Radar, so it is dropped.
    const { pending: _pending, ...rest } = state;
    state = { ...rest, cur: "exclusive", tried: 0 };
  }
  if (state === null) {
    // The search started while the zone was paused: it starts its steps now that offers may go out.
    const start = startOf(doc, control, Number(search.busy), localTime(doc.timeZone, now));
    if (start === null) return;
    state = newSearch(start.mode, start.pending);
  }
  // v0.18.39 §63 (far rider, fix plan A2 "Proof: far rider"): a driver who let reaskLimit (admin, default 2) offers of this trip pass in
  // this search (declined, ran out; withdrawn ones do not count) is not asked again in it — one busy driver is not asked
  // forever. The counts are read from the offers table (rule 33: no server copy keeps them).
  const passedRows = await trx.selectFrom("offers").select(["driver_id", sql<string>`count(*)`.as("n")]).where("trip_id", "=", tripId).where("status", "in", ["declined", "expired"]).where("sent_at", ">=", search.started_at).groupBy("driver_id").execute();
  const passed = new Set(passedRows.map((r) => r.driver_id));
  const spent = new Set(passedRows.filter((r) => Number(r.n) >= reaskLimitOf(doc)).map((r) => r.driver_id));
  const far = farReachKm(doc);
  // A wait is radar.seconds (exclusive.seconds with Radar off), contract.json ranges radar.seconds 5–120: 0 s is not a
  // contract value and would spin the round timer, so the same guard applies (checker M2, 2026-11-01).
  const waitRound = (seconds: number) => scheduleTimer(trx, { kind: ROUND, refId: tripId, dueAt: new Date(Math.min(now.getTime() + positiveSeconds(seconds, 15) * 1000, search.end_at.getTime())), payload: {} });
  // Job 1 (fix plan R1 d): drivers beyond the widest step are never read (they are out of range for every round).
  // v0.18.39 §63: once the search took its far step (state.far), the widest step is limits.farReachKm.
  const poolFor = async (rules: DispatchDoc, read?: PoolRows) => {
    const p = await candidatesFrom(trx, trip, now, read ?? (await poolRows(trx, trip, rules, now, { reachKm: maxPickupKm(rules) })));
    return { ...p, candidates: p.candidates.filter((c) => !spent.has(c.driverId)) };
  };
  let rules = state.far && far !== null ? farDoc(doc, far) : doc;
  const box = await poolRows(trx, trip, rules, now, { reachKm: maxPickupKm(rules) });
  // B1.29 (S4-W1 recheck Q89, owner "no behaviour change"; AUDIT-S01 A5): the per-driver facts (open offers, papers,
  // driving limit, score counts, blocks, category off) can only REMOVE drivers. When the round planned on every free
  // driver of the box (less the spent ones) is a sure wait (certainWait), the real pool waits exactly the same, so it is
  // written and scheduled as below without reading them. Not taken when the far step may still come (it re-plans), a
  // driver on a trip is in the box (his km needs onTripReach), or the pickup is in an on airport queue area (queuePick).
  const boxFree = options.readFactsAlways || (!state.far && far !== null) ? null : freeRowsAsCandidates(box, now, spent);
  const sure = boxFree === null ? null : certainWait(rules, state, rank(rules, boxFree, trip.category_id));
  if (sure !== null && !(await queueMayPick(trx, trip))) {
    await trx.updateTable("searches").set({ state: JSON.stringify(sure.state), rounds: search.rounds + 1, updated_at: now }).where("trip_id", "=", tripId).execute();
    await waitRound(sure.round.seconds);
    return;
  }
  let pool = await poolFor(rules, box);
  // Owner smart assign (v0.18.19): a booked ride asks first the drivers who can arrive early.
  // v0.18.36 §60 (fix job 9, contract.json#airportQueue.dispatch): an airport pickup goes first, as an Exclusive, to the
  // first driver in the airport queue (DB order) who passed this round's filter; the round then locks and re-checks him.
  const queued = await queuePick(trx, trip, pool.candidates.map((c) => c.driverId), now);
  const queueOk = queued !== null && (await lockAndRecheck(trx, [queued.driverId], pool.bookedNext)).size === 0;
  const plan = async (r: DispatchDoc, s: SearchState) => planRound(r, s, await smartOrder(trx, trip, rank(r, pool.candidates, trip.category_id), now));
  let planned = queueOk
    ? { state, round: { type: "offer" as const, kind: "exclusive" as const, radiusKm: pool.meta.get(queued.driverId)!.km, driverIds: [queued.driverId], reasonCode: QUEUE_REASON } }
    : await plan(rules, state);
  if (!queueOk && !state.far && far !== null && nobodyNew(planned, passed)) {
    // v0.18.39 §63: the steps are used up and nobody new is inside the widest step: ONE extra step at farReachKm, and
    // the repeat rounds go on at that reach from now on (SearchState.far, stored with the trip row locked).
    rules = farDoc(doc, far);
    pool = await poolFor(rules);
    planned = await plan(rules, { ...state, repeat: true, far: true });
  }
  await trx.updateTable("searches").set({ state: JSON.stringify(planned.state), rounds: search.rounds + 1, updated_at: now }).where("trip_id", "=", tripId).execute();
  let round: typeof planned.round = planned.round;
  if (round.type === "offer" && !queueOk) {
    // Job 1 (fix plan R1 d): only the chosen drivers are locked, then checked again under the lock. One who just took
    // another trip or offer is left out; an Exclusive whose driver is gone is planned again at the next round, at once.
    const gone = await lockAndRecheck(trx, [...round.driverIds, ...(round.alsoRadar?.driverIds ?? [])], pool.bookedNext);
    if (gone.size > 0) {
      const driverIds = round.driverIds.filter((id) => !gone.has(id));
      const also = round.alsoRadar ? round.alsoRadar.driverIds.filter((id) => !gone.has(id)) : [];
      if (driverIds.length === 0 && also.length === 0) {
        await scheduleTimer(trx, { kind: ROUND, refId: tripId, dueAt: now, payload: {} });
        return;
      }
      if (driverIds.length === 0) round = { type: "offer", kind: "radar", radiusKm: round.alsoRadar!.radiusKm, driverIds: also };
      else round = { ...round, driverIds, ...(round.alsoRadar ? { alsoRadar: { ...round.alsoRadar, driverIds: also } } : {}) };
      if (round.type === "offer" && round.alsoRadar && round.alsoRadar.driverIds.length === 0) delete round.alsoRadar;
    }
  }
  if (round.type === "wait") {
    await waitRound(round.seconds);
    return;
  }
  const expiryOf = (kind: "radar" | "exclusive") => new Date(Math.min(now.getTime() + positiveSeconds(doc[kind].seconds, 15) * 1000, search.end_at.getTime()));
  const expiresAt = queueOk ? new Date(Math.min(now.getTime() + queued.offerSeconds * 1000, search.end_at.getTime())) : expiryOf(round.kind);
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
      // v0.18.33 (owner Q2 2026-11-05): a decline or miss while he is on a trip never counts against him
      // (acceptance, auto-offline run).
      driver_on_trip: pool.bookedNext.has(driverId),
    };
    await trx.insertInto("offers").values(offer).execute();
    const row = (await loadOffer(trx, offer.offer_id))!;
    queue.push(driverId, "offer_created", offerView(row, trip));
  }
  trip = await applyCommand(trx, trip, { command: "send_offer", actor: "system", now });
  await scheduleTimer(trx, { kind: ROUND, refId: tripId, dueAt: new Date(Math.min(...sends.map((x) => x.expiresAt.getTime()))), payload: {} });
}
