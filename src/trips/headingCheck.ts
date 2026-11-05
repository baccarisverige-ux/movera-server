import { contract } from "../contract/contract.js";
import { liveDocument } from "../config/service.js";
import type { Executor, Trx } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { DISPATCH } from "../dispatch/engine.js";
import { haversineKm } from "../maps/routing.js";
import { notify } from "../notifications/service.js";

/**
 * v0.18.13 (owner G5-8, decisions/driver-g5.md item 8 + notes; contract.json#pickupWaiting.headingCheck): the smart
 * late rule. With every server ETA tick (every 30 s) from accept until arrival the server asks: did the driver get at
 * least headingPct % (default 80, admin per zone) as much closer to the pickup as normal road speed allowed since the
 * last check? Normal road speed is the route's own (distance / duration of the driver's leg to the pickup). The
 * latest answer is kept on the trip (trips.heading_check, TripProjection.headingCheck). Not heading for
 * notHeadingMinutes in a row → the rider's cancel is free, and with reassign on the trip goes back to dispatch without
 * that driver (counted against him). The first free minutes after accept stay free for the rider whatever this says.
 */

/**
 * v0.18.35 (owner Q-A, job 4 Q4; contract.json#bookedTakeBack): reassign is read-only and ignored for LIVE trips (never
 * taken back); notice / noticeEveryMin = the driver's "not driving to the rider" notice every minute while not heading.
 */
export type HeadingSettings = { on: boolean; headingPct: number; notHeadingMinutes: number; reassign: boolean; notice: boolean; noticeEveryMin: number };
/** noticeAt (v0.18.35): the last "not driving to the rider" notice, kept on the trip row so server copies never repeat it. */
export type HeadingState = { heading: boolean; checkedAt: string; notHeadingSince?: string; freeAfter?: string; meters?: number; speedMps?: number; noticeAt?: string };

type Notice = { kind: string; deepLink: string; title: Record<string, string>; body: Record<string, string> };
type Spec = { driverNotice: Notice; notHeadingNotice: Notice };
const DEFAULTS = (contract as unknown as { configDefaults: { headingCheck: HeadingSettings } }).configDefaults.headingCheck;
const SPEC = (contract as unknown as { pickupWaiting: { headingCheck: Spec } }).pickupWaiting.headingCheck;
/** "Arrived" is accepted within this distance (ride.ts ARRIVE_MAX_METERS): a driver this close is heading. */
const AT_PICKUP_METERS = 300;
const TO_PICKUP = new Set(["accepted", "driver_to_pickup"]);
export const NOT_HEADING_REASON = "not_heading_to_pickup";

const num = (value: unknown, min: number, max: number, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback);

/** DriverAppConfig.headingCheck of a zone (or its country standard), with the defaults. */
export function headingSettingsOf(doc: { headingCheck?: Partial<HeadingSettings> } | null | undefined): HeadingSettings {
  const h = doc?.headingCheck ?? {};
  return {
    on: typeof h.on === "boolean" ? h.on : DEFAULTS.on,
    headingPct: num(h.headingPct, 50, 100, DEFAULTS.headingPct),
    notHeadingMinutes: num(h.notHeadingMinutes, 1, 30, DEFAULTS.notHeadingMinutes),
    reassign: typeof h.reassign === "boolean" ? h.reassign : DEFAULTS.reassign,
    notice: typeof h.notice === "boolean" ? h.notice : DEFAULTS.notice,
    noticeEveryMin: num(h.noticeEveryMin, 1, 10, DEFAULTS.noticeEveryMin),
  };
}

export async function headingSettingsFor(ex: Executor, zoneId: string): Promise<HeadingSettings> {
  const live = await liveDocument<{ headingCheck?: Partial<HeadingSettings> }>(ex, "driver_app_config", zoneId);
  return headingSettingsOf(live?.document);
}

/** Free cancel because of this rule: not heading for notHeadingMinutes in a row. */
export function isFreeCancel(state: HeadingState | null, settings: HeadingSettings, now: Date): boolean {
  if (!settings.on || state === null || state.heading || !state.notHeadingSince) return false;
  return now.getTime() - Date.parse(state.notHeadingSince) >= settings.notHeadingMinutes * 60_000;
}

/** One check: the new state from the previous one and the driver's distance (road metres) to the pickup now. */
export function nextHeading(
  previous: HeadingState | null,
  input: { now: Date; settings: HeadingSettings; meters: number | null; speedMps: number | null; atPickup: boolean },
): HeadingState | null {
  const checkedAt = input.now.toISOString();
  const keep = (heading: boolean): HeadingState => {
    const since = previous && !previous.heading && previous.notHeadingSince ? previous.notHeadingSince : checkedAt;
    return {
    heading,
    checkedAt,
    ...(heading ? {} : { notHeadingSince: since, freeAfter: new Date(Date.parse(since) + input.settings.notHeadingMinutes * 60_000).toISOString() }),
    ...(input.meters !== null ? { meters: input.meters } : {}),
    ...(input.speedMps !== null ? { speedMps: input.speedMps } : previous?.speedMps !== undefined ? { speedMps: previous.speedMps } : {}),
    };
  };
  // Checker 1: a tick without a position changes nothing — the previous state and its clock stay (none yet = none).
  if (input.meters === null) return previous;
  if (input.atPickup) return keep(true);
  // The first check sets the start line.
  if (!previous || previous.meters === undefined) return keep(true);
  const seconds = Math.max(0, (input.now.getTime() - Date.parse(previous.checkedAt)) / 1000);
  const speed = previous.speedMps ?? input.speedMps ?? (DISPATCH.score.pickupKmh * 1000) / 3600;
  const possible = Math.min(previous.meters, speed * seconds);
  if (possible <= 0) return keep(previous.heading);
  const progress = previous.meters - input.meters;
  return keep(progress >= (input.settings.headingPct / 100) * possible);
}

/** TripProjection.headingCheck (all views) from accept until arrival. */
export function headingView(trip: Pick<TripRow, "status" | "heading_check"> & { kind?: string }, now: Date): Record<string, unknown> | null {
  const state = trip.heading_check as HeadingState | null;
  if (!state || !TO_PICKUP.has(trip.status)) return null;
  return {
    heading: state.heading,
    checkedAt: state.checkedAt,
    ...(state.notHeadingSince ? { notHeadingSince: state.notHeadingSince } : {}),
    // The free cancel of this rule is for live trips (a booked ride keeps its own cancel rules).
    freeCancel: trip.kind !== "scheduled" && !state.heading && !!state.freeAfter && now.getTime() >= Date.parse(state.freeAfter),
  };
}

type Place = { lat: number; lng: number };

/**
 * The check of one ETA tick (inside the tick's transaction, trip locked). Returns true when the trip was taken back
 * from the driver. `leg` is the route just computed (null without a fresh position).
 *
 * v0.18.35 (owner Q-A + job 4, contract.json#bookedTakeBack): a LIVE trip is never taken back (reassign is ignored).
 * Not heading for notHeadingMinutes in a row = the driver's "not driving to the rider" notice every noticeEveryMin
 * minutes (live and booked); a BOOKED trip (driver_to_pickup) is then handed to `takeBackBooked`, which takes it only
 * when the take-back rule says so (late > takeBackLateMin, drive > takeBackKeepIfDriveMin, ≥ untilMinBeforePickup).
 */
export async function headingTick(
  trx: Trx,
  trip: TripRow,
  input: { fix: Place | null; leg: { distanceMeters: number; durationSeconds: number } | null; now: Date },
  takeBackBooked: (trx: Trx, trip: TripRow, now: Date, driveSeconds: number) => Promise<boolean>,
): Promise<boolean> {
  if (!trip.driver_id || !TO_PICKUP.has(trip.status) || (trip.kind !== "live" && trip.kind !== "scheduled")) return false;
  const settings = await headingSettingsFor(trx, trip.zone_id);
  if (!settings.on) {
    if (trip.heading_check !== null) await trx.updateTable("trips").set({ heading_check: null }).where("trip_id", "=", trip.trip_id).execute();
    return false;
  }
  const atPickup = input.fix ? haversineKm(input.fix, trip.pickup as Place) * 1000 <= AT_PICKUP_METERS : false;
  const meters = input.leg ? input.leg.distanceMeters : null;
  const speedMps = input.leg && input.leg.durationSeconds > 0 ? input.leg.distanceMeters / input.leg.durationSeconds : null;
  const previous = trip.heading_check as HeadingState | null;
  let state = nextHeading(previous, { now: input.now, settings, meters, speedMps, atPickup });
  if (state === null) return false;
  // The notice clock stays while he keeps not heading; heading again starts it over.
  if (state !== previous && !state.heading && previous && !previous.heading && previous.noticeAt) state = { ...state, noticeAt: previous.noticeAt };
  const notHeading = isFreeCancel(state, settings, input.now);
  if (notHeading && settings.notice && (!state.noticeAt || input.now.getTime() - Date.parse(state.noticeAt) >= settings.noticeEveryMin * 60_000)) {
    state = { ...state, noticeAt: input.now.toISOString() };
    await noticeNotHeading(trx, trip.driver_id, trip.trip_id, input.now);
  }
  if (state !== previous) await trx.updateTable("trips").set({ heading_check: JSON.stringify(state) }).where("trip_id", "=", trip.trip_id).execute();
  if (notHeading && trip.kind === "scheduled" && input.leg) return takeBackBooked(trx, { ...trip, heading_check: state }, input.now, input.leg.durationSeconds);
  return false;
}

async function driverLang(ex: Executor, driverId: string, texts: Record<string, string>): Promise<string> {
  const driver = await ex.selectFrom("drivers").select("language").where("driver_id", "=", driverId).executeTakeFirst();
  return driver?.language && driver.language in texts ? driver.language : "en";
}

/** v0.18.35 (owner Q-A, job 4 Q4): "You are not driving towards the rider" (bell + push, his language, else English). */
export async function noticeNotHeading(ex: Executor, driverId: string, tripId: string, now: Date): Promise<void> {
  const n = SPEC.notHeadingNotice;
  const lang = await driverLang(ex, driverId, n.title);
  await notify(ex, { audience: "driver", subjectId: driverId, kind: n.kind, title: n.title[lang]!, body: n.body[lang]!, deepLink: n.deepLink.replace("{tripId}", tripId), tripId, data: { tripId, reason: "not_heading_to_rider" } }, now);
}

/** The driver's notice when the trip is taken back (bell + push, his language, else English). */
export async function noticeTakenBack(ex: Executor, driverId: string, tripId: string, now: Date): Promise<void> {
  const driver = await ex.selectFrom("drivers").select("language").where("driver_id", "=", driverId).executeTakeFirst();
  const lang = driver?.language && driver.language in SPEC.driverNotice.title ? driver.language : "en";
  await notify(ex, { audience: "driver", subjectId: driverId, kind: SPEC.driverNotice.kind, title: SPEC.driverNotice.title[lang]!, body: SPEC.driverNotice.body[lang]!, deepLink: SPEC.driverNotice.deepLink, tripId, data: { tripId, reason: NOT_HEADING_REASON } }, now);
}
