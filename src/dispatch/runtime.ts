import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import { appendTripEvent, lockTrip, OFFER_EVENTS_CHANNEL, type TripRow } from "../db/tripLog.js";
import { ApiError } from "../http/errors.js";
import { newId } from "../ids.js";
import { cancelTimer, scheduleTimer, type TimerHandler } from "../jobs/timers.js";
import { liveDocument } from "../config/service.js";
import { STALE_AFTER_SECONDS } from "../drivers/service.js";
import { pickupPayMinor, type PickupPayRate } from "../rules/pickupPay.js";
import { applyCommand } from "../trips/commands.js";
import { tripProjection } from "../trips/projection.js";
import {
  busyOf,
  DISPATCH,
  dispatchKm,
  newSearch,
  planRound,
  rank,
  searchEndSec,
  startMode,
  waitingSteps,
  type Candidate,
  type Control,
  type DispatchDoc,
  type SearchState,
} from "./engine.js";

/**
 * Automatic dispatch at run time (contract v0.5.1 §3.6) on durable timers, so a restart loses nothing:
 *   dispatch_round  → expire lapsed offers, then plan and send the next round (engine.planRound)
 *   search_step     → a rider-waiting step fires (alert_admin, keep_waiting, busy)
 *   search_end      → nobody accepted in time: the trip expires
 * Lock order everywhere: trip, then offer, then driver.
 */

export const ROUND = "dispatch_round";
export const STEP = "search_step";
export const END = "search_end";

type Place = { lat: number; lng: number };
type Step = { id: string; kind: string; message: string; extraMin?: number | null; atSec: number };

const OPEN_STATUSES = ["searching", "offered"];
const PICKUP_KMH = DISPATCH.score.pickupKmh;

function localTime(zone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

async function controlOf(ex: Executor, zoneId: string): Promise<Control> {
  const row = await ex.selectFrom("dispatch_controls").select(["paused", "mode"]).where("zone_id", "=", zoneId).executeTakeFirst();
  return row ? { paused: row.paused, mode: row.mode } : { paused: false, mode: null };
}

/* ---------------------------------------------------------------- start */

/** Called in the transaction that puts a live trip into searching. */
export async function startSearch(trx: Trx, trip: TripRow, now: Date): Promise<void> {
  const live = await liveDocument<DispatchDoc>(trx, "dispatch", trip.zone_id);
  if (live === null) {
    // No published rules: nothing to dispatch with. The trip waits for an admin (alert) until it expires.
    await trx.insertInto("searches").values({ trip_id: trip.trip_id, started_at: now, start_mode: null, busy: 0, document: JSON.stringify({}), doc_version: 0, state: null, end_at: new Date(now.getTime() + 10 * 60_000), updated_at: now }).onConflict((c) => c.column("trip_id").doNothing()).execute();
    await scheduleTimer(trx, { kind: END, refId: trip.trip_id, dueAt: new Date(now.getTime() + 10 * 60_000), payload: {} });
    return;
  }
  const doc = live.document;
  const waiting = await trx.selectFrom("trips").select((eb) => eb.fn.countAll<string>().as("n")).where("zone_id", "=", trip.zone_id).where("status", "in", ["requested", "searching", "offered"]).executeTakeFirstOrThrow();
  const free = await freeDriversInZone(trx, trip.zone_id, now);
  const busy = busyOf(Number(waiting.n), free);
  const control = await controlOf(trx, trip.zone_id);
  const mode = startMode(doc, control, busy, localTime(doc.timeZone, now));
  const steps: Step[] = waitingSteps(doc).map((w) => ({ id: w.id, kind: w.kind, message: w.message, extraMin: w.extraMin ?? null, atSec: w.atSec }));
  const endAt = new Date(now.getTime() + searchEndSec(doc) * 1000);
  const values = {
    trip_id: trip.trip_id,
    started_at: now,
    start_mode: mode,
    busy,
    document: JSON.stringify(doc),
    doc_version: live.version,
    state: mode ? JSON.stringify(newSearch(mode)) : null,
    end_at: endAt,
    steps: JSON.stringify(steps),
    fired: JSON.stringify([]),
    answered: JSON.stringify([]),
    rounds: 0,
    updated_at: now,
  };
  // A trip back in searching after a driver cancel starts a new search; who was asked stays asked (§3.6).
  const previous = await trx.selectFrom("searches").select("state").where("trip_id", "=", trip.trip_id).executeTakeFirst();
  const asked = (previous?.state as SearchState | null)?.asked ?? [];
  if (mode && asked.length) values.state = JSON.stringify({ ...newSearch(mode), asked });
  await trx.insertInto("searches").values(values).onConflict((c) => c.column("trip_id").doUpdateSet(values)).execute();
  for (const step of steps) {
    await scheduleTimer(trx, { kind: STEP, refId: `${trip.trip_id}:${step.id}`, dueAt: new Date(now.getTime() + step.atSec * 1000), payload: { tripId: trip.trip_id, stepId: step.id } });
  }
  await scheduleTimer(trx, { kind: END, refId: trip.trip_id, dueAt: endAt, payload: {} });
  await scheduleTimer(trx, { kind: ROUND, refId: trip.trip_id, dueAt: now, payload: {} });
}

async function freeDriversInZone(ex: Executor, zoneId: string, now: Date): Promise<number> {
  const row = await ex
    .selectFrom("drivers")
    .innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("drivers.online_status", "=", "online")
    .where("driver_locations.zone_id", "=", zoneId)
    .where("driver_locations.received_at", ">", new Date(now.getTime() - STALE_AFTER_SECONDS * 1000))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/* ---------------------------------------------------------------- candidates */

type Pool = { candidates: Candidate[]; meta: Map<string, { km: number; etaSeconds: number; meters: number }> };

/** Drivers who may get an offer now, with what the score needs (contract §3.6; stale ones are left out, §12). */
async function candidatesFor(trx: Trx, trip: TripRow, doc: DispatchDoc, now: Date): Promise<Pool> {
  const pickup = trip.pickup as Place;
  const rows = await trx
    .selectFrom("drivers")
    .innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .select(["drivers.driver_id", "drivers.online_status", "drivers.category_ids", "drivers.zone_ids", "drivers.rating_sum", "drivers.rating_count", "drivers.last_free_at", "driver_locations.lat", "driver_locations.lng"])
    .where("drivers.account_status", "=", "active")
    .where("drivers.online_status", "in", ["online", "on_trip"])
    .where("driver_locations.received_at", ">", new Date(now.getTime() - STALE_AFTER_SECONDS * 1000))
    .execute();
  const since = new Date(now.getTime() - 30 * 24 * 3600_000);
  const pool: Pool = { candidates: [], meta: new Map() };
  for (const d of rows) {
    if (!d.zone_ids.includes(trip.zone_id)) continue;
    if (!d.category_ids.includes(trip.category_id)) continue;
    // A free driver holds at most one open Exclusive; one with a rider at most exclusiveWhileDriving.count (§3.6).
    const open = await trx.selectFrom("offers").select((eb) => eb.fn.countAll<string>().as("n")).where("driver_id", "=", d.driver_id).where("status", "=", "open").where("kind", "in", ["exclusive", "assigned"]).executeTakeFirstOrThrow();
    const active = await trx.selectFrom("trips").select(["trip_id", "status", "dropoff"]).where("driver_id", "=", d.driver_id).where("status", "in", ["accepted", "driver_to_pickup", "arrived", "rider_onboard", "in_trip", "approaching_dropoff"]).executeTakeFirst();
    if (active && !["in_trip", "approaching_dropoff"].includes(active.status)) continue;
    if (!active && Number(open.n) >= 1) continue;
    if (active && Number(open.n) >= doc.exclusiveWhileDriving.count) continue;
    const here = { lat: d.lat, lng: d.lng };
    let finishing: Candidate["finishing"];
    if (active) {
      const drop = active.dropoff as Place;
      finishing = { inMin: Math.max(0, Math.round((dispatchKm(here, drop) / PICKUP_KMH) * 60)), dropKm: dispatchKm(drop, pickup) };
    }
    const km = finishing ? finishing.dropKm : dispatchKm(here, pickup);
    const answered = await trx
      .selectFrom("offers")
      .select([sql<string>`count(*) FILTER (WHERE status = 'claimed')`.as("took"), sql<string>`count(*) FILTER (WHERE status IN ('claimed', 'declined', 'expired'))`.as("all")])
      .where("driver_id", "=", d.driver_id)
      .where("kind", "in", ["exclusive", "assigned"])
      .where("sent_at", ">", since)
      .executeTakeFirstOrThrow();
    const candidate: Candidate = {
      driverId: d.driver_id,
      km,
      categoryIds: d.category_ids,
      idleMin: d.last_free_at && !active ? (now.getTime() - d.last_free_at.getTime()) / 60_000 : 0,
      ...(d.rating_count > 0 ? { rating: d.rating_sum / d.rating_count } : {}),
      ...(Number(answered.all) > 0 ? { acceptancePct: (Number(answered.took) / Number(answered.all)) * 100 } : {}),
      ...(finishing ? { finishing } : {}),
    };
    pool.candidates.push(candidate);
    const etaSeconds = Math.max(60, Math.round((km / PICKUP_KMH) * 3600)) + (finishing ? finishing.inMin * 60 : 0);
    pool.meta.set(d.driver_id, { km, etaSeconds, meters: Math.round(km * 1000) });
  }
  return pool;
}

/* ---------------------------------------------------------------- offers */

type OfferRow = Awaited<ReturnType<typeof loadOffer>>;
async function loadOffer(ex: Executor, offerId: string, lock = false) {
  let query = ex.selectFrom("offers").selectAll().where("offer_id", "=", offerId);
  if (lock) query = query.forUpdate();
  return query.executeTakeFirst();
}

export function offerView(offer: NonNullable<OfferRow>, trip: TripRow): Record<string, unknown> {
  const money = (minor: string | number) => ({ amountMinor: Number(minor), currency: offer.currency });
  return {
    offerId: offer.offer_id,
    tripId: offer.trip_id,
    kind: offer.kind,
    status: offer.status,
    version: offer.version,
    expiresAt: offer.expires_at.toISOString(),
    fare: money(offer.fare_minor),
    driverEarnings: money(offer.driver_earnings_minor),
    ...(Number(offer.pickup_pay_minor) > 0 ? { pickupPay: money(offer.pickup_pay_minor) } : {}),
    priority: trip.priority,
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
    ...(trip.scheduled_at ? { scheduledAt: trip.scheduled_at.toISOString() } : {}),
    ...(offer.reason_code ? { reasonCode: offer.reason_code } : {}),
  };
}

/** One event on a driver's offer feed, with the next per-driver sequence (the driver row's lock orders them). */
async function feed(trx: Trx, driverId: string, kind: "offer_created" | "offer_updated" | "offer_withdrawn", offer: Record<string, unknown>, now: Date) {
  const bumped = await trx.updateTable("drivers").set({ offer_seq: sql`offer_seq + 1` }).where("driver_id", "=", driverId).returning("offer_seq").executeTakeFirstOrThrow();
  const sequence = Number(bumped.offer_seq);
  await trx.insertInto("offer_events").values({ driver_id: driverId, sequence, event_id: newId("evt", now.getTime()), kind, offer: JSON.stringify(offer), occurred_at: now }).execute();
  await sql`SELECT pg_notify(${OFFER_EVENTS_CHANNEL}, ${JSON.stringify({ driverId, sequence })})`.execute(trx);
}

/** Closes every open offer of a trip with `status` and tells each driver. */
async function closeOpenOffers(trx: Trx, trip: TripRow, status: "claimed_elsewhere" | "expired" | "withdrawn", now: Date, exceptOfferId?: string) {
  const open = await trx.selectFrom("offers").selectAll().where("trip_id", "=", trip.trip_id).where("status", "=", "open").orderBy("offer_id").forUpdate().execute();
  for (const offer of open) {
    if (offer.offer_id === exceptOfferId) continue;
    await trx.updateTable("offers").set({ status, version: offer.version + 1, answered_at: now }).where("offer_id", "=", offer.offer_id).execute();
    await feed(trx, offer.driver_id, "offer_withdrawn", offerView({ ...offer, status, version: offer.version + 1 }, trip), now);
  }
}

/* ---------------------------------------------------------------- rounds */

async function loadSearch(trx: Trx, tripId: string) {
  return trx.selectFrom("searches").selectAll().where("trip_id", "=", tripId).forUpdate().executeTakeFirst();
}

/** dispatch_round: expire what lapsed, then send the next round (or wait). */
export const roundHandler: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  await runRound(trx, timer.refId, now);
};

export async function runRound(trx: Trx, tripId: string, now: Date): Promise<void> {
  let trip = await lockTrip(trx, tripId);
  const search = await loadSearch(trx, tripId);
  if (!search || !OPEN_STATUSES.includes(trip.status)) return;

  // 1. Open offers that ran out are expired; when none is left open the trip lapses back to searching.
  const open = await trx.selectFrom("offers").selectAll().where("trip_id", "=", tripId).where("status", "=", "open").forUpdate().execute();
  for (const offer of open.filter((o) => o.expires_at.getTime() <= now.getTime())) {
    await trx.updateTable("offers").set({ status: "expired", version: offer.version + 1, answered_at: now }).where("offer_id", "=", offer.offer_id).execute();
    await feed(trx, offer.driver_id, "offer_withdrawn", offerView({ ...offer, status: "expired", version: offer.version + 1 }, trip), now);
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
    await scheduleTimer(trx, { kind: ROUND, refId: tripId, dueAt: new Date(now.getTime() + doc.radar.seconds * 1000), payload: {} });
    return;
  }
  let state = search.state as SearchState | null;
  if (state === null) {
    // The search started while the zone was paused: it starts its steps now that offers may go out.
    const mode = startMode(doc, control, Number(search.busy), localTime(doc.timeZone, now));
    if (mode === null) return;
    state = newSearch(mode);
  }
  const pool = await candidatesFor(trx, trip, doc, now);
  const planned = planRound(doc, state, rank(doc, pool.candidates, trip.category_id));
  await trx.updateTable("searches").set({ state: JSON.stringify(planned.state), rounds: search.rounds + 1, updated_at: now }).where("trip_id", "=", tripId).execute();
  const round = planned.round;
  if (round.type === "wait") {
    await scheduleTimer(trx, { kind: ROUND, refId: tripId, dueAt: new Date(Math.min(now.getTime() + round.seconds * 1000, search.end_at.getTime())), payload: {} });
    return;
  }
  const expiresAt = new Date(Math.min(now.getTime() + doc[round.kind].seconds * 1000, search.end_at.getTime()));
  const driverDoc = await liveDocument<{ pickupPay?: { offers?: Record<string, boolean>; byCategory?: Record<string, PickupPayRate> } }>(trx, "driver_app_config", trip.zone_id);
  const rate = driverDoc?.document.pickupPay?.byCategory?.[trip.category_id];
  const kinds = driverDoc?.document.pickupPay?.offers ?? {};
  const groupId = round.kind === "radar" ? newId("grp", now.getTime()) : null;
  for (const driverId of round.driverIds) {
    const meta = pool.meta.get(driverId)!;
    const pickupPay = rate ? pickupPayMinor(rate, kinds, round.kind, meta.km, meta.etaSeconds / 60) : 0;
    const offer = {
      offer_id: newId("ofr", now.getTime()),
      trip_id: tripId,
      driver_id: driverId,
      kind: round.kind,
      round: search.rounds + 1,
      group_id: groupId,
      reason_code: round.reasonCode ?? null,
      currency: trip.currency,
      fare_minor: Number(trip.fare_minor),
      driver_earnings_minor: Number(trip.driver_earnings_minor ?? 0) + pickupPay,
      pickup_pay_minor: pickupPay,
      pickup_meters: meta.meters,
      pickup_eta_seconds: meta.etaSeconds,
      sent_at: now,
      expires_at: expiresAt,
      answered_at: null,
      decline_reason: null,
    };
    await trx.insertInto("offers").values(offer).execute();
    const row = (await loadOffer(trx, offer.offer_id))!;
    await feed(trx, driverId, "offer_created", offerView(row, trip), now);
  }
  trip = await applyCommand(trx, trip, { command: "send_offer", actor: "system", now });
  await scheduleTimer(trx, { kind: ROUND, refId: tripId, dueAt: expiresAt, payload: {} });
}

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
  if (offer.version !== expectedVersion) throw staleOffer(offer, trip);
  if (offer.status !== "open" || offer.expires_at.getTime() <= now.getTime()) {
    const status = offer.status === "open" ? "expired" : offer.status;
    throw new ApiError("conflict", status === "claimed_elsewhere" ? "Another driver took this ride." : "This offer is no longer open.", { reason: `offer_${status}`, projection: offerView({ ...offer, status }, trip) });
  }
  const driver = await trx.selectFrom("drivers").selectAll().where("driver_id", "=", driverId).forUpdate().executeTakeFirstOrThrow();
  const vehicle = driver.vehicle_id ? await trx.selectFrom("vehicles").selectAll().where("vehicle_id", "=", driver.vehicle_id).executeTakeFirst() : undefined;
  await trx.updateTable("offers").set({ status: "claimed", version: offer.version + 1, answered_at: now }).where("offer_id", "=", offerId).execute();
  await closeOpenOffers(trx, trip, "claimed_elsewhere", now, offerId);
  const summary = {
    driverId,
    firstName: driver.first_name || "Driver",
    ...(driver.rating_count > 0 ? { rating: Math.round((driver.rating_sum / driver.rating_count) * 100) / 100 } : {}),
    vehicle: vehicle ? { vehicleId: vehicle.vehicle_id, make: vehicle.make, model: vehicle.model, color: vehicle.color, plate: vehicle.plate, categoryId: trip.category_id } : {},
  };
  const earnings = Number(offer.driver_earnings_minor);
  trip = await applyCommand(trx, trip, {
    command: "accept",
    actor: "driver",
    now,
    set: {
      driver_id: driverId,
      vehicle_id: driver.vehicle_id,
      accepted_at: now,
      driver_earnings_minor: earnings,
      pickup_pay_minor: Number(offer.pickup_pay_minor),
      commission_minor: Number(trip.fare_minor) - earnings,
      driver_summary: JSON.stringify(summary),
      search_step: null,
    },
  });
  await trx.updateTable("drivers").set({ online_status: "on_trip", version: driver.version + 1, updated_at: now }).where("driver_id", "=", driverId).execute();
  await endSearchTimers(trx, trip.trip_id);
  return trip;
}

/** POST /offers/{offerId}/decline: the round moves on at once when nobody else still holds it. */
export async function declineOffer(trx: Trx, driverId: string, offerId: string, expectedVersion: number, reasonCode: string | undefined, now: Date) {
  const head = await trx.selectFrom("offers").select(["trip_id", "driver_id"]).where("offer_id", "=", offerId).executeTakeFirst();
  if (!head || head.driver_id !== driverId) throw new ApiError("not_found", "No such offer.", { reason: "offer_not_found" });
  const trip = await lockTrip(trx, head.trip_id);
  const offer = (await loadOffer(trx, offerId, true))!;
  if (offer.version !== expectedVersion) throw staleOffer(offer, trip);
  if (offer.status !== "open") throw new ApiError("invalid_transition", "This offer is no longer open.", { reason: `offer_${offer.status}`, projection: offerView(offer, trip) });
  await trx.updateTable("offers").set({ status: "declined", version: offer.version + 1, answered_at: now, decline_reason: reasonCode ?? null }).where("offer_id", "=", offerId).execute();
  const declined = { ...offer, status: "declined" as const, version: offer.version + 1 };
  await feed(trx, driverId, "offer_updated", offerView(declined, trip), now);
  const left = await trx.selectFrom("offers").select((eb) => eb.fn.countAll<string>().as("n")).where("trip_id", "=", trip.trip_id).where("status", "=", "open").executeTakeFirstOrThrow();
  if (Number(left.n) === 0) await scheduleTimer(trx, { kind: ROUND, refId: trip.trip_id, dueAt: now, payload: {} });
  return offerView(declined, trip);
}

/* ---------------------------------------------------------------- rider-waiting steps and the end */

async function endSearchTimers(trx: Trx, tripId: string) {
  await cancelTimer(trx, ROUND, tripId);
  await cancelTimer(trx, END, tripId);
  await trx.deleteFrom("timers").where("kind", "=", STEP).where("ref_id", "like", `${tripId}:%`).execute();
}

/** A trip that leaves the search some other way (rider cancel, admin cancel): offers withdrawn, timers gone. */
export async function stopSearch(trx: Trx, trip: TripRow, now: Date): Promise<void> {
  await closeOpenOffers(trx, trip, "withdrawn", now);
  await endSearchTimers(trx, trip.trip_id);
}

/** Puts the step on the rider's projection without a version change (contract.json#dispatch.searchStep). */
async function showStep(trx: Trx, trip: TripRow, step: Step, now: Date) {
  const searchStep = { id: step.id, kind: step.kind, message: step.message, extraMin: step.extraMin ?? null, at: now.toISOString() };
  await trx.updateTable("trips").set({ search_step: JSON.stringify(searchStep) }).where("trip_id", "=", trip.trip_id).execute();
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  const sequence = Number(updated.sequence) + 1;
  await appendTripEvent(trx, { tripId: trip.trip_id, kind: "trip_projection", version: updated.version, occurredAt: now, projection: { ...tripProjection(updated, "admin", { sequence }), searchStep } });
}

export const stepHandler: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  const { tripId, stepId } = timer.payload as { tripId: string; stepId: string };
  const trip = await lockTrip(trx, tripId);
  const search = await loadSearch(trx, tripId);
  if (!search || !OPEN_STATUSES.includes(trip.status)) return;
  const step = (search.steps as Step[]).find((s) => s.id === stepId);
  if (!step || (search.fired as string[]).includes(stepId)) return;
  await trx.updateTable("searches").set({ fired: JSON.stringify([...(search.fired as string[]), stepId]), updated_at: now }).where("trip_id", "=", tripId).execute();
  if (step.kind === "busy") {
    await showStep(trx, trip, step, now);
    await expireSearch(trx, tripId, now);
    return;
  }
  await showStep(trx, trip, step, now);
};

export const endHandler: TimerHandler = async (trx, timer) => {
  await expireSearch(trx, timer.refId, timer.firedAt);
};

async function expireSearch(trx: Trx, tripId: string, now: Date) {
  let trip = await lockTrip(trx, tripId);
  if (!OPEN_STATUSES.includes(trip.status)) return;
  await closeOpenOffers(trx, trip, "expired", now);
  trip = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  await applyCommand(trx, trip, { command: "expire", actor: "system", now, set: { ended_by_command: "expire" } });
  await endSearchTimers(trx, tripId);
}

/** POST /trips/{tripId}/keep-waiting (owner decision 24). */
export async function keepWaiting(trx: Trx, riderId: string, tripId: string, answer: "wait" | "stop", now: Date, cancel: (trip: TripRow) => Promise<TripRow>): Promise<TripRow> {
  const trip = await lockTrip(trx, tripId);
  if (trip.rider_id !== riderId) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
  const search = await loadSearch(trx, tripId);
  const step = trip.search_step as { id: string; kind: string; extraMin: number | null } | null;
  const answered = (search?.answered as string[] | undefined) ?? [];
  if (!search || !OPEN_STATUSES.includes(trip.status) || step?.kind !== "keep_waiting" || answered.includes(step.id)) {
    throw new ApiError("invalid_transition", "There is no question to answer now.", { projection: tripProjection(trip, "rider") });
  }
  await trx.updateTable("searches").set({ answered: JSON.stringify([...answered, step.id]), updated_at: now }).where("trip_id", "=", tripId).execute();
  if (answer === "stop") return cancel(trip);
  const endAt = new Date(search.end_at.getTime() + (step.extraMin ?? 0) * 60_000);
  const steps = (search.steps as Step[]).map((s) => (s.kind === "busy" && !(search.fired as string[]).includes(s.id) ? { ...s, atSec: Math.max(s.atSec, (endAt.getTime() - search.started_at.getTime()) / 1000) } : s));
  await trx.updateTable("searches").set({ end_at: endAt, steps: JSON.stringify(steps), updated_at: now }).where("trip_id", "=", tripId).execute();
  await scheduleTimer(trx, { kind: END, refId: tripId, dueAt: endAt, payload: {} });
  for (const s of steps.filter((s) => s.kind === "busy" && !(search.fired as string[]).includes(s.id))) {
    await scheduleTimer(trx, { kind: STEP, refId: `${tripId}:${s.id}`, dueAt: new Date(search.started_at.getTime() + s.atSec * 1000), payload: { tripId, stepId: s.id } });
  }
  return trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
}

export const dispatchHandlers: Record<string, TimerHandler> = { [ROUND]: roundHandler, [STEP]: stepHandler, [END]: endHandler };
