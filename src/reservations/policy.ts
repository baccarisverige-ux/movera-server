import type { Principal } from "../auth/guard.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { audit } from "../admin/audit.js";

/**
 * v0.18.19 (owner 2026-11-03, contract.json#bookLater.liveFixes.includedWaiting): the reservation policy for every zone.
 * includedWaitingMinutes is a booked ride's free waiting at the pickup, counted from the pickup time; it replaces the
 * zone's own waiting minutes for kind scheduled trips.
 */
export type ReservationPolicy = { includedWaitingMinutes: number; rev: number; updatedAt: string };

export async function reservationPolicy(ex: Executor): Promise<ReservationPolicy> {
  const row = await ex.selectFrom("reservation_policy").selectAll().where("id", "=", 1).executeTakeFirst();
  if (!row) return { includedWaitingMinutes: 5, rev: 1, updatedAt: new Date(0).toISOString() };
  return { includedWaitingMinutes: row.included_waiting_min, rev: row.rev, updatedAt: row.updated_at.toISOString() };
}

export async function saveReservationPolicy(trx: Trx, who: Principal, body: { expectedRev: number; includedWaitingMinutes: number }, now: Date): Promise<ReservationPolicy> {
  const minutes = body.includedWaitingMinutes;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60) throw badRequest("Included waiting must be 0 to 60 minutes.", "invalid_body");
  const current = await trx.selectFrom("reservation_policy").select(["rev", "included_waiting_min"]).where("id", "=", 1).forUpdate().executeTakeFirstOrThrow();
  if (current.rev !== body.expectedRev) throw new ApiError("version_mismatch", "Someone saved the reservation policy first. Load it again.");
  await trx.updateTable("reservation_policy").set({ included_waiting_min: minutes, rev: current.rev + 1, updated_at: now, updated_by: who.subjectId }).where("id", "=", 1).execute();
  await audit(trx, { adminId: who.subjectId, action: "reservation.policy", targetType: "reservation_policy", targetId: "all-zones", detail: { includedWaitingMinutes: { before: current.included_waiting_min, after: minutes }, rev: current.rev + 1 }, at: now });
  return reservationPolicy(trx);
}
