import { contract } from "../../contract/contract.js";
import type { TripRow } from "../../db/tripLog.js";
import { cancelFee, isFreeCancel, type FeeRule } from "../../rules/cancelFees.js";
import type { Money, Waiting } from "./shared.js";
import { clockAt } from "./waitingClock.js";

/**
 * The rider's cancel fee at a moment, from facts already read (contract §3, §5 "Live cancel fees per category";
 * contract.json#transitions `fee: "riderCancelFee"`). One rule for the real cancel (riderCancelFee, ride/cancel.ts, which
 * reads the facts from the database) and for TripProjection.cancelPreview (v0.18.89 §90, which reads them from the trip
 * row), so the preview is always the fee the cancel charges.
 */
export type RiderFee = { fee: Money; kind: "cancel" | "no_show" };

export type CancelFeeFacts = {
  /** The trip's cancel rule (BookingRules.cancelRule); null = free. */
  rule: FeeRule | null;
  cancelAfterArrivedIsNoShow: boolean;
  /** The no-show fee charged for a cancel after the free waiting (waiting.noShowFee, else the category's). */
  noShowFeeMinor: number;
  /** v0.18.13 heading check: true when the rider may cancel free at `at` because the driver is not heading to the pickup. */
  headingFree: (at: Date) => boolean;
};

/** v0.18.49 §71 (owner Q10 update, contract.json#afterTestRules.bookedCancel.graceAfterBookingMin): 5 min, fixed. */
export const BOOKED_GRACE_MS = (contract as unknown as { afterTestRules: { bookedCancel: { graceAfterBookingMin: number } } }).afterTestRules.bookedCancel.graceAfterBookingMin * 60_000;

type FeeTrip = Pick<TripRow, "kind" | "status" | "scheduled_at" | "accepted_at" | "driver_id" | "next_after_trip_id" | "chained" | "chain_free_cancel_at" | "created_at" | "booked_fare_minor" | "fare_lines" | "currency" | "waiting">;

/** The cancel is free whatever the rules (no driver yet, a queued trip, a late chained trip, a booked ride past pickup, the booking grace). */
export function freeWithoutRules(trip: FeeTrip, now: Date): boolean {
  // v0.18.33 (fix job 5, owner fix-plan Q3, contract.json#afterTestRules.bookedCancel): a BOOKED ride cancelled after
  // the category's free minutes costs the fee even when no driver took it yet (Movera keeps it, owner Q5).
  const bookedNoDriver = trip.kind === "scheduled" && trip.scheduled_at !== null && (trip.accepted_at === null || trip.driver_id === null);
  if (!bookedNoDriver && (trip.accepted_at === null || trip.driver_id === null)) return true;
  // v0.18.33 (owner Q3): a live trip queued behind the driver's current trip: he is not on his way yet, the cancel is free.
  if (trip.next_after_trip_id) return true;
  // Owner Q5: a chained trip whose rider has waited more than lateFreeCancelMin since accept may cancel free.
  if (trip.chained && trip.chain_free_cancel_at && now.getTime() >= new Date(trip.chain_free_cancel_at).getTime()) return true;
  // Its pickup time passed with no driver: Movera did not deliver it, always free (rider app terms, owner P17 "no fee").
  if (bookedNoDriver && now.getTime() >= new Date(trip.scheduled_at!).getTime()) return true;
  // v0.18.49 §71 (owner Q10 update): the first graceAfterBookingMin minutes after booking a booked ride cancels free, so a
  // short-notice booking does not owe the fee at once.
  if (trip.kind === "scheduled" && now.getTime() - new Date(trip.created_at).getTime() < BOOKED_GRACE_MS) return true;
  return false;
}

/** True when a cancel at `now` would be a no-show (arrived live trip, the zone's switch on, the free waiting over).
 * v0.18.93 (contract.json#autoArrive): the free waiting is read on the waiting clock, frozen at away.since while the driver is away. */
export function cancelIsNoShow(trip: FeeTrip, cancelAfterArrivedIsNoShow: boolean, now: Date): boolean {
  const waiting = trip.waiting as Waiting | null;
  return trip.kind !== "scheduled" && trip.status === "arrived" && cancelAfterArrivedIsNoShow && waiting !== null && clockAt(waiting, now).getTime() >= Date.parse(waiting.freeUntil);
}

export function riderCancelFeeAt(trip: FeeTrip, facts: CancelFeeFacts, now: Date): RiderFee | null {
  if (freeWithoutRules(trip, now)) return null;
  // v0.18.93 round 2 (contract.json#autoArrive.riderCancel, supervisor M3; owner verbatim, Rules decisions/driver-g15.md:64:
  // "if driver drive away from pickup … if rider cancel he got no cancellation fee"): while the waiting clock stands still
  // (the driver is away from the pickup) the rider's cancel is free — no cancel fee, no no-show fee, live or booked.
  if (trip.status === "arrived" && (trip.waiting as Waiting | null)?.away) return null;
  // v0.18.49 §71 (owner Q10 "Category rule B only", contract.json#bookLater.rider.cancel): only the category's free
  // minutes (isFreeCancel below) make a booked cancel free; freeChangeBeforeMin is the change window only.
  const rule = facts.rule;
  if (rule === null) return null;
  const owed = ((trip.fare_lines as Array<{ code: string; amount: Money }> | null) ?? []).find((l) => l.code === "outstanding_fee");
  const fare = { amountMinor: Number(trip.booked_fare_minor) - (owed ? owed.amount.amountMinor : 0), currency: trip.currency };
  const minutesSinceAccept = trip.accepted_at ? (now.getTime() - new Date(trip.accepted_at).getTime()) / 60_000 : 0;
  const minutesBeforePickup = trip.scheduled_at ? (new Date(trip.scheduled_at).getTime() - now.getTime()) / 60_000 : 0;
  const kind = trip.kind === "scheduled" ? "reservation" : "live";
  // v0.18.7 (Q2, contract.json#pickupWaiting.cancelAfterArrived): inside the free minutes the rider always cancels free,
  // also after the driver arrived (owner 2026-10-29). After them, a cancel with the driver at the pickup is a no-show
  // when the zone says so (admin setting, default on): the no-show fee with the no-show share.
  if (isFreeCancel({ kind, rule, minutesSinceAccept, minutesBeforePickup })) return null;
  // Checker M1: it is a no-show only from waiting.freeUntil on, the moment the driver himself could mark one (a
  // reservation's clock runs from the booked time); a cancel seconds after arrival is the normal cancel fee.
  // v0.18.51 §73 (owner 2026-11-07 "If rider cancel do booking fee … (for only reservation)"): a booked ride's cancel
  // after arrival is the booked late-cancel fee below (feeKind cancel), never turned into the no-show fee.
  if (cancelIsNoShow(trip, facts.cancelAfterArrivedIsNoShow, now)) {
    return facts.noShowFeeMinor > 0 ? { fee: { amountMinor: facts.noShowFeeMinor, currency: trip.currency }, kind: "no_show" } : null;
  }
  const amount = cancelFee({ kind, rule, fare: fare as Parameters<typeof cancelFee>[0]["fare"], minutesSinceAccept, minutesBeforePickup });
  if (amount.amountMinor <= 0) return null;
  // v0.18.13 (owner G5-8, contract.json#pickupWaiting.headingCheck.riderCancel): after the free minutes the rider pays
  // only while the driver is heading to the pickup (checked with every ETA tick); not heading for notHeadingMinutes in
  // a row = free. Checker 1: no check yet (a trip accepted before the deploy, no position so far) = the normal fee rules.
  if (trip.kind === "live" && trip.status !== "arrived" && facts.headingFree(now)) return null;
  return { fee: amount, kind: "cancel" };
}
