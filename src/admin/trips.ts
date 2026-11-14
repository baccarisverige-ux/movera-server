import { exponentOf, moneyText, type CurrencyCode } from "../rules/money.js";
import { tripTerms } from "../trips/ride.js";
import { notify } from "../notifications/service.js";
import { sql } from "kysely";
import { correctFee } from "../riders/debt.js";
import { commissionOf } from "../rules/commission.js";
import { GROUP_MAX_DRIVERS, pickGroup, pickRadarZone, startRadarZoneSend, stopRadarZoneSend } from "../dispatch/tools.js";
import { boxAround, driversNear } from "../dispatch/nearArea.js";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import { liveDocument } from "../config/service.js";
import type { Executor, Trx } from "../db/db.js";
import { lockTrip, type TripRow } from "../db/tripLog.js";
import { addMoneyReachKm, dispatchKm, type DispatchDoc } from "../dispatch/engine.js";
import { addBonus, bonusFor, scopeCovers, sideOfKind, type BonusScope } from "../dispatch/bonusScope.js";
import { freeCandidatesDetailed, refreshOpenOffers, sendAdminOffers, stopSearch, offerView } from "../dispatch/runtime.js";
import { DISPATCH_FIX_MAX_AGE_SECONDS, STALE_AFTER_SECONDS } from "../drivers/service.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { TERMINAL, isTripStatus } from "../rules/transitions.js";
import { applyCommand, expectVersion, touchTrip } from "../trips/commands.js";
import { cappedChangeOf, driverTotalOf, tripProjection } from "../trips/projection.js";
import { backToDispatch, completeTrip, credit, fareWithWaiting, markNoShow, refreshOutstanding, releaseDriver } from "../trips/ride.js";
import { FREE_END_COLUMNS } from "../trips/ride/money.js";
import { PAY_TEXT, payChangeMaxOf } from "../trips/finish.js";
import { audit } from "./audit.js";
import { creditWallet } from "../riders/wallet.js";
import { adminUnlockPin } from "../trips/pin.js";
import { registerApprovalHandler, runOrRequest, type PendingApproval } from "./approvals.js";
import { resumTripDay } from "./kpis.js";
import { reassignHeldBooked } from "../reservations/service.js";
import { noticeLanguage } from "../notifications/noticeLanguage.js";
import { noticeDriverRefund } from "../notifications/refundDriverNotice.js";

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
async function bonusSoFar(ex: Executor, trip: TripRow, scope: BonusScope = "both"): Promise<number> {
  // Owner bug 2026-11-01: money waiting for one kind of offer counts only against that kind (the driver gets one of them).
  const waiting = scope === "both" ? Number(trip.driver_bonus_minor ?? 0) : bonusFor(trip, scope);
  const paid = await ex.selectFrom("earnings_entries").select((eb) => eb.fn.coalesce(eb.fn.sum<string>("amount_minor"), sql<string>`0`).as("n")).where("trip_id", "=", trip.trip_id).where("kind", "=", "bonus").executeTakeFirstOrThrow();
  return (trip.status === "completed" ? 0 : waiting) + Number(paid.n);
}

/** A trip's fare is never below 0 (audit Phase 4, P4-3: a negative fare made negative driver earnings). */
/* ---------------------------------------------------------------- the admin types the driver's pay (S5 J6) */

/**
 * v0.18.82 S5 J6 (contract.json#moneyBase.adminFare; owner Q-M7 "If admin increase fare it's only for the driver side !!
 * The rider pay same amount when booked", Q-S5-8 "Admin types driver pay"): the old `fare` (a rider price in admins
 * before v0.18.82) is refused and never read as a pay, so an older admin can never pay a wrong amount by mistake.
 */
function refuseOldFare(body: { fare?: unknown }) {
  if (body.fare !== undefined) throw badRequest("Type the driver's pay (driverPay); the rider's price cannot be changed.", "fare_is_driver_pay");
}

/** The driver's pay on the trip without the tip (owner 2026-11-13 "No, without tip": the tip stays on top). */
const payWithoutTip = (row: TripRow): number => driverTotalOf(row) - Number((row.tip as { amount?: Money } | null)?.amount?.amountMinor ?? 0);

/**
 * The change the admin's typed pay makes: driverPay − the pay now. Checked like a driver-pay change (owner "The change"):
 * its size at most CountryRules.driverPayChangeMax (TN 100 DT), the pay never below 0.
 */
async function driverPayChange(ex: Executor, row: TripRow, driverPay: Money): Promise<number> {
  sameCurrency(row, driverPay, "The driver's pay");
  const before = payWithoutTip(row);
  if (driverPay.amountMinor < 0) throw badRequest(PAY_TEXT.belowZero(before, row.currency), "driver_pay_below_zero");
  const change = driverPay.amountMinor - before;
  const max = await payChangeMaxOf(ex, row.zone_id, row.currency);
  if (Math.abs(change) > max) throw badRequest(PAY_TEXT.atMost(max, row.currency), "driver_pay_above_max");
  return change;
}

async function checkBonus(ex: Executor, trip: TripRow, amount: Money, scope: BonusScope = "both") {
  sameCurrency(trip, amount, "The bonus");
  if (amount.amountMinor <= 0) throw badRequest("The bonus must be more than 0.", "invalid_amount");
  let limit = await bonusLimit(ex, trip);
  // Owner C (v0.18.19 liveFixes.raiseFare): a booked ride's raise is the same call and the same limit as a live ride;
  // the zone's Book later switch and highest raise (DriverAppConfig.reservations.raiseFare / raiseMax) apply on top.
  if (trip.kind === "scheduled") {
    const doc = await liveDocument<{ reservations?: { raiseFare?: unknown; raiseMax?: unknown } }>(ex, "driver_app_config", trip.zone_id);
    const resv = doc?.document.reservations ?? {};
    if (resv.raiseFare === false) throw new ApiError("forbidden", "Raising the driver's fare of a booked ride is switched off in this zone.", { reason: "raise_off" });
    if (typeof resv.raiseMax === "number" && Number.isFinite(resv.raiseMax) && resv.raiseMax >= 0) limit = Math.min(limit, Math.round(resv.raiseMax * 10 ** exponentOf(trip.currency as CurrencyCode)));
  }
  if ((await bonusSoFar(ex, trip, scope)) + amount.amountMinor > limit) {
    throw badRequest(`A trip can carry at most ${moneyText({ amountMinor: limit, currency: trip.currency as CurrencyCode })} of bonus; adjust the limit in Pricing.`, "bonus_over_limit");
  }
}

/**
 * v0.18.90 BQ-M21 (contract.json#moneyBase.lostDriverPaid): the lost-driver payment is checked and kept on the trip
 * BEFORE the trip's command, so the command's projection and stored event already take it off what Movera keeps.
 */
async function keepLostDriverPay(trx: Trx, trip: TripRow, bonus: Money | undefined) {
  if (!bonus) return;
  if (!trip.driver_id) throw badRequest("This trip has no driver to pay.", "no_driver");
  await checkBonus(trx, trip, bonus);
  await trx.updateTable("trips").set({ lost_driver_paid_minor: sql`lost_driver_paid_minor + ${bonus.amountMinor}` }).where("trip_id", "=", trip.trip_id).execute();
}

/** Movera's money for the driver who lost the trip (owner decisions 32, 33): a bonus entry, at once (after keepLostDriverPay). */
async function payLostDriver(trx: Trx, trip: TripRow, bonus: Money | undefined, now: Date) {
  if (!bonus || !trip.driver_id) return;
  await credit(trx, { driverId: trip.driver_id, tripId: trip.trip_id, kind: "bonus", currency: trip.currency, amount: bonus.amountMinor }, now);
  // v0.18.82 S5 J5: the bonus entry counts on the trip's day; an older stored day is re-summed now.
  await resumTripDay(trx, trip.trip_id, now);
}

/* ---------------------------------------------------------------- cancel, reassign */

type ReasonBody = { expectedVersion: number; reasonCode: string; note: string; driverBonus?: Money };

export async function adminCancel(trx: Trx, who: Principal, tripId: string, body: ReasonBody, now: Date): Promise<TripRow> {
  if (!ADMIN_REASONS.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not an admin reason.`, "invalid_reason_code");
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  // The rider pays nothing (owner decision 33); the admin's note stays in the audit.
  const cancellation = { actor: "admin", reasonCode: body.reasonCode, at: now.toISOString(), fee: null };
  await keepLostDriverPay(trx, trip, body.driverBonus);
  // S5 J6 (owner 2026-11-13): an end without a paid ride follows only the cancel-fee rules; the admin's change is dropped.
  const cancelled = await applyCommand(trx, trip, { command: "cancel", actor: "admin", now, set: { ...FREE_END_COLUMNS, cancellation: JSON.stringify(cancellation), ended_by_command: "cancel", ended_at: now, search_step: null, driver_adjustments_minor: 0 } });
  await stopSearch(trx, cancelled, now);
  await payLostDriver(trx, trip, body.driverBonus, now);
  await releaseDriver(trx, trip.driver_id, now);
  await audit(trx, { adminId: who.subjectId, action: "trip.cancel", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { reasonCode: body.reasonCode, note: body.note, from: trip.status, driverId: trip.driver_id, driverBonus: body.driverBonus ?? null }, at: now });
  return cancelled;
}

export async function adminReassign(trx: Trx, who: Principal, tripId: string, body: ReasonBody, now: Date): Promise<TripRow> {
  if (!ADMIN_REASONS.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not an admin reason.`, "invalid_reason_code");
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  await keepLostDriverPay(trx, trip, body.driverBonus);
  await payLostDriver(trx, trip, body.driverBonus, now);
  // v0.18.50 §72 (L6): a booked ride a driver holds goes back to the list like Unassign (he is not barred from it).
  const back = trip.kind === "scheduled" && trip.status === "accepted" && trip.next_after_trip_id === null
    ? await reassignHeldBooked(trx, trip, now)
    : await backToDispatch(trx, trip, { command: "reassign", actor: "admin", now });
  await audit(trx, { adminId: who.subjectId, action: "trip.reassign", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { reasonCode: body.reasonCode, note: body.note, from: trip.status, driverId: trip.driver_id, driverBonus: body.driverBonus ?? null }, at: now });
  return back;
}

/* ---------------------------------------------------------------- assign, radar group, bonus */

type OfferBody = { expectedVersion: number; note?: string; driverBonus?: Money; priority?: boolean; applyTo?: BonusScope };

/** The kinds a send's money is for: what the admin chose, else the kind of this send (exclusive or radar). */
const sendScope = (body: OfferBody, kind: "assigned" | "radar"): BonusScope => body.applyTo ?? (kind === "radar" ? "radar" : "exclusive");

async function withBonus(trx: Trx, trip: TripRow, body: OfferBody, scope: BonusScope): Promise<TripRow> {
  if (!body.driverBonus && body.priority === undefined) return trip;
  if (body.driverBonus) await checkBonus(trx, trip, body.driverBonus, scope);
  await trx.updateTable("trips").set(addBonus(trip, body.driverBonus?.amountMinor ?? 0, scope, body.priority)).where("trip_id", "=", trip.trip_id).execute();
  return trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
}

async function offerTo(trx: Trx, who: Principal, tripId: string, driverIds: string[], kind: "assigned" | "radar", body: OfferBody, now: Date, extra: { seconds?: number; detail?: Record<string, unknown> } = {}) {
  let trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  // Locked once a driver accepted (contract.json#adminDispatch.lockedStatuses): the transition table says so.
  const scope = sendScope(body, kind);
  trip = await withBonus(trx, trip, body, scope);
  trip = await applyCommand(trx, trip, { command: "assign", actor: "admin", now });
  // Same path as "Add money": every open offer of the trip shows the new money / Priority badge at once (offer_updated).
  if (body.driverBonus || body.priority !== undefined) await refreshOpenOffers(trx, trip, now, scope);
  const sent = await sendAdminOffers(trx, trip, driverIds, kind, now, extra.seconds);
  await audit(trx, { adminId: who.subjectId, action: kind === "assigned" ? "trip.assign" : "trip.radar_group", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { driverIds, note: body.note ?? null, driverBonus: body.driverBonus ?? null, ...(body.driverBonus || body.priority !== undefined ? { applyTo: scope } : {}), priority: body.priority ?? null, groupId: sent.groupId, sentTo: sent.offers.map((o) => o["driverId"]), refreshed: sent.kept.map((o) => o["driverId"]), skipped: sent.skipped, ...(extra.detail ?? {}) }, at: now });
  // A driver who already saw the trip keeps that offer: it is listed with the new ones (no shape change; the admin counts
  // the offers outside groupId as refreshed).
  return { trip, ...sent, offers: [...sent.offers, ...sent.kept] };
}

export async function adminAssign(trx: Trx, who: Principal, tripId: string, body: OfferBody & { driverId: string }, now: Date): Promise<TripRow> {
  const sent = await offerTo(trx, who, tripId, [body.driverId], "assigned", body, now);
  // v0.18.26 (owner "Yes, respect it"): the driver switched this category off in Ride preferences; say so to the admin.
  if (sent.offers.length === 0 && sent.skipped.some((s) => s.reason === "category_switched_off")) {
    throw new ApiError("invalid_transition", "This driver switched this ride type off in his ride preferences.", { reason: "category_switched_off" });
  }
  return sent.trip;
}

export async function adminRadarGroup(trx: Trx, who: Principal, tripId: string, body: OfferBody & { driverIds?: string[]; groupId?: string; radarZoneId?: string; ruleId?: string }, now: Date) {
  // v0.18.6 (G4-F3, F4, contract.json#adminDispatch.radarGroup.v0186): exactly one of driverIds, groupId, radarZoneId + ruleId.
  const ways = [body.driverIds !== undefined, body.groupId !== undefined, body.radarZoneId !== undefined || body.ruleId !== undefined].filter(Boolean).length;
  if (ways !== 1 || (body.radarZoneId === undefined) !== (body.ruleId === undefined)) throw badRequest("Give driverIds, or groupId, or radarZoneId with ruleId.", "radar_group_target");
  if (body.driverIds !== undefined) {
    if (body.driverIds.length === 0) throw badRequest("Give at least one driver.", "invalid_body");
    if (new Set(body.driverIds).size !== body.driverIds.length) throw badRequest("Each driver once.", "duplicate_driver");
    const sent = await offerTo(trx, who, tripId, body.driverIds, "radar", body, now);
    return { groupId: sent.groupId!, tripId, offers: sent.offers, skipped: sent.skipped, expiresAt: sent.expiresAt.toISOString(), projection: tripProjection(sent.trip, "admin"), pickedFrom: "drivers" };
  }
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  if (body.groupId !== undefined) {
    const ids = await pickGroup(trx, who, trip, body.groupId, now);
    const sent = await offerTo(trx, who, tripId, ids, "radar", body, now, { detail: { driverGroupId: body.groupId } });
    return { groupId: sent.groupId!, tripId, offers: sent.offers, skipped: sent.skipped, expiresAt: sent.expiresAt.toISOString(), projection: tripProjection(sent.trip, "admin"), pickedFrom: "group" };
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
  return { groupId: sent.groupId!, tripId, offers: sent.offers, skipped: sent.skipped, expiresAt: sent.expiresAt.toISOString(), projection: tripProjection(sent.trip, "admin"), pickedFrom: "radar_zone", radarZoneSend: send };
}

export async function adminStopRadarZone(trx: Trx, who: Principal, tripId: string, body: { note?: string }, now: Date) {
  const trip = await lockTrip(trx, tripId);
  if (!adminCoversZone(who, trip.zone_id)) throw new ApiError("forbidden", "This trip is outside your zones.", { reason: "zone_out_of_scope" });
  return stopRadarZoneSend(trx, who, trip, body.note, now);
}

/** "Add money to trip": Movera pays it; open offers show the new money at once. */
/** Live fix 2026-11-02: skipped counts free drivers left out (expired = let an offer of this trip go / declined;
 * busy = refused when sent; far = beyond reachKm, the widest reach used, null = no limit). Counts are drivers, each
 * once: expired/far = the larger of the kinds looked at (same nearby drivers), busy = the sum over the sends (Both sends
 * Exclusive and Radar to different drivers). */
export type MoneySend = { exclusiveTo: string | null; radarTo: string[]; skipped: { expired: number; busy: number; far: number }; reachKm: number | null };

/**
 * Owner decision 2026-11-01 (driver-g5.md): Add money with an explicit applyTo puts the money in front of drivers NOW.
 * Exclusive: no exclusive offer out → an exclusive offer (with the money) to the nearest free driver. Radar: the trip's
 * open exclusive offers become radar offers, and with no radar offer out the nearest free drivers (up to the radar
 * group size) get one. Both: exclusive to the nearest, radar to the others, at the same time. Same rules and timers as
 * the admin's own Exclusive / Radar sends (sendAdminOffers); a driver who cannot take it is skipped.
 */
async function sendWithMoney(trx: Trx, trip: TripRow, scope: BonusScope, now: Date): Promise<MoneySend> {
  const done: MoneySend = { exclusiveTo: null, radarTo: [], skipped: { expired: 0, busy: 0, far: 0 }, reachKm: null };
  const open = await trx.selectFrom("offers").select(["driver_id", "kind"]).where("trip_id", "=", trip.trip_id).where("status", "=", "open").where("expires_at", ">", now).execute();
  const dispatch = await liveDocument<DispatchDoc>(trx, "dispatch", trip.zone_id);
  // Same drivers the automatic dispatch would ask (checker 2026-11-01), in-zone first then nearest, within the zone's
  // own reach for each kind (mode steps, limits.maxPickupKm / maxPickupEtaMin; owner rule 16).
  const reaches: number[] = [];
  const nearFor = async (mode: "exclusive" | "radar") => {
    const reach = addMoneyReachKm(dispatch?.document, mode);
    reaches.push(reach);
    const found = await freeCandidatesDetailed(trx, trip, now, reach);
    done.skipped.expired = Math.max(done.skipped.expired, found.expired);
    done.skipped.far = Math.max(done.skipped.far, found.far);
    return found.ids;
  };
  const nearExclusive = scopeCovers(scope, "exclusive") ? await nearFor("exclusive") : [];
  const nearRadar = scopeCovers(scope, "radar") ? await nearFor("radar") : [];
  const widest = reaches.length ? Math.max(...reaches) : Infinity;
  done.reachKm = Number.isFinite(widest) ? widest : null;
  const send = async (ids: string[], kind: "assigned" | "radar") => {
    if (!ids.length) return [] as string[];
    try {
      const sent = await sendAdminOffers(trx, trip, ids, kind, now);
      done.skipped.busy += sent.skipped.length;
      return ids.filter((id) => !sent.skipped.some((x) => x.driverId === id));
    } catch (error) {
      if (error instanceof ApiError && error.code === "conflict") { done.skipped.busy += ids.length; return []; }
      throw error;
    }
  };
  if (scopeCovers(scope, "exclusive") && !open.some((o) => sideOfKind(o.kind) === "exclusive")) {
    // The nearest free one; if he is refused (skipped), the next one by distance.
    for (const id of nearExclusive) {
      done.exclusiveTo = (await send([id], "assigned"))[0] ?? null;
      if (done.exclusiveTo) break;
    }
  }
  if (scopeCovers(scope, "radar")) {
    const convert = scope === "radar" ? open.filter((o) => sideOfKind(o.kind) === "exclusive").map((o) => o.driver_id) : [];
    const fresh = open.some((o) => sideOfKind(o.kind) === "radar") ? [] : nearRadar.filter((id) => id !== done.exclusiveTo && !open.some((o) => o.driver_id === id));
    const ids = [...new Set([...convert, ...fresh])].slice(0, GROUP_MAX_DRIVERS);
    done.radarTo = await send(ids, "radar");
  }
  return done;
}

export async function adminDriverBonus(trx: Trx, who: Principal, tripId: string, body: { expectedVersion: number; amount: Money; priority?: boolean; note?: string; applyTo?: BonusScope }, now: Date): Promise<TripRow & { moneySend?: MoneySend }> {
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  if (["cancelled_by_rider", "cancelled_by_driver", "cancelled_by_admin", "cancelled_by_system", "expired", "failed", "no_show"].includes(trip.status)) {
    throw new ApiError("invalid_transition", "This trip is over; pay a lost driver with the cancel or reassign bonus.", { reason: "trip_over", projection: tripProjection(trip, "admin") });
  }
  // Owner bug 2026-11-01: "Apply to: Exclusive" is for exclusive offers only (radar offers keep their money); a trip
  // a driver already took gets it whatever the scope (it is his trip now). Old callers without applyTo: both.
  const taken = Boolean(trip.driver_id) && !["requested", "searching", "offered"].includes(trip.status);
  const scope: BonusScope = taken ? "both" : body.applyTo ?? "both";
  await checkBonus(trx, trip, body.amount, scope);
  const columns = addBonus(trip, body.amount.amountMinor, scope, body.priority);
  // On a taken trip the money is his: driver_bonus_minor grows by the amount (not the max of the two kinds).
  const bonus = taken ? Number(trip.driver_bonus_minor ?? 0) + body.amount.amountMinor : columns.driver_bonus_minor;
  // v0.18.87 BQ-M19 (contract.json#moneyBase.commission + bonusOutsideCommission): after the paid end the commission is
  // what Movera kept at the end and is never rewritten; the bonus is a later pay change (its own entry below, in
  // driverBonus / driverTotal, lower moneySplit.movera and moveraEarnings). Before the paid end it is inside commission.
  // (addBonus's commission_minor is the before-the-end recompute, so it is replaced here too.)
  const commission = trip.status === "completed" ? trip.commission_minor : commissionOf(Number(trip.fare_minor), trip.fare_lines, Number(trip.driver_earnings_minor ?? 0), Number(trip.pickup_pay_minor ?? 0), bonus);
  const updated = await touchTrip(trx, trip, { ...columns, driver_bonus_minor: bonus, commission_minor: commission }, now);
  // A completed trip's earnings are already written: the bonus is its own entry now.
  if (updated.status === "completed" && updated.driver_id) {
    await credit(trx, { driverId: updated.driver_id, tripId, kind: "bonus", currency: trip.currency, amount: body.amount.amountMinor }, now);
    // v0.18.82 S5 J5: the trip's (older, stored) day is re-summed now.
    await resumTripDay(trx, tripId, now);
  }
  await refreshOpenOffers(trx, updated, now, scope);
  // Only a caller that chose a kind gets the immediate send (older callers: money only, as before).
  let current = updated;
  let moneySend: MoneySend | undefined;
  if (!taken && body.applyTo && ["searching", "offered"].includes(updated.status)) {
    // Live test 2026-11-01: nobody free → no offer went out, so the trip keeps its waiting status (searching) for the
    // automatic dispatch; it becomes offered only when an offer was really sent.
    moneySend = await sendWithMoney(trx, updated, scope, now);
    current = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    if (moneySend.exclusiveTo || moneySend.radarTo.length) current = await applyCommand(trx, current, { command: "assign", actor: "admin", now });
  }
  await audit(trx, { adminId: who.subjectId, action: "trip.driver_bonus", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { amount: body.amount, applyTo: scope, total: bonus, note: body.note ?? null, ...(moneySend ? { sent: moneySend } : {}) }, at: now });
  return moneySend ? Object.assign(current, { moneySend }) : current;
}

/* ---------------------------------------------------------------- no-show, complete */

export async function adminNoShow(trx: Trx, who: Principal, tripId: string, body: { expectedVersion: number; note: string; waiveFee?: boolean }, now: Date): Promise<TripRow> {
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  // v0.18.19 (contract.json#bookLater.liveFixes.noShowTime, live test HIGH 1): a booked ride is a no-show only after its
  // pickup time plus its no-show wait; before that the rider has not missed anything.
  if (trip.kind === "scheduled" && trip.scheduled_at) {
    const wait = Number(tripTerms(trip)?.["noShowAfterMin"] ?? 0);
    // v0.18.51 §73 (contract.json#bookedRide0_18_51.noShow): once the driver arrived, the trip's own no-show time
    // (noShowAfterMin after the later of arrival and pickup time); the pickup time + the wait stays the earliest.
    const arrivedNoShowAt = Date.parse((trip.waiting as { noShowAt?: string } | null)?.noShowAt ?? "");
    const from = Math.max(trip.scheduled_at.getTime() + (Number.isFinite(wait) ? wait : 0) * 60_000, Number.isFinite(arrivedNoShowAt) ? arrivedNoShowAt : 0);
    if (now.getTime() < from) throw new ApiError("conflict", "A booked ride can be marked a no-show only after its pickup time and the waiting time.", { reason: "no_show_too_early", projection: tripProjection(trip, "admin") });
  }
  const ended = await markNoShow(trx, trip, "admin", body.waiveFee === true, now);
  await audit(trx, { adminId: who.subjectId, action: "trip.no_show", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { note: body.note, waiveFee: body.waiveFee === true, from: trip.status }, at: now });
  return ended;
}

/**
 * v0.18.8 (contract.json#arrivedWaiting.reverseNoShow; owner G6 decision 3 + decision 34): the admin reverses a no-show with
 * a reason. The status stays no_show (terminal); cancellation.reversal; an owed fee is waived, a paid one refunded to the
 * wallet; the fare becomes 0; the driver keeps his share unless takeBackDriverShare (an earnings adjustment of − share).
 * Again on a reversed trip: the trip as it is, nothing changes.
 */
export async function adminReverseNoShow(trx: Trx, who: Principal, tripId: string, body: { expectedVersion: number; reason: string; takeBackDriverShare?: boolean }, now: Date): Promise<TripRow> {
  const trip = await lockTrip(trx, tripId);
  if (!adminCoversZone(who, trip.zone_id)) throw new ApiError("forbidden", "This trip is outside your zones.", { reason: "zone_out_of_scope" });
  const cancellation = (trip.cancellation ?? {}) as Record<string, unknown> & { reversal?: unknown; driverShare?: Money; fee?: Money | null };
  if (trip.status === "no_show" && cancellation.reversal) return trip;
  if (trip.status !== "no_show") throw new ApiError("invalid_transition", "Only a no-show can be reversed.", { reason: "not_a_no_show", projection: tripProjection(trip, "admin") });
  expectVersion(trip, body.expectedVersion, "admin");
  const takeBack = body.takeBackDriverShare === true;
  const fee = await trx.selectFrom("rider_fees").selectAll().where("trip_id", "=", trip.trip_id).forUpdate().executeTakeFirst();
  let feeStatus = cancellation["feeStatus"] as string | undefined;
  let refunded = false;
  if (fee && fee.status === "owed") {
    // S5 J8 (debtModel.adminCorrections): a wallet correction entry, no fee_on_running_trip refusal any more.
    await correctFee(trx, fee, now);
    await trx.updateTable("rider_fees").set({ status: "waived", settled_at: now }).where("trip_id", "=", trip.trip_id).execute();
    await refreshOutstanding(trx, trip.rider_id, now);
    feeStatus = "waived";
  } else if (fee && fee.status === "paid") {
    await creditWallet(trx, trip.rider_id, { amountMinor: Number(fee.amount_minor), currency: fee.currency }, trip.trip_id, now);
    await trx.updateTable("rider_fees").set({ status: "refunded", settled_at: now }).where("trip_id", "=", trip.trip_id).execute();
    // Checker round 1 (M3): live 0.18.7 apps know only paid / owed / waived (statusWords.feeStatus): the wire says waived,
    // refundedAt + refundedToWallet tell the money went back.
    feeStatus = "waived";
    refunded = true;
  }
  const share = Number(trip.driver_earnings_minor ?? 0);
  if (takeBack && share > 0 && trip.driver_id) {
    await credit(trx, { driverId: trip.driver_id, tripId: trip.trip_id, kind: "adjustment", currency: trip.currency, amount: -share }, now);
  }
  const earnings = takeBack ? 0 : share;
  const reversal = { at: now.toISOString(), by: who.subjectId, reason: body.reason, driverShareTakenBack: takeBack };
  const next = { ...cancellation, ...(feeStatus ? { feeStatus } : {}), ...(refunded ? { refundedAt: now.toISOString(), refundedToWallet: true } : {}), reversal };
  const done = await touchTrip(trx, trip, { cancellation: JSON.stringify(next), fare_minor: 0, fare_lines: JSON.stringify([]), driver_earnings_minor: earnings, commission_minor: -earnings }, now);
  await audit(trx, { adminId: who.subjectId, action: "trip.reverse_no_show", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { reason: body.reason, takeBackDriverShare: takeBack, feeStatus: feeStatus ?? null, driverShare: share }, at: now });
  await resumTripDay(trx, trip.trip_id, now);
  return done;
}

/** v0.18.8 checker round 1 (M2): POST /admin/trips/{tripId}/pin/unlock { expectedVersion, reason } — audited trip.pin_unlock. */
export async function adminPinUnlock(trx: Trx, who: Principal, tripId: string, body: { expectedVersion: number; reason: string }, now: Date): Promise<TripRow> {
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  const done = await adminUnlockPin(trx, trip, now);
  await audit(trx, { adminId: who.subjectId, action: "trip.pin_unlock", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { reason: body.reason, wrongTotal: Number(trip.pin_wrong_total), blocked: trip.pin_blocked }, at: now });
  return done;
}

export async function adminComplete(trx: Trx, who: Principal, tripId: string, body: { expectedVersion: number; note: string; driverPay?: Money; fare?: unknown }, now: Date): Promise<TripRow> {
  refuseOldFare(body);
  const trip = await lockForAdmin(trx, who, tripId, body.expectedVersion);
  sameCurrency(trip, body.driverPay, "The driver's pay");
  // Supervisor should-fix 5: a pay for a trip with no driver is refused, never silently dropped.
  if (body.driverPay !== undefined && trip.driver_id === null) throw badRequest("This trip has no driver.", "driver_pay_no_driver");
  // The rider pays what the normal completion works out; the admin's driverPay never reaches the fare (S5 J6).
  const done = await completeTrip(trx, { actor: "admin", subjectId: who.subjectId }, tripId, { expectedVersion: body.expectedVersion }, now);
  let final = done;
  let pay: { before: Money; after: Money } | null = null;
  if (body.driverPay !== undefined && done.driver_id !== null) {
    // contract.json#moneyBase.adminFare: the change is from the pay the normal completion works out; an adjustment entry.
    const change = await driverPayChange(trx, done, body.driverPay);
    pay = { before: { amountMinor: payWithoutTip(done), currency: done.currency }, after: body.driverPay };
    if (change !== 0) {
      await credit(trx, { driverId: done.driver_id, tripId, kind: "adjustment", currency: done.currency, amount: change }, now);
      final = await touchTrip(trx, done, { driver_adjustments_minor: Number(done.driver_adjustments_minor ?? 0) + change }, now);
    }
  }
  await audit(trx, { adminId: who.subjectId, action: "trip.complete", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { note: body.note, from: trip.status, driverPay: body.driverPay ?? null, ...(pay ?? {}) }, at: now });
  return final;
}

/* ---------------------------------------------------------------- adjust (two-person rule) */

export const ADJUST_ACTION = "trip.adjust";
export const REFUND_ACTION = "trip.refund";

// v0.18.82 S5 J6: driverPay is the driver's new pay; fare is only read to refuse it (an approval filed before J6).
type AdjustPayload = { tripId: string; expectedVersion: number; driverPay?: Money; fare?: unknown; waitingSeconds?: number; waiveCancelFee?: boolean; reason: string; before?: Money; after?: Money };

async function adjustTrip(trx: Trx, p: AdjustPayload, now: Date): Promise<Record<string, unknown>> {
  refuseOldFare(p);
  const trip = await lockTrip(trx, p.tripId);
  expectVersion(trip, p.expectedVersion, "admin");
  sameCurrency(trip, p.driverPay, "The driver's pay");
  const set: Record<string, unknown> = {};
  if (p.waiveCancelFee) {
    // The rider owes nothing more; the driver keeps the share already credited (owner decision 34).
    const fee = await trx.selectFrom("rider_fees").selectAll().where("trip_id", "=", trip.trip_id).forUpdate().executeTakeFirst();
    if (!fee || fee.status !== "owed") throw new ApiError("conflict", "There is no unpaid fee on this trip.", { reason: "no_fee_to_waive", projection: tripProjection(trip, "admin") });
    // S5 J8 (debtModel.adminCorrections): a wallet correction entry, no fee_on_running_trip refusal any more.
    await correctFee(trx, fee, now);
    await trx.updateTable("rider_fees").set({ status: "waived", settled_at: now }).where("trip_id", "=", trip.trip_id).execute();
    set["cancellation"] = JSON.stringify({ ...(trip.cancellation as object), feeStatus: "waived" });
    await refreshOutstanding(trx, trip.rider_id, now);
  }
  if (p.waitingSeconds !== undefined || p.driverPay !== undefined) {
    // A paid trip is corrected with a refund, so cash and the record never disagree.
    if (terminal(trip.status)) throw new ApiError("invalid_transition", "This trip is paid; use a refund.", { reason: "use_refund", projection: tripProjection(trip, "admin") });
    // Before accept the offers carry the price; change it once a driver has it.
    if (["draft", "quoted", "requested", "searching", "offered"].includes(trip.status)) throw new ApiError("invalid_transition", "Change the fare or the driver's pay after a driver accepted.", { reason: "adjust_after_accept", projection: tripProjection(trip, "admin") });
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
        commission_minor: commissionOf(fare.total.amountMinor, fare.fareLines, fare.driverEarnings.amountMinor, pickupPay, Number(trip.driver_bonus_minor ?? 0)),
      });
      row = { ...trip, fare_minor: String(fare.total.amountMinor), fare_lines: fare.fareLines, driver_earnings_minor: String(fare.driverEarnings.amountMinor) };
    }
    // S5 J6 (owner Q-M7, Q-S5-8, S07 M8 "32 DT, keep change"): only the driver's pay moves, as its own change on the trip
    // (driverAdjustments). The fare, its lines and the commission stay; every later re-price sets driver_earnings_minor
    // only, so the change is kept on top. Paid as an adjustment entry when the trip is paid.
    if (p.driverPay !== undefined) {
      const change = await driverPayChange(trx, row, p.driverPay);
      // From the shown (capped) change, so the pay the admin typed is the pay shown.
      if (change !== 0) set["driver_adjustments_minor"] = cappedChangeOf(row) + change;
    }
  }
  if (Object.keys(set).length === 0) throw badRequest("Nothing to change.", "nothing_to_change");
  return tripProjection(await touchTrip(trx, trip, set, now), "admin");
}

registerApprovalHandler(ADJUST_ACTION, async (trx, payload, _approvedBy, _requestedBy, now) => adjustTrip(trx, payload as AdjustPayload, now));

export async function adminAdjust(trx: Trx, who: Principal, tripId: string, body: Omit<AdjustPayload, "tripId">, now: Date): Promise<{ status: number; body: unknown }> {
  refuseOldFare(body);
  const trip = await adminTrip(trx, who, tripId);
  // The audit line (trip.adjust) carries the driver's pay before and after (contract.json#moneyBase.adminFare).
  const pay = body.driverPay !== undefined ? { before: { amountMinor: payWithoutTip(trip), currency: trip.currency }, after: body.driverPay } : {};
  const ran = await runOrRequest<Record<string, unknown>>(trx, who, { action: ADJUST_ACTION, targetType: "trip", targetId: tripId, zoneId: trip.zone_id, payload: { ...body, ...pay, tripId }, approvePermission: "approval.decide" }, now);
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

/**
 * What the rider paid on a paid trip end: on a pay-in-car trip the cash taken + the wallet part; on a card / in-app trip
 * the whole fare (the card paid fare − wallet, BQ-M25: no cash is booked there). An old row without counted cash: the fare.
 */
export function paidByRider(trip: Pick<TripRow, "payment_method" | "fare_minor" | "cash_collected_minor" | "wallet_applied_minor">): number {
  if (trip.payment_method !== "cash" || trip.cash_collected_minor === null) return Number(trip.fare_minor);
  return Number(trip.cash_collected_minor) + Number(trip.wallet_applied_minor ?? 0);
}

/** What can still be refunded: what the rider paid (paidByRider), less the refunds already made. */
async function refundRoom(ex: Executor, trip: TripRow, amount: Money) {
  sameCurrency(trip, amount, "The refund");
  if (!terminal(trip.status) || !["captured", "partially_refunded"].includes(trip.payment_status ?? "")) {
    throw new ApiError("invalid_transition", "Only a paid trip can be refunded.", { reason: "not_paid", projection: tripProjection(trip, "admin") });
  }
  if (amount.amountMinor <= 0) throw badRequest("The refund must be more than 0.", "invalid_amount");
  const done = await ex.selectFrom("refunds").select((eb) => eb.fn.coalesce(eb.fn.sum<string>("amount_minor"), sql<string>`0`).as("n")).where("trip_id", "=", trip.trip_id).where("status", "=", "done").executeTakeFirstOrThrow();
  const paid = paidByRider(trip);
  const left = paid - Number(done.n);
  if (amount.amountMinor > left) throw badRequest(`At most ${moneyText({ amountMinor: Math.max(0, left), currency: trip.currency as CurrencyCode })} is left to refund.`, "refund_too_large");
  return { paid, left };
}

async function createRefund(trx: Trx, p: RefundPayload, createdBy: string, now: Date, approved = false): Promise<Record<string, unknown>> {
  const trip = await lockTrip(trx, p.tripId);
  // Deep fix 2026-11-02 (g7-g9 M4): an approved refund reads the trip as it is at approval (a note or pay change since
  // the request moved the version); the money rules (refundRoom) are checked again on that row.
  if (!approved) expectVersion(trip, p.expectedVersion, "admin");
  const { paid, left } = await refundRoom(trx, trip, p.amount);
  const refundId = newId("rfd", now.getTime());
  await trx.insertInto("refunds").values({ refund_id: refundId, trip_id: trip.trip_id, rider_id: trip.rider_id, currency: trip.currency, amount_minor: p.amount.amountMinor, reason: p.reason, status: "done", approval_id: null, from_driver: p.fromDriver === true, destination: null, payout_to: null, payout_status: null, created_by: createdBy, created_at: now }).execute();
  // "Take from driver": the driver loses their share of the refunded money (owner decision 31).
  if (p.fromDriver && trip.driver_id && paid > 0) {
    // Deep fix 2026-11-02 (g7-g9 M1): the rider's old debt collected on this trip is not part of the ride the driver earned on.
    const debt = trip.status === "completed" ? (((trip.fare_lines as Array<{ code: string; amount: Money }>) ?? []).filter((l) => l.code === "outstanding_fee").reduce((sum, l) => sum + l.amount.amountMinor, 0)) : 0;
    const fare = Number(trip.fare_minor) - debt;
    // Checker (7): never more than the driver still has on this trip (his one number never goes below 0).
    const share = Math.min(driverTotalOf(trip), fare > 0 ? Math.round((Math.min(p.amount.amountMinor, fare) * Number(trip.driver_earnings_minor ?? 0)) / fare) : 0);
    if (share > 0) {
      await credit(trx, { driverId: trip.driver_id, tripId: trip.trip_id, kind: "adjustment", currency: trip.currency, amount: -share }, now);
      // v0.18.10 (contract.json#finish.driverMoney): the driver's one number on the trip moves with it.
      await trx.updateTable("trips").set({ driver_adjustments_minor: sql`driver_adjustments_minor - ${share}` }).where("trip_id", "=", trip.trip_id).execute();
      // v0.18.91 job A7 (contract.json#finish.refund.driverNotice): the driver is told how much and why (bell + push).
      await noticeDriverRefund(trx, { trip_id: trip.trip_id, zone_id: trip.zone_id, driver_id: trip.driver_id }, { amountMinor: share, currency: trip.currency as CurrencyCode }, refundId, p.reason, now);
    }
  }
  await trx.updateTable("trips").set({ refunded_minor: sql`refunded_minor + ${p.amount.amountMinor}` }).where("trip_id", "=", trip.trip_id).execute();
  // v0.10.3: refunds count on the trip's day; an earlier day's summary is re-summed now.
  await resumTripDay(trx, trip.trip_id, now);
  const all = p.amount.amountMinor === left;
  // touchTrip re-reads the row, so the projection event carries the new refunded / adjustments numbers.
  await touchTrip(trx, trip, { payment_status: all ? "refunded" : "partially_refunded" }, now);
  const row = await trx.selectFrom("refunds").selectAll().where("refund_id", "=", refundId).executeTakeFirstOrThrow();
  // Deep fix 2026-11-02 (g7-g9 P2-M5): the rider hears about it (bell + push, his language).
  await noticeRefund(trx, trip, p.amount, now);
  return refundView(row);
}

const REFUND_TEXT = { sv: { title: "Återbetalning", body: "Du får tillbaka {amount} för din resa." }, fr: { title: "Remboursement", body: "Vous êtes remboursé de {amount} pour votre course." }, en: { title: "Refund", body: "You get {amount} back for your trip." } } as const;
/** Price format (owner 2026-11-14; audit price-display gap 14): the refund in the shared money text ("12.350 DT", not "12,350 TND"). */
export const refundNoticeBody = (amount: Money, lang: keyof typeof REFUND_TEXT): string => REFUND_TEXT[lang].body.replace("{amount}", moneyText(amount));
async function noticeRefund(trx: Trx, trip: TripRow, amount: Money, now: Date) {
  // v0.18.66 §87: the one notice-language rule (his language, else the trip country's, TN fr, else en).
  const lang = await noticeLanguage(trx, { actor: "rider", id: trip.rider_id }, trip.zone_id);
  await notify(trx, { audience: "rider", subjectId: trip.rider_id, kind: "refund", title: REFUND_TEXT[lang].title, body: refundNoticeBody(amount, lang), deepLink: `movera://trips/${trip.trip_id}/receipt`, tripId: trip.trip_id, data: { tripId: trip.trip_id, amount } }, now);
}

registerApprovalHandler(REFUND_ACTION, async (trx, payload, _approvedBy, requestedBy, now) => createRefund(trx, payload as RefundPayload, requestedBy, now, true));

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
  const radiusKm = input.scope === "radius" ? input.radiusKm ?? 5 : input.scope === "zone_and_neighbours" ? 25 : Infinity;
  // S4 B1.20 (owner yes, W1 Q81b): not every online driver of every country, only the drivers whose fresh position is
  // in the trip's zone or within the radius (nearArea.ts). The filter below stays and decides, so the lists are the same.
  const near = await driversNear(ex, input.scope === "zone" ? { zoneId: trip.zone_id } : { box: boxAround(trip.pickup as Place, radiusKm) }, now);
  if (near === null) return { items: [], scope: input.scope, ...(input.scope === "radius" ? { radiusKm } : {}) };
  const rows = await near
    .select(["drivers.driver_id", "drivers.first_name", "drivers.online_status", "drivers.category_ids", "driver_locations.lat", "driver_locations.lng", "driver_locations.accuracy", "driver_locations.heading", "driver_locations.speed_mps", "driver_locations.moving", "driver_locations.measured_at", "driver_locations.zone_id"])
    .where("drivers.account_status", "=", "active")
    .where("drivers.online_status", "in", ["online", "on_trip"])
    .where("driver_locations.received_at", ">", new Date(now.getTime() - STALE_AFTER_SECONDS * 1000))
    .where("driver_locations.measured_at", ">", new Date(now.getTime() - DISPATCH_FIX_MAX_AGE_SECONDS * 1000))
    .execute();
  const open = await ex.selectFrom("offers").select(["driver_id", "offer_id"]).where("trip_id", "=", trip.trip_id).where("status", "=", "open").execute();
  const items = rows
    .map((d) => ({ d, km: dispatchKm(d, trip.pickup as Place) }))
    .filter(({ d, km }) => (input.scope === "zone" ? d.zone_id === trip.zone_id : km <= radiusKm))
    .sort((a, b) => a.km - b.km || (a.d.driver_id < b.d.driver_id ? -1 : 1))
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
