import { contract } from "../../contract/contract.js";
import { liveDocument } from "../../config/service.js";
import type { Executor } from "../../db/db.js";
import type { WaitingRuleId } from "../waitingRules.js";

/**
 * The ride after a driver accepted (contract §3, §3.5, §3.7): the driver's steps, the waiting clock and no-show,
 * driver cancels (back to dispatch, or ended on board), the rider ending early, completion with cash, the rider's
 * cancel fee after accept, unpaid fees and ratings. Cash only in the test week (owner decision).
 */

export type Money = { amountMinor: number; currency: string };
export type Place = { lat: number; lng: number };
export type WaitingAlert = { kind: "paid_waiting_started" | "no_show_possible"; at: string };
/** v0.18.8 (contract.json#arrivedWaiting): the effective rule numbers set at arrive, and the island alerts sent. */
export type Waiting = {
  arrivedAt: string; freeUntil: string; noShowAt: string; chargedSeconds: number; noShowFee?: Money; noShowDriverShare?: Money;
  rules?: WaitingRuleId[]; freeWaitMin?: number; perMin?: Money; noShowAfterMin?: number; alerts?: WaitingAlert[];
};
export type Who = { actor: "rider" | "driver" | "admin"; subjectId: string };

const C = contract as unknown as {
  cancelReasons: Record<string, string[]>;
  configDefaults: { noShowDriverSharePct: number; maxPickupMoveMeters: number; cancelAfterArrivedIsNoShow: boolean };
  pickupWaiting: { pickupMove: { range: [number, number] } };
};
export const REASONS = C.cancelReasons;
export const DEFAULT_NO_SHOW_SHARE = C.configDefaults.noShowDriverSharePct;
/** v0.18.7 (contract.json#pickupWaiting): the pickup move limit and the cancel-after-arrival rule, per zone, with their defaults. */
export const DEFAULT_MAX_PICKUP_MOVE_METERS = C.configDefaults.maxPickupMoveMeters;
export const DEFAULT_CANCEL_AFTER_ARRIVED_IS_NO_SHOW = C.configDefaults.cancelAfterArrivedIsNoShow;
const PICKUP_MOVE_RANGE = C.pickupWaiting.pickupMove.range;
export const validPickupMoveMeters = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= PICKUP_MOVE_RANGE[0] && value <= PICKUP_MOVE_RANGE[1] ? value : null;

/** Within this distance of the drop-off the trip shows "Almost there" (near_dropoff). */
export const NEAR_DROPOFF_METERS = 500;
export const NEAR_DROPOFF = "near_dropoff";
/* v0.18.13: the old came-closer check (400 m/min × 50 %, once at the cancel) is replaced by the heading check (headingCheck.ts). */
/** "Arrived" is accepted within this distance of the pickup (the driver's latest fix). */
export const ARRIVE_MAX_METERS = 300;
const POSITION_MAX_AGE = (contract as unknown as { arrivedWaiting: { positionMaxAge: { default: number; range: [number, number] } } }).arrivedWaiting.positionMaxAge;

/** v0.18.14: DriverAppConfig.waiting.positionMaxAgeSeconds of the zone (default 60, range 15–600). */
export async function positionMaxAge(ex: Executor, zoneId: string): Promise<number> {
  const doc = await liveDocument<{ waiting?: { positionMaxAgeSeconds?: unknown } }>(ex, "driver_app_config", zoneId);
  const v = doc?.document.waiting?.positionMaxAgeSeconds;
  return typeof v === "number" && Number.isInteger(v) && v >= POSITION_MAX_AGE.range[0] && v <= POSITION_MAX_AGE.range[1] ? v : POSITION_MAX_AGE.default;
}
/** A trip completed farther than this from the drop-off (the driver's latest fix) ended early: the rider pays what was driven. */
export const COMPLETE_NEAR_DROPOFF_METERS = 300;

export const ONBOARD = ["rider_onboard", "in_trip", "approaching_dropoff"];
