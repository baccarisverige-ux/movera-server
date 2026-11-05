import type { ReservationSettings } from "./plan.js";

/**
 * v0.18.35 FIX JOB 4 (CONTRACT.md §59, contract.json#bookedTakeBack; owner Q2 / Q-B / fix-plan Q2 of 2026-11-04, Rules
 * decisions/driver-g15.md). The ONE case the server takes a ride from a driver: a booked ride where he would reach the
 * pickup MORE than takeBackLateMin minutes after the pickup time, he is MORE than takeBackKeepIfDriveMin minutes' drive
 * away (closer = he keeps it), and the pickup is still at least takeBackUntilMinBeforePickup minutes away (inside that
 * time there is no time to find another driver, so he keeps it). A pure rule: no clock, no database.
 */
export function takeBackDecision(
  now: Date,
  scheduledAt: Date,
  driveSeconds: number | null,
  s: Pick<ReservationSettings, "takeBackLateMin" | "takeBackKeepIfDriveMin" | "takeBackUntilMinBeforePickup">,
): { take: boolean; lateMin: number } {
  if (driveSeconds === null) return { take: false, lateMin: 0 };
  const lateMs = now.getTime() + driveSeconds * 1000 - scheduledAt.getTime();
  const lateMin = Math.round(lateMs / 60_000);
  const late = lateMs > s.takeBackLateMin * 60_000;
  const far = driveSeconds > s.takeBackKeepIfDriveMin * 60;
  const inTime = now.getTime() <= scheduledAt.getTime() - s.takeBackUntilMinBeforePickup * 60_000;
  return { take: late && far && inTime, lateMin };
}

/** The driver_cancels reason of a take-back (counts on his cancel record, never a fee; not a wire CancelReasonCode). */
export const BOOKED_LATE_REASON = "booked_late_taken_back";
