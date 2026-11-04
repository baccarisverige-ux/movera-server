import { incidentHandlers } from "../safety/incidents.js";
import { rideCheckHandlers } from "../safety/rideCheck.js";
import { rideCheckScanHandler } from "../safety/rideCheckServer.js";
import { routeChangeExpireHandler } from "./routeChange.js";
import type { TimerHandler } from "../jobs/timers.js";
import { NEAR_DROPOFF } from "./ride/shared.js";
import { DRIVER_SILENCE, driverSilenceHandler, nearDropoffHandler } from "./ride/steps.js";
import { WAITING_NO_SHOW, WAITING_PAID, waitingAlertHandler } from "./ride/timers.js";

/**
 * The ride after a driver accepted (contract §3, §3.5, §3.7): the driver's steps, the waiting clock and no-show,
 * driver cancels (back to dispatch, or ended on board), the rider ending early, completion with cash, the rider's
 * cancel fee after accept, unpaid fees and ratings. Cash only in the test week (owner decision).
 *
 * Split into ride/*.ts with no behaviour change (base job 2, 2026-11-04); this file keeps every public name.
 */

export { DEFAULT_MAX_PICKUP_MOVE_METERS, DEFAULT_CANCEL_AFTER_ARRIVED_IS_NO_SHOW, validPickupMoveMeters, NEAR_DROPOFF_METERS, NEAR_DROPOFF, ARRIVE_MAX_METERS, positionMaxAge, COMPLETE_NEAR_DROPOFF_METERS } from "./ride/shared.js";
export { pricingOf, DEFAULT_CANCEL_SHARE, DEFAULT_LIVE_CANCEL_RULE, type BookingRules, type EarlyEndSettings, earlyEndSettingsOf, type PinSettings, pinSettingsOf, bookingRulesFor, cancelAfterArrivedOf, pickupMoveLimitOf, rulesOf, tripTerms, fareWithWaiting, scaledFare } from "./ride/settings.js";
export { releaseDriver, credit, refreshOutstanding, feeSplit } from "./ride/money.js";
export { newPin, driverStep, maybeNearDropoff, nearDropoffHandler, DRIVER_SILENCE, SILENT_ALERT_MS, SILENT_FAIL_MS, SILENT_RECHECK_MS, driverSilenceHandler, bookSilenceChecks } from "./ride/steps.js";
export { noShow, markNoShow, type RiderFee, riderCancelFee, riderFeeSharePct, riderFeeColumns, afterRiderCancel, driverCancelReasonsOf, driverCancel, backToDispatch, takeBackNotHeading } from "./ride/cancel.js";
export { endEarly, creditTrip, PREVIEW_FREEZE_SECONDS, completePreview, PriceChanged, completeTrip, rateTrip } from "./ride/finish.js";
export { driverEarnings } from "./ride/earnings.js";
export { WAITING_PAID, WAITING_NO_SHOW } from "./ride/timers.js";
export type { Who } from "./ride/shared.js";

// Kept here, not in ride/timers.ts, so the map is built only after every ride/*.ts module has loaded (as before the split).
export const rideHandlers: Record<string, TimerHandler> = {
  [NEAR_DROPOFF]: nearDropoffHandler,
  [DRIVER_SILENCE]: driverSilenceHandler,
  [WAITING_PAID]: waitingAlertHandler("paid_waiting_started"),
  [WAITING_NO_SHOW]: waitingAlertHandler("no_show_possible"),
  ...incidentHandlers,
  ...rideCheckHandlers,
  // v0.18.9: without a router the off-route check measures straight lines (main.ts passes the road router). A literal key
  // and a lazy call, so this object never touches rideCheckServer.js while the import cycle is still loading.
  ride_check_scan: (trx, timer) => rideCheckScanHandler()(trx, timer),
  // v0.18.9 (contract.json#onTrip.routeChange): the driver did not answer in time.
  route_change_expire: (trx, timer) => routeChangeExpireHandler(trx, timer),
};
