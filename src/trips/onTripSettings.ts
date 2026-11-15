import { contract } from "../contract/contract.js";
import { liveDocument } from "../config/service.js";
import type { Executor } from "../db/db.js";
import { ApiError } from "../http/errors.js";

/**
 * v0.18.9 (contract.json#onTrip, owner rule 16): the per-zone admin settings of driver group 7 with their defaults.
 * Read live from the zone's documents each time they are used, so an admin's change works at once. A missing field,
 * or one outside its range, reads as the default.
 */

type Range = [number, number];
type OnTripContract = {
  configDefaults: { maxStops: number; rideCheck: RideCheckSettings; routeChange: RouteChangeSettings };
  onTrip: { rideCheck: { settings: { ranges: Record<string, Range> } }; routeChange: { settings: { ranges: Record<string, Range> } } };
};
const C = contract as unknown as OnTripContract;

export type RideCheckSettings = { on: boolean; stopMinutes: number; offRouteKm: number; endFarMeters: number; noAnswerSeconds: number; repeatMinutes: number; noAnswerAlarm: boolean; scanEverySeconds: number };
export type FixedPriceTrips = "block" | "switch_to_normal";
export type RouteChangeSettings = { on: boolean; driverCanRefuse: boolean; answerSeconds: number; beforePickup: boolean; fixedPriceTrips: FixedPriceTrips };

export const RIDE_CHECK_DEFAULTS: RideCheckSettings = C.configDefaults.rideCheck;
export const ROUTE_CHANGE_DEFAULTS: RouteChangeSettings = C.configDefaults.routeChange;
export const MAX_STOPS_DEFAULT = C.configDefaults.maxStops;
const RC_RANGES = C.onTrip.rideCheck.settings.ranges;
const RX_RANGES = C.onTrip.routeChange.settings.ranges;

type Doc = Record<string, unknown>;
const isObj = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, range: Range | undefined, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) && (!range || (v >= range[0] && v <= range[1])) ? v : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

export function rideCheckSettingsOf(driverDoc: unknown): RideCheckSettings {
  const r = isObj(driverDoc) && isObj(driverDoc["rideCheck"]) ? driverDoc["rideCheck"] : {};
  const d = RIDE_CHECK_DEFAULTS;
  return {
    on: bool(r["on"], d.on),
    stopMinutes: num(r["stopMinutes"], RC_RANGES["stopMinutes"], d.stopMinutes),
    offRouteKm: num(r["offRouteKm"], RC_RANGES["offRouteKm"], d.offRouteKm),
    endFarMeters: num(r["endFarMeters"], RC_RANGES["endFarMeters"], d.endFarMeters),
    noAnswerSeconds: num(r["noAnswerSeconds"], RC_RANGES["noAnswerSeconds"], d.noAnswerSeconds),
    repeatMinutes: num(r["repeatMinutes"], RC_RANGES["repeatMinutes"], d.repeatMinutes),
    noAnswerAlarm: bool(r["noAnswerAlarm"], d.noAnswerAlarm),
    // v0.18.100 (BQ-V37, owner W1 Q66 = Q-B6): the scan runs at most once every this many seconds per trip (default 30).
    scanEverySeconds: num(r["scanEverySeconds"], RC_RANGES["scanEverySeconds"], d.scanEverySeconds),
  };
}

export function routeChangeSettingsOf(driverDoc: unknown): RouteChangeSettings {
  const r = isObj(driverDoc) && isObj(driverDoc["routeChange"]) ? driverDoc["routeChange"] : {};
  const d = ROUTE_CHANGE_DEFAULTS;
  const fixed = r["fixedPriceTrips"];
  return {
    on: bool(r["on"], d.on),
    driverCanRefuse: bool(r["driverCanRefuse"], d.driverCanRefuse),
    answerSeconds: Math.round(num(r["answerSeconds"], RX_RANGES["answerSeconds"], d.answerSeconds)),
    // Owner rule 16 (2026-11-01, G7 open questions 1 and 4): admin settings with the defaults that keep the earlier behaviour.
    beforePickup: bool(r["beforePickup"], d.beforePickup),
    fixedPriceTrips: fixed === "block" || fixed === "switch_to_normal" ? fixed : d.fixedPriceTrips,
  };
}

const maxStopsIn = (doc: unknown): number | null => {
  const v = isObj(doc) && isObj(doc["booking"]) ? doc["booking"]["maxStops"] : undefined;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10 ? v : null;
};

async function driverDocOf(ex: Executor, zoneId: string): Promise<Doc | undefined> {
  return (await liveDocument<Doc>(ex, "driver_app_config", zoneId))?.document;
}

export const rideCheckSettings = async (ex: Executor, zoneId: string) => rideCheckSettingsOf(await driverDocOf(ex, zoneId));
export const routeChangeSettings = async (ex: Executor, zoneId: string) => routeChangeSettingsOf(await driverDocOf(ex, zoneId));

/** The zone's max stops: RiderAppConfig.booking.maxStops, else DriverAppConfig.booking.maxStops, else 3 (contract.json#onTrip.maxStops). */
export async function maxStopsOf(ex: Executor, zoneId: string): Promise<number> {
  const rider = (await liveDocument<Doc>(ex, "rider_app_config", zoneId))?.document;
  return maxStopsIn(rider) ?? maxStopsIn(await driverDocOf(ex, zoneId)) ?? MAX_STOPS_DEFAULT;
}

/** 400 too_many_stops when the stops pass the zone's max (details maxStops=N). */
export async function checkMaxStops(ex: Executor, zoneId: string, stops: number): Promise<void> {
  const max = await maxStopsOf(ex, zoneId);
  if (stops > max) throw new ApiError("invalid_request", `You can add at most ${max} stops.`, { reason: "too_many_stops", details: [`maxStops=${max}`] });
}
