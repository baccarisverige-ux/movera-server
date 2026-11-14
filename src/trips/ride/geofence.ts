import { contract } from "../../contract/contract.js";
import { liveDocument } from "../../config/service.js";
import type { Executor, Trx } from "../../db/db.js";
import { appendTripEvent, type TripRow } from "../../db/tripLog.js";
import { scheduleTimer, type TimerHandler } from "../../jobs/timers.js";
import { haversineKm } from "../../maps/routing.js";
import { lockTripNow } from "../../dispatch/runtime.js";
import { tripProjection } from "../projection.js";
import { PICKUP_GEOFENCE, positionMaxAge, type Place, type Waiting } from "./shared.js";
import { WAITING_NO_SHOW, WAITING_PAID } from "./timers.js";
import { awayFrom, backAt } from "./waitingClock.js";
import { confirmedBy, type CountingFix } from "./fixConfirm.js";
import { arriveAtStop, nextStopIndex, openVisitOf, stopAwayFrom, stopBackAt, visitsOf, type StopVisit } from "./stopClock.js";
import { touchTrip } from "../commands.js";

/**
 * v0.18.93 (job C9, contract.json#autoArrive; owner 2026-11-02 review Q3 "Both: auto + button", Rules
 * decisions/driver-g7.md:83-84): the server marks the driver arrived when his latest fix is within the zone's
 * waiting.autoArriveMeters of the pickup (the Arrived button stays), and the waiting clock stops while he is farther than
 * waiting.leaveMeters before the rider is on board; it goes on at a new arrival (back within autoArriveMeters, or his tap
 * within leaveMeters). Round 2 (supervisor M1): each change needs 2 counting fixes in a row (fixConfirm.ts).
 * v0.18.98 (job C9b, contract.json#autoArrive.stops; owner "At the pickup AND at stops"): the same job, the same kept
 * distances and the same 2-fix confirm at the middle stops while in_trip / approaching_dropoff: the NEXT stop is arrived
 * (stops[i].arrivedBy auto), the open stop's wait stands still while the driver is away and goes on when he is back
 * (ride/stopClock.ts).
 */

type Range = [number, number];
const AA = (contract as unknown as { autoArrive: { settings: { arriveMeters: { default: number; range: Range }; leaveMeters: { default: number; range: Range } }; maxAccuracyMeters: number; confirm: { fixes: number; minGapSeconds: number; maxArriveSpeedKmh: number } } }).autoArrive;
/** Round 2 (contract.json#autoArrive.confirm, supervisor M1): 2 counting fixes in a row ≥ 5 s apart; arrivals ≤ 15 km/h. */
export const AUTO_CONFIRM = AA.confirm;
const ARRIVE_RANGE = AA.settings.arriveMeters.range;
const LEAVE_RANGE = AA.settings.leaveMeters.range;
/** A fix counts for the automatic arrival and the waiting clock only when at least this accurate (contract.json#autoArrive.maxAccuracyMeters). */
export const AUTO_MAX_ACCURACY_METERS = AA.maxAccuracyMeters;

export type Geofence = { autoArriveMeters: number; leaveMeters: number };
export const GEOFENCE_DEFAULTS: Geofence = { autoArriveMeters: AA.settings.arriveMeters.default, leaveMeters: AA.settings.leaveMeters.default };

const wholeIn = (v: unknown, [lo, hi]: Range): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const waitingOfDoc = (doc: unknown) => (doc as { waiting?: { autoArriveMeters?: unknown; leaveMeters?: unknown } } | null | undefined)?.waiting;

/** DriverAppConfig.waiting.autoArriveMeters / leaveMeters of a driver document; a bad value or a bad pair takes the defaults (100 / 200). */
export function geofenceOf(doc: unknown): Geofence {
  const w = waitingOfDoc(doc);
  const arrive = wholeIn(w?.autoArriveMeters, ARRIVE_RANGE) ? w!.autoArriveMeters as number : GEOFENCE_DEFAULTS.autoArriveMeters;
  const leave = wholeIn(w?.leaveMeters, LEAVE_RANGE) ? w!.leaveMeters as number : GEOFENCE_DEFAULTS.leaveMeters;
  return leave > arrive ? { autoArriveMeters: arrive, leaveMeters: leave } : { ...GEOFENCE_DEFAULTS };
}

/** contract.json#autoArrive.settings.validation: null when fine or not set, else why (400 invalid_auto_arrive_distance). */
export function geofenceProblem(doc: unknown): string | null {
  const w = waitingOfDoc(doc);
  if (w === undefined || w === null) return null;
  if (w.autoArriveMeters !== undefined && !wholeIn(w.autoArriveMeters, ARRIVE_RANGE)) return `autoArriveMeters must be a whole number from ${ARRIVE_RANGE[0]} to ${ARRIVE_RANGE[1]}`;
  if (w.leaveMeters !== undefined && !wholeIn(w.leaveMeters, LEAVE_RANGE)) return `leaveMeters must be a whole number from ${LEAVE_RANGE[0]} to ${LEAVE_RANGE[1]}`;
  const arrive = (w.autoArriveMeters as number | undefined) ?? GEOFENCE_DEFAULTS.autoArriveMeters;
  const leave = (w.leaveMeters as number | undefined) ?? GEOFENCE_DEFAULTS.leaveMeters;
  return leave > arrive ? null : "leaveMeters must be greater than autoArriveMeters";
}

/** The trip's distances: kept at booking (v0.18.93), else the zone's live driver document. */
export async function tripGeofence(ex: Executor, trip: Pick<TripRow, "booking_rules" | "zone_id">): Promise<Geofence> {
  const kept = trip.booking_rules as Partial<Geofence> | null;
  if (kept && typeof kept.autoArriveMeters === "number" && typeof kept.leaveMeters === "number") return { autoArriveMeters: kept.autoArriveMeters, leaveMeters: kept.leaveMeters };
  return geofenceOf((await liveDocument(ex, "driver_app_config", trip.zone_id))?.document);
}

export { awayFrom, backAt, chargedSecondsAt, clockAt } from "./waitingClock.js";

/* ---------------------------------------------------------------- writing it */

/** The island alerts follow the moved moments (contract.json#arrivedWaiting.alerts): one not sent yet is booked again. */
export async function rebookWaitingAlerts(trx: Trx, tripId: string, waiting: Waiting): Promise<void> {
  const sent = new Set((waiting.alerts ?? []).map((a) => a.kind));
  const payload = { arrivedAt: waiting.arrivedAt };
  if (!sent.has("paid_waiting_started")) await scheduleTimer(trx, { kind: WAITING_PAID, refId: tripId, dueAt: new Date(waiting.freeUntil), payload });
  if (!sent.has("no_show_possible")) await scheduleTimer(trx, { kind: WAITING_NO_SHOW, refId: tripId, dueAt: new Date(waiting.noShowAt), payload });
}

/** Away / back from a fix: the waiting is written with no version change and a trip_projection event goes out (like an island alert). */
async function writeWaiting(trx: Trx, trip: TripRow, waiting: Waiting, now: Date): Promise<void> {
  await trx.updateTable("trips").set({ waiting: JSON.stringify(waiting) }).where("trip_id", "=", trip.trip_id).execute();
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  await appendTripEvent(trx, { tripId: trip.trip_id, kind: "trip_projection", version: updated.version, occurredAt: now, projection: tripProjection(updated, "admin", { sequence: Number(updated.sequence) + 1, now }) });
}

/* ---------------------------------------------------------------- from the driver's positions */

export { PICKUP_GEOFENCE } from "./shared.js";

/** What POST /driver/location knows about the active trip (one statement, drivers/service.ts locationFacts). */
export type GeofenceFacts = { trip_id: string; status: string; pickup: unknown; arrive_m?: number | null; leave_m?: number | null; away?: boolean | null; stops?: unknown; stop_visits?: unknown };

const ON_THE_WAY = new Set(["in_trip", "approaching_dropoff"]);

/**
 * After a new current fix (drivers/service.ts storeFixes): book the check as a job when the fix may change something —
 * the trip's kept distances when it has them, else the widest the settings allow (the job decides exactly). Only a timer
 * row is written here, never the trip (lock order, as maybeNearDropoff).
 */
export async function maybePickupGeofence(trx: Trx, active: GeofenceFacts, fix: Place & { accuracy?: number }, now: Date): Promise<void> {
  const atPickup = active.status === "driver_to_pickup" || active.status === "arrived";
  if (!atPickup && !ON_THE_WAY.has(active.status)) return;
  if (typeof fix.accuracy === "number" && fix.accuracy > AUTO_MAX_ACCURACY_METERS) return;
  const arrive = typeof active.arrive_m === "number" ? active.arrive_m : ARRIVE_RANGE[1];
  const leave = typeof active.leave_m === "number" ? active.leave_m : LEAVE_RANGE[0];
  const metersTo = (p: Place) => haversineKm(fix, p) * 1000;
  let may: boolean;
  if (atPickup) {
    const meters = metersTo(active.pickup as Place);
    may = active.status === "driver_to_pickup" ? meters <= arrive : active.away ? meters <= arrive : meters > leave;
  } else {
    // v0.18.98 (contract.json#autoArrive.stops.auto): booked only while the trip has an unvisited or open stop.
    const stops = Array.isArray(active.stops) ? (active.stops as Place[]) : [];
    const visits = visitsOf({ stop_visits: active.stop_visits });
    const next = nextStopIndex(stops.length, visits);
    const open = openVisitOf(visits);
    const openStop = open ? stops[open.stopIndex] : undefined;
    may = (next !== null && metersTo(stops[next]!) <= arrive) || (openStop !== undefined && (open!.away ? metersTo(openStop) <= arrive : metersTo(openStop) > leave));
  }
  if (may) await scheduleTimer(trx, { kind: PICKUP_GEOFENCE, refId: active.trip_id, dueAt: now, payload: {} });
}

/** v0.18.98: the open stop's away / back from a fix, with no version change; a trip_projection event goes out (as writeWaiting). */
async function writeStopVisits(trx: Trx, trip: TripRow, visits: StopVisit[], now: Date): Promise<void> {
  await trx.updateTable("trips").set({ stop_visits: JSON.stringify(visits) }).where("trip_id", "=", trip.trip_id).execute();
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  await appendTripEvent(trx, { tripId: trip.trip_id, kind: "trip_projection", version: updated.version, occurredAt: now, projection: tripProjection(updated, "admin", { sequence: Number(updated.sequence) + 1, now }) });
}

/** The arrive step the server runs for the driver (steps.ts autoArrive), given here so this module does not import steps.ts. */
export type AutoArrive = (trx: Trx, trip: TripRow, here: Place, now: Date) => Promise<void>;

/**
 * The job: reads the driver's latest stored fix (fresh, accurate) and arrives him, stops or goes on with the waiting clock —
 * round 2 (contract.json#autoArrive.confirm): only when the trip's earlier counting fixes confirm it (one fix never decides).
 */
export function pickupGeofenceHandler(autoArrive: AutoArrive): TimerHandler {
  return async (trx, timer) => {
    const now = timer.firedAt;
    const trip = await lockTripNow(trx, timer.refId);
    if (!trip || !trip.driver_id || (trip.status !== "driver_to_pickup" && trip.status !== "arrived" && !ON_THE_WAY.has(trip.status))) return;
    const fix = await trx.selectFrom("driver_locations").select(["lat", "lng", "accuracy", "measured_at", "speed_mps"]).where("driver_id", "=", trip.driver_id).executeTakeFirst();
    if (!fix || fix.accuracy > AUTO_MAX_ACCURACY_METERS) return;
    const maxAge = await positionMaxAge(trx, trip.zone_id);
    if (Math.abs(now.getTime() - fix.measured_at.getTime()) > maxAge * 1000) return;
    const fence = await tripGeofence(trx, trip);
    // The trip's counting fixes up to the latest one, newest first (trip_locations is written before this job is booked).
    const rows = await trx
      .selectFrom("trip_locations")
      .select(["lat", "lng", "measured_at", "speed_mps"])
      .where("trip_id", "=", trip.trip_id)
      .where("driver_id", "=", trip.driver_id)
      .where("accuracy", "<=", AUTO_MAX_ACCURACY_METERS)
      .where("measured_at", "<=", fix.measured_at)
      .where("measured_at", ">=", new Date(fix.measured_at.getTime() - maxAge * 1000))
      .orderBy("measured_at", "desc")
      .limit(60)
      .execute();
    /** The counting fixes, newest first, with their distance to `target`. */
    const fixesTo = (target: Place): CountingFix[] => {
      const meters = (p: { lat: number; lng: number }) => haversineKm(p, target) * 1000;
      const list: CountingFix[] = rows.map((r) => ({ lat: r.lat, lng: r.lng, measuredAt: r.measured_at, speedMps: r.speed_mps, meters: meters(r) }));
      // The stored latest fix leads (a fix the phone sent again keeps its first row; the latest is never missing).
      if (list[0]?.measuredAt.getTime() !== fix.measured_at.getTime()) list.unshift({ lat: fix.lat, lng: fix.lng, measuredAt: fix.measured_at, speedMps: fix.speed_mps, meters: meters(fix) });
      return list;
    };
    const rule = { ...AUTO_CONFIRM, windowSeconds: maxAge };
    const apart = (a: CountingFix, b: CountingFix) => haversineKm(a, b) * 1000;
    const within = (f: CountingFix) => f.meters <= fence.autoArriveMeters;
    const beyond = (f: CountingFix) => f.meters > fence.leaveMeters;
    if (ON_THE_WAY.has(trip.status)) {
      // v0.18.98 (contract.json#autoArrive.stops): the next stop first (in order), then the open stop's away / back.
      const stops = (trip.stops as Place[] | null) ?? [];
      const visits = visitsOf(trip);
      const next = nextStopIndex(stops.length, visits);
      const open = openVisitOf(visits);
      const openStop = open ? stops[open.stopIndex] : undefined;
      // Supervisor M1 (Rules audits/impact/c9b-middle-stops-supervisor.md): while the driver waits at an open stop (not
      // away), both fixes of the pair must also be farther than autoArriveMeters from it, so two stops close together
      // (next door, the same building) never close the first one by themselves; then only his tap arrives the next stop.
      const leftOpen = (f: CountingFix) => !openStop || Boolean(open!.away) || haversineKm(f, openStop) * 1000 > fence.autoArriveMeters;
      if (next !== null && confirmedBy(fixesTo(stops[next]!), (f) => within(f) && leftOpen(f), rule, true, apart)) {
        // The same step as the driver's tap (version + 1, trip_projection); an earlier open stop gets leftAt = now.
        await touchTrip(trx, trip, { stop_visits: JSON.stringify(arriveAtStop(visits, next, now, "auto")) }, now);
        return;
      }
      if (!open || !openStop) return;
      const first = confirmedBy(fixesTo(openStop), open.away ? within : beyond, rule, Boolean(open.away), apart);
      if (!first) return;
      const changed = open.away ? stopBackAt(open, first.measuredAt, now) : stopAwayFrom(open, first.measuredAt, now);
      await writeStopVisits(trx, trip, visits.map((v) => (v.stopIndex === open.stopIndex ? changed : v)), now);
      return;
    }
    const fixes = fixesTo(trip.pickup as Place);
    if (trip.status === "driver_to_pickup") {
      if (confirmedBy(fixes, within, rule, true, apart)) await autoArrive(trx, trip, { lat: fix.lat, lng: fix.lng }, now);
      return;
    }
    const waiting = trip.waiting as Waiting | null;
    if (!waiting) return;
    if (!waiting.away) {
      const first = confirmedBy(fixes, (f) => f.meters > fence.leaveMeters, rule, false, apart);
      if (first) await writeWaiting(trx, trip, awayFrom(waiting, first.measuredAt, now), now);
      return;
    }
    const first = confirmedBy(fixes, within, rule, true, apart);
    if (first) {
      const back = backAt(waiting, first.measuredAt, now);
      await rebookWaitingAlerts(trx, trip.trip_id, back);
      await writeWaiting(trx, trip, back, now);
    }
  };
}
