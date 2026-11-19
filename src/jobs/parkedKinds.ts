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
 * B1.14 (owner W1 Q75 "A stopped dispatch round restarts once after 1 min, with an alert?" = Yes; contract 0.18.73
 * contract.json#alertDesk.serverDetection.kindDefaults.system_health.rule): dispatch_round too.
 * Before, nothing ever woke a parked round, so a live ride silently stopped getting offers. Its handler (runRound)
 * locks the trip and returns unless it is still searching or offered with a search, and an offer already out only
 * makes it wait for that offer (proof: restart_rechecks.test.ts; the restart itself: dispatch_round_restart.test.ts).
 * S4 B1.1 SF-1 (owner 2026-11-16 "Yes, same as drop-off (Rec.)"; contract 0.18.121
 * contract.json#alertDesk.serverDetection.kindDefaults.system_health.rule): pickup_geofence too. Since B1.1 round 2 a GPS
 * batch never wakes a failing or parked one, and one row serves the automatic arrival at the pickup, the waiting clock's
 * away / back (paid waiting) and the automatic arrival at the middle stops. Its handler locks the trip and re-checks the
 * status, the latest fix and the 2-fix confirm rule first (proof: restart_rechecks.test.ts; the restart itself:
 * pickup_geofence_restart.test.ts).
 * S4 B1.1 SF-2, round 4 (OQ-B101-2 "Yes, restart once + urgent alert (Rec.)": a SESSION decision under the owner's night
 * rule, 2026-11-16 17:53 UTC, the owner reviews it; contract 0.18.121, same rule text): trip_eta too. Since B1.1 round 1
 * nothing wakes a failing or parked tick, so the live road ETA, the rider's "almost there" push and the late check of a
 * booked ride stopped for the rest of the trip. trip_eta books its own next run and one run may push and take a late
 * booked ride back, so its restart is safe only because: the handler locks the trip and re-reads its target first; the
 * push is sent once per driver from the notification row (maybePushArriving); a ride taken back has no driver, so the
 * next run ends; everything a failed run did (the push, the take-back, the next tick it booked) is undone with it
 * (TimerWorker's savepoint); and (kind, ref_id) is unique, so there is one row whatever books it (proof:
 * restart_rechecks.test.ts; the restart itself, with the real handler failing after its work and two copies at the
 * restart: trip_eta_restart.test.ts).
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
  "pickup_geofence",
  "trip_eta",
];

/** Parked trip and safety kinds: their system_health alert is critical (the loud alarm). */
export const LOUD_PARKED_KINDS: readonly string[] = [...RESTART_ONCE_KINDS, "ride_check_no_answer", "withdraw_driver_offers"];

/** G34 S3 lane-late limits (contract v0.18.83 fastDispatch.lateAlarm); read by jobs/heartbeat.ts and, L20-6, the alert detector. */
export const LANE_LATE_LIMITS: ReadonlyArray<{ group: string; kinds: string[]; lateMs: number }> = [
  // The kind names, not the constants (no import of the trip / dispatch runtime here); test/jobs/heartbeat.test.ts checks them.
  { group: "trip_timers", kinds: ["trip_eta", "ride_check_scan", "near_dropoff", "pickup_geofence"], lateMs: 60_000 },
  { group: "dispatch", kinds: ["dispatch_round", "withdraw_driver_offers"], lateMs: 30_000 },
];
