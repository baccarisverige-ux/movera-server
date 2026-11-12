/**
 * B1.6b (stage S4 wave B1; owner W1 Q70 "Re-arm every stopped job at start, a loud alarm for stopped trip and safety
 * jobs, and an admin 'Retry job' button?" = Yes, 2026-11-11). A leaf module (plain names, no imports), so the alert
 * detector and the worker set-up can both read it without an import cycle.
 */

/**
 * Trip and safety kinds whose parked timer runs once more (TimerWorker restartOnce; restartParkedOnce at start). Each
 * kind is here only because its handler re-checks the trip or case first, proven in test/jobs/restart_rechecks.test.ts
 * (a second run changes nothing). Not here: ride_check_no_answer (its handler does not look at the trip state, so a
 * restart could open a new safety case for a trip that ended — supervisor B1.6b F1), withdraw_driver_offers (it
 * withdraws the driver's open offers without looking whether he is still offline or blocked).
 * B1.14 (owner W1 Q75 "A stopped dispatch round restarts once after 1 min, with an alert?" = Yes): dispatch_round too.
 * Before, nothing ever woke a parked round, so a live ride silently stopped getting offers. Its handler (runRound)
 * locks the trip and returns unless it is still searching or offered with a search, and an offer already out only
 * makes it wait for that offer (proof: restart_rechecks.test.ts; the restart itself: dispatch_round_restart.test.ts).
 */
export const RESTART_ONCE_KINDS: readonly string[] = [
  "incident_escalate",
  "ride_check_scan",
  "near_dropoff",
  "waiting_paid",
  "waiting_no_show",
  "driver_silence",
  "search_step",
  "search_end",
  "dispatch_round",
];

/** Parked trip and safety kinds: their system_health alert is critical (the loud alarm). */
export const LOUD_PARKED_KINDS: readonly string[] = [...RESTART_ONCE_KINDS, "ride_check_no_answer", "withdraw_driver_offers"];
