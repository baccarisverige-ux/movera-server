import { describe, expect, it } from "vitest";
import * as ride from "../../src/trips/ride.js";
import * as runtime from "../../src/dispatch/runtime.js";

// Base job 2 (2026-11-04): ride.ts and runtime.ts were split into parts with no behaviour change. These lists are the
// runtime names each module exported before the split; the timer handler maps keep every kind they had.
describe("split modules keep their public names", () => {
  it("trips/ride.ts", () => {
    expect(Object.keys(ride).sort()).toEqual([
      "ARRIVE_MAX_METERS", "COMPLETE_NEAR_DROPOFF_METERS", "DEFAULT_CANCEL_AFTER_ARRIVED_IS_NO_SHOW", "DEFAULT_CANCEL_SHARE", "DEFAULT_LIVE_CANCEL_RULE",
      "DEFAULT_MAX_PICKUP_MOVE_METERS", "DRIVER_SILENCE", "NEAR_DROPOFF", "NEAR_DROPOFF_METERS", "PICKUP_GEOFENCE", "PREVIEW_FREEZE_SECONDS", "PriceChanged",
      "SILENT_ALERT_MS", "SILENT_FAIL_MS", "SILENT_RECHECK_MS", "WAITING_NO_SHOW", "WAITING_PAID", "afterRiderCancel", "backToDispatch",
      "bookSilenceChecks", "bookingRulesFor", "cancelAfterArrivedOf", "completePreview", "completeTrip", "credit", "creditTrip", "driverCancel",
      "driverCancelReasonsOf", "driverEarnings", "driverSilenceHandler", "driverStep", "earlyEndSettingsOf", "endEarly", "fareWithWaiting", "feeSplit",
      // v0.18.93 (job C9, contract.json#autoArrive): the automatic arrival and the waiting clock.
      "geofenceOf", "geofenceProblem", "maybePickupGeofence",
      "markNoShow", "maybeNearDropoff", "nearDropoffHandler", "newPin", "noShow", "pickupMoveLimitOf", "pinSettingsOf", "positionMaxAge", "pricingOf",
      "rateTrip", "refreshOutstanding", "releaseDriver", "rideHandlers", "riderCancelFee", "riderFeeColumns", "riderFeeSharePct", "rulesOf", "scaledFare",
      "takeBackLateBooked", "takeBackNotHeading", "tripTerms", "validPickupMoveMeters",
    ].sort());
    for (const kind of [ride.NEAR_DROPOFF, ride.PICKUP_GEOFENCE, ride.DRIVER_SILENCE, ride.WAITING_PAID, ride.WAITING_NO_SHOW, "ride_check_scan", "route_change_expire"]) {
      expect(typeof ride.rideHandlers[kind]).toBe("function");
    }
  });

  it("dispatch/runtime.ts", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "END", "FeedQueue", "ROUND", "STEP", "WITHDRAW", "acceptOffer", "declineOffer", "dispatchHandlers", "endHandler", "freeCandidatesByDistance",
      "freeCandidatesDetailed", "keepWaiting", "lockTripNow", "offerView", "positiveSeconds", "refreshOpenOffers", "riderRatingForOffer", "roundHandler",
      "runRound", "sendAdminOffers", "startSearch", "stepHandler", "stopBookedNoDriver", "stopSearch", "withdrawHandler",
    ].sort());
    expect(Object.keys(runtime.dispatchHandlers).sort()).toEqual([
      runtime.ROUND, runtime.STEP, runtime.END, runtime.WITHDRAW, "resv_popup", "resv_open_all", "resv_dispatch", "resv_no_driver", "resv_rider_reminder",
      "resv_driver_reminder", "resv_go_online", "resv_offline_check", "resv_change_ask", "resv_overdue", "resv_leave_check", "resv_no_driver_stop", "trip_eta",
    ].sort());
  });
});
