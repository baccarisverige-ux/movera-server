/**
 * B1.6b (stage S4 wave B1; owner W1 Q70 "Re-arm every stopped job at start, a loud alarm for stopped trip and safety
 * jobs, and an admin 'Retry job' button?" = Yes, 2026-11-11). A leaf module (plain names, no imports), so the alert
 * detector and the worker set-up can both read it without an import cycle.
 */

/**
 * Trip and safety kinds whose parked timer runs once more (TimerWorker restartOnce; restartParkedOnce at start). Each
 * kind is here only because its handler re-checks the trip or case first, proven in test/jobs/restart_rechecks.test.ts
 * (a second run changes nothing). Not here yet: withdraw_driver_offers (it withdraws the driver's open offers without
 * looking whether he is still offline or blocked) and dispatch_round (B1.14).
 */
export const RESTART_ONCE_KINDS: readonly string[] = [
  "incident_escalate",
  "ride_check_no_answer",
  "ride_check_scan",
  "near_dropoff",
  "waiting_paid",
  "waiting_no_show",
  "driver_silence",
  "search_step",
  "search_end",
];

/** Parked trip and safety kinds: their system_health alert is critical (the loud alarm). */
export const LOUD_PARKED_KINDS: readonly string[] = [...RESTART_ONCE_KINDS, "withdraw_driver_offers", "dispatch_round"];
