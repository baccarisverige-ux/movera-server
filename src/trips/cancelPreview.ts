import { contract } from "../contract/contract.js";
import type { TripRow } from "../db/tripLog.js";
import type { HeadingState } from "./headingCheck.js";
import { BOOKED_GRACE_MS, riderCancelFeeAt, type CancelFeeFacts, type RiderFee } from "./ride/cancelFeeAt.js";
import type { BookingRules } from "./ride/settings.js";
import { DEFAULT_CANCEL_AFTER_ARRIVED_IS_NO_SHOW, type Money, type Waiting } from "./ride/shared.js";

/**
 * v0.18.89 §90 (contract.json#priceDisplay.cancelPreview; owner 2026-11-14 "make sure rider and driver app show correct
 * prices every where"): TripProjection.cancelPreview { feeNow, kind, freeUntil?, feeAfterFree?, kindAfterFree? } for the
 * rider and the admin (never the driver). feeNow is the fee POST /trips/{tripId}/cancel charges at the projection's time —
 * the same rule (riderCancelFeeAt) with the facts kept on the trip; freeUntil is the first moment ahead at which that fee
 * changes (the free minutes end, the booked ride's grace ends, the free waiting ends → no-show), with the fee from then on.
 * A fact the trip does not keep (no kept rules, no cancel rule, no kept no-show fee where one is needed) → absent, never a guess.
 */

type Rider = { from: string[]; command: string; actor: string };
/** contract.json#transitions: the statuses the rider may cancel from. */
const RIDER_CANCEL_FROM = new Set((contract as unknown as { transitions: Rider[] }).transitions.find((t) => t.command === "cancel" && t.actor === "rider")?.from ?? []);
/** A live trip has a fee only once a driver has it. */
const LIVE_WITH_DRIVER = new Set(["accepted", "driver_to_pickup", "arrived"]);

/** The facts riderCancelFee reads from the database, from the trip row only (null when one is not kept). */
function factsOf(row: TripRow): CancelFeeFacts | null {
  const kept = row.booking_rules as Partial<BookingRules> | null;
  if (kept === null || typeof kept !== "object" || !kept.cancelRule) return null;
  const noShowOn = kept.cancelAfterArrivedIsNoShow ?? DEFAULT_CANCEL_AFTER_ARRIVED_IS_NO_SHOW;
  const waiting = row.waiting as Waiting | null;
  const noShowFee = waiting?.noShowFee ?? kept.waiting?.noShowFee;
  // The real cancel reads the category's no-show fee when the trip keeps none; the preview never guesses it.
  if (noShowFee === undefined && noShowOn && row.kind !== "scheduled" && row.status === "arrived" && waiting !== null) return null;
  // The heading check's free cancel (v0.18.13): its own clock, freeAfter, written by the ETA tick with the zone's minutes
  // (the tick clears the state when the zone turns the check off).
  const state = row.heading_check as HeadingState | null;
  const headingFree = (at: Date) => state !== null && !state.heading && !!state.freeAfter && at.getTime() >= Date.parse(state.freeAfter);
  return { rule: kept.cancelRule, cancelAfterArrivedIsNoShow: noShowOn, noShowFeeMinor: noShowFee?.amountMinor ?? 0, headingFree };
}

const same = (a: RiderFee | null, b: RiderFee | null) => (a?.fee.amountMinor ?? 0) === (b?.fee.amountMinor ?? 0) && (a?.kind ?? "cancel") === (b?.kind ?? "cancel");

export function cancelPreviewOf(row: TripRow, now: Date): Record<string, unknown> | null {
  if (row.ended_at !== null || !RIDER_CANCEL_FROM.has(row.status)) return null;
  if (row.kind === "scheduled" ? row.scheduled_at === null : !LIVE_WITH_DRIVER.has(row.status)) return null;
  const facts = factsOf(row);
  if (facts === null) return null;
  const feeAt = (at: Date) => riderCancelFeeAt(row, facts, at);
  const current = feeAt(now);
  const zero: Money = { amountMinor: 0, currency: row.currency };
  const out: Record<string, unknown> = { feeNow: current?.fee ?? zero, kind: current?.kind ?? "cancel" };
  // The moments the fee can change: the free minutes end (live: after accept; booked: before pickup), the booked ride's
  // grace after booking ends, the free waiting ends on an arrived trip (a cancel becomes a no-show).
  const freeMs = facts.rule!.freeMin * 60_000;
  const steps: number[] = [];
  if (row.kind === "scheduled") {
    steps.push(new Date(row.scheduled_at!).getTime() - freeMs, new Date(row.created_at).getTime() + BOOKED_GRACE_MS);
  } else if (row.accepted_at) {
    steps.push(new Date(row.accepted_at).getTime() + freeMs);
  }
  const waiting = row.waiting as Waiting | null;
  if (row.status === "arrived" && waiting) steps.push(Date.parse(waiting.freeUntil));
  for (const step of steps.filter((t) => t > now.getTime()).sort((a, b) => a - b)) {
    // Just after the step (a booked ride is free AT freeMin before pickup, charged right after).
    const next = feeAt(new Date(step + 1));
    if (next === null || same(next, current)) continue;
    out["freeUntil"] = new Date(step).toISOString();
    out["feeAfterFree"] = next.fee;
    out["kindAfterFree"] = next.kind;
    break;
  }
  return out;
}
