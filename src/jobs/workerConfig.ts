import { timerLanes, type TimerHandler, type TimerLane } from "./timers.js";
import { maintenanceHandlers } from "./maintenance.js";
import { RIDE_CHECK_SCAN, rideCheckScanHandler } from "../safety/rideCheckServer.js";
import { pricingHandlers } from "../pricing/surge.js";
import { ALERT_SWEEP, alertSweepHandler } from "../alerts/detector.js";
import { dispatchHandlers, ROUND, WITHDRAW } from "../dispatch/runtime.js";
import { RADAR_ZONE_REPEAT, radarZoneRepeatHandler } from "../dispatch/tools.js";
import { NEAR_DROPOFF, rideHandlers } from "../trips/ride.js";
import { callHandlers } from "../calls/service.js";
import { etaHandler, TRIP_ETA } from "../trips/eta.js";
import type { Router } from "../maps/routing.js";

/** Trip GPS work (ETA, ride check, near drop-off): its own lane, never on the general lanes (stress H1). */
export const TRIP_LANE_KINDS: readonly string[] = [TRIP_ETA, RIDE_CHECK_SCAN, NEAR_DROPOFF];

/**
 * The timer worker's handlers and lanes (S08 A1/A2, moved out of main.ts with no behaviour change).
 * Job 1 (fast dispatch): one lane only for dispatch rounds and withdrawals, the others for any timer (TIMER_LANES).
 * The real-router TRIP_ETA and RIDE_CHECK_SCAN handlers are set last on purpose, over the straight-line trip_eta that
 * dispatchHandlers carries.
 */
export function buildWorkerConfig(router: Router, o: { timerLanes: number; dispatchLanes: number }): { handlers: Record<string, TimerHandler>; lanes: TimerLane[] } {
  const handlers: Record<string, TimerHandler> = {
    ...maintenanceHandlers, ...dispatchHandlers, [RADAR_ZONE_REPEAT]: radarZoneRepeatHandler, ...rideHandlers, ...callHandlers, ...pricingHandlers,
    [ALERT_SWEEP]: alertSweepHandler,
  };
  handlers[TRIP_ETA] = etaHandler(router);
  handlers[RIDE_CHECK_SCAN] = rideCheckScanHandler(router);
  const lanes = timerLanes({ dispatchKinds: [ROUND, WITHDRAW], tripKinds: [...TRIP_LANE_KINDS], timerLanes: o.timerLanes, dispatchLanes: o.dispatchLanes });
  return { handlers, lanes };
}
