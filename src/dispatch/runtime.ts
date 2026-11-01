import { driverPerformance, scoreInputs } from "../drivers/performance.js";
import { driverPhotoUrl } from "../trips/driverPhoto.js";
import { etaHandler, startEta } from "../trips/eta.js";
import { EstimateRouter } from "../maps/routing.js";
import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import { appendTripEvent, lockTrip, OFFER_EVENTS_CHANNEL, type TripRow } from "../db/tripLog.js";
import { ApiError } from "../http/errors.js";
import { newId } from "../ids.js";
import { cancelTimer, scheduleTimer, TimerBusy, type TimerHandler } from "../jobs/timers.js";
import { liveDocument } from "../config/service.js";
import { autoOfflineIfDue, COUNTING_KINDS } from "./autoOffline.js";
import { queueOfferPush } from "./offerPush.js";
import { endTripSends } from "./radarSends.js";
import { DISPATCH_FIX_MAX_AGE_SECONDS, STALE_AFTER_SECONDS } from "../drivers/service.js";
import { zoneChecker } from "../drivers/presence.js";
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
  startOf,
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
/** Withdraws a driver's open offers after they took another trip or went offline (one trip lock at a time). */
export const WITHDRAW = "withdraw_driver_offers";

type Place = { lat: number; lng: number };
type Step = { id: string; kind: string; message: string; extraMin?: number | null; atSec: number };

const OPEN_STATUSES = ["searching", "offered"];
const PICKUP_KMH = DISPATCH.score.pickupKmh;
/** At most this many open Radar offers per driver (DriverAppConfig.offers.radarApp.full default, §3.3). */
const RADAR_LIST_MAX = 8;

/** Timer handlers lock the trip without waiting: a command holding it may be waiting on this very timer. */
export async function lockTripNow(trx: Trx, tripId: string): Promise<TripRow | undefined> {
  try {
    return await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).forUpdate().noWait().executeTakeFirst();
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") throw new TimerBusy(`trip ${tripId} is busy`);
    throw error;
  }
}

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
  const start = startOf(doc, control, busy, localTime(doc.timeZone, now));
  const mode = start?.mode ?? null;
  const steps: Step[] = waitingSteps(doc).map((w) => ({ id: w.id, kind: w.kind, message: w.message, extraMin: w.extraMin ?? null, atSec: w.atSec }));
  const endAt = new Date(now.getTime() + searchEndSec(doc) * 1000);
  const values = {
    trip_id: trip.trip_id,
    started_at: now,
    start_mode: mode,
    busy,
    document: JSON.stringify(doc),
    doc_version: live.version,
    state: start ? JSON.stringify(newSearch(start.mode, start.pending)) : null,
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
  if (start && asked.length) values.state = JSON.stringify({ ...newSearch(start.mode, start.pending), asked });
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
    .where("driver_locations.measured_at", ">", new Date(now.getTime() - DISPATCH_FIX_MAX_AGE_SECONDS * 1000))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/* ---------------------------------------------------------------- candidates */

type Pool = { candidates: Candidate[]; meta: Map<string, { km: number; etaSeconds: number; meters: number }> };

/** v0.18.9: of `zoneIds`, those with the same country and currency as `zoneId` (neighbours never cross a border). */
async function sameCountryZones(trx: Trx, zoneId: string, zoneIds: string[]): Promise<string[]> {
  const home = await trx.selectFrom("zones").select(["country", "currency"]).where("zone_id", "=", zoneId).executeTakeFirst();
  if (!home) return [];
  const rows = await trx.selectFrom("zones").select("zone_id").where("zone_id", "in", zoneIds).where("country", "=", home.country).where("currency", "=", home.currency).execute();
  return rows.map((r) => r.zone_id);
}

/** Drivers who may get an offer now, with what the score needs (contract §3.6; stale ones are left out, §12). */
async function candidatesFor(trx: Trx, trip: TripRow, doc: DispatchDoc, now: Date): Promise<Pool> {
  const pickup = trip.pickup as Place;
  // Lock the online drivers in id order before counting their open offers, so two rounds at once (two server
  // instances) cannot both give one free driver an Exclusive (lock order: trip, offers, then drivers by id).
  await trx.selectFrom("drivers").select("driver_id").where("account_status", "=", "active").where("online_status", "=", "online").orderBy("driver_id").forUpdate().execute();
  const rows = await trx
    .selectFrom("drivers")
    .innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .select(["drivers.driver_id", "drivers.online_status", "drivers.category_ids", "drivers.zone_ids", "drivers.rating_sum", "drivers.rating_count", "drivers.last_free_at", "driver_locations.lat", "driver_locations.lng"])
    .where("drivers.account_status", "=", "active")
    .where("drivers.online_status", "in", ["online", "on_trip"])
    .where("driver_locations.received_at", ">", new Date(now.getTime() - STALE_AFTER_SECONDS * 1000))
    .where("driver_locations.measured_at", ">", new Date(now.getTime() - DISPATCH_FIX_MAX_AGE_SECONDS * 1000))
    .execute();
  const pool: Pool = { candidates: [], meta: new Map() };
  // v0.18.4 (G3-R2): only a driver whose latest position is inside one of his own zones gets offers.
  const insideOwn = await zoneChecker(trx, [...new Set(rows.flatMap((r) => r.zone_ids))]);
  // v0.18.9: with neighbours on, drivers of the listed zones are candidates too (the engine asks them from afterStep).
  // Only zones of the same country and currency as the trip zone may lend drivers (a SE zone never borrows FR).
  const listed = doc.neighbours?.on ? doc.neighbours.zoneIds.filter((z) => z !== trip.zone_id) : [];
  const neighbourZones = listed.length ? await sameCountryZones(trx, trip.zone_id, listed) : [];
  for (const d of rows) {
    const own = d.zone_ids.includes(trip.zone_id);
    const neighbour = !own && d.zone_ids.some((z) => neighbourZones.includes(z));
    if (!own && !neighbour) continue;
    if (!insideOwn({ lat: d.lat, lng: d.lng }, d.zone_ids)) continue;
    // A driver who cancelled this trip is not offered it again.
    if (trip.cancelled_driver_ids.includes(d.driver_id)) continue;
    if (!d.category_ids.includes(trip.category_id)) continue;
    // A free driver holds at most one open Exclusive; one with a rider at most exclusiveWhileDriving.count (§3.6).
    const open = await trx.selectFrom("offers").select((eb) => eb.fn.countAll<string>().as("n")).where("driver_id", "=", d.driver_id).where("status", "=", "open").where("kind", "in", ["exclusive", "assigned"]).executeTakeFirstOrThrow();
    const active = await trx.selectFrom("trips").select(["trip_id", "status", "dropoff"]).where("driver_id", "=", d.driver_id).where("status", "in", ["accepted", "driver_to_pickup", "arrived", "rider_onboard", "in_trip", "approaching_dropoff"]).executeTakeFirst();
    // Next trips (an offer to a driver who still has a rider) are a later round (owner decision 10): only free
    // drivers get offers in the test week.
    if (active || d.online_status !== "online") continue;
    if (Number(open.n) >= 1) continue;
    const radarOpen = await trx.selectFrom("offers").select((eb) => eb.fn.countAll<string>().as("n")).where("driver_id", "=", d.driver_id).where("status", "=", "open").where("kind", "=", "radar").executeTakeFirstOrThrow();
    if (Number(radarOpen.n) >= RADAR_LIST_MAX) continue;
    const here = { lat: d.lat, lng: d.lng };
    const km = dispatchKm(here, pickup);
    const candidate: Candidate = {
      driverId: d.driver_id,
      km,
      categoryIds: d.category_ids,
      ...(neighbour ? { neighbour: true } : {}),
      idleMin: d.last_free_at ? (now.getTime() - d.last_free_at.getTime()) / 60_000 : 0,
      // v0.18.4 (G3-D2): the driver's real numbers (contract.json#driverHome.performance); a null one is left out
      // and the engine uses the §3.6 default.
      ...scoreInputs(await driverPerformance(trx, d.driver_id, now)),
    };
    pool.candidates.push(candidate);
    const etaSeconds = Math.max(60, Math.round((km / PICKUP_KMH) * 3600));
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
  // A Movera bonus is inside the fare and earnings the driver sees (contract.json#adminDispatch.driverBonus).
  const bonus = Number(trip.driver_bonus_minor ?? 0);
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
    // v0.8.0 (contract.json#autoOffline): a declined or expired Exclusive offer may end a run that sets the driver offline;
    // v0.18.6 (owner G4-E3 "Count them"): a hand-sent (assigned) one too.
    for (const e of this.events) {
      const missed = COUNTING_KINDS.includes(e.offer["kind"] as string) && (e.offer["status"] === "declined" || e.offer["status"] === "expired");
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
async function closeOpenOffers(trx: Trx, trip: TripRow, status: "claimed_elsewhere" | "expired" | "withdrawn", now: Date, queue: FeedQueue, exceptOfferId?: string) {
  const open = await trx.selectFrom("offers").selectAll().where("trip_id", "=", trip.trip_id).where("status", "=", "open").orderBy("offer_id").forUpdate().execute();
  for (const offer of open) {
    if (offer.offer_id === exceptOfferId) continue;
    await trx.updateTable("offers").set({ status, version: offer.version + 1, answered_at: now }).where("offer_id", "=", offer.offer_id).execute();
    queue.push(offer.driver_id, "offer_withdrawn", offerView({ ...offer, status, version: offer.version + 1 }, trip));
  }
}

/* ---------------------------------------------------------------- rounds */

async function loadSearch(trx: Trx, tripId: string) {
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
  const planned = planRound(doc, state, rank(doc, pool.candidates, trip.category_id));
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

/* ---------------------------------------------------------------- admin offers (§3.1) */

/** The first whole number of seconds above 0; an offer never runs on a 0 s timer. */
export function positiveSeconds(...candidates: (number | null | undefined)[]): number {
  for (const value of candidates) if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.round(value);
  return 15;
}

const ASSIGNED_TRIP = ["accepted", "driver_to_pickup", "arrived", "rider_onboard", "in_trip", "approaching_dropoff"];

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
  const seconds = kind === "radar"
    ? positiveSeconds(secondsOverride, offersDoc.radarSeconds, dispatchDoc?.document.radar.seconds, 15)
    : positiveSeconds(secondsOverride, offersDoc.assignAcceptSeconds, offersDoc.exclusiveSeconds, dispatchDoc?.document.exclusive.seconds, 30);
  const search = await loadSearch(trx, trip.trip_id);
  const end = search && ["searching", "offered"].includes(trip.status) ? search.end_at.getTime() : Infinity;
  const expiresAt = new Date(Math.min(now.getTime() + seconds * 1000, end));
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
  const skipped: { driverId: string; reason: string; name: string }[] = [];
  for (const driverId of driverIds) {
    const d = rows.find((r) => r.driver_id === driverId);
    if (!d) throw new ApiError("not_found", "No such driver.", { reason: "driver_not_found" });
    const busy = await trx.selectFrom("trips").select("trip_id").where("driver_id", "=", driverId).where("status", "in", ASSIGNED_TRIP).executeTakeFirst();
    const fix = await trx.selectFrom("driver_locations").select(["lat", "lng", "received_at", "measured_at"]).where("driver_id", "=", driverId).executeTakeFirst();
    const fresh = fix && now.getTime() - fix.received_at.getTime() <= STALE_AFTER_SECONDS * 1000 && now.getTime() - fix.measured_at.getTime() <= DISPATCH_FIX_MAX_AGE_SECONDS * 1000;
    const already = await trx.selectFrom("offers").select("offer_id").where("trip_id", "=", trip.trip_id).where("driver_id", "=", driverId).where("status", "=", "open").where("expires_at", ">", now).executeTakeFirst();
    if (already && kind === "radar" && d.account_status === "active" && d.online_status === "online" && !busy) {
      kept.push(offerView((await loadOffer(trx, already.offer_id))!, trip));
      continue;
    }
    if (d.account_status !== "active" || d.online_status !== "online" || busy || !fresh || (already && kind === "radar")) {
      skipped.push({ driverId, name: d.first_name || driverId, reason: busy ? "driver_on_trip" : "driver_not_available" });
      continue;
    }
    if (already) {
      // An exclusive assign replaces the driver's open (automatic) offer: withdrawn, then the admin's exclusive one.
      const old = (await loadOffer(trx, already.offer_id, true))!;
      await trx.updateTable("offers").set({ status: "withdrawn", version: old.version + 1, answered_at: now }).where("offer_id", "=", old.offer_id).execute();
      queue.push(driverId, "offer_withdrawn", offerView({ ...old, status: "withdrawn", version: old.version + 1 }, trip));
    }
    const km = dispatchKm(fix!, trip.pickup as Place);
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
  }
  if (made.length === 0 && kept.length === 0) {
    const first = skipped[0]!;
    throw new ApiError("conflict", `${first.name} cannot take a ride now.`, { reason: first.reason });
  }
  await queue.flush(trx, now);
  // The round timer expires these offers (and lets the search go on) when they run out.
  if (search && made.length > 0) await scheduleTimer(trx, { kind: ROUND, refId: trip.trip_id, dueAt: expiresAt, payload: {} });
  return { offers: made, kept, skipped: skipped.map(({ driverId, reason }) => ({ driverId, reason })), expiresAt, groupId };
}

/** Open offers of a trip are sent again with the trip's new money (a bonus was added). */
export async function refreshOpenOffers(trx: Trx, trip: TripRow, now: Date): Promise<void> {
  const open = await trx.selectFrom("offers").selectAll().where("trip_id", "=", trip.trip_id).where("status", "=", "open").where("expires_at", ">", now).orderBy("offer_id").forUpdate().execute();
  const queue = new FeedQueue();
  for (const offer of open) {
    await trx.updateTable("offers").set({ version: offer.version + 1 }).where("offer_id", "=", offer.offer_id).execute();
    queue.push(offer.driver_id, "offer_updated", offerView({ ...offer, version: offer.version + 1 }, trip));
  }
  await queue.flush(trx, now);
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
  const queue = new FeedQueue();
  // The trip's other offers are closed first (trip → offer), then every driver to tell is locked in id order.
  await closeOpenOffers(trx, trip, "claimed_elsewhere", now, queue, offerId);
  queue.push(driverId, "offer_updated", offerView({ ...offer, status: "claimed", version: offer.version + 1 }, trip));
  await queue.flush(trx, now, [driverId]);
  const driver = await trx.selectFrom("drivers").selectAll().where("driver_id", "=", driverId).executeTakeFirstOrThrow();
  // Only an active, online driver with no trip can take one (a driver who went offline keeps no offer, §3.6).
  const busy = await trx.selectFrom("trips").select("trip_id").where("driver_id", "=", driverId).where("status", "in", ["accepted", "driver_to_pickup", "arrived", "rider_onboard", "in_trip", "approaching_dropoff"]).executeTakeFirst();
  if (driver.account_status !== "active" || driver.online_status !== "online" || busy) {
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
      commission_minor: Number(trip.fare_minor) - earnings - pickupPay - Number(trip.driver_bonus_minor ?? 0),
      driver_summary: JSON.stringify(summary),
      rider_summary: JSON.stringify(riderSummary),
      eta: null,
      search_step: null,
      // Where the driver started from: the rider cancel "came closer" check measures against it.
      accept_pickup_meters: offer.pickup_meters,
    },
  });
  await trx.updateTable("drivers").set({ online_status: "on_trip", version: driver.version + 1, updated_at: now }).where("driver_id", "=", driverId).execute();
  // v0.18.7 (Q4): the server's road-route ETA starts ticking now (trips/eta.ts).
  await startEta(trx, trip.trip_id, now);
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
  if (offer.version !== expectedVersion) throw staleOffer(offer, trip);
  if (offer.status !== "open") throw new ApiError("invalid_transition", "This offer is no longer open.", { reason: `offer_${offer.status}`, projection: offerView(offer, trip) });
  await trx.updateTable("offers").set({ status: "declined", version: offer.version + 1, answered_at: now, decline_reason: reasonCode ?? null }).where("offer_id", "=", offerId).execute();
  const declined = { ...offer, status: "declined" as const, version: offer.version + 1 };
  const queue = new FeedQueue();
  queue.push(driverId, "offer_updated", offerView(declined, trip));
  await queue.flush(trx, now);
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
  const queue = new FeedQueue();
  await closeOpenOffers(trx, trip, "withdrawn", now, queue);
  await queue.flush(trx, now);
  await endSearchTimers(trx, trip.trip_id);
  await endTripSends(trx, trip.trip_id, "trip_over", null, now);
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
  const trip = await lockTripNow(trx, tripId);
  if (!trip) return;
  const search = await loadSearch(trx, tripId);
  if (!search || !OPEN_STATUSES.includes(trip.status)) return;
  const step = (search.steps as Step[]).find((s) => s.id === stepId);
  if (!step || (search.fired as string[]).includes(stepId)) return;
  // Only busy ends the search at its own time; any other step at or after the end never shows.
  if (step.kind !== "busy" && now.getTime() >= search.end_at.getTime()) return;
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
  const locked = await lockTripNow(trx, tripId);
  if (!locked || !OPEN_STATUSES.includes(locked.status)) return;
  let trip = locked;
  const queue = new FeedQueue();
  await closeOpenOffers(trx, trip, "expired", now, queue);
  await queue.flush(trx, now);
  trip = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  await applyCommand(trx, trip, { command: "expire", actor: "system", now, set: { ended_by_command: "expire" } });
  await endSearchTimers(trx, tripId);
  await endTripSends(trx, tripId, "search_ended", null, now);
}

/** POST /trips/{tripId}/keep-waiting (owner decision 24). */
export async function keepWaiting(trx: Trx, riderId: string, tripId: string, answer: "wait" | "stop", now: Date, cancel: (trip: TripRow) => Promise<TripRow>, expectedVersion?: number): Promise<TripRow> {
  const trip = await lockTrip(trx, tripId);
  if (trip.rider_id !== riderId) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
  if (expectedVersion !== undefined && expectedVersion !== trip.version) {
    throw new ApiError("version_mismatch", "The trip changed since you last saw it.", { projection: tripProjection(trip, "rider") });
  }
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

/** Closes a driver's open offers on other trips, one trip at a time (trip → offer → driver). */
export const withdrawHandler: TimerHandler = async (trx, timer) => {
  const driverId = timer.refId;
  const now = timer.firedAt;
  const open = await trx.selectFrom("offers").select(["offer_id", "trip_id"]).where("driver_id", "=", driverId).where("status", "=", "open").orderBy("trip_id").execute();
  const queue = new FeedQueue();
  for (const { trip_id } of open) {
    const trip = await lockTripNow(trx, trip_id);
    if (!trip) continue;
    const offers = await trx.selectFrom("offers").selectAll().where("trip_id", "=", trip_id).where("driver_id", "=", driverId).where("status", "=", "open").forUpdate().execute();
    for (const offer of offers) {
      await trx.updateTable("offers").set({ status: "withdrawn", version: offer.version + 1, answered_at: now }).where("offer_id", "=", offer.offer_id).execute();
      queue.push(driverId, "offer_withdrawn", offerView({ ...offer, status: "withdrawn", version: offer.version + 1 }, trip));
    }
    const left = await trx.selectFrom("offers").select((eb) => eb.fn.countAll<string>().as("n")).where("trip_id", "=", trip_id).where("status", "=", "open").executeTakeFirstOrThrow();
    if (Number(left.n) === 0 && trip.status === "offered") await scheduleTimer(trx, { kind: ROUND, refId: trip_id, dueAt: now, payload: {} });
  }
  await queue.flush(trx, now);
};

// v0.18.7: the ETA tick booked at accept rides with the dispatch handlers (straight-line estimate here; main.ts sets the
// server's real router over it, [TRIP_ETA]: etaHandler(router)).
export const dispatchHandlers: Record<string, TimerHandler> = { [ROUND]: roundHandler, [STEP]: stepHandler, [END]: endHandler, [WITHDRAW]: withdrawHandler, // "trip_eta" spelled out and the handler made on first use: trips/eta.ts imports this module, so when eta.ts loads
// first (main.ts), TRIP_ETA is not initialised yet while this line runs (Render deploy of 48e587e crashed on it).
  trip_eta: (trx, timer) => etaHandler(new EstimateRouter())(trx, timer) };
