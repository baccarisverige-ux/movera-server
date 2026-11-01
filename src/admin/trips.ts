import { sql } from "kysely";
import { pickGroup, pickRadarZone, startRadarZoneSend, stopRadarZoneSend } from "../dispatch/tools.js";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import { liveDocument } from "../config/service.js";
import type { Executor, Trx } from "../db/db.js";
import { lockTrip, type TripRow } from "../db/tripLog.js";
import { dispatchKm } from "../dispatch/engine.js";
import { refreshOpenOffers, sendAdminOffers, stopSearch, offerView } from "../dispatch/runtime.js";
import { DISPATCH_FIX_MAX_AGE_SECONDS, STALE_AFTER_SECONDS } from "../drivers/service.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { TERMINAL, isTripStatus } from "../rules/transitions.js";
import { applyCommand, expectVersion, touchTrip } from "../trips/commands.js";
import { tripProjection } from "../trips/projection.js";
import { backToDispatch, completeTrip, credit, fareWithWaiting, markNoShow, refreshOutstanding, releaseDriver, scaledFare } from "../trips/ride.js";
import { audit } from "./audit.js";
import { registerApprovalHandler, runOrRequest, type PendingApproval } from "./approvals.js";
import { resumTripDay } from "./kpis.js";

/**
 * The admin's trip tools (contract §3, §3.1; owner decisions 30–34): cancel, reassign, direct assign, radar
 * group, no-show, complete, fare corrections, a driver bonus and refunds. Every change is audited.
 */

type Money = { amountMinor: number; currency: string };
type Place = { lat: number; lng: number };

const C = contract as unknown as {
  cancelReasons: { admin: string[] };
  configDefaults: { countries: Record<string, { driverBonus: { defaultLimit: Money; hardMax: Money } }> };
};
const ADMIN_REASONS = C.cancelReasons.admin;
const terminal = (status: string) => isTripStatus(status) && TERMINAL.has(status);

/** The trip, locked, in the admin's zones (403 zone_out_of_scope), at the version the admin saw. */
async function lockForAdmin(trx: Trx, who: Principal, tripId: string, expectedVersion: number): Promise<TripRow> {
  const trip = await lockTrip(trx, tripId);
  if (!adminCoversZone(who, trip.zone_id)) throw new ApiError("forbidden", "This trip is outside your zones.", { reason: "zone_out_of_scope" });
  expectVersion(trip, expectedVersion, "admin");
  return trip;
}

export async function adminTrip(ex: Executor, who: Principal, tripId: string): Promise<TripRow> {
  const trip = await ex.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirst();
  if (!trip) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
  if (!adminCoversZone(who, trip.zone_id)) throw new ApiError("forbidden", "This trip is outside your zones.", { reason: "zone_out_of_scope" });
  return trip;
}

function sameCurrency(trip: TripRow, money: Money | undefined, what: string) {
  if (money && money.currency !== trip.currency) throw badRequest(`${what} must be in ${trip.currency}.`, "currency_mismatch");
}

/* ---------------------------------------------------------------- driver bonus limits */

/** DriverAppConfig.driverBonus of the zone, else the country default (SE 200 kr, at most 1 000 kr). */
async function bonusLimit(ex: Executor, trip: TripRow): Promise<number> {
  const live = await liveDocument<{ driverBonus?: { defaultLimit?: Money; hardMax?: Money } }>(ex, "driver_app_config", trip.zone_id);
  const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", trip.zone_id).executeTakeFirst();
  const fallback = C.configDefaults.countries[zone?.country ?? "SE"]?.driverBonus ?? C.configDefaults.countries["SE"]!.driverBonus;
  const limit = live?.document.driverBonus?.defaultLimit?.amountMinor ?? fallback.defaultLimit.amountMinor;
  const hardMax = live?.document.driverBonus?.hardMax?.amountMinor ?? fallback.hardMax.amountMinor;
  return Math.min(limit, hardMax);
}

/**
 * Every bonus on a trip counts toward its limit: the bonus waiting on the trip plus what was already paid out on
 * it (lost drivers, or the bonus paid at completion, which is the same money then).
 */
async function bonusSoFar(ex: Executor, trip: TripRow): Promise<number> {
  const paid = await ex.selectFrom("earnings_entries").select((eb) => eb.fn.coalesce(eb.fn.sum<string>("amount_minor"), sql<string>`0`).as("n")).where("trip_id", "=", trip.trip_id).where("kind", "=", "bonus").executeTakeFirstOrThrow();
  return (trip.status === "completed" ? 0 : Number(trip.driver_bonus_minor ?? 0)) + Number(paid.n);
}

/** A trip's fare is never below 0 (audit Phase 4, P4-3: a negative fare made negative driver earnings). */
function notBelowZero(fare: Money | undefined) {
  if (fare !== undefined && fare.amountMinor < 0) throw badRequest("The fare cannot be below 0.", "invalid_amount");
}

async function checkBonus(ex: Executor, trip: TripRow, amount: Money) {
  sameCurrency(trip, amount, "The bonus");
  if (amount.amountMinor <= 0) throw badRequest("The bonus must be more than 0.", "invalid_amount");
  const limit = await bonusLimit(ex, trip);
  if ((await bonusSoFar(ex, trip)) + amount.amountMinor > limit) {
    throw badRequest(`A trip can carry at most ${limit / 100} ${trip.currency} of bonus; adjust the limit in Pricing.`, "bonus_over_limit");
  }
}

/** Movera's money for the driver who lost the trip (owner decisions 32, 33): a bonus entry, at once. */
async function payLostDriver(trx: Trx, trip: TripRow, bonus: Money | undefined, now: Date) {
  if (!bonus) return;
  if (!trip.driver_id) throw badRequest("This trip has no driver to pay.", "no_driver");
  await checkBonus(trx, trip, bonus);
  await credit(trx, { driverId: trip.driver_id, tripId: trip.trip_id, kind: "bonus", currency: trip.currency, amount: bonus.amountMinor }, now);
}

/* ---------------------------------------------------------------- cancel, reassign */

type ReasonBody = { expectedVersion: number; reasonCode: string; note: string; driverBonus?: Money };

export async function adminCancel(trx: Trx, who: Principal, tripId: string, body: ReasonBody, now: Date): Promise<TripRow> {
  if (!ADMIN_REASONS.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not an admin reason.`, "invalid_reason_code");
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  // The rider pays nothing (owner decision 33); the admin's note stays in the audit.
  const cancellation = { actor: "admin", reasonCode: body.reasonCode, at: now.toISOString(), fee: null };
  const cancelled = await applyCommand(trx, trip, { command: "cancel", actor: "admin", now, set: { cancellation: JSON.stringify(cancellation), ended_by_command: "cancel", ended_at: now, search_step: null } });
  await stopSearch(trx, cancelled, now);
  await payLostDriver(trx, trip, body.driverBonus, now);
  await releaseDriver(trx, trip.driver_id, now);
  await audit(trx, { adminId: who.subjectId, action: "trip.cancel", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { reasonCode: body.reasonCode, note: body.note, from: trip.status, driverId: trip.driver_id, driverBonus: body.driverBonus ?? null }, at: now });
  return cancelled;
}

export async function adminReassign(trx: Trx, who: Principal, tripId: string, body: ReasonBody, now: Date): Promise<TripRow> {
  if (!ADMIN_REASONS.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not an admin reason.`, "invalid_reason_code");
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  await payLostDriver(trx, trip, body.driverBonus, now);
  const back = await backToDispatch(trx, trip, { command: "reassign", actor: "admin", now });
  await audit(trx, { adminId: who.subjectId, action: "trip.reassign", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { reasonCode: body.reasonCode, note: body.note, from: trip.status, driverId: trip.driver_id, driverBonus: body.driverBonus ?? null }, at: now });
  return back;
}

/* ---------------------------------------------------------------- assign, radar group, bonus */

type OfferBody = { expectedVersion: number; note?: string; driverBonus?: Money; priority?: boolean };

async function withBonus(trx: Trx, trip: TripRow, body: OfferBody): Promise<TripRow> {
  if (!body.driverBonus && body.priority === undefined) return trip;
  const already = Number(trip.driver_bonus_minor ?? 0);
  if (body.driverBonus) await checkBonus(trx, trip, body.driverBonus);
  const bonus = already + (body.driverBonus?.amountMinor ?? 0);
  await trx.updateTable("trips").set({ driver_bonus_minor: bonus, commission_minor: Number(trip.fare_minor) - Number(trip.driver_earnings_minor ?? 0) - Number(trip.pickup_pay_minor ?? 0) - bonus, ...(body.priority !== undefined ? { priority: body.priority } : {}) }).where("trip_id", "=", trip.trip_id).execute();
  return trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
}

async function offerTo(trx: Trx, who: Principal, tripId: string, driverIds: string[], kind: "assigned" | "radar", body: OfferBody, now: Date, extra: { seconds?: number; detail?: Record<string, unknown> } = {}) {
  let trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  // Locked once a driver accepted (contract.json#adminDispatch.lockedStatuses): the transition table says so.
  trip = await withBonus(trx, trip, body);
  trip = await applyCommand(trx, trip, { command: "assign", actor: "admin", now });
  const sent = await sendAdminOffers(trx, trip, driverIds, kind, now, extra.seconds);
  await audit(trx, { adminId: who.subjectId, action: kind === "assigned" ? "trip.assign" : "trip.radar_group", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { driverIds, note: body.note ?? null, driverBonus: body.driverBonus ?? null, priority: body.priority ?? null, groupId: sent.groupId, ...(extra.detail ?? {}) }, at: now });
  return { trip, ...sent };
}

export async function adminAssign(trx: Trx, who: Principal, tripId: string, body: OfferBody & { driverId: string }, now: Date): Promise<TripRow> {
  return (await offerTo(trx, who, tripId, [body.driverId], "assigned", body, now)).trip;
}

export async function adminRadarGroup(trx: Trx, who: Principal, tripId: string, body: OfferBody & { driverIds?: string[]; groupId?: string; radarZoneId?: string; ruleId?: string }, now: Date) {
  // v0.18.6 (G4-F3, F4, contract.json#adminDispatch.radarGroup.v0186): exactly one of driverIds, groupId, radarZoneId + ruleId.
  const ways = [body.driverIds !== undefined, body.groupId !== undefined, body.radarZoneId !== undefined || body.ruleId !== undefined].filter(Boolean).length;
  if (ways !== 1 || (body.radarZoneId === undefined) !== (body.ruleId === undefined)) throw badRequest("Give driverIds, or groupId, or radarZoneId with ruleId.", "radar_group_target");
  if (body.driverIds !== undefined) {
    if (body.driverIds.length === 0) throw badRequest("Give at least one driver.", "invalid_body");
    if (new Set(body.driverIds).size !== body.driverIds.length) throw badRequest("Each driver once.", "duplicate_driver");
    const sent = await offerTo(trx, who, tripId, body.driverIds, "radar", body, now);
    return { groupId: sent.groupId!, tripId, offers: sent.offers, expiresAt: sent.expiresAt.toISOString(), projection: tripProjection(sent.trip, "admin"), pickedFrom: "drivers" };
  }
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  if (body.groupId !== undefined) {
    const ids = await pickGroup(trx, who, trip, body.groupId, now);
    const sent = await offerTo(trx, who, tripId, ids, "radar", body, now, { detail: { driverGroupId: body.groupId } });
    return { groupId: sent.groupId!, tripId, offers: sent.offers, expiresAt: sent.expiresAt.toISOString(), projection: tripProjection(sent.trip, "admin"), pickedFrom: "group" };
  }
  const picked = await pickRadarZone(trx, who, trip, body.radarZoneId!, body.ruleId!, now);
  if (picked.ids.length === 0) {
    // repeat on and nobody free inside yet: the first round waits for the next interval.
    const expiresAt = new Date(now.getTime() + picked.rule.seconds * 1000);
    const send = await startRadarZoneSend(trx, who, trip, picked, expiresAt, now);
    await audit(trx, { adminId: who.subjectId, action: "trip.radar_group", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { driverIds: [], radarZoneId: body.radarZoneId, ruleId: body.ruleId, repeat: true, note: body.note ?? null }, at: now });
    return { groupId: send.sendId, tripId, offers: [], expiresAt: expiresAt.toISOString(), projection: tripProjection(trip, "admin"), pickedFrom: "radar_zone", radarZoneSend: send };
  }
  const sent = await offerTo(trx, who, tripId, picked.ids, "radar", body, now, { seconds: picked.rule.seconds, detail: { radarZoneId: body.radarZoneId, ruleId: body.ruleId, repeat: picked.rule.repeat } });
  const send = await startRadarZoneSend(trx, who, sent.trip, picked, sent.expiresAt, now);
  return { groupId: sent.groupId!, tripId, offers: sent.offers, expiresAt: sent.expiresAt.toISOString(), projection: tripProjection(sent.trip, "admin"), pickedFrom: "radar_zone", radarZoneSend: send };
}

export async function adminStopRadarZone(trx: Trx, who: Principal, tripId: string, body: { note?: string }, now: Date) {
  const trip = await lockTrip(trx, tripId);
  if (!adminCoversZone(who, trip.zone_id)) throw new ApiError("forbidden", "This trip is outside your zones.", { reason: "zone_out_of_scope" });
  return stopRadarZoneSend(trx, who, trip, body.note, now);
}

/** "Add money to trip": Movera pays it; open offers show the new money at once. */
export async function adminDriverBonus(trx: Trx, who: Principal, tripId: string, body: { expectedVersion: number; amount: Money; priority?: boolean; note?: string }, now: Date): Promise<TripRow> {
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  if (["cancelled_by_rider", "cancelled_by_driver", "cancelled_by_admin", "cancelled_by_system", "expired", "failed", "no_show"].includes(trip.status)) {
    throw new ApiError("invalid_transition", "This trip is over; pay a lost driver with the cancel or reassign bonus.", { reason: "trip_over", projection: tripProjection(trip, "admin") });
  }
  await checkBonus(trx, trip, body.amount);
  const bonus = Number(trip.driver_bonus_minor ?? 0) + body.amount.amountMinor;
  const updated = await touchTrip(trx, trip, { driver_bonus_minor: bonus, commission_minor: Number(trip.fare_minor) - Number(trip.driver_earnings_minor ?? 0) - Number(trip.pickup_pay_minor ?? 0) - bonus, ...(body.priority !== undefined ? { priority: body.priority } : {}) }, now);
  // A completed trip's earnings are already written: the bonus is its own entry now.
  if (updated.status === "completed" && updated.driver_id) await credit(trx, { driverId: updated.driver_id, tripId, kind: "bonus", currency: trip.currency, amount: body.amount.amountMinor }, now);
  await refreshOpenOffers(trx, updated, now);
  await audit(trx, { adminId: who.subjectId, action: "trip.driver_bonus", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { amount: body.amount, total: bonus, note: body.note ?? null }, at: now });
  return updated;
}

/* ---------------------------------------------------------------- no-show, complete */

export async function adminNoShow(trx: Trx, who: Principal, tripId: string, body: { expectedVersion: number; note: string; waiveFee?: boolean }, now: Date): Promise<TripRow> {
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  const ended = await markNoShow(trx, trip, "admin", body.waiveFee === true, now);
  await audit(trx, { adminId: who.subjectId, action: "trip.no_show", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { note: body.note, waiveFee: body.waiveFee === true, from: trip.status }, at: now });
  return ended;
}

export async function adminComplete(trx: Trx, who: Principal, tripId: string, body: { expectedVersion: number; note: string; fare?: Money }, now: Date): Promise<TripRow> {
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  sameCurrency(trip, body.fare, "The fare");
  notBelowZero(body.fare);
  const done = await completeTrip(trx, { actor: "admin", subjectId: who.subjectId }, tripId, { expectedVersion: body.expectedVersion, ...(body.fare ? { fare: body.fare } : {}) }, now);
  await audit(trx, { adminId: who.subjectId, action: "trip.complete", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { note: body.note, from: trip.status, fare: body.fare ?? null }, at: now });
  return done;
}

/* ---------------------------------------------------------------- adjust (two-person rule) */

export const ADJUST_ACTION = "trip.adjust";
export const REFUND_ACTION = "trip.refund";

type AdjustPayload = { tripId: string; expectedVersion: number; fare?: Money; waitingSeconds?: number; waiveCancelFee?: boolean; reason: string };

async function adjustTrip(trx: Trx, p: AdjustPayload, now: Date): Promise<Record<string, unknown>> {
  const trip = await lockTrip(trx, p.tripId);
  expectVersion(trip, p.expectedVersion, "admin");
  sameCurrency(trip, p.fare, "The fare");
  const set: Record<string, unknown> = {};
  if (p.waiveCancelFee) {
    // The rider owes nothing more; the driver keeps the share already credited (owner decision 34).
    const fee = await trx.selectFrom("rider_fees").selectAll().where("trip_id", "=", trip.trip_id).forUpdate().executeTakeFirst();
    if (!fee || fee.status !== "owed") throw new ApiError("conflict", "There is no unpaid fee on this trip.", { reason: "no_fee_to_waive", projection: tripProjection(trip, "admin") });
    // A ride going now already carries it in its price: waive it after that ride, or refund it then.
    const carrying = await trx.selectFrom("trips").select("trip_id").where("rider_id", "=", trip.rider_id).where("status", "not in", [...TERMINAL]).where(sql<boolean>`fare_lines @> '[{"code":"outstanding_fee"}]'::jsonb`).executeTakeFirst();
    if (carrying) throw new ApiError("conflict", "The rider's current ride already includes this fee; waive it when that ride is over.", { reason: "fee_on_running_trip", projection: tripProjection(trip, "admin") });
    await trx.updateTable("rider_fees").set({ status: "waived", settled_at: now }).where("trip_id", "=", trip.trip_id).execute();
    set["cancellation"] = JSON.stringify({ ...(trip.cancellation as object), feeStatus: "waived" });
    await refreshOutstanding(trx, trip.rider_id, now);
  }
  if (p.waitingSeconds !== undefined || p.fare !== undefined) {
    // A paid trip is corrected with a refund, so cash and the record never disagree.
    if (terminal(trip.status)) throw new ApiError("invalid_transition", "This trip is paid; use a refund.", { reason: "use_refund", projection: tripProjection(trip, "admin") });
    // Before accept the offers carry the price; change it once a driver has it.
    if (["draft", "quoted", "requested", "searching", "offered"].includes(trip.status)) throw new ApiError("invalid_transition", "Change the fare after a driver accepted.", { reason: "adjust_after_accept", projection: tripProjection(trip, "admin") });
    let row = trip;
    if (p.waitingSeconds !== undefined) {
      if (!trip.waiting) throw new ApiError("invalid_transition", "The driver has not arrived yet.", { reason: "no_waiting", projection: tripProjection(trip, "admin") });
      const fare = await fareWithWaiting(trx, trip, p.waitingSeconds);
      const pickupPay = Number(trip.pickup_pay_minor ?? 0);
      Object.assign(set, {
        waiting: JSON.stringify({ ...(trip.waiting as object), chargedSeconds: p.waitingSeconds }),
        fare_minor: fare.total.amountMinor,
        fare_lines: JSON.stringify(fare.fareLines),
        driver_earnings_minor: fare.driverEarnings.amountMinor,
        commission_minor: fare.total.amountMinor - fare.driverEarnings.amountMinor - pickupPay - Number(trip.driver_bonus_minor ?? 0),
      });
      row = { ...trip, fare_minor: String(fare.total.amountMinor), fare_lines: fare.fareLines, driver_earnings_minor: String(fare.driverEarnings.amountMinor) };
    }
    if (p.fare !== undefined) Object.assign(set, scaledFare(row, p.fare.amountMinor));
  }
  if (Object.keys(set).length === 0) throw badRequest("Nothing to change.", "nothing_to_change");
  return tripProjection(await touchTrip(trx, trip, set, now), "admin");
}

registerApprovalHandler(ADJUST_ACTION, async (trx, payload, _approvedBy, _requestedBy, now) => adjustTrip(trx, payload as AdjustPayload, now));

export async function adminAdjust(trx: Trx, who: Principal, tripId: string, body: Omit<AdjustPayload, "tripId">, now: Date): Promise<{ status: number; body: unknown }> {
  const trip = await adminTrip(trx, who, tripId);
  notBelowZero(body.fare);
  const ran = await runOrRequest<Record<string, unknown>>(trx, who, { action: ADJUST_ACTION, targetType: "trip", targetId: tripId, zoneId: trip.zone_id, payload: { ...body, tripId }, approvePermission: "approval.decide" }, now);
  return ran.ran ? { status: 200, body: ran.result } : { status: 202, body: ran.pending as PendingApproval };
}

/* ---------------------------------------------------------------- refunds (owner decisions 30, 31) */

type RefundPayload = { tripId: string; expectedVersion: number; amount: Money; reason: string; fromDriver?: boolean };

export function refundView(r: { refund_id: string; trip_id: string; currency: string; amount_minor: string; reason: string; status: string; approval_id: string | null; created_at: Date; destination: string | null; payout_status: string | null; from_driver: boolean; paid_at: Date | null }) {
  return {
    refundId: r.refund_id,
    paymentId: `pay_${r.trip_id}`,
    tripId: r.trip_id,
    amount: { amountMinor: Number(r.amount_minor), currency: r.currency },
    reason: r.reason,
    status: r.status,
    ...(r.approval_id ? { approvalId: r.approval_id } : {}),
    createdAt: r.created_at.toISOString(),
    // Where the money goes (owner decision 30): null until the rider chooses.
    destination: r.destination,
    payoutStatus: r.payout_status,
    ...(r.paid_at ? { paidAt: r.paid_at.toISOString() } : {}),
    fromDriver: r.from_driver,
  };
}

/** What can still be refunded: what the rider paid (cash taken + wallet), less the refunds already made. */
async function refundRoom(ex: Executor, trip: TripRow, amount: Money) {
  sameCurrency(trip, amount, "The refund");
  if (!terminal(trip.status) || !["captured", "partially_refunded"].includes(trip.payment_status ?? "")) {
    throw new ApiError("invalid_transition", "Only a paid trip can be refunded.", { reason: "not_paid", projection: tripProjection(trip, "admin") });
  }
  if (amount.amountMinor <= 0) throw badRequest("The refund must be more than 0.", "invalid_amount");
  const done = await ex.selectFrom("refunds").select((eb) => eb.fn.coalesce(eb.fn.sum<string>("amount_minor"), sql<string>`0`).as("n")).where("trip_id", "=", trip.trip_id).where("status", "=", "done").executeTakeFirstOrThrow();
  const paid = trip.cash_collected_minor === null ? Number(trip.fare_minor) : Number(trip.cash_collected_minor) + Number(trip.wallet_applied_minor ?? 0);
  const left = paid - Number(done.n);
  if (amount.amountMinor > left) throw badRequest(`At most ${Math.max(0, left) / 100} ${trip.currency} is left to refund.`, "refund_too_large");
  return { paid, left };
}

async function createRefund(trx: Trx, p: RefundPayload, createdBy: string, now: Date): Promise<Record<string, unknown>> {
  const trip = await lockTrip(trx, p.tripId);
  expectVersion(trip, p.expectedVersion, "admin");
  const { paid, left } = await refundRoom(trx, trip, p.amount);
  const refundId = newId("rfd", now.getTime());
  await trx.insertInto("refunds").values({ refund_id: refundId, trip_id: trip.trip_id, rider_id: trip.rider_id, currency: trip.currency, amount_minor: p.amount.amountMinor, reason: p.reason, status: "done", approval_id: null, from_driver: p.fromDriver === true, destination: null, payout_to: null, payout_status: null, created_by: createdBy, created_at: now }).execute();
  // "Take from driver": the driver loses their share of the refunded money (owner decision 31).
  if (p.fromDriver && trip.driver_id && paid > 0) {
    const fare = Number(trip.fare_minor);
    const share = fare > 0 ? Math.round((p.amount.amountMinor * Number(trip.driver_earnings_minor ?? 0)) / fare) : 0;
    if (share > 0) await credit(trx, { driverId: trip.driver_id, tripId: trip.trip_id, kind: "adjustment", currency: trip.currency, amount: -share }, now);
  }
  // v0.10.3: refunds count on the trip's day; an earlier day's summary is re-summed now.
  await resumTripDay(trx, trip.trip_id, now);
  const all = p.amount.amountMinor === left;
  await touchTrip(trx, trip, { payment_status: all ? "refunded" : "partially_refunded" }, now);
  const row = await trx.selectFrom("refunds").selectAll().where("refund_id", "=", refundId).executeTakeFirstOrThrow();
  return refundView(row);
}

registerApprovalHandler(REFUND_ACTION, async (trx, payload, _approvedBy, requestedBy, now) => createRefund(trx, payload as RefundPayload, requestedBy, now));

export async function adminRefund(trx: Trx, who: Principal, tripId: string, body: Omit<RefundPayload, "tripId">, now: Date): Promise<{ status: number; body: unknown }> {
  const trip = await adminTrip(trx, who, tripId);
  // Checked now too, so a request that cannot work is refused at once instead of waiting for a second admin.
  expectVersion(trip, body.expectedVersion, "admin");
  await refundRoom(trx, trip, body.amount);
  const ran = await runOrRequest<Record<string, unknown>>(trx, who, { action: REFUND_ACTION, targetType: "refund", targetId: tripId, zoneId: trip.zone_id, payload: { ...body, tripId }, approvePermission: "approval.decide" }, now);
  return ran.ran ? { status: 201, body: ran.result } : { status: 202, body: ran.pending };
}

/** POST /admin/refunds/{refundId}/paid: the admin sent the Swish or bank payment by hand. */
export async function markRefundPaid(trx: Trx, who: Principal, refundId: string, body: { note?: string }, now: Date) {
  const r = await trx.selectFrom("refunds").selectAll().where("refund_id", "=", refundId).forUpdate().executeTakeFirst();
  if (!r) throw new ApiError("not_found", "No such refund.", { reason: "refund_not_found" });
  const trip = await adminTrip(trx, who, r.trip_id);
  if (r.payout_status !== "pending") throw new ApiError("conflict", r.payout_status === "paid" ? "This refund is already paid." : "The rider has not chosen Swish or a bank account.", { reason: r.payout_status === "paid" ? "already_paid" : "no_payout" });
  await trx.updateTable("refunds").set({ payout_status: "paid", paid_at: now, paid_by: who.subjectId }).where("refund_id", "=", refundId).execute();
  await audit(trx, { adminId: who.subjectId, action: "refund.paid", targetType: "refund", targetId: refundId, zoneId: trip.zone_id, detail: { note: body.note ?? null, destination: r.destination }, at: now });
  return refundView((await trx.selectFrom("refunds").selectAll().where("refund_id", "=", refundId).executeTakeFirstOrThrow()));
}

/* ---------------------------------------------------------------- reads */

export async function tripOffers(ex: Executor, trip: TripRow, input: { cursor?: string; limit: number }) {
  let q = ex.selectFrom("offers").selectAll().where("trip_id", "=", trip.trip_id);
  if (input.cursor) q = q.where("offer_id", "<", input.cursor);
  const rows = await q.orderBy("offer_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  return { items: page.map((o) => ({ ...offerView(o, trip), driverId: o.driver_id })), nextCursor: rows.length > input.limit ? page[page.length - 1]!.offer_id : null };
}

/** Drivers near the pickup for an assign or a radar group (contract §3.1): radius (5 / 7 / 10 km presets), the zone, or the zone and around it. */
export async function nearbyDrivers(ex: Executor, trip: TripRow, input: { scope: "radius" | "zone" | "zone_and_neighbours"; radiusKm?: number }, now: Date) {
  const rows = await ex
    .selectFrom("drivers")
    .innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .select(["drivers.driver_id", "drivers.first_name", "drivers.online_status", "drivers.category_ids", "driver_locations.lat", "driver_locations.lng", "driver_locations.accuracy", "driver_locations.heading", "driver_locations.speed_mps", "driver_locations.moving", "driver_locations.measured_at", "driver_locations.zone_id"])
    .where("drivers.account_status", "=", "active")
    .where("drivers.online_status", "in", ["online", "on_trip"])
    .where("driver_locations.received_at", ">", new Date(now.getTime() - STALE_AFTER_SECONDS * 1000))
    .where("driver_locations.measured_at", ">", new Date(now.getTime() - DISPATCH_FIX_MAX_AGE_SECONDS * 1000))
    .execute();
  const radiusKm = input.scope === "radius" ? input.radiusKm ?? 5 : input.scope === "zone_and_neighbours" ? 25 : Infinity;
  const open = await ex.selectFrom("offers").select(["driver_id", "offer_id"]).where("trip_id", "=", trip.trip_id).where("status", "=", "open").execute();
  const items = rows
    .map((d) => ({ d, km: dispatchKm(d, trip.pickup as Place) }))
    .filter(({ d, km }) => (input.scope === "zone" ? d.zone_id === trip.zone_id : km <= radiusKm))
    .sort((a, b) => a.km - b.km)
    .slice(0, 100)
    .map(({ d, km }) => ({
      driverId: d.driver_id,
      firstName: d.first_name,
      onlineStatus: d.online_status,
      moving: d.moving,
      location: { lat: d.lat, lng: d.lng, accuracy: d.accuracy, ...(d.heading !== null ? { heading: d.heading } : {}), ...(d.speed_mps !== null ? { speedMps: d.speed_mps } : {}), moving: d.moving, measuredAt: d.measured_at.toISOString() },
      distanceMeters: Math.round(km * 1000),
      pickupEtaSeconds: Math.max(60, Math.round((km / 24) * 3600)),
      ...(d.zone_id ? { zoneId: d.zone_id } : {}),
      categoryIds: d.category_ids,
      ...(open.find((o) => o.driver_id === d.driver_id) ? { openOfferId: open.find((o) => o.driver_id === d.driver_id)!.offer_id } : {}),
    }));
  return { items, scope: input.scope, ...(input.scope === "radius" ? { radiusKm } : {}) };
}
