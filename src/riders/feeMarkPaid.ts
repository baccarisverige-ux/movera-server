import { z } from "zod";
import type { Principal } from "../auth/guard.js";
import { adminCoversZone } from "../auth/guard.js";
import type { Trx } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { audit } from "../admin/audit.js";
import { adminRiderView, riderWallets } from "../admin/lists.js";
import { correctFee } from "./debt.js";
import { refreshOutstanding } from "../trips/ride/money.js";

/**
 * v0.18.39 fix job 0 (owner A2-2 2026-11-05 "Only mark and detect from next trip so add to next trip";
 * contract.json#outstandingFee.adminMarkPaid): POST /admin/riders/{riderId}/fees/{tripId}/mark-paid { reason }.
 * The one admin action on an owed fee: the rider paid Movera another way. There is no "Ask rider to pay"; a fee left
 * owed is added by itself to the rider's next trip in its currency (trips/ride/money.ts).
 */
export const FeeMarkPaidBody = z.object({ reason: z.string().max(300).optional().default("") });

export async function markRiderFeePaid(trx: Trx, who: Principal, riderId: string, tripId: string, body: { reason: string }, currency: string, now: Date) {
  const reason = body.reason.trim();
  if (!reason) throw new ApiError("invalid_request", "Write why the fee is marked as paid.", { reason: "reason_required" });
  const rider = await trx.selectFrom("riders").selectAll().where("rider_id", "=", riderId).forUpdate().executeTakeFirst();
  if (!rider) throw new ApiError("not_found", "No such rider.", { reason: "rider_not_found" });
  // Zone scope first (never tell an admin outside the zone anything about the fee).
  const trip = await trx.selectFrom("trips").select(["trip_id", "zone_id", "cancellation", "version"]).where("trip_id", "=", tripId).where("rider_id", "=", riderId).executeTakeFirst();
  if (trip && !adminCoversZone(who, trip.zone_id)) throw new ApiError("forbidden", "This trip is outside your zones.", { reason: "zone_out_of_scope" });
  const fee = trip ? await trx.selectFrom("rider_fees").selectAll().where("trip_id", "=", tripId).where("rider_id", "=", riderId).forUpdate().executeTakeFirst() : undefined;
  if (!trip || !fee || fee.status !== "owed") throw new ApiError("invalid_transition", "This rider owes no fee for that trip.", { reason: "fee_not_owed", projection: adminRiderView(rider, currency, undefined, (await riderWallets(trx, [riderId])).get(riderId), who) });
  // S5 J8 (contract v0.18.84 debtModel.adminCorrections): a correction entry in the wallet (+the fee, at most what is
  // still owed); a ride open now simply reads the lower debt when it is paid (no fee_on_running_trip any more).
  await correctFee(trx, fee, now);
  await trx.updateTable("rider_fees").set({ status: "paid", carried_by: null, settled_at: now }).where("trip_id", "=", tripId).execute();
  // The original trip says paid too (no version change: nothing the driver or rider acts on changed).
  await trx.updateTable("trips").set({ cancellation: JSON.stringify({ ...((trip.cancellation ?? {}) as object), feeStatus: "paid" }) }).where("trip_id", "=", tripId).execute();
  await refreshOutstanding(trx, riderId, now);
  await trx.updateTable("riders").set({ version: rider.version + 1, updated_at: now }).where("rider_id", "=", riderId).execute();
  await audit(trx, { adminId: who.subjectId, action: "rider.fee_mark_paid", targetType: "rider", targetId: riderId, zoneId: trip.zone_id, detail: { tripId, kind: fee.kind, amountMinor: Number(fee.amount_minor), currency: fee.currency, reason }, at: now });
  return adminRiderView(await trx.selectFrom("riders").selectAll().where("rider_id", "=", riderId).executeTakeFirstOrThrow(), currency, undefined, (await riderWallets(trx, [riderId])).get(riderId), who);
}
