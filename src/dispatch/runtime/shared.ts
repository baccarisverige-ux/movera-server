import type { Executor, Trx } from "../../db/db.js";
import type { TripRow } from "../../db/tripLog.js";
import { TimerBusy } from "../../jobs/timers.js";
import { DISPATCH, type Control } from "../engine.js";

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

export type Place = { lat: number; lng: number };
export type Step = { id: string; kind: string; message: string; extraMin?: number | null; atSec: number };

export const OPEN_STATUSES = ["searching", "offered"];
/**
 * v0.18.39 §63 (owner N2 "search keeps going until the rider cancels"): a live ride's search has no end time. Its
 * searches.end_at holds this far date (the column is NOT NULL) and no search_end timer is scheduled.
 */
export const NO_END = new Date("9999-12-31T00:00:00Z");
/** v0.18.39 §63: the id of the "No driver nearby" step in searches.steps / fired. */
export const NO_DRIVER_NEARBY_STEP = "nd";
export const PICKUP_KMH = DISPATCH.score.pickupKmh;
/** At most this many open Radar offers per driver (DriverAppConfig.offers.radarApp.full default, §3.3). */
export const RADAR_LIST_MAX = 8;

/** Timer handlers lock the trip without waiting: a command holding it may be waiting on this very timer. */
export async function lockTripNow(trx: Trx, tripId: string): Promise<TripRow | undefined> {
  try {
    return await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).forUpdate().noWait().executeTakeFirst();
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") throw new TimerBusy(`trip ${tripId} is busy`);
    throw error;
  }
}

export function localTime(zone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

export async function controlOf(ex: Executor, zoneId: string): Promise<Control> {
  const row = await ex.selectFrom("dispatch_controls").select(["paused", "mode"]).where("zone_id", "=", zoneId).executeTakeFirst();
  return row ? { paused: row.paused, mode: row.mode } : { paused: false, mode: null };
}
