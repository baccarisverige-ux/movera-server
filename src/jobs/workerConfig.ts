import { timerLanes, type TimerHandler, type TimerLane, type TimerWorkerOptions } from "./timers.js";
import { RESTART_ONCE_KINDS } from "./parkedKinds.js";
import { maintenanceHandlers, NIGHTLY, SWEEP_IDEMPOTENCY_KEYS } from "./maintenance.js";
import { HOUSEKEEPING_KINDS } from "./housekeeping.js";
import { RIDE_CHECK_SCAN, rideCheckScanHandler } from "../safety/rideCheckServer.js";
import { pricingHandlers } from "../pricing/surge.js";
import { ALERT_SWEEP, alertSweepHandler, raiseParkedAlert } from "../alerts/detector.js";
import { dispatchHandlers, ROUND, WITHDRAW } from "../dispatch/runtime.js";
import { RADAR_ZONE_REPEAT, radarZoneRepeatHandler } from "../dispatch/tools.js";
import { NEAR_DROPOFF, rideHandlers } from "../trips/ride.js";
import { callHandlers } from "../calls/service.js";
import { etaHandler, TRIP_ETA } from "../trips/eta.js";
import type { Router } from "../maps/routing.js";

export { RESTART_ONCE_KINDS, LOUD_PARKED_KINDS } from "./parkedKinds.js";

/** Trip GPS work (ETA, ride check, near drop-off): its own lane, never on the general lanes (stress H1). */
export const TRIP_LANE_KINDS: readonly string[] = [TRIP_ETA, RIDE_CHECK_SCAN, NEAR_DROPOFF];

/**
 * B1.7 (stage S4 wave B1; owner W1 Q71 "Cleaning on its own lane, after a test proves it delays SOS escalation?" = "Yes,
 * after the proof", 2026-11-11; proof: test/jobs/housekeeping_lane.test.ts). Every clean-up and bookkeeping run: the 12
 * housekeeping jobs (0.14b), the hourly sweep (payout pass) and the nightly run. They run only on the housekeeping lane;
 * every other kind (incident_escalate, alert_sweep, booked rides, calls, …) never waits behind them.
 */
export const HOUSEKEEPING_LANE_KINDS: readonly string[] = [...HOUSEKEEPING_KINDS, SWEEP_IDEMPOTENCY_KEYS, NIGHTLY];

/**
 * The timer worker's handlers and lanes (S08 A1/A2, moved out of main.ts with no behaviour change).
 * Job 1 (fast dispatch): one lane only for dispatch rounds and withdrawals, the others for any timer (TIMER_LANES).
 * The real-router TRIP_ETA and RIDE_CHECK_SCAN handlers are set last on purpose, over the straight-line trip_eta that
 * dispatchHandlers carries.
 * B1.6b: `parked` = a parked trip or safety timer runs once more, and parking any timer raises the alert naming it at once.
 * B1.7: housekeeping on its own `housekeepingLanes` loops (HOUSEKEEPING_LANES, default 1), never on the general lanes.
 */
export function buildWorkerConfig(router: Router, o: { timerLanes: number; dispatchLanes: number; housekeepingLanes?: number }): { handlers: Record<string, TimerHandler>; lanes: TimerLane[]; parked: Pick<TimerWorkerOptions, "restartOnce" | "onParked"> } {
  const handlers: Record<string, TimerHandler> = {
    ...maintenanceHandlers, ...dispatchHandlers, [RADAR_ZONE_REPEAT]: radarZoneRepeatHandler, ...rideHandlers, ...callHandlers, ...pricingHandlers,
    [ALERT_SWEEP]: alertSweepHandler,
  };
  handlers[TRIP_ETA] = etaHandler(router);
  handlers[RIDE_CHECK_SCAN] = rideCheckScanHandler(router);
  const lanes = timerLanes({ dispatchKinds: [ROUND, WITHDRAW], tripKinds: [...TRIP_LANE_KINDS], timerLanes: o.timerLanes, dispatchLanes: o.dispatchLanes, housekeepingKinds: [...HOUSEKEEPING_LANE_KINDS], housekeepingLanes: o.housekeepingLanes ?? 1 });
  return { handlers, lanes, parked: { restartOnce: RESTART_ONCE_KINDS, onParked: raiseParkedAlert } };
}
