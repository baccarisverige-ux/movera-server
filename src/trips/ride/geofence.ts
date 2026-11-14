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

/**
 * v0.18.93 (job C9, contract.json#autoArrive; owner 2026-11-02 review Q3 "Both: auto + button", Rules
 * decisions/driver-g7.md:83-84): the server marks the driver arrived when his latest fix is within the zone's
 * waiting.autoArriveMeters of the pickup (the Arrived button stays), and the waiting clock stops while he is farther than
 * waiting.leaveMeters before the rider is on board; it goes on at a new arrival (back within autoArriveMeters, or his tap).
 * Pickup only: middle stops keep their taps (contract.json#autoArrive.notInThisVersion).
 */

type Range = [number, number];
const AA = (contract as unknown as { autoArrive: { settings: { arriveMeters: { default: number; range: Range }; leaveMeters: { default: number; range: Range } }; maxAccuracyMeters: number } }).autoArrive;
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
export type GeofenceFacts = { trip_id: string; status: string; pickup: unknown; arrive_m?: number | null; leave_m?: number | null; away?: boolean | null };

/**
 * After a new current fix (drivers/service.ts storeFixes): book the check as a job when the fix may change something —
 * the trip's kept distances when it has them, else the widest the settings allow (the job decides exactly). Only a timer
 * row is written here, never the trip (lock order, as maybeNearDropoff).
 */
export async function maybePickupGeofence(trx: Trx, active: GeofenceFacts, fix: Place & { accuracy?: number }, now: Date): Promise<void> {
  if (active.status !== "driver_to_pickup" && active.status !== "arrived") return;
  if (typeof fix.accuracy === "number" && fix.accuracy > AUTO_MAX_ACCURACY_METERS) return;
  const meters = haversineKm(fix, active.pickup as Place) * 1000;
  const arrive = typeof active.arrive_m === "number" ? active.arrive_m : ARRIVE_RANGE[1];
  const leave = typeof active.leave_m === "number" ? active.leave_m : LEAVE_RANGE[0];
  const may = active.status === "driver_to_pickup" ? meters <= arrive : active.away ? meters <= arrive : meters > leave;
  if (may) await scheduleTimer(trx, { kind: PICKUP_GEOFENCE, refId: active.trip_id, dueAt: now, payload: {} });
}

/** The arrive step the server runs for the driver (steps.ts autoArrive), given here so this module does not import steps.ts. */
export type AutoArrive = (trx: Trx, trip: TripRow, here: Place, now: Date) => Promise<void>;

/** The job: reads the driver's latest stored fix (fresh, accurate) and arrives him, stops or goes on with the waiting clock. */
export function pickupGeofenceHandler(autoArrive: AutoArrive): TimerHandler {
  return async (trx, timer) => {
    const now = timer.firedAt;
    const trip = await lockTripNow(trx, timer.refId);
    if (!trip || !trip.driver_id || (trip.status !== "driver_to_pickup" && trip.status !== "arrived")) return;
    const fix = await trx.selectFrom("driver_locations").select(["lat", "lng", "accuracy", "measured_at"]).where("driver_id", "=", trip.driver_id).executeTakeFirst();
    if (!fix || fix.accuracy > AUTO_MAX_ACCURACY_METERS) return;
    if (Math.abs(now.getTime() - fix.measured_at.getTime()) > (await positionMaxAge(trx, trip.zone_id)) * 1000) return;
    const fence = await tripGeofence(trx, trip);
    const meters = haversineKm(fix, trip.pickup as Place) * 1000;
    if (trip.status === "driver_to_pickup") {
      if (meters <= fence.autoArriveMeters) await autoArrive(trx, trip, fix, now);
      return;
    }
    const waiting = trip.waiting as Waiting | null;
    if (!waiting) return;
    if (!waiting.away && meters > fence.leaveMeters) await writeWaiting(trx, trip, awayFrom(waiting, fix.measured_at, now), now);
    else if (waiting.away && meters <= fence.autoArriveMeters) {
      const back = backAt(waiting, fix.measured_at, now);
      await rebookWaitingAlerts(trx, trip.trip_id, back);
      await writeWaiting(trx, trip, back, now);
    }
  };
}
