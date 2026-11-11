/**
 * The booked-ride timer kinds (contract.json#bookLater.timers). A leaf module with no imports, so dispatch/runtime.ts can
 * build its handler map from it at load time (reservations/service.ts imports dispatch/runtime.ts, S08 A2).
 */
export const TIMER = {
  popup: "resv_popup",
  openAll: "resv_open_all",
  dispatch: "resv_dispatch",
  noDriver: "resv_no_driver",
  riderReminder: "resv_rider_reminder",
  driverReminder: "resv_driver_reminder",
  goOnline: "resv_go_online",
  offlineCheck: "resv_offline_check",
  changeAsk: "resv_change_ask",
  leaveCheck: "resv_leave_check",
  overdue: "resv_overdue",
  /** v0.18.39 §63 (P17): pickup + noDriverStopAfterMin with no driver → the ride ends (no fee). */
  noDriverStop: "resv_no_driver_stop",
} as const;
export const RESERVATION_TIMER_KINDS: string[] = Object.values(TIMER);
