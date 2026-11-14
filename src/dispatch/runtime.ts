import { reservationTimer } from "../reservations/service.js";
import { RESERVATION_TIMER_KINDS } from "../reservations/timerKinds.js";
import { etaHandler } from "../trips/eta.js";
import { EstimateRouter } from "../maps/routing.js";
import type { Timer, TimerHandler } from "../jobs/timers.js";
import type { Trx } from "../db/db.js";
import { END, ROUND, STEP, WITHDRAW, WITHDRAW_CASH } from "./runtime/shared.js";
import { roundHandler } from "./runtime/rounds.js";
import { endHandler, stepHandler, withdrawHandler, withdrawCashHandler } from "./runtime/end.js";

/**
 * Automatic dispatch at run time (contract v0.5.1 §3.6) on durable timers, so a restart loses nothing:
 *   dispatch_round  → expire lapsed offers, then plan and send the next round (engine.planRound)
 *   search_step     → a rider-waiting step fires (alert_admin, keep_waiting, busy)
 *   search_end      → nobody accepted in time: the trip expires
 * Lock order everywhere: trip, then offer, then driver.
 *
 * Split into runtime/*.ts with no behaviour change (base job 2, 2026-11-04); this file keeps every public name.
 */

export { ROUND, STEP, END, WITHDRAW, lockTripNow } from "./runtime/shared.js";
export { startSearch } from "./runtime/start.js";
export { freeCandidatesByDistance, freeCandidatesDetailed } from "./runtime/candidates.js";
export { offerView, riderRatingForOffer, FeedQueue } from "./runtime/offers.js";
export { roundHandler, runRound } from "./runtime/rounds.js";
export { positiveSeconds, sendAdminOffers, refreshOpenOffers } from "./runtime/adminOffers.js";
export { acceptOffer, declineOffer } from "./runtime/answers.js";
export { stopSearch, stopBookedNoDriver, stepHandler, endHandler, keepWaiting, withdrawHandler } from "./runtime/end.js";

// Kept here, not in runtime/end.ts, so the map is built only after every runtime/*.ts module has loaded (as before the split).
// v0.18.7: the ETA tick booked at accept rides with the dispatch handlers (straight-line estimate here; main.ts sets the
// server's real router over it, [TRIP_ETA]: etaHandler(router)).
export const dispatchHandlers: Record<string, TimerHandler> = { [ROUND]: roundHandler, [STEP]: stepHandler, [END]: endHandler, [WITHDRAW]: withdrawHandler, [WITHDRAW_CASH]: withdrawCashHandler,
  // v0.18.17 (contract.json#bookLater.timers): the booked-ride timers (kinds from the leaf module reservations/timerKinds.ts,
  // which loads before this line even though reservations/service.ts imports this module; S02 C3).
  ...Object.fromEntries(RESERVATION_TIMER_KINDS.map((kind) => [kind, (trx: Trx, timer: Timer) => reservationTimer(trx, timer)])), // "trip_eta" spelled out and the handler made on first use: trips/eta.ts imports this module, so when eta.ts loads
// first (main.ts), TRIP_ETA is not initialised yet while this line runs (Render deploy of 48e587e crashed on it).
  trip_eta: (trx, timer) => etaHandler(new EstimateRouter())(trx, timer) };
