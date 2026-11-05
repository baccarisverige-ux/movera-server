import { afterBackToRequested, afterStartedTakeBack, freeCancelByTime, lateStartedBooked } from "../../reservations/service.js";
import { BOOKED_LATE_REASON } from "../../reservations/takeBack.js";
import { commissionOf } from "../../rules/commission.js";
import { askUnexpectedEnd } from "../../safety/rideCheckServer.js";
import { sql } from "kysely";
import { liveDocument } from "../../config/service.js";
import type { Executor, Trx } from "../../db/db.js";
import type { TripRow } from "../../db/tripLog.js";
import { ApiError, badRequest } from "../../http/errors.js";
import { cancelFee, isFreeCancel } from "../../rules/cancelFees.js";
import { startSearch, stopSearch } from "../../dispatch/runtime.js";
import { applyCommand, expectVersion, lockOwnTrip } from "../commands.js";
import { nextStatus } from "../../rules/transitions.js";
import { tripProjection, type EndInfo } from "../projection.js";
import { headingSettingsFor, isFreeCancel as headingFreeCancel, NOT_HEADING_REASON, noticeTakenBack, type HeadingState } from "../headingCheck.js";
import { type Money, type Waiting, REASONS, ONBOARD } from "./shared.js";
import { rulesOf, waitingOf, outstandingLine } from "./settings.js";
import { releaseDriver, credit, chargeRiderFee, feeSplit, feeColumns, spendWallet } from "./money.js";
import { newPin } from "./steps.js";
import { creditTrip, earlyEndPrice, type FrozenMoney } from "./finish.js";

/* ---------------------------------------------------------------- no-show */

export async function noShow(trx: Trx, driverId: string, tripId: string, body: { expectedVersion: number; reasonCode?: string }, now: Date): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, { actor: "driver", subjectId: driverId });
  expectVersion(trip, body.expectedVersion, "driver");
  if (body.reasonCode !== undefined && !REASONS["noShow"]!.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not a no-show reason.`, "invalid_reason_code");
  const waiting = trip.waiting as Waiting | null;
  // Guard "waited >= noShowAfterMin" (contract.json#transitions).
  if (trip.status === "arrived" && (waiting === null || now.getTime() < Date.parse(waiting.noShowAt))) {
    throw new ApiError("invalid_transition", "Wait until the no-show time before marking a no-show.", { reason: "no_show_too_early", projection: tripProjection(trip, "driver") });
  }
  return markNoShow(trx, trip, "driver", false, now);
}

/** The no-show itself (driver after the wait, or an admin who may waive the fee). */
export async function markNoShow(trx: Trx, trip: TripRow, actor: "driver" | "admin", waive: boolean, now: Date): Promise<TripRow> {
  // v0.18.8: the no-show fee of the rule applied at arrive (waiting.noShowFee), else the category's.
  const ruleFee = (trip.waiting as Waiting | null)?.noShowFee ?? (await waitingOf(trx, trip)).noShowFee;
  const fee: Money | null = !waive && ruleFee.amountMinor > 0 ? { amountMinor: ruleFee.amountMinor, currency: trip.currency } : null;
  const share = (await rulesOf(trx, trip)).noShowDriverSharePct;
  // v0.18.7 (Q6): feeKind and the driver's part, so both apps show the amount.
  const cancellation = { actor, reasonCode: "rider_no_show", at: now.toISOString(), fee, ...(fee ? { feeStatus: "owed", feeKind: "no_show", driverShare: { amountMinor: feeSplit(fee, share).driver, currency: fee.currency } } : {}) };
  const ended = await applyCommand(trx, trip, {
    command: "no_show",
    actor,
    now,
    set: { cancellation: JSON.stringify(cancellation), ended_by_command: "no_show", ended_at: now, search_step: null, ...(fee ? feeColumns(fee, share) : {}) },
  });
  if (fee && trip.driver_id) {
    await chargeRiderFee(trx, ended, "no_show", fee, now);
    await credit(trx, { driverId: trip.driver_id, tripId: trip.trip_id, kind: "fee_share", currency: fee.currency, amount: feeSplit(fee, share).driver }, now);
  } else if (fee) {
    await chargeRiderFee(trx, ended, "no_show", fee, now);
  }
  await stopSearch(trx, ended, now);
  await releaseDriver(trx, trip.driver_id, now);
  return ended;
}

/* ---------------------------------------------------------------- the rider's cancel fee after accept */

/**
 * The rider's cancel fee (contract §3, §5 "Live cancel fees per category"): nothing before a driver accepted or
 * inside the free minutes; a live trip is charged only while the driver is heading to the pickup (headingCheck.ts). The fee is on the booked fare without an outstanding fee.
 */
export type RiderFee = { fee: Money; kind: "cancel" | "no_show" };

export async function riderCancelFee(ex: Executor, trip: TripRow, now: Date): Promise<RiderFee | null> {
  if (trip.accepted_at === null || trip.driver_id === null) return null;
  // v0.18.17 (contract.json#bookLater.rider.cancel, owner Q6): more than freeChangeBeforeMin before pickup = free.
  if (await freeCancelByTime(ex, trip, now)) return null;
  const rules = await rulesOf(ex, trip);
  const rule = rules.cancelRule;
  if (rule === null) return null;
  const owed = outstandingLine(trip);
  const fare = { amountMinor: Number(trip.booked_fare_minor) - (owed ? owed.amount.amountMinor : 0), currency: trip.currency };
  const minutesSinceAccept = (now.getTime() - trip.accepted_at.getTime()) / 60_000;
  const minutesBeforePickup = trip.scheduled_at ? (trip.scheduled_at.getTime() - now.getTime()) / 60_000 : 0;
  const kind = trip.kind === "scheduled" ? "reservation" : "live";
  // v0.18.7 (Q2, contract.json#pickupWaiting.cancelAfterArrived): inside the free minutes the rider always cancels free,
  // also after the driver arrived (owner 2026-10-29). After them, a cancel with the driver at the pickup is a no-show
  // when the zone says so (admin setting, default on): the no-show fee with the no-show share.
  if (isFreeCancel({ kind, rule, minutesSinceAccept, minutesBeforePickup })) return null;
  // Checker M1: it is a no-show only from waiting.freeUntil on, the moment the driver himself could mark one (a
  // reservation's clock runs from the booked time); a cancel seconds after arrival is the normal cancel fee.
  const waiting = trip.waiting as Waiting | null;
  if (trip.status === "arrived" && rules.cancelAfterArrivedIsNoShow && waiting !== null && now.getTime() >= Date.parse(waiting.freeUntil)) {
    const noShow = (waiting.noShowFee ?? (await waitingOf(ex, trip)).noShowFee).amountMinor;
    return noShow > 0 ? { fee: { amountMinor: noShow, currency: trip.currency }, kind: "no_show" } : null;
  }
  const amount = cancelFee({ kind, rule, fare: fare as Parameters<typeof cancelFee>[0]["fare"], minutesSinceAccept, minutesBeforePickup });
  if (amount.amountMinor <= 0) return null;
  if (trip.kind === "live" && trip.status !== "arrived") {
    // v0.18.13 (owner G5-8, contract.json#pickupWaiting.headingCheck.riderCancel): after the free minutes the rider pays
    // only while the driver is heading to the pickup (checked with every ETA tick); not heading for notHeadingMinutes in
    // a row = free. Checker 1: no check yet (a trip accepted before the deploy, no position so far) = the normal fee rules.
    const settings = await headingSettingsFor(ex, trip.zone_id);
    if (settings.on) {
      const state = trip.heading_check as HeadingState | null;
      if (state !== null && headingFreeCancel(state, settings, now)) return null;
    }
  }
  return { fee: amount, kind: "cancel" };
}

/** The driver's share of a rider fee: the cancel share, or the no-show share when the cancel counted as a no-show (v0.18.7). */
export async function riderFeeSharePct(ex: Executor, trip: TripRow, kind: RiderFee["kind"]): Promise<number> {
  const rules = await rulesOf(ex, trip);
  return kind === "no_show" ? rules.noShowDriverSharePct : rules.cancelDriverSharePct;
}

/** After the rider's cancel: the driver is free again and gets their share of a fee (owed by the rider). */
export async function riderFeeColumns(ex: Executor, trip: TripRow, charged: RiderFee) {
  return feeColumns(charged.fee, await riderFeeSharePct(ex, trip, charged.kind));
}

export async function afterRiderCancel(trx: Trx, before: TripRow, cancelled: TripRow, charged: RiderFee | null, now: Date) {
  if (charged && before.driver_id) {
    const share = await riderFeeSharePct(trx, before, charged.kind);
    await chargeRiderFee(trx, cancelled, charged.kind, charged.fee, now);
    await credit(trx, { driverId: before.driver_id, tripId: before.trip_id, kind: "fee_share", currency: charged.fee.currency, amount: feeSplit(charged.fee, share).driver }, now);
  }
  await releaseDriver(trx, before.driver_id, now);
}

/* ---------------------------------------------------------------- the driver's cancel */

/**
 * v0.18.13 (G5-9): the driver cancel codes the zone's live DriverAppConfig.cancelReasons turns on, per sheet; a sheet the
 * admin did not set or left empty uses contract.json#cancelReasons; a code the contract does not know is dropped.
 */
export async function driverCancelReasonsOf(ex: Executor, zoneId: string): Promise<Record<"driverBeforeTrip" | "driverDuringTrip" | "scheduled", string[]>> {
  const doc = await liveDocument<{ cancelReasons?: Record<string, unknown> }>(ex, "driver_app_config", zoneId);
  const listed = doc?.document.cancelReasons ?? {};
  const sheet = (name: "driverBeforeTrip" | "driverDuringTrip" | "scheduled") => {
    const value = listed[name];
    const codes = Array.isArray(value) ? value.filter((code): code is string => typeof code === "string" && REASONS[name]!.includes(code)) : [];
    // An empty sheet would leave a driver unable to cancel at all (safety): the built-in list then.
    return codes.length > 0 ? codes : [...REASONS[name]!];
  };
  return { driverBeforeTrip: sheet("driverBeforeTrip"), driverDuringTrip: sheet("driverDuringTrip"), scheduled: sheet("scheduled") };
}

export async function driverCancel(trx: Trx, driverId: string, tripId: string, body: { expectedVersion: number; reasonCode: string; note?: string }, now: Date): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, { actor: "driver", subjectId: driverId });
  expectVersion(trip, body.expectedVersion, "driver");
  if (nextStatus(trip.status as never, "cancel", "driver", trip.kind) === null) {
    throw new ApiError("invalid_transition", `A driver cannot cancel a trip that is ${trip.status}.`, { projection: tripProjection(trip, "driver") });
  }
  const onboard = ONBOARD.includes(trip.status);
  // v0.18.13 checker 3: the admin list (DriverAppConfig.cancelReasons, driverCancelReasonsOf) only decides what the app
  // shows; the server accepts every contract code of the sheet, so an old app showing the built-in list still works.
  const allowed = onboard ? REASONS["driverDuringTrip"]! : trip.kind === "scheduled" ? [...REASONS["scheduled"]!, ...REASONS["driverBeforeTrip"]!] : REASONS["driverBeforeTrip"]!;
  if (!allowed.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not a reason for a driver cancel now.`, "invalid_reason_code");
  // The driver's note is for Movera only (driver_cancels); the rider sees the reason code.
  const cancellation = { actor: "driver", reasonCode: body.reasonCode, at: now.toISOString(), fee: null };
  // Counts in the driver's cancel rate (§3 "counts in cancel rate").
  await trx.insertInto("driver_cancels").values({ trip_id: tripId, driver_id: driverId, at: now, from_status: trip.status, reason_code: body.reasonCode, note: body.note ?? null }).execute();

  if (onboard) {
    // Ended on board: the rider pays for what was driven, in cash, like an early end (owner decision 8).
    // Builder question 4: one rule with the early complete — re-priced only over the admin's km / minutes.
    const priced = await earlyEndPrice(trx, trip, now);
    const money = { fare_minor: Number(trip.fare_minor), ...priced.money } as FrozenMoney & { fare_minor: number };
    const wallet = await spendWallet(trx, trip, money.fare_minor, now);
    const info: EndInfo = { ...priced.info, reasonCode: body.reasonCode };
    const ended = await applyCommand(trx, trip, {
      command: "cancel",
      actor: "driver",
      now,
      set: { ...money, cancellation: JSON.stringify(cancellation), end_info: JSON.stringify(info), ended_by_command: "cancel", ended_at: now, payment_status: "captured", cash_collected_minor: money.fare_minor - wallet, wallet_applied_minor: wallet },
    });
    await creditTrip(trx, ended, now);
    await releaseDriver(trx, driverId, now);
    // v0.18.9 (contract.json#onTrip.rideCheck): ended on board far from the drop-off → "Is everything OK?" to both.
    await askUnexpectedEnd(trx, ended, now);
    return trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  }

  // Before boarding: back to dispatch (or a reservation back to the list), without this driver.
  return backToDispatch(trx, trip, { command: "cancel", actor: "driver", now, exclude: driverId });
}

/**
 * The trip leaves its driver and goes back to dispatch (driver cancel before boarding, admin reassign): the
 * driver is free, open offers are withdrawn and a new search starts (§3.6 "One search per driver cancel").
 */
export async function backToDispatch(trx: Trx, trip: TripRow, input: { command: "cancel" | "reassign"; actor: "driver" | "admin"; now: Date; exclude?: string }): Promise<TripRow> {
  const now = input.now;
  const quote = trip.quote_id ? await trx.selectFrom("quotes").select("driver_earnings_minor").where("quote_id", "=", trip.quote_id).executeTakeFirst() : undefined;
  const booked = Number(trip.booked_fare_minor);
  const quoted = quote ? Number(quote.driver_earnings_minor) : Number(trip.driver_earnings_minor ?? 0);
  // An admin may have changed the fare: the driver's share follows it.
  const earnings = booked > 0 && Number(trip.fare_minor) !== booked ? Math.round((quoted * Number(trip.fare_minor)) / booked) : quoted;
  const back = await applyCommand(trx, trip, {
    command: input.command,
    actor: input.actor,
    now,
    set: {
      driver_id: null,
      vehicle_id: null,
      accepted_at: null,
      arrived_at: null,
      waiting: null,
      driver_summary: null,
      // v0.18.7 (Q1, Q4): the next driver gets his own rider summary at accept; the ETA starts again with him.
      rider_summary: null,
      eta: null,
      // Checker round 1 (H1): the PIN state belongs to one driver; a new driver gets a fresh PIN (the rider sees the new one).
      pin_verified_at: null,
      pin_attempts: 0,
      pin_locked_until: null,
      pin_wrong_total: 0,
      pin_blocked: false,
      ...(trip.pin_required ? { pickup_pin: newPin() } : {}),
      accept_pickup_meters: null,
      // v0.18.13 (G5-8): the heading check starts again with the next driver.
      heading_check: null,
      pickup_pay_minor: 0,
      driver_earnings_minor: earnings,
      commission_minor: commissionOf(Number(trip.fare_minor), trip.fare_lines, earnings, 0, Number(trip.driver_bonus_minor ?? 0)),
      wallet_applied_minor: 0,
      search_step: null,
      ...(input.exclude ? { cancelled_driver_ids: sql<string[]>`array_append(cancelled_driver_ids, ${input.exclude})` } : {}),
      ...(trip.status === "accepted" && trip.kind === "scheduled" ? {} : { search_started_at: now }),
    },
  });
  await stopSearch(trx, back, now);
  await releaseDriver(trx, trip.driver_id, now);
  if (back.status === "searching") await startSearch(trx, back, now);
  // v0.18.17 (contract.json#bookLater.driver.release): a booked ride back on the list; after its dispatch time, searched now.
  if (back.status === "requested") return afterBackToRequested(trx, back, now);
  return back;
}

/**
 * v0.18.13 (owner G5-8, contract.json#pickupWaiting.headingCheck.reassign): the driver was not heading to the pickup for
 * notHeadingMinutes in a row: the trip goes back to dispatch without him, it counts as his cancel (driver_cancels,
 * reason not_heading_to_pickup) and he gets a notice. The rider gets the driver_changed push (applyCommand).
 */
export async function takeBackNotHeading(trx: Trx, trip: TripRow, now: Date): Promise<void> {
  const driverId = trip.driver_id;
  if (!driverId) return;
  await trx.insertInto("driver_cancels").values({ trip_id: trip.trip_id, driver_id: driverId, at: now, from_status: trip.status, reason_code: NOT_HEADING_REASON, note: null }).execute();
  await backToDispatch(trx, trip, { command: "cancel", actor: "driver", now, exclude: driverId });
  await noticeTakenBack(trx, driverId, trip.trip_id, now);
}

/**
 * v0.18.35 FIX JOB 4 (contract.json#bookedTakeBack, owner job-4 Q4 "if he is late so take it from him"): a booked ride
 * the driver started but is not heading to the pickup, and the take-back rule says he would be too late while there is
 * still time: back to dispatch without him (the rider sees "searching for a new driver" and gets the driver_changed
 * push, owner job-4 Q2), counted on his cancel record (reason booked_late_taken_back, never a fee), and he is told.
 * Runs in the ETA tick's transaction with the trip row locked (rule 33: one copy takes it back once).
 */
export async function takeBackLateBooked(trx: Trx, trip: TripRow, now: Date, driveSeconds: number): Promise<boolean> {
  const driverId = trip.driver_id;
  if (!driverId || !(await lateStartedBooked(trx, trip, driveSeconds, now))) return false;
  await trx.insertInto("driver_cancels").values({ trip_id: trip.trip_id, driver_id: driverId, at: now, from_status: trip.status, reason_code: BOOKED_LATE_REASON, note: null }).execute();
  await backToDispatch(trx, trip, { command: "cancel", actor: "driver", now, exclude: driverId });
  await afterStartedTakeBack(trx, trip, driverId, now);
  return true;
}
