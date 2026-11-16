import { blockedDriversFor } from "../blockedPairs/service.js";
import { overOwesLimit } from "../drivers/owes.js";
import { NOT_HELD } from "./view.js";
import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import { liveDocument } from "../config/service.js";
import { zoneAt } from "../config/zoneLookup.js";
import type { Executor, Trx } from "../db/db.js";
import { appendTripEvent, lockTrip, type TripRow } from "../db/tripLog.js";
import { ApiError, badRequest } from "../http/errors.js";
import { audit } from "../admin/audit.js";
import { notify } from "../notifications/service.js";
import { cancelTimer, scheduleTimer, TimerBusy, type Timer } from "../jobs/timers.js";
import { applyCommand, expectVersion } from "../trips/commands.js";
import { driverTotalOf, tripProjection } from "../trips/projection.js";
import { startEta } from "../trips/eta.js";
import { reservationView } from "./view.js";
import { EstimateRouter, haversineKm, legKey, type LatLng, type Router } from "../maps/routing.js";
import { driverPhotoUrl } from "../trips/driverPhoto.js";
import { DISPATCH, dispatchKm } from "../dispatch/engine.js";
import { commissionOf } from "../rules/commission.js";
import { TERMINAL } from "../rules/transitions.js";
import { startSearch, stopBookedNoDriver, stopSearch } from "../dispatch/runtime.js";
import { driverTimes, freeByTime, leaveAtOf, planOf, reservationSettings, rideTypeOf, windowError, type Plan, type ReservationSettings, type RideTypeKey } from "./plan.js";
import { pokeAlerts } from "../alerts/detector.js";
import { BOOKED_LATE_REASON, takeBackDecision } from "./takeBack.js";

/**
 * v0.18.17 Book later (CONTRACT.md §41, contract.json#bookLater; owner 2026-11-03 Q1–Q7). Everything a booked ride
 * (Trip.kind scheduled) does between booking and the driver heading to the pickup: the plan, the Scheduled rides
 * list, the reservation notice, the pre-pickup dispatch, the no-driver alert, the reminders, accept / release / start,
 * the rider's change, the admin's unassign / dispatch-now. Sweden, France and Tunisia alike: every number is the
 * zone's DriverAppConfig.reservations.
 */

type Lang = "sv" | "fr" | "en";
type Texts = Record<Lang, string>;
type PushKind = "reservation_new" | "reservation_popup" | "reservation_reminder" | "reservation_go_online" | "reservation_lost" | "reservation_changed" | "reservation_driver_found" | "reservation_no_driver" | "reservation_change_ask" | "reservation_unassigned" | "reservation_not_started" | "reservation_assigned" | "reservation_offered" | "reservation_leave_now" | "reservation_late_risk" | "reservation_taken_back" | "reservation_no_driver_found";
const BL = (contract as unknown as { bookLater: { push: { texts: Record<PushKind, { title: Texts; body: Texts }> } } }).bookLater;
const SCHEDULED_REASONS = (contract as unknown as { cancelReasons: Record<string, string[]> }).cancelReasons["scheduled"]!;
/** Statuses with no driver yet: the no-driver alert counts these. */
const NO_DRIVER = new Set(["requested", "searching", "offered"]);
const ASSIGNED = ["accepted", "driver_to_pickup", "arrived", "rider_onboard", "in_trip", "approaching_dropoff"] as const;

import { TIMER, RESERVATION_TIMER_KINDS } from "./timerKinds.js";
import { pickNoticeLanguage } from "../notifications/noticeLanguage.js";
import { heardAgainAt, outageGraceMinutes } from "../drivers/presence.js";
export { TIMER, RESERVATION_TIMER_KINDS };

/** What the trip keeps (trips.reservation). */
export type ReservationState = {
  mode: "now" | "list";
  dispatchAt: string;
  freeChangeUntil: string;
  noDriver: boolean;
  popupAt: string | null;
  openAllAt: string | null;
  popup: boolean;
  openAll: boolean;
  /** random / nearNow: the drivers picked once at booking. */
  picked: string[] | null;
  notified: string[];
  mustBeOnlineAt?: string;
  rideType?: RideTypeKey;
  /** Owner leave on time (v0.18.19). */
  leaveAt?: string;
  driveSeconds?: number;
  leaveNotified?: boolean;
  atRisk?: boolean;
  /** Checker M5: a held ride not started at its pickup time (admin alert). */
  notStarted?: boolean;
  /** v0.18.19: the drivers the rider was already told about ("driver found" once per driver). */
  toldDrivers?: string[];
  /** Checker H1: held for later (not the driver's current trip until he starts it). */
  held?: boolean;
  /** BL-Q7: the pickup time passed with no driver (admin alert). */
  overdue?: boolean;
  /** v0.18.39 §63 (P17): the server ended it, no driver found (admin alert booked_no_driver_ended). */
  noDriverFound?: boolean;
  /** BL-Q6: the rider changed a held ride; the driver answers by `until`. */
  changeAsk?: { until: string; previousAt: string } | null;
  /** v0.18.35 job 4: the server took the ride back from this driver (late); cleared when a new driver takes it. */
  takenBack?: { driverId: string; at: string } | null;
};

/**
 * v0.18.35 job 4 L6 (contract.json#bookedTakeBack.newDriverState): the fields that belong to ONE driver. When a booked
 * ride loses its driver they are cleared, so the next driver gets his own "start now" and late-risk notices.
 */
export function withoutDriverState(state: ReservationState): ReservationState {
  const { leaveAt: _leaveAt, driveSeconds: _drive, leaveNotified: _notified, atRisk: _risk, notStarted: _notStarted, ...rest } = state;
  return rest;
}

/** L6: clear the per-driver fields of a booked ride that just lost its driver (any path: give-back, cancel, take-back). */
export async function forgetDriverState(trx: Trx, tripId: string): Promise<void> {
  const row = await trx.selectFrom("trips").select(["kind", "reservation"]).where("trip_id", "=", tripId).executeTakeFirst();
  const state = row && row.kind === "scheduled" ? stateOf(row) : null;
  if (state) await saveState(trx, tripId, withoutDriverState(state));
}

export const stateOf = (trip: Pick<TripRow, "reservation">): ReservationState | null => (trip.reservation as ReservationState | null) ?? null;

/** The busy rule: a driver's current trip. A booked ride he holds for later (scheduled, accepted) is not one. */
export function currentTripOf(ex: Executor, driverId: string) {
  return ex
    .selectFrom("trips")
    .select(["trip_id", "status", "dropoff"])
    .where("driver_id", "=", driverId)
    .where("status", "in", [...ASSIGNED])
    .where(NOT_HELD)
    .executeTakeFirst();
}

/**
 * Job 1 (fix plan R1 d): currentTripOf for many drivers in one query — the drivers of `driverIds` who have a current
 * trip now (a booked ride held for later is not one).
 */
export async function driversWithCurrentTrip(ex: Executor, driverIds: string[]): Promise<Set<string>> {
  if (driverIds.length === 0) return new Set();
  const rows = await ex.selectFrom("trips").select("driver_id").where("driver_id", "in", driverIds).where("status", "in", [...ASSIGNED]).where(NOT_HELD).execute();
  return new Set(rows.map((r) => r.driver_id as string));
}

/**
 * Job 1 (fix plan R10, ledger L10): the drivers of `driverIds` for whom a live ride starting now clashes with a booked
 * ride they hold — the same smart gap as the booking list (rideTypes.normal.spareMin), always (owner Q3): the live ride
 * [now, now + drive to pickup + trip + spareMin] overlaps the booked [scheduledAt, scheduledAt + trip + spareMin].
 */
export async function driversWithClashingBooking(ex: Executor, trip: TripRow, driverIds: string[], pickupSecondsOf: (driverId: string) => number, now: Date): Promise<Set<string>> {
  if (driverIds.length === 0) return new Set();
  const s = await settingsFor(ex, trip.zone_id);
  // Owner Q3 2026-11-04: ALWAYS, whatever hideClashing says (that switch is only about the Scheduled rides list).
  const held = await ex.selectFrom("trips").select(["driver_id", "scheduled_at", "duration_seconds"]).where("driver_id", "in", driverIds).where("kind", "=", "scheduled").where("status", "=", "accepted").where("trip_id", "!=", trip.trip_id).execute();
  const spare = s.rideTypes.normal.spareMin * 60_000;
  const out = new Set<string>();
  for (const h of held) {
    if (!h.scheduled_at || !h.driver_id) continue;
    const a0 = now.getTime();
    const a1 = a0 + (pickupSecondsOf(h.driver_id) + (trip.duration_seconds ?? 0)) * 1000 + spare;
    const b0 = h.scheduled_at.getTime();
    const b1 = b0 + (h.duration_seconds ?? 0) * 1000 + spare;
    if (a0 < b1 && b0 < a1) out.add(h.driver_id);
  }
  return out;
}

export async function settingsFor(ex: Executor, zoneId: string): Promise<ReservationSettings> {
  const live = await liveDocument<{ reservations?: unknown }>(ex, "driver_app_config", zoneId);
  return reservationSettings(live?.document.reservations);
}

/** Q1: the booking window, at quote and at booking. */
export async function checkWindow(ex: Executor, zoneId: string, scheduledAt: Date, now: Date): Promise<void> {
  const s = await settingsFor(ex, zoneId);
  // Owner A (v0.18.19): booked rides switched off in the zone → refused (the rider app shows "Not available in this area yet").
  if (!s.on) throw new ApiError("forbidden", "Booked rides are not available in this area yet.", { reason: "reservations_off" });
  const error = windowError(now, scheduledAt, s);
  if (error === "booking_too_soon") throw badRequest(`Book at least ${s.minAheadMin} minutes ahead.`, error);
  if (error === "booking_too_far") throw badRequest(`Book at most ${s.maxAheadDays} days ahead.`, error);
}

/**
 * v0.18.81 B1.34 (contract.json#bookLater.riderCap, owner Q94 "A) Yes", 2026-11-13: default 3): a rider holds at most
 * maxOpenPerRider booked rides that have not ended (any zone; the limit of the zone booked). The caller holds the rider
 * row lock (FOR UPDATE), so two bookings at the same moment are counted one after the other and never both pass.
 */
export async function checkOpenBookedCap(ex: Executor, riderId: string, zoneId: string): Promise<void> {
  const s = await settingsFor(ex, zoneId);
  const row = await ex.selectFrom("trips").select((eb) => eb.fn.countAll<string>().as("n")).where("rider_id", "=", riderId).where("kind", "=", "scheduled").where("status", "not in", [...TERMINAL]).executeTakeFirst();
  if (Number(row?.n ?? 0) >= s.maxOpenPerRider) {
    throw new ApiError("conflict", `You can have at most ${s.maxOpenPerRider} booked rides. Cancel one to book another.`, { reason: "booked_rides_limit" });
  }
}

/** The demo admin's Max Trip Distance (Reservations): a booked route longer than maxTripKm is refused at quote. */
export async function checkTripLength(ex: Executor, zoneId: string, km: number): Promise<void> {
  const s = await settingsFor(ex, zoneId);
  if (s.maxTripKm !== null && km > s.maxTripKm) throw badRequest(`A booked ride can be at most ${s.maxTripKm} km.`, "trip_too_long");
}

/* ---------------------------------------------------------------- texts */

async function zoneFacts(ex: Executor, zoneId: string) {
  const zone = await ex.selectFrom("zones").select(["country", "time_zone"]).where("zone_id", "=", zoneId).executeTakeFirst();
  return { country: zone?.country ?? "SE", timeZone: zone?.time_zone ?? "Europe/Stockholm" };
}

export const clock = (at: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

async function push(ex: Executor, trip: TripRow, to: { audience: "rider" | "driver"; id: string }, kind: PushKind, now: Date, extra: Record<string, string> = {}): Promise<void> {
  const facts = await zoneFacts(ex, trip.zone_id);
  const person = to.audience === "rider"
    ? await ex.selectFrom("riders").select("language").where("rider_id", "=", to.id).executeTakeFirst()
    : await ex.selectFrom("drivers").select("language").where("driver_id", "=", to.id).executeTakeFirst();
  if (!person) return;
  // v0.18.66 §87: the one notice-language rule (the person's language, else the trip country's, TN fr, else en).
  const lang: Lang = pickNoticeLanguage(person.language, facts.country);
  const fill = (text: string) => Object.entries({ time: trip.scheduled_at ? clock(trip.scheduled_at, facts.timeZone) : "", ...extra }).reduce((t, [k, v]) => t.replaceAll(`{${k}}`, v), text).replace(/ · $/, "");
  const text = BL.push.texts[kind];
  await notify(ex, {
    audience: to.audience,
    subjectId: to.id,
    kind,
    title: fill(text.title[lang]),
    body: fill(text.body[lang]),
    deepLink: to.audience === "rider" ? `movera://trips/${trip.trip_id}` : `movera-driver://reservations/${trip.trip_id}`,
    tripId: trip.trip_id,
    // v0.18.32 (bookedRideSeen.leaveNowName): the leave-now popup shows the rider's first name.
    data: { tripId: trip.trip_id, ...(extra["riderFirstName"] !== undefined ? { riderFirstName: extra["riderFirstName"] } : {}), texts: { title: Object.fromEntries(Object.entries(text.title).map(([l, v]) => [l, fill(v)])), body: Object.fromEntries(Object.entries(text.body).map(([l, v]) => [l, fill(v)])) } },
  }, now);
}

/* ---------------------------------------------------------------- who sees it */

type Seen = { driverId: string; km: number | null };

/** contract.json#bookLater.listTo: the drivers who may take this ride from Scheduled rides, nearest first. */
export async function listedDrivers(ex: Executor, trip: TripRow, s: ReservationSettings, now: Date, options: { openAll?: boolean; onlyDriverId?: string } = {}): Promise<Seen[]> {
  const state = stateOf(trip);
  const openAll = options.openAll ?? state?.openAll ?? false;
  let query = ex
    .selectFrom("drivers")
    .leftJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .leftJoin("vehicles", "vehicles.vehicle_id", "drivers.vehicle_id")
    .select(["drivers.driver_id", "drivers.home_area", "drivers.rating_sum", "drivers.rating_count", "driver_locations.lat", "driver_locations.lng", "vehicles.category_ids as vehicle_category_ids", "vehicles.status as vehicle_status"])
    .where("drivers.account_status", "=", "active")
    .where(sql<boolean>`${trip.zone_id} = ANY(drivers.zone_ids)`)
    .where(sql<boolean>`${trip.category_id} = ANY(drivers.category_ids)`)
    // v0.18.26 (contract.json#phoneDataToServer.driverPreferences.dispatch): not to a driver who switched it off.
    .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM driver_phone_data p WHERE p.driver_id = drivers.driver_id AND ${trip.category_id} = ANY(p.categories_off))`);
  if (options.onlyDriverId) query = query.where("drivers.driver_id", "=", options.onlyDriverId);
  const rows = await query.execute();
  const pickup = trip.pickup as { lat: number; lng: number };
  // v0.18.43 §64 (fix job 10, contract.json#blockedPairs.dispatch): never listed to (nor claimable by) a blocked driver.
  const blocked = await blockedDriversFor(ex, trip.rider_id, rows.map((r) => r.driver_id));
  // S5 J8 (debtModel.driverOwes.cashOffers): a booked pay-in-car ride is not listed to (nor claimable by) a driver at or
  // over the owes-limit; a booked ride he already accepted stays his (owner 2026-11-13 15:01 "He keeps it").
  const owing = await overOwesLimit(ex, trip, rows.map((r) => r.driver_id));
  let seen = rows
    .filter((r) => !trip.cancelled_driver_ids.includes(r.driver_id) && !blocked.has(r.driver_id) && !owing.has(r.driver_id))
    .map((r) => ({ ...r, km: r.lat !== null && r.lng !== null ? dispatchKm(pickup, { lat: r.lat, lng: r.lng }) : null }));
  const rule = openAll ? "all" : s.listTo;
  if (rule === "category") seen = seen.filter((r) => r.vehicle_status === "approved" && (r.vehicle_category_ids ?? []).includes(trip.category_id));
  if (rule === "rating") seen = seen.filter((r) => r.rating_count === 0 || r.rating_sum / r.rating_count >= s.listMinRating);
  if ((rule === "random" || rule === "nearNow") && state?.picked) seen = seen.filter((r) => state.picked!.includes(r.driver_id));
  if (rule === "group") {
    const group = s.listGroupId ? await ex.selectFrom("driver_groups").select("driver_ids").where("group_id", "=", s.listGroupId).executeTakeFirst() : undefined;
    const members = new Set(group?.driver_ids ?? []);
    seen = seen.filter((r) => members.has(r.driver_id));
  }
  if (rule === "areaRegulars") {
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const counts = await ex.selectFrom("trips").select(["driver_id", (eb) => eb.fn.countAll<string>().as("n")]).where("zone_id", "=", trip.zone_id).where("status", "=", "completed").where("created_at", ">=", since).where("driver_id", "is not", null).groupBy("driver_id").execute();
    const regular = new Set(counts.filter((c) => Number(c.n) >= s.listAreaTrips).map((c) => c.driver_id));
    seen = seen.filter((r) => regular.has(r.driver_id));
  }
  // Owner BL-Q4: home nearby, the rider's favourites, near the pickup at that time.
  if (rule === "homeNear") seen = seen.filter((r) => {
    const home = r.home_area as { lat?: number; lng?: number } | null;
    return typeof home?.lat === "number" && typeof home.lng === "number" && dispatchKm(pickup, { lat: home.lat, lng: home.lng }) <= s.listHomeKm;
  });
  if (rule === "favourites") {
    const favs = new Set((await ex.selectFrom("rider_favourite_drivers").select("driver_id").where("rider_id", "=", trip.rider_id).execute()).map((f) => f.driver_id));
    seen = seen.filter((r) => favs.has(r.driver_id));
  }
  if (rule === "nearAtTime" && trip.scheduled_at) {
    const at = trip.scheduled_at.getTime();
    const held = await ex.selectFrom("trips").select(["driver_id", "scheduled_at", "duration_seconds", "dropoff"]).where("kind", "=", "scheduled").where("status", "=", "accepted").where("driver_id", "is not", null).where("trip_id", "!=", trip.trip_id).execute();
    const near = new Set(held.filter((h) => {
      if (!h.scheduled_at) return false;
      const ends = h.scheduled_at.getTime() + (h.duration_seconds ?? 0) * 1000;
      const drop = h.dropoff as { lat: number; lng: number };
      return ends <= at && ends >= at - s.listAtTimeMin * 60_000 && dispatchKm(pickup, drop) <= s.listAtTimeKm;
    }).map((h) => h.driver_id));
    seen = seen.filter((r) => near.has(r.driver_id));
  }
  if (s.hideClashing) {
    const keep: typeof seen = [];
    for (const r of seen) if (!(await clashes(ex, r.driver_id, trip, s))) keep.push(r);
    seen = keep;
  }
  return seen.sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity) || a.driver_id.localeCompare(b.driver_id)).map((r) => ({ driverId: r.driver_id, km: r.km }));
}

/** Smart gap: [scheduledAt, scheduledAt + duration + spareMin] of the two rides overlap. */
async function clashes(ex: Executor, driverId: string, trip: TripRow, s: ReservationSettings): Promise<boolean> {
  if (!trip.scheduled_at) return false;
  const held = await ex.selectFrom("trips").select(["trip_id", "scheduled_at", "duration_seconds"]).where("driver_id", "=", driverId).where("kind", "=", "scheduled").where("status", "=", "accepted").where("trip_id", "!=", trip.trip_id).execute();
  const spare = s.rideTypes.normal.spareMin * 60_000;
  const span = (at: Date, seconds: number | null) => [at.getTime(), at.getTime() + (seconds ?? 0) * 1000 + spare] as const;
  const [a0, a1] = span(trip.scheduled_at, trip.duration_seconds);
  return held.some((h) => {
    if (!h.scheduled_at) return false;
    const [b0, b1] = span(h.scheduled_at, h.duration_seconds);
    return a0 < b1 && b0 < a1;
  });
}

async function pickOnce(ex: Executor, trip: TripRow, s: ReservationSettings, now: Date): Promise<string[] | null> {
  if (s.listTo !== "random" && s.listTo !== "nearNow") return null;
  const all = await listedDrivers(ex, { ...trip, reservation: null }, { ...s, listTo: "all" }, now);
  if (s.listTo === "nearNow") return all.filter((d) => d.km !== null && d.km <= s.listNearKm).map((d) => d.driverId);
  // random: a fair shuffle, once at booking.
  const ids = all.map((d) => d.driverId);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  return ids.slice(0, s.listGroupSize);
}

/* ---------------------------------------------------------------- plan */

async function saveState(trx: Trx, tripId: string, state: ReservationState): Promise<void> {
  await trx.updateTable("trips").set({ reservation: JSON.stringify(state) }).where("trip_id", "=", tripId).execute();
}

async function clearTimers(trx: Trx, tripId: string): Promise<void> {
  await trx.deleteFrom("timers").where("kind", "in", RESERVATION_TIMER_KINDS).where((eb) => eb.or([eb("ref_id", "=", tripId), eb("ref_id", "like", `${tripId}:%`)])).execute();
}

async function clearDriverTimers(trx: Trx, tripId: string): Promise<void> {
  await trx.deleteFrom("timers").where("kind", "in", [TIMER.driverReminder, TIMER.goOnline, TIMER.offlineCheck, TIMER.leaveCheck]).where((eb) => eb.or([eb("ref_id", "=", tripId), eb("ref_id", "like", `${tripId}:%`)])).execute();
}

async function startSearchNow(trx: Trx, trip: TripRow, now: Date): Promise<TripRow> {
  if (trip.status !== "requested") return trip;
  const searching = await applyCommand(trx, trip, { command: "start_search", actor: "system", now, set: { search_started_at: now } });
  await startSearch(trx, searching, now);
  return searching;
}

/**
 * Called in the transaction that books (or changes) a scheduled trip, while it is requested. Plans the ride
 * (bookLater.plan), sends the reservation notice, books the timers; mode now starts the search at once.
 */
export async function planBookedRide(trx: Trx, trip: TripRow, now: Date): Promise<TripRow> {
  if (trip.kind !== "scheduled" || !trip.scheduled_at) return trip;
  const s = await settingsFor(trx, trip.zone_id);
  const plan: Plan = planOf(now, trip.scheduled_at, s);
  const state: ReservationState = {
    mode: plan.mode,
    dispatchAt: plan.dispatchAt.toISOString(),
    freeChangeUntil: plan.freeChangeUntil.toISOString(),
    noDriver: false,
    popupAt: plan.popupAt?.toISOString() ?? null,
    openAllAt: plan.openAllAt?.toISOString() ?? null,
    popup: false,
    openAll: false,
    picked: plan.mode === "list" ? await pickOnce(trx, trip, s, now) : null,
    notified: [],
  };
  await saveState(trx, trip.trip_id, state);
  let current = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  await clearTimers(trx, trip.trip_id);
  await scheduleTimer(trx, { kind: TIMER.noDriver, refId: trip.trip_id, dueAt: plan.noDriverAt });
  await scheduleTimer(trx, { kind: TIMER.overdue, refId: trip.trip_id, dueAt: trip.scheduled_at });
  await scheduleTimer(trx, { kind: TIMER.noDriverStop, refId: trip.trip_id, dueAt: stopAt(trip.scheduled_at, s) });
  if (plan.riderReminderAt) await scheduleTimer(trx, { kind: TIMER.riderReminder, refId: trip.trip_id, dueAt: plan.riderReminderAt });
  if (plan.mode === "now") return startSearchNow(trx, current, now);
  if (s.noticeOn) current = await sendNotice(trx, current, s, "reservation_new", now);
  if (plan.popupAt) await scheduleTimer(trx, { kind: TIMER.popup, refId: trip.trip_id, dueAt: plan.popupAt });
  if (plan.openAllAt) await scheduleTimer(trx, { kind: TIMER.openAll, refId: trip.trip_id, dueAt: plan.openAllAt });
  await scheduleTimer(trx, { kind: TIMER.dispatch, refId: trip.trip_id, dueAt: plan.dispatchAt });
  return current;
}

async function sendNotice(trx: Trx, trip: TripRow, s: ReservationSettings, kind: "reservation_new" | "reservation_popup", now: Date, options: { onlyNew?: boolean } = {}): Promise<TripRow> {
  const state = stateOf(trip)!;
  const listed = await listedDrivers(trx, trip, s, now);
  const targets = (options.onlyNew ? listed.filter((d) => !state.notified.includes(d.driverId)) : listed).slice(0, s.noticeMaxDrivers);
  for (const d of targets) await push(trx, trip, { audience: "driver", id: d.driverId }, kind, now);
  const notified = [...new Set([...state.notified, ...targets.map((d) => d.driverId)])];
  await saveState(trx, trip.trip_id, { ...state, notified, ...(kind === "reservation_popup" ? { popup: true } : {}) });
  return trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
}

/* ---------------------------------------------------------------- driver */

async function rideTypeFor(ex: Executor, trip: TripRow, s: ReservationSettings): Promise<RideTypeKey> {
  const airport = (await zoneAt(ex, trip.pickup as { lat: number; lng: number }, { kind: "airport" })) !== null || (await zoneAt(ex, trip.dropoff as { lat: number; lng: number }, { kind: "airport" })) !== null;
  return rideTypeOf(trip, airport, s);
}

async function itemOf(ex: Executor, trip: TripRow, s: ReservationSettings): Promise<Record<string, unknown>> {
  const rideType = stateOf(trip)?.rideType ?? (await rideTypeFor(ex, trip, s));
  const times = s.rideTypes[rideType];
  const at = trip.scheduled_at!;
  const online = new Date(at.getTime() - times.onlineBeforeMin * 60_000);
  return {
    tripId: trip.trip_id,
    version: trip.version,
    scheduledAt: at.toISOString(),
    categoryId: trip.category_id,
    rideType,
    pickup: trip.pickup,
    dropoff: trip.dropoff,
    stops: ((trip.stops as unknown[]) ?? []).length,
    distanceMeters: trip.distance_meters ?? 0,
    durationSeconds: trip.duration_seconds ?? 0,
    earnings: { amountMinor: Number(trip.driver_earnings_minor ?? 0), currency: trip.currency },
    // v0.18.96 BQ-M23 (contract.json#priceDisplay.bookedRide; owner s06:1164 "only how much he get", G8 Q3 "One number"):
    // what the driver gets for this booked ride = earnings + pickup pay + Movera's bonus + Movera's driver-pay change on a
    // held ride (J6 driverAdjustments, capped so never below 0); no tip before the trip. The same driverTotalOf as
    // TripProjection.driverTotal, so the row and the trip show one number. Driver view only (rider views have no
    // DriverReservation).
    driverTotal: { amountMinor: driverTotalOf(trip), currency: trip.currency },
    status: trip.status,
    mustBeOnlineAt: online.toISOString(),
    canStartAt: online.toISOString(),
    popup: stateOf(trip)?.popup ?? false,
    // Live test HIGH 2 (v0.18.19): the list row carries the reservation (changeAsk for "Keep it at the new time?",
    // leaveAt for the start countdown), as the trip read does.
    reservation: reservationView(trip, "driver"),
  };
}

/** GET /driver/reservations?scope=open|accepted (contract.json#bookLater.driver.list). */
export async function driverReservations(ex: Executor, driverId: string, scope: "open" | "accepted", now: Date): Promise<{ items: Record<string, unknown>[]; nextCursor: null }> {
  const driver = await ex.selectFrom("drivers").select("zone_ids").where("driver_id", "=", driverId).executeTakeFirstOrThrow();
  if (scope === "accepted") {
    const rows = await ex.selectFrom("trips").selectAll().where("driver_id", "=", driverId).where("kind", "=", "scheduled").where("status", "=", "accepted").orderBy("scheduled_at").execute();
    const items = [];
    // v0.18.32 (bookedRideSeen.leaveNowName): his own accepted rides carry the rider's first name for the leave-now popup.
    for (const row of rows) items.push({ ...(await itemOf(ex, row, await settingsFor(ex, row.zone_id))), riderFirstName: riderFirstNameOf(row) });
    return { items, nextCursor: null };
  }
  const zones = driver.zone_ids;
  const settings = new Map<string, ReservationSettings>();
  for (const zoneId of zones) settings.set(zoneId, await settingsFor(ex, zoneId));
  const on = zones.filter((z) => settings.get(z)!.on);
  if (zones.length > 0 && on.length === 0) throw new ApiError("forbidden", "Booked rides are off in your zone.", { reason: "reservations_off" });
  if (on.length === 0) return { items: [], nextCursor: null };
  const rows = await ex.selectFrom("trips").selectAll().where("kind", "=", "scheduled").where("status", "=", "requested").where("zone_id", "in", on).where("scheduled_at", ">", now).orderBy("scheduled_at").limit(200).execute();
  const items = [];
  for (const row of rows) {
    if (stateOf(row)?.mode !== "list") continue;
    const s = settings.get(row.zone_id)!;
    if ((await listedDrivers(ex, row, s, now, { onlyDriverId: driverId })).length === 0) continue;
    items.push(await itemOf(ex, row, s));
  }
  return { items, nextCursor: null };
}

async function lockScheduled(trx: Trx, tripId: string): Promise<TripRow> {
  const trip = await lockTrip(trx, tripId).catch(() => undefined);
  if (!trip || trip.kind !== "scheduled") throw new ApiError("not_found", "No such booked ride.", { reason: "reservation_not_open" });
  return trip;
}

/** POST /driver/reservations/{tripId}/accept: the first tap wins (contract.json#bookLater.driver.accept). */
export async function acceptReservation(trx: Trx, driverId: string, tripId: string, expectedVersion: number | undefined, now: Date): Promise<TripRow> {
  const trip = await lockScheduled(trx, tripId);
  const s = await settingsFor(trx, trip.zone_id);
  if (!s.on) throw new ApiError("forbidden", "Booked rides are off in this zone.", { reason: "reservations_off" });
  if (trip.status === "searching" || trip.status === "offered") throw new ApiError("conflict", "This ride is being sent to drivers now. It comes to you as an offer.", { reason: "reservation_in_dispatch" });
  if (trip.status !== "requested") throw new ApiError("conflict", "Another driver took this ride.", { reason: "reservation_taken" });
  if (expectedVersion !== undefined) expectVersion(trip, expectedVersion, "driver");
  const driver = await trx.selectFrom("drivers").selectAll().where("driver_id", "=", driverId).forUpdate().executeTakeFirstOrThrow();
  if (s.hideClashing && (await clashes(trx, driverId, trip, s))) throw new ApiError("conflict", "This ride is too close to another booked ride you have.", { reason: "reservation_clash" });
  if (driver.account_status !== "active" || (await listedDrivers(trx, trip, { ...s, hideClashing: false }, now, { onlyDriverId: driverId })).length === 0) {
    throw new ApiError("not_found", "This ride is not in your list.", { reason: "reservation_not_open" });
  }
  const vehicle = driver.vehicle_id ? await trx.selectFrom("vehicles").selectAll().where("vehicle_id", "=", driver.vehicle_id).executeTakeFirst() : undefined;
  const summary: Record<string, unknown> = {
    driverId,
    firstName: driver.first_name || "Driver",
    ...(driver.rating_count > 0 ? { rating: Math.round((driver.rating_sum / driver.rating_count) * 100) / 100 } : {}),
    vehicle: vehicle ? { vehicleId: vehicle.vehicle_id, make: vehicle.make, model: vehicle.model, color: vehicle.color, plate: vehicle.plate, categoryId: trip.category_id } : {},
  };
  const photoUrl = await driverPhotoUrl(trx, driverId, trip.trip_id, now);
  if (photoUrl) summary["photoUrl"] = photoUrl;
  const rider = await trx.selectFrom("riders").select("first_name").where("rider_id", "=", trip.rider_id).executeTakeFirstOrThrow();
  const rideType = await rideTypeFor(trx, trip, s);
  const times = driverTimes(now, trip.scheduled_at!, s.rideTypes[rideType], s.offlineBackupAfterMin);
  const state = stateOf(trip)!;
  const fresh = { ...withoutDriverState(state), takenBack: null, rideType, mustBeOnlineAt: times.goOnlineAt.toISOString(), held: true };
  await saveState(trx, tripId, fresh);
  const accepted = await applyCommand(trx, { ...trip, reservation: fresh }, {
    command: "accept",
    actor: "driver",
    now,
    set: { driver_id: driverId, vehicle_id: driver.vehicle_id, accepted_at: now, driver_summary: JSON.stringify(summary), rider_summary: JSON.stringify({ firstName: rider.first_name || "Rider" }), search_step: null },
  });
  for (const [index, at] of times.reminders.entries()) await scheduleTimer(trx, { kind: TIMER.driverReminder, refId: `${tripId}:${index}`, dueAt: at, payload: { tripId, driverId } });
  await scheduleTimer(trx, { kind: TIMER.goOnline, refId: tripId, dueAt: times.goOnlineAt, payload: { driverId } });
  await scheduleTimer(trx, { kind: TIMER.offlineCheck, refId: tripId, dueAt: times.offlineCheckAt, payload: { driverId } });
  await scheduleLeaveCheck(trx, tripId, trip.scheduled_at!, driverId, now);
  // Q5 rider: a message when a driver takes the ride. Owner M6-a: the driver gets an "assigned" notice.
  await tellDriverFound(trx, accepted, now);
  await push(trx, accepted, { audience: "driver", id: driverId }, "reservation_assigned", now);
  return accepted;
}

/** The driver leaves the ride (release, offline, admin unassign, rider change): back to the list, or to dispatch after dispatchAt. */
async function backToList(trx: Trx, trip: TripRow, input: { command: "cancel" | "release" | "unassign" | "reschedule"; actor: "driver" | "system" | "admin" | "rider"; now: Date; set?: Record<string, unknown> }): Promise<TripRow> {
  const back = await applyCommand(trx, trip, {
    command: input.command,
    actor: input.actor,
    now: input.now,
    set: {
      driver_id: null, vehicle_id: null, accepted_at: null, arrived_at: null, waiting: null, driver_summary: null, rider_summary: null, eta: null, heading_check: null, search_step: null,
      // S5 J6 (supervisor must-fix 1): an admin's change to the old driver's pay is his; the next driver starts from his own pay.
      driver_adjustments_minor: 0,
      ...(input.command === "cancel" || input.command === "release" ? { cancelled_driver_ids: sql<string[]>`array_append(cancelled_driver_ids, ${trip.driver_id})` } : {}),
      ...(input.set ?? {}),
    },
  });
  await clearDriverTimers(trx, trip.trip_id);
  const state = stateOf(back);
  if (state) await saveState(trx, trip.trip_id, { ...withoutDriverState(state), held: false });
  const fresh = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  if (state && Date.parse(state.dispatchAt) <= input.now.getTime()) return startSearchNow(trx, fresh, input.now);
  return fresh;
}

/** POST /driver/reservations/{tripId}/release: the driver gives the ride back (contract.json#bookLater.driver.release). */
export async function releaseReservation(trx: Trx, driverId: string, tripId: string, body: { reasonCode: string; note?: string }, now: Date): Promise<void> {
  const trip = await lockScheduled(trx, tripId);
  if (trip.driver_id !== driverId) throw new ApiError("not_found", "No such booked ride.", { reason: "reservation_not_open" });
  if (trip.status !== "accepted") throw new ApiError("invalid_transition", "Only a booked ride you hold can be given back.", { projection: tripProjection(trip, "driver") });
  if (!SCHEDULED_REASONS.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not a reason for giving back a booked ride.`, "invalid_reason_code");
  await trx.insertInto("driver_cancels").values({ trip_id: tripId, driver_id: driverId, at: now, from_status: trip.status, reason_code: body.reasonCode, note: body.note ?? null }).execute();
  await backToList(trx, trip, { command: "cancel", actor: "driver", now });
}

/** POST /driver/reservations/{tripId}/start: head to the pickup, from scheduledAt − onlineBeforeMin. */
export async function startReservation(trx: Trx, driverId: string, tripId: string, expectedVersion: number | undefined, now: Date): Promise<TripRow> {
  const trip = await lockScheduled(trx, tripId);
  if (trip.driver_id !== driverId) throw new ApiError("not_found", "No such booked ride.", { reason: "reservation_not_open" });
  if (expectedVersion !== undefined) expectVersion(trip, expectedVersion, "driver");
  const s = await settingsFor(trx, trip.zone_id);
  const rideType = stateOf(trip)?.rideType ?? (await rideTypeFor(trx, trip, s));
  const from = trip.scheduled_at!.getTime() - s.rideTypes[rideType].onlineBeforeMin * 60_000;
  if (trip.status === "accepted" && now.getTime() < from) throw new ApiError("conflict", "It is too early to start this ride.", { reason: "reservation_too_early", projection: tripProjection(trip, "driver") });
  const driver = await trx.selectFrom("drivers").selectAll().where("driver_id", "=", driverId).forUpdate().executeTakeFirstOrThrow();
  if (await currentTripOf(trx, driverId)) throw new ApiError("conflict", "Finish your current trip first.", { reason: "driver_on_trip" });
  if (driver.online_status !== "online") throw new ApiError("conflict", "Go online to start the ride.", { reason: "driver_not_available" });
  const state = stateOf(trip);
  if (state) await saveState(trx, tripId, { ...state, held: false });
  const started = await applyCommand(trx, { ...trip, reservation: state ? { ...state, held: false } : trip.reservation }, { command: "head_to_pickup", actor: "driver", now });
  await trx.updateTable("drivers").set({ online_status: "on_trip", version: driver.version + 1, updated_at: now }).where("driver_id", "=", driverId).execute();
  await startEta(trx, tripId, now);
  await cancelTimer(trx, TIMER.goOnline, tripId);
  await cancelTimer(trx, TIMER.offlineCheck, tripId);
  return started;
}

/* ---------------------------------------------------------------- rider */

/** POST /trips/{tripId}/reschedule (contract.json#bookLater.rider.change). */
export async function rescheduleTrip(trx: Trx, riderId: string, tripId: string, body: { quoteId: string; expectedVersion: number }, now: Date): Promise<TripRow> {
  const trip = await lockTrip(trx, tripId).catch(() => undefined);
  if (!trip || trip.rider_id !== riderId) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
  expectVersion(trip, body.expectedVersion, "rider");
  if (trip.kind !== "scheduled" || !trip.scheduled_at || !["requested", "accepted", "searching", "offered"].includes(trip.status)) throw new ApiError("conflict", "Only a booked ride before pickup can be changed.", { reason: "not_a_reservation", projection: tripProjection(trip, "rider") });
  const s = await settingsFor(trx, trip.zone_id);
  if (!freeByTime(now, trip.scheduled_at, s) || (trip.status !== "requested" && trip.status !== "accepted")) throw new ApiError("conflict", `A booked ride can be changed only more than ${s.freeChangeBeforeMin} minutes before pickup.`, { reason: "change_too_late", projection: tripProjection(trip, "rider") });
  const quote = await trx.selectFrom("quotes").selectAll().where("quote_id", "=", body.quoteId).forUpdate().executeTakeFirst();
  if (quote === undefined || quote.rider_id !== riderId) throw new ApiError("not_found", "No such quote.", { reason: "quote_not_found" });
  if (quote.used_at !== null) throw new ApiError("conflict", "This price was already used for a ride.", { reason: "quote_used" });
  if (quote.expires_at.getTime() <= now.getTime()) throw new ApiError("conflict", "This price expired. Ask for a new one.", { reason: "quote_expired" });
  if (quote.kind !== "scheduled" || quote.scheduled_at === null) throw badRequest("A booked ride changes to another booked time.", "quote_mismatch");
  if (quote.zone_id !== trip.zone_id) throw badRequest("The new pickup is in another area. Cancel and book again.", "quote_mismatch");
  await checkWindow(trx, quote.zone_id, quote.scheduled_at, now);
  const money = {
    pickup: JSON.stringify(quote.pickup), dropoff: JSON.stringify(quote.dropoff), stops: JSON.stringify(quote.stops ?? []), scheduled_at: quote.scheduled_at, category_id: quote.category_id,
    quote_id: quote.quote_id, quote_expires_at: quote.expires_at, fare_minor: quote.total_minor, fare_lines: JSON.stringify(quote.fare_lines), booked_fare_minor: quote.total_minor,
    driver_earnings_minor: quote.driver_earnings_minor, distance_meters: quote.distance_meters, duration_seconds: quote.duration_seconds, surge_multiplier: quote.surge_multiplier,
    price_extras: JSON.stringify(quote.price_extras ?? {}), pricing_version: quote.pricing_version, pricing_scope: quote.pricing_scope,
    commission_minor: commissionOf(Number(quote.total_minor), quote.fare_lines, Number(quote.driver_earnings_minor), 0, 0),
  };
  await trx.updateTable("quotes").set({ used_at: now }).where("quote_id", "=", quote.quote_id).execute();
  if (trip.status === "accepted" && trip.driver_id) {
    // Owner BL-Q6: the driver who holds it is asked "Keep it at the new time?"; it stays his until he says No or the time runs out.
    await trx.updateTable("trips").set({ ...money, version: trip.version + 1, updated_at: now }).where("trip_id", "=", tripId).execute();
    let changed = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    const plan = planOf(now, changed.scheduled_at!, s);
    const until = new Date(now.getTime() + s.changeAnswerMin * 60_000);
    await clearTimers(trx, tripId);
    await saveState(trx, tripId, { ...stateOf(changed)!, mode: plan.mode, dispatchAt: plan.dispatchAt.toISOString(), freeChangeUntil: plan.freeChangeUntil.toISOString(), noDriver: false, overdue: false, changeAsk: { until: until.toISOString(), previousAt: trip.scheduled_at.toISOString() } });
    changed = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    // v0.18.51 §73: a held ride rescheduled is a list change (the driver's row shows "Keep it at the new time?").
    await appendTripEvent(trx, { tripId, kind: "trip_projection", version: changed.version, occurredAt: now, projection: tripProjection(changed, "admin", { sequence: Number(changed.sequence) + 1 }), reservations: true });
    await scheduleTimer(trx, { kind: TIMER.changeAsk, refId: tripId, dueAt: until, payload: { driverId: trip.driver_id } });
    await push(trx, changed, { audience: "driver", id: trip.driver_id }, "reservation_change_ask", now);
    return changed;
  }
  const changed = await applyCommand(trx, trip, { command: "reschedule", actor: "rider", now, set: money });
  await stopSearch(trx, changed, now);
  return planBookedRide(trx, changed, now);
}

/** The driver's No (or no answer): back to the list, planned again for the new time. */
async function changeRefused(trx: Trx, trip: TripRow, now: Date): Promise<TripRow> {
  const driverId = trip.driver_id;
  await saveState(trx, trip.trip_id, { ...stateOf(trip)!, changeAsk: null });
  const back = await backToList(trx, await lockTrip(trx, trip.trip_id), { command: "release", actor: "system", now });
  if (driverId) await push(trx, back, { audience: "driver", id: driverId }, "reservation_changed", now);
  return back.status === "requested" ? planBookedRide(trx, back, now) : back;
}

/** POST /driver/reservations/{tripId}/keep (owner BL-Q6). */
export async function keepReservation(trx: Trx, driverId: string, tripId: string, keep: boolean, now: Date): Promise<TripRow> {
  const trip = await lockScheduled(trx, tripId);
  if (trip.driver_id !== driverId) throw new ApiError("not_found", "No such booked ride.", { reason: "reservation_not_open" });
  const state = stateOf(trip);
  if (trip.status !== "accepted" || !state?.changeAsk) throw new ApiError("invalid_transition", "There is no question to answer now.", { projection: tripProjection(trip, "driver") });
  await cancelTimer(trx, TIMER.changeAsk, tripId);
  if (!keep) return changeRefused(trx, trip, now);
  await saveState(trx, tripId, { ...state, changeAsk: null });
  const kept = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  await planTimersOnly(trx, kept, now);
  await afterHeldAccept(trx, kept, now);
  await tellDriverFound(trx, kept, now);
  return trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
}

/** v0.18.39 §63 (P17): when a booked ride with no driver is ended. */
const stopAt = (scheduledAt: Date, s: ReservationSettings) => new Date(scheduledAt.getTime() + s.noDriverStopAfterMin * 60_000);

/** The rider's timers of a held ride at its (new) time. */
async function planTimersOnly(trx: Trx, trip: TripRow, now: Date): Promise<void> {
  const s = await settingsFor(trx, trip.zone_id);
  const plan = planOf(now, trip.scheduled_at!, s);
  await scheduleTimer(trx, { kind: TIMER.noDriver, refId: trip.trip_id, dueAt: plan.noDriverAt });
  await scheduleTimer(trx, { kind: TIMER.overdue, refId: trip.trip_id, dueAt: trip.scheduled_at! });
  await scheduleTimer(trx, { kind: TIMER.noDriverStop, refId: trip.trip_id, dueAt: stopAt(trip.scheduled_at!, s) });
  if (plan.riderReminderAt) await scheduleTimer(trx, { kind: TIMER.riderReminder, refId: trip.trip_id, dueAt: plan.riderReminderAt });
}

/* ---------------------------------------------------------------- admin */

export async function adminUnassign(trx: Trx, who: { subjectId: string }, tripId: string, body: { expectedVersion: number; reason?: string }, now: Date): Promise<TripRow> {
  const trip = await lockScheduled(trx, tripId);
  expectVersion(trip, body.expectedVersion, "admin");
  if (!body.reason?.trim()) throw badRequest("Write why the driver is taken off.", "reason_required");
  if (trip.status !== "accepted") throw new ApiError("invalid_transition", "Only a booked ride a driver holds can be unassigned.", { projection: tripProjection(trip, "admin") });
  const back = await backToList(trx, trip, { command: "unassign", actor: "admin", now });
  if (trip.driver_id) await push(trx, trip, { audience: "driver", id: trip.driver_id }, "reservation_unassigned", now);
  await audit(trx, { adminId: who.subjectId, action: "reservation.unassign", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { reason: body.reason, driverId: trip.driver_id }, at: now });
  return back;
}

/**
 * v0.18.50 §72 (L6, contract.json#lifecycle0_18_50.l6): admin Reassign (Trips page) on a booked ride a driver holds does
 * what Unassign does: back to the list (searched at once after its dispatch time) and the driver gets
 * reservation_unassigned. As with Unassign he is not barred from it (owner 2026-11-07: re-offer allowed). The caller
 * locked the trip and audits.
 */
export async function reassignHeldBooked(trx: Trx, trip: TripRow, now: Date): Promise<TripRow> {
  const back = await backToList(trx, trip, { command: "unassign", actor: "admin", now });
  if (trip.driver_id) await push(trx, trip, { audience: "driver", id: trip.driver_id }, "reservation_unassigned", now);
  return back;
}

export async function adminDispatchNow(trx: Trx, who: { subjectId: string }, tripId: string, body: { expectedVersion: number; reason?: string }, now: Date): Promise<TripRow> {
  const trip = await lockScheduled(trx, tripId);
  expectVersion(trip, body.expectedVersion, "admin");
  if (trip.status !== "requested") throw new ApiError("invalid_transition", "Only a booked ride without a driver can be sent now.", { projection: tripProjection(trip, "admin") });
  const sent = await startSearchNow(trx, trip, now);
  await cancelTimer(trx, TIMER.dispatch, tripId);
  await audit(trx, { adminId: who.subjectId, action: "reservation.dispatch_now", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { reason: body.reason ?? null }, at: now });
  return sent;
}

/* ---------------------------------------------------------------- timers */

/** One handler for every reservation timer kind (registered in dispatch/runtime.ts dispatchHandlers). */
export async function reservationTimer(trx: Trx, timer: Timer): Promise<void> {
  const now = timer.firedAt;
  const tripId = timer.refId.split(":")[0]!;
  // S5: FOR NO KEY UPDATE, as lockTrip (db/tripLog.ts); a future trip DELETE must take FOR UPDATE itself.
  const trip = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).forNoKeyUpdate().executeTakeFirst();
  if (!trip || trip.kind !== "scheduled" || !trip.scheduled_at) return;
  const state = stateOf(trip);
  if (!state) return;
  const payload = (timer.payload ?? {}) as { driverId?: string };
  const s = await settingsFor(trx, trip.zone_id);
  switch (timer.kind) {
    case TIMER.popup:
      if (trip.status === "requested" && s.homePopup) await sendNotice(trx, trip, s, "reservation_popup", now);
      return;
    case TIMER.openAll:
      if (trip.status === "requested") {
        await saveState(trx, tripId, { ...state, openAll: true });
        if (s.noticeOn) await sendNotice(trx, { ...trip, reservation: { ...state, openAll: true } }, s, "reservation_new", now, { onlyNew: true });
      }
      return;
    case TIMER.dispatch:
      if (trip.status === "requested") await startSearchNow(trx, trip, now);
      return;
    case TIMER.noDriver: {
      if (!NO_DRIVER.has(trip.status)) return;
      await saveState(trx, tripId, { ...state, noDriver: true });
      const marked = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
      const sequence = Number(marked.sequence) + 1;
      await appendTripEvent(trx, { tripId, kind: "trip_projection", version: marked.version, occurredAt: now, projection: tripProjection(marked, "admin", { sequence }) });
      await push(trx, marked, { audience: "rider", id: marked.rider_id }, "reservation_no_driver", now);
      await startSearchNow(trx, marked, now);
      return;
    }
    case TIMER.riderReminder:
      if (!["requested", "searching", "offered", "accepted", "driver_to_pickup"].includes(trip.status)) return;
      await push(trx, trip, { audience: "rider", id: trip.rider_id }, "reservation_reminder", now);
      return;
    case TIMER.driverReminder:
      if (trip.driver_id === payload.driverId && (trip.status === "accepted" || trip.status === "driver_to_pickup")) await push(trx, trip, { audience: "driver", id: trip.driver_id! }, "reservation_reminder", now);
      return;
    case TIMER.goOnline:
      if (trip.driver_id === payload.driverId && trip.status === "accepted") await push(trx, trip, { audience: "driver", id: trip.driver_id! }, "reservation_go_online", now);
      return;
    case TIMER.leaveCheck:
      if (trip.status === "accepted" && trip.driver_id === payload.driverId && state.held) await leaveCheck(trx, trip, state, s, now, timer.prepared);
      return;
    case TIMER.changeAsk:
      if (trip.status === "accepted" && trip.driver_id === payload.driverId && state.changeAsk) await changeRefused(trx, await lockTrip(trx, tripId), now);
      return;
    case TIMER.overdue: {
      if (trip.status === "accepted" && state.held && trip.driver_id) {
        // Checker M5: the driver holds it but has not started at the pickup time: the admin is alerted, the driver told.
        await saveState(trx, tripId, { ...state, notStarted: true });
        const marked = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
        await appendTripEvent(trx, { tripId, kind: "trip_projection", version: marked.version, occurredAt: now, projection: tripProjection(marked, "admin", { sequence: Number(marked.sequence) + 1 }) });
        await push(trx, marked, { audience: "driver", id: trip.driver_id }, "reservation_not_started", now);
        await pokeAlerts(trx, now);
        return;
      }
      if (!NO_DRIVER.has(trip.status)) return;
      // Owner BL-Q7: never expires; the admin is alerted and it keeps going out as Exclusive offers.
      await saveState(trx, tripId, { ...state, overdue: true, noDriver: true });
      // v0.18.23: the admin alert "pickup time passed, no driver" at once.
      await pokeAlerts(trx, now);
      const marked = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
      await appendTripEvent(trx, { tripId, kind: "trip_projection", version: marked.version, occurredAt: now, projection: tripProjection(marked, "admin", { sequence: Number(marked.sequence) + 1 }) });
      await startSearchNow(trx, marked, now);
      return;
    }
    case TIMER.noDriverStop: {
      // v0.18.39 §63 (P17): still no driver at pickup + noDriverStopAfterMin: the ride ends, no fee, rider told, admin alert.
      if (!NO_DRIVER.has(trip.status)) return;
      await clearTimers(trx, tripId);
      const ended = await stopBookedNoDriver(trx, trip, now, () => saveState(trx, tripId, { ...state, overdue: true, noDriver: true, noDriverFound: true }));
      await push(trx, ended, { audience: "rider", id: ended.rider_id }, "reservation_no_driver_found", now);
      await pokeAlerts(trx, now);
      return;
    }
    case TIMER.offlineCheck: {
      if (trip.driver_id !== payload.driverId || trip.status !== "accepted") return;
      const driver = await trx.selectFrom("drivers").select("online_status").where("driver_id", "=", trip.driver_id!).executeTakeFirst();
      if (driver && driver.online_status !== "offline" && driver.online_status !== "suspended") return;
      // S4 B1.23: after an outage the driver could not go online; he gets noFixMinutes from the moment the server could
      // hear again, then the check runs once more; never past the ride's search start (dispatchAt), so another driver
      // can still be found.
      const heardAgain = await heardAgainAt(trx, now);
      if (heardAgain !== null) {
        const grace = heardAgain.getTime() + (await outageGraceMinutes(trx, trip.driver_id!, trip.zone_id)) * 60_000;
        const until = Math.min(grace, Date.parse(state.dispatchAt));
        if (until > now.getTime()) {
          await scheduleTimer(trx, { kind: TIMER.offlineCheck, refId: tripId, dueAt: new Date(until), payload: { driverId: payload.driverId } });
          return;
        }
      }
      await backToList(trx, await lockTrip(trx, tripId), { command: "release", actor: "system", now });
      await push(trx, trip, { audience: "driver", id: trip.driver_id! }, "reservation_lost", now);
      return;
    }
  }
}

/** Kept for the search restart: a booked ride whose search ends before the pickup time searches again (Q3). */
export const searchesAgain = (trip: Pick<TripRow, "kind" | "scheduled_at">, _now: Date): boolean => trip.kind === "scheduled" && trip.scheduled_at !== null;

/** BL-Q7: after its pickup time a booked ride goes out as Exclusive offers only. */
export const exclusiveOnly = (trip: Pick<TripRow, "kind" | "scheduled_at">, now: Date): boolean => trip.kind === "scheduled" && trip.scheduled_at !== null && now.getTime() >= trip.scheduled_at.getTime();

/**
 * A booked ride back in requested (a driver cancel through POST /trips/{tripId}/cancel, an admin reassign): after its
 * dispatchAt it goes straight to dispatch; the driver's reminders are taken back.
 */
export async function afterBackToRequested(trx: Trx, trip: TripRow, now: Date): Promise<TripRow> {
  if (trip.kind !== "scheduled" || trip.status !== "requested") return trip;
  await clearDriverTimers(trx, trip.trip_id);
  await forgetDriverState(trx, trip.trip_id);
  const state = stateOf(trip);
  if (state && Date.parse(state.dispatchAt) <= now.getTime()) return startSearchNow(trx, trip, now);
  return trip;
}

/** An admin-assigned offer of a booked ride taken before its dispatchAt: held for later, not the driver's current trip. */
export function heldForLater(trip: Pick<TripRow, "kind" | "reservation">, now: Date): boolean {
  const state = trip.kind === "scheduled" ? stateOf(trip) : null;
  return state !== null && state.mode === "list" && Date.parse(state.dispatchAt) > now.getTime();
}

/** After a held accept through an offer: the driver's reminders and the rider's message, as for a list accept. */
export async function afterHeldAccept(trx: Trx, trip: TripRow, now: Date): Promise<void> {
  const s = await settingsFor(trx, trip.zone_id);
  const rideType = await rideTypeFor(trx, trip, s);
  const times = driverTimes(now, trip.scheduled_at!, s.rideTypes[rideType], s.offlineBackupAfterMin);
  await saveState(trx, trip.trip_id, { ...stateOf(trip)!, takenBack: null, rideType, mustBeOnlineAt: times.goOnlineAt.toISOString(), held: true });
  for (const [index, at] of times.reminders.entries()) await scheduleTimer(trx, { kind: TIMER.driverReminder, refId: `${trip.trip_id}:${index}`, dueAt: at, payload: { tripId: trip.trip_id, driverId: trip.driver_id } });
  await scheduleTimer(trx, { kind: TIMER.goOnline, refId: trip.trip_id, dueAt: times.goOnlineAt, payload: { driverId: trip.driver_id } });
  await scheduleTimer(trx, { kind: TIMER.offlineCheck, refId: trip.trip_id, dueAt: times.offlineCheckAt, payload: { driverId: trip.driver_id } });
  if (trip.driver_id) await scheduleLeaveCheck(trx, trip.trip_id, trip.scheduled_at!, trip.driver_id, now);
  // Low (checker): the rider already got "driver found" from the accept itself; no second message here.
  if (trip.driver_id) await push(trx, trip, { audience: "driver", id: trip.driver_id }, "reservation_assigned", now);
}

export type { ReservationSettings };

/** v0.18.19 (liveFixes.offlineGive): a booked ride whose search starts later: an admin offer may wait for the driver until then. */
export function aheadOf(trip: Pick<TripRow, "kind" | "reservation" | "status">, now: Date): Date | null {
  const state = trip.kind === "scheduled" ? stateOf(trip) : null;
  if (!state || state.mode !== "list") return null;
  const at = Date.parse(state.dispatchAt);
  return at > now.getTime() ? new Date(at) : null;
}

export async function notifyOffered(trx: Trx, trip: TripRow, driverId: string, now: Date): Promise<void> {
  await push(trx, trip, { audience: "driver", id: driverId }, "reservation_offered", now);
}

/** v0.18.19 (liveFixes.driverFoundOnce): "driver found" once per driver of a booked ride. */
export async function tellDriverFound(trx: Trx, trip: TripRow, now: Date): Promise<void> {
  if (trip.kind !== "scheduled" || !trip.driver_id) return;
  const fresh = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  const state = stateOf(fresh);
  if (!state || (state.toldDrivers ?? []).includes(trip.driver_id)) return;
  await saveState(trx, trip.trip_id, { ...state, toldDrivers: [...(state.toldDrivers ?? []), trip.driver_id] });
  await push(trx, fresh, { audience: "rider", id: fresh.rider_id }, "reservation_driver_found", now, { driver: (fresh.driver_summary as { firstName?: string } | null)?.firstName ?? "" });
}

/** Owner leave on time: checks start 3 h before pickup (or now), then every 2 minutes. */
async function scheduleLeaveCheck(trx: Trx, tripId: string, scheduledAt: Date, driverId: string, now: Date): Promise<void> {
  const first = Math.max(now.getTime(), scheduledAt.getTime() - 180 * 60_000);
  await scheduleTimer(trx, { kind: TIMER.leaveCheck, refId: tripId, dueAt: new Date(first), payload: { driverId } });
}

/** The drive from the driver's last position to the pickup (the same estimate as an offer's pickup ETA). */
/** The router behind the start time: main.ts sets the server's real router (OSRM, else the estimate), the same one
 * that gives normal rides their ETA (trips/eta.ts). Tests and the default use the straight-line estimate. */
let leaveRouter: Router = new EstimateRouter();
export function setLeaveRouter(router: Router): void {
  leaveRouter = router;
}

/**
 * S7 0.17 (owner W2 Q120 part 3): the leave check's road route is asked BEFORE its transaction (the timer worker's
 * `prepare` step: no transaction, no lock), not inside it. It used to be asked in the timer's transaction with the trip
 * row locked: while OSRM took its time (up to its 2.5 s timeout) the booked trip's row and the timer's row stayed
 * locked, and one of the worker's lanes stood still.
 * What `prepare` hands the handler: the road it asked (`route`: for which driver, from which position, to which
 * pickup), or `route: null` with `routerFailed` when the router itself failed, or `route: null` when there was nothing
 * to route at that moment (no such held ride, no position yet).
 */
export type LeaveRoute = { route: { driverId: string; from: LatLng; to: LatLng; durationSeconds: number } | null; routerFailed?: boolean };
/** 0.17: the prepared road still counts when the driver's position moved at most this far since it was asked (~15-30 s of driving, far below the minutes the leave check decides on). */
export const LEAVE_FIX_MOVED_M = 250;

/** 0.17: the leave check's `prepare` (dispatch/runtime.ts): plain reads and the road, with no transaction and no lock. */
export async function prepareLeaveCheck(ex: Executor, timer: Pick<Timer, "kind" | "refId" | "payload">): Promise<LeaveRoute | null> {
  if (timer.kind !== TIMER.leaveCheck) return null;
  const driverId = ((timer.payload ?? {}) as { driverId?: string }).driverId;
  const trip = await ex.selectFrom("trips").select(["kind", "status", "driver_id", "pickup"]).where("trip_id", "=", timer.refId.split(":")[0]!).executeTakeFirst();
  if (!trip || trip.kind !== "scheduled" || trip.status !== "accepted" || driverId === undefined || trip.driver_id !== driverId) return { route: null };
  const fix = await ex.selectFrom("driver_locations").select(["lat", "lng"]).where("driver_id", "=", driverId).executeTakeFirst();
  if (!fix) return { route: null };
  const from = { lat: fix.lat, lng: fix.lng };
  const pickup = trip.pickup as { lat: number; lng: number };
  const to = { lat: pickup.lat, lng: pickup.lng };
  try {
    // The check needs the drive time only, never the road's shape.
    const leg = await leaveRouter.route([from, to], { shape: false });
    return { route: { driverId, from, to, durationSeconds: leg.durationSeconds } };
  } catch {
    return { route: null, routerFailed: true };
  }
}

/**
 * Owner (v0.18.19 leaveOnTime): the drive from the driver's live position to the pickup, by the real road route.
 * 0.17: runs in the timer's transaction with the trip row locked, so it never calls the router. It re-reads the
 * driver's position under the lock and uses the prepared road only if its inputs still hold: the same driver, the
 * same pickup, and a position at most LEAVE_FIX_MOVED_M from the one that was routed.
 *  - Inputs changed while the road was asked (the driver drove on, the pickup moved, a position came in meanwhile):
 *    TimerBusy. The transaction is rolled back having written nothing and the worker runs the timer again shortly,
 *    with a new `prepare` (a new read, a new road). Not a failure; the timer keeps its due time.
 *  - Nothing was prepared (the worker's prepare step failed, the router failed, or the handler was run without one):
 *    the straight-line estimate from the position as it is now, worked out here without any network call. It is the
 *    same number the router itself gives while OSRM is down (EstimateRouter).
 */
async function driveSecondsOf(ex: Executor, driverId: string, trip: TripRow, prepared: unknown): Promise<number | null> {
  const fix = await ex.selectFrom("driver_locations").select(["lat", "lng"]).where("driver_id", "=", driverId).executeTakeFirst();
  const given = (prepared ?? null) as LeaveRoute | null;
  const routed = given?.route ?? null;
  if (!fix) {
    // A road was asked from a position that is gone now: nothing to decide on (as before: no position, no drive time).
    return null;
  }
  const from = { lat: fix.lat, lng: fix.lng };
  const pickup = trip.pickup as { lat: number; lng: number };
  const to = { lat: pickup.lat, lng: pickup.lng };
  if (routed !== null) {
    const same = routed.driverId === driverId && legKey([routed.to]) === legKey([to]) && haversineKm(routed.from, from) * 1000 <= LEAVE_FIX_MOVED_M;
    if (!same) throw new TimerBusy("leave check: the driver's position or the pickup changed while the road was asked");
    return Math.max(60, Math.round(routed.durationSeconds));
  }
  // prepare ran and found nothing to route, but under the lock there is: the inputs changed in between → once more.
  if (given !== null && given.routerFailed !== true) throw new TimerBusy("leave check: the ride or the driver's position changed while it was prepared");
  // Pure arithmetic (straight line × road factor at the dispatch speed): no network, safe inside the transaction.
  const leg = await new EstimateRouter().route([from, to]);
  return Math.max(60, Math.round(leg.durationSeconds));
}

/** v0.18.32 (contract.json#bookedRideSeen.leaveNowName): the rider's first name the trip keeps since accept, else "". */
function riderFirstNameOf(trip: TripRow): string {
  const summary = (typeof trip.rider_summary === "string" ? JSON.parse(trip.rider_summary) : trip.rider_summary) as { firstName?: unknown } | null;
  return typeof summary?.firstName === "string" ? summary.firstName : "";
}

/** Owner (v0.18.19 leaveOnTime): leaveAt, the "start now" notice, and the late-risk alert. */
async function leaveCheck(trx: Trx, trip: TripRow, state: ReservationState, s: ReservationSettings, now: Date, prepared: unknown): Promise<void> {
  const at = trip.scheduled_at!;
  const drive = await driveSecondsOf(trx, trip.driver_id!, trip, prepared);
  let next: ReservationState = { ...state };
  // v0.18.35 job 4 (contract.json#bookedTakeBack): the one case a ride is taken from a driver.
  if (takeBackDecision(now, at, drive, s).take) {
    await takeBackLate(trx, trip, now);
    return;
  }
  if (drive !== null) {
    const leaveAt = leaveAtOf(at, drive, s.arriveEarlyMin);
    next = { ...next, leaveAt: leaveAt.toISOString(), driveSeconds: drive };
    if (!next.leaveNotified && now.getTime() >= leaveAt.getTime()) {
      next.leaveNotified = true;
      await push(trx, trip, { audience: "driver", id: trip.driver_id! }, "reservation_leave_now", now, { early: String(s.arriveEarlyMin), riderFirstName: riderFirstNameOf(trip) });
    }
    const late = now.getTime() >= leaveAt.getTime() + 5 * 60_000 || now.getTime() + drive * 1000 > at.getTime();
    if (late && !next.atRisk) {
      next.atRisk = true;
      await push(trx, trip, { audience: "driver", id: trip.driver_id! }, "reservation_late_risk", now);
    }
  }
  await saveState(trx, trip.trip_id, next);
  if (next.atRisk !== state.atRisk || next.leaveAt !== state.leaveAt) {
    const marked = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
    await appendTripEvent(trx, { tripId: trip.trip_id, kind: "trip_projection", version: marked.version, occurredAt: now, projection: tripProjection(marked, "admin", { sequence: Number(marked.sequence) + 1 }) });
  }
  if (now.getTime() < at.getTime()) await scheduleTimer(trx, { kind: TIMER.leaveCheck, refId: trip.trip_id, dueAt: new Date(now.getTime() + 2 * 60_000), payload: { driverId: trip.driver_id } });
}

/**
 * v0.18.35 job 4 (contract.json#bookedTakeBack.takeBack): a held booked ride taken back from a late driver, in the leave
 * check's transaction (trip row locked). It counts on his cancel record (driver_cancels, never a fee), the ride goes back
 * to the list or to dispatch like a give-back, the per-driver state is cleared and reservation.takenBack set (admin
 * alert booked_taken_back), and he is told. The rider is told nothing (owner job-4 Q2: silent before he starts driving).
 */
async function takeBackLate(trx: Trx, trip: TripRow, now: Date): Promise<void> {
  const driverId = trip.driver_id!;
  await trx.insertInto("driver_cancels").values({ trip_id: trip.trip_id, driver_id: driverId, at: now, from_status: trip.status, reason_code: BOOKED_LATE_REASON, note: null }).execute();
  await saveState(trx, trip.trip_id, { ...stateOf(trip)!, takenBack: { driverId, at: now.toISOString() } });
  const back = await backToList(trx, await lockTrip(trx, trip.trip_id), { command: "release", actor: "system", now });
  await push(trx, back, { audience: "driver", id: driverId }, "reservation_taken_back", now);
  await pokeAlerts(trx, now);
}

/**
 * v0.18.35 job 4: a booked ride the driver already started (driver_to_pickup) but is not heading to the pickup: the
 * heading check asks this with the latest road drive; true = the take-back rule says take it (cancel.ts does it).
 */
export async function lateStartedBooked(ex: Executor, trip: TripRow, driveSeconds: number, now: Date): Promise<boolean> {
  if (trip.kind !== "scheduled" || !trip.scheduled_at) return false;
  return takeBackDecision(now, trip.scheduled_at, driveSeconds, await settingsFor(ex, trip.zone_id)).take;
}

/** v0.18.35 job 4: after a started booked ride was taken back: the take-back mark and the driver's notice. */
export async function afterStartedTakeBack(trx: Trx, trip: TripRow, driverId: string, now: Date): Promise<void> {
  const fresh = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  const state = stateOf(fresh);
  if (state) await saveState(trx, trip.trip_id, { ...withoutDriverState(state), held: false, takenBack: { driverId, at: now.toISOString() } });
  await push(trx, trip, { audience: "driver", id: driverId }, "reservation_taken_back", now);
  await pokeAlerts(trx, now);
}

/**
 * Owner smart assign (v0.18.19): a booked ride's offers go in 3 steps — 1) drivers who can arrive arriveEarlyMin
 * before the pickup time, 2) drivers who can arrive on time, 3) any other near driver — for Exclusive and Radar rounds
 * and after the pickup time alike (then nobody is early or on time, so step 3 keeps the nearest first).
 */
export async function smartOrder<T extends { id: string; km: number }>(ex: Executor, trip: TripRow, ranked: T[], now: Date): Promise<T[]> {
  if (trip.kind !== "scheduled" || !trip.scheduled_at) return ranked;
  const s = await settingsFor(ex, trip.zone_id);
  const left = (trip.scheduled_at.getTime() - now.getTime()) / 1000;
  const drive = (r: T) => (r.km / DISPATCH.score.pickupKmh) * 3600;
  const early = ranked.filter((r) => drive(r) <= left - s.arriveEarlyMin * 60);
  const onTime = ranked.filter((r) => !early.includes(r) && drive(r) <= left);
  return [...early, ...onTime, ...ranked.filter((r) => !early.includes(r) && !onTime.includes(r))];
}
