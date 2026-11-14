import { reservationView } from "../reservations/view.js";
import { headingView } from "./headingCheck.js";
import type { TripRow } from "../db/tripLog.js";
import { bonusFor, priorityFor } from "../dispatch/bonusScope.js";
import { tripTerms } from "./ride.js";
import { contract } from "../contract/contract.js";
import { debtOf } from "../rules/commission.js";

/**
 * TripProjection (contract §2) from a trips row, per viewer: the rider never sees the driver's money
 * (driverEarnings, commission) or driver-only fare lines; the driver and admin do. One function, so every answer
 * and every realtime event of a trip has the same shape.
 */

export type Viewer = "rider" | "driver" | "admin";

const DRIVER_ONLY_LINES = new Set(["pickup_pay", "driver_bonus"]);

type Money = { amountMinor: number; currency: string };
const money = (minor: string | number | null | undefined, currency: string): Money | undefined =>
  minor === null || minor === undefined ? undefined : { amountMinor: Number(minor), currency };
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : undefined);

/** Where the stored ETA must point in each status (contract.json#pickupWaiting.eta: to the pickup until boarding, then to the drop-off). */
const ETA_TARGET_OF: Record<string, "pickup" | "dropoff"> = { accepted: "pickup", driver_to_pickup: "pickup", rider_onboard: "dropoff", in_trip: "dropoff", approaching_dropoff: "dropoff" };

type WaitingRow = { arrivedAt: string; waitFrom?: string; freeWaitMin?: number; freeUntil: string; noShowAt: string; chargedSeconds: number; noShowFee?: Money; noShowDriverShare?: Money };

/**
 * v0.18.7 (Q5, contract.json#pickupWaiting.runningTotal): while the driver waits, the paid seconds and cost so far at
 * read time (no version change): seconds after freeUntil × the trip's per-minute waiting price.
 */
/**
 * v0.18.51 §73 (contract.json#bookedRide0_18_51.waitFrom): when the free waiting starts. Set at arrive from v0.18.51; a
 * trip that arrived before has the clock it is charged by: freeUntil − freeWaitMin (else arrivedAt).
 */
function withWaitFrom(waiting: WaitingRow): WaitingRow {
  if (typeof waiting.waitFrom === "string") return waiting;
  const from = typeof waiting.freeWaitMin === "number" ? new Date(Date.parse(waiting.freeUntil) - waiting.freeWaitMin * 60_000).toISOString() : waiting.arrivedAt;
  return { ...waiting, waitFrom: from };
}

function waitingNow(row: TripRow, stored: WaitingRow, now: Date): WaitingRow & { chargedSecondsNow?: number; chargedSoFar?: Money; paidMinutes?: number } {
  const waiting = withWaitFrom(stored);
  // v0.18.8 (contract.json#arrivedWaiting.projection.waiting): whole paid minutes, rounded up, for the admin waiting box.
  // G6 live fix 7: a trip that ended while the driver was waiting (no-show / cancel from arrived) never boarded, so
  // chargedSeconds stayed 0: count the paid seconds up to the end (freeUntil → ended_at).
  if (row.status !== "arrived") {
    const endedWaiting = waiting.chargedSeconds > 0 || row.boarded_at || !row.ended_at ? 0 : Math.max(0, Math.floor((new Date(row.ended_at).getTime() - Date.parse(waiting.freeUntil)) / 1000));
    return { ...waiting, paidMinutes: Math.ceil(Math.max(0, waiting.chargedSeconds, endedWaiting) / 60) };
  }
  const terms = tripTerms(row);
  const perMin = (terms?.["waitPerMin"] as Money | undefined)?.amountMinor;
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(waiting.freeUntil)) / 1000));
  return { ...waiting, chargedSecondsNow: seconds, paidMinutes: Math.ceil(seconds / 60), ...(perMin !== undefined ? { chargedSoFar: { amountMinor: Math.floor((seconds * perMin) / 60 + 0.5), currency: row.currency } } : {}) };
}

/**
 * Contract §2: the rider never sees the driver's money. v0.18.7 (checker L1): also the driver's part of a fee and the share
 * percentages inside cancellation, waiting and terms. One function for GET answers and for the stream's redaction.
 */
export function hideDriverMoney(projection: Record<string, unknown>): Record<string, unknown> {
  const out = { ...projection };
  const without = (key: string, hidden: string[]) => {
    const value = out[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const copy = { ...(value as Record<string, unknown>) };
      for (const h of hidden) delete copy[h];
      out[key] = copy;
    }
  };
  without("cancellation", ["driverShare"]);
  without("waiting", ["noShowDriverShare"]);
  without("terms", ["noShowDriverSharePct", "cancelDriverSharePct"]);
  without("routeChange", ["driverEarnings", "earningsDifference"]);
  // v0.18.10 (contract.json#finish): the driver's one number, Movera's changes, the old debt and who gets what.
  without("finish", ["driverTotal", "earningsBreakdown"]);
  without("tip", ["driverShare"]);
  // v0.18.87: what Movera keeps now (moneyBase.commissionRow) is driver and admin only.
  for (const key of ["driverTotal", "earningsBreakdown", "driverAdjustments", "debtCollected", "moneySplit", "moveraKeepsNow"]) delete out[key];
  delete out["adminFlag"];
  delete out["pinAttempts"];
  delete out["pinBlocked"];
  hideReversalDetails(out);
  return out;
}

/** v0.18.8: the rider and the driver see that a no-show was reversed, not the admin's reason or name. */
export function hideReversalDetails(out: Record<string, unknown>): void {
  const c = out["cancellation"] as Record<string, unknown> | undefined;
  const r = c?.["reversal"] as Record<string, unknown> | undefined;
  if (c && r) out["cancellation"] = { ...c, reversal: { at: r["at"], driverShareTakenBack: r["driverShareTakenBack"] } };
}

/** v0.18.8 (contract.json#arrivedWaiting.pin): the driver never sees the rider's PIN nor the tries count. */
export function hidePinFromDriver(out: Record<string, unknown>): Record<string, unknown> {
  // v0.18.10: "who gets what" (moneySplit) is the admin's.
  const { pickupPin: _p, pinAttempts: _a, pinBlocked: _b, adminFlag: _f, moneySplit: _m, ...rest } = out;
  // v0.18.90 BQ-M21 (moneyBase.lostDriverPaid.driverView): the stored (admin) projection's moveraKeepsNow has the lost
  // driver's payment taken off; the driver's stream gets what Movera keeps from his own trip (the payment added back).
  const lost = (_m as { lostDriverPaid?: { amountMinor?: unknown } } | undefined)?.lostDriverPaid?.amountMinor;
  const keeps = rest["moveraKeepsNow"] as { amountMinor: number; currency: string } | undefined;
  if (keeps && typeof lost === "number" && lost > 0) rest["moveraKeepsNow"] = { ...keeps, amountMinor: keeps.amountMinor + lost };
  void _f;
  void _b;
  void _p;
  void _a;
  hideReversalDetails(rest);
  return rest;
}


/* ---------------------------------------------------------------- v0.18.10 (contract.json#finish) */

const SOS = (contract as unknown as { safety: { sos: { riderStatuses: string[]; driverStatuses: string[] } } }).safety.sos;
const SOS_RIDER = new Set(SOS.riderStatuses);
const SOS_DRIVER = new Set(SOS.driverStatuses);

export type EndInfo = { endedEarly: boolean; endedBy?: "rider" | "driver"; reasonCode?: string; repriced?: boolean; shortKm?: number; shortMin?: number };

/** What ended the trip (trips.end_info, set at the end; older trips: from the ending command). */
export function endInfoOf(trip: Pick<TripRow, "end_info" | "ended_by_command" | "cancellation" | "boarded_at">): EndInfo {
  const kept = trip.end_info as EndInfo | null;
  if (kept && typeof kept === "object") return kept;
  const reason = (trip.cancellation as { reasonCode?: string } | null)?.reasonCode;
  if (trip.ended_by_command === "end_early") return { endedEarly: true, endedBy: "rider", ...(reason ? { reasonCode: reason } : {}) };
  if (trip.ended_by_command === "cancel" && trip.boarded_at !== null) return { endedEarly: true, endedBy: "driver", ...(reason ? { reasonCode: reason } : {}) };
  return { endedEarly: false };
}

type MoneyRow = Pick<TripRow, "driver_earnings_minor" | "pickup_pay_minor" | "driver_bonus_minor" | "tip" | "driver_adjustments_minor"> & Partial<Pick<TripRow, "ended_at">>;
const tipMinor = (row: Pick<TripRow, "tip">) => Number((row.tip as { amount?: Money } | null)?.amount?.amountMinor ?? 0);

/**
 * S5 J6 (contract.json#moneyBase.adminFare "the pay never below 0"; supervisor re-check round 2): the one cap of the
 * admin's kept change. Before the end a negative change is shown at most as large as the pay without the tip (earnings +
 * pickup pay + bonus), so a downward re-price (a shorter route, the driven price) never shows a pay below 0, and the paid
 * end writes this same value (keptChange). After the end the row holds what was paid and written (post-end pay changes,
 * refunds taken from the driver, which may reach into the tip), so it is shown as it is.
 */
export function cappedChangeOf(row: MoneyRow): number {
  const change = Number(row.driver_adjustments_minor ?? 0);
  if (change >= 0 || (row.ended_at !== undefined && row.ended_at !== null)) return change;
  const pay = Number(row.driver_earnings_minor ?? 0) + Number(row.pickup_pay_minor ?? 0) + Number(row.driver_bonus_minor ?? 0);
  return Math.max(change, -Math.max(0, pay));
}

/** contract.json#finish.driverMoney (owner G8 Q3): the driver's one number for a trip and its lines (trip line always). */
export function earningsLinesOf(row: MoneyRow): Array<{ code: string; amountMinor: number }> {
  const lines = [
    { code: "trip", amountMinor: Number(row.driver_earnings_minor ?? 0) },
    { code: "pickup_pay", amountMinor: Number(row.pickup_pay_minor ?? 0) },
    { code: "bonus", amountMinor: Number(row.driver_bonus_minor ?? 0) },
    { code: "tip", amountMinor: tipMinor(row) },
    { code: "adjustment", amountMinor: cappedChangeOf(row) },
  ];
  return lines.filter((l) => l.code === "trip" || l.amountMinor !== 0);
}
export const driverTotalOf = (row: MoneyRow): number => earningsLinesOf(row).reduce((sum, l) => sum + l.amountMinor, 0);

/** v0.18.87: a paid trip end (completed, the rider's early end, the driver's end on board, admin complete), as in KPIs. */
const PAID_STATUSES = new Set(["captured", "partially_refunded", "refunded"]);
/** v0.18.90 BQ-M21 (moneyBase.lostDriverPaid): Movera's payments on this trip to the driver(s) who lost it (reassign / cancel). */
export const lostDriverPaidOf = (row: { lost_driver_paid_minor?: string | number | null }): number => Math.max(0, Number(row.lost_driver_paid_minor ?? 0));
export const isPaidEnd = (row: { status: string; payment_status: string | null }): boolean => row.status === "completed" || PAID_STATUSES.has(row.payment_status ?? "");

/** An ended trip with a fare the driver collected or the rider paid (complete, the rider's early end, a driver cancel on board). */
const FINISH_COMMANDS = new Set(["complete", "end_early"]);
function finishOf(row: TripRow, viewer: Viewer): Record<string, unknown> | null {
  if (row.ended_at === null) return null;
  const onboardCancel = row.ended_by_command === "cancel" && row.boarded_at !== null && row.payment_status !== null;
  if (!FINISH_COMMANDS.has(row.ended_by_command ?? "") && !onboardCancel) return null;
  const currency = row.currency;
  const fare = Number(row.fare_minor);
  const end = endInfoOf(row);
  const rating = viewer === "driver" ? row.driver_rating_status : row.rating_status;
  return {
    endedEarly: end.endedEarly,
    ...(end.endedBy ? { endedBy: end.endedBy } : {}),
    ...(end.reasonCode ? { reasonCode: end.reasonCode } : {}),
    ...(end.repriced !== undefined ? { repriced: end.repriced } : {}),
    total: { amountMinor: fare, currency },
    cashToCollect: { amountMinor: Math.max(0, fare - Number(row.wallet_applied_minor ?? 0)), currency },
    ...(viewer !== "rider"
      ? { driverTotal: { amountMinor: driverTotalOf(row), currency }, earningsBreakdown: earningsLinesOf(row).map((l) => ({ code: l.code, amount: { amountMinor: l.amountMinor, currency } })) }
      : {}),
    ratingAllowed: rating === "pending",
  };
}

/** stops[i] with the arrivedAt / leftAt of the matching stop visit (contract.json#stopWaits.projection). */
export function stopsWithVisits(stops: unknown, visits: unknown): unknown[] {
  const list = Array.isArray(stops) ? stops : [];
  const byIndex = new Map<number, { arrivedAt?: string; leftAt?: string }>();
  for (const v of Array.isArray(visits) ? (visits as Array<{ stopIndex?: unknown; arrivedAt?: string; leftAt?: string }>) : []) {
    if (typeof v?.stopIndex === "number") byIndex.set(v.stopIndex, v);
  }
  return list.map((stop, i) => {
    if (!stop || typeof stop !== "object") return stop;
    // Only the server's visits say arrived / left (a client echo of these keys in a stored stop never counts).
    const { arrivedAt: _a, leftAt: _l, ...place } = stop as Record<string, unknown>;
    const v = byIndex.get(i);
    return { ...place, ...(v?.arrivedAt ? { arrivedAt: v.arrivedAt } : {}), ...(v?.leftAt ? { leftAt: v.leftAt } : {}) };
  });
}

function headingField(row: TripRow, now: Date): Record<string, unknown> {
  const view = row.heading_check ? headingView(row, now) : null;
  return view ? { headingCheck: view } : {};
}

export function tripProjection(row: TripRow, viewer: Viewer, overrides: { sequence?: number; now?: Date } = {}): Record<string, unknown> {
  const currency = row.currency;
  const lines = (row.fare_lines as Array<{ code: string; amount: Money }>) ?? [];
  const terms = tripTerms(row);
  // The stored ETA shows while the car is going somewhere (to the pickup, or to the drop-off with the rider on board).
  // Live 5+5 2026-11-08 (problem 5): only an ETA to where the car goes NOW; the pickup ETA kept after boarding is not
  // sent (the trip-start event said "there at the start time" until the next tick).
  const stored = row.driver_id ? (row.eta as { etaSeconds: number; target?: string } | null) : null;
  const eta = stored && ETA_TARGET_OF[row.status] !== undefined && stored.target === ETA_TARGET_OF[row.status] ? stored : null;
  const projection: Record<string, unknown> = {
    tripId: row.trip_id,
    rideId: row.trip_id,
    status: row.status,
    version: row.version,
    sequence: overrides.sequence ?? Number(row.sequence),
    kind: row.kind,
    ...(row.scheduled_at ? { scheduledAt: iso(row.scheduled_at) } : {}),
    // v0.18.17 (contract.json#bookLater.rider.projection).
    ...(reservationView(row, viewer === "rider" ? "rider" : viewer === "driver" ? "driver" : "admin") ? { reservation: reservationView(row, viewer === "rider" ? "rider" : viewer === "driver" ? "driver" : "admin") } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    acceptedAt: iso(row.accepted_at) ?? null,
    riderId: row.rider_id,
    ...(row.driver_id ? { driverId: row.driver_id } : {}),
    ...(row.vehicle_id ? { vehicleId: row.vehicle_id } : {}),
    zoneId: row.zone_id,
    categoryId: row.category_id,
    pickup: row.pickup,
    dropoff: row.dropoff,
    // contract.json#stopWaits.projection: TripProjection.stops[i] gains arrivedAt? / leftAt? from the driver's taps.
    stops: stopsWithVisits(row.stops, row.stop_visits),
    // v0.7.1 (§3.8): the same taps, also as stopVisits (kept for older readers).
    ...(((row.stop_visits as unknown[] | null) ?? []).length ? { stopVisits: row.stop_visits } : {}),
    fare: money(row.fare_minor, currency),
    fareLines: viewer === "rider" ? lines.filter((l) => !DRIVER_ONLY_LINES.has(l.code)) : lines,
    paymentMethod: row.payment_method,
    ...(row.payment_method_id ? { paymentMethodId: row.payment_method_id } : {}),
    ...(row.payment_status ? { paymentStatus: row.payment_status } : {}),
    ratingStatus: viewer === "driver" ? row.driver_rating_status : row.rating_status,
    // The driver's own rating status, for admins and for the driver's realtime stream (redactProjection).
    ...(viewer === "admin" ? { driverRatingStatus: row.driver_rating_status } : {}),
    pinRequired: row.pin_required,
    // v0.18.8: the PIN (rider and admin views; taken out for the driver below and on his stream) and whether it was given.
    ...(row.pin_required && row.pickup_pin ? { pickupPin: row.pickup_pin, pinVerified: row.pin_verified_at !== null, pinAttempts: Number(row.pin_attempts ?? 0), pinBlocked: row.pin_blocked === true } : {}),
    // Owner D (v0.18.19): a held booked ride shows the rider "Driver assigned" only; the driver from driver_to_pickup on.
    ...(row.driver_summary && !(viewer === "rider" && row.kind === "scheduled" && row.status === "accepted") ? { driver: row.driver_summary } : {}),
    ...(viewer === "rider" && row.kind === "scheduled" && row.status === "accepted" && row.driver_id ? { driverAssigned: true } : {}),
    // v0.18.7 (Q1): the rider as the driver sees him; never in the rider's own view.
    ...(row.rider_summary && viewer !== "rider" ? { rider: row.rider_summary } : {}),
    // v0.18.7: the rules this trip is charged by, and the server's road-route ETA (TripEta) while it has one.
    ...(terms ? { terms } : {}),
    ...(eta ? { eta, etaSeconds: eta.etaSeconds } : {}),
    // v0.18.13 (G5-8, contract.json#pickupWaiting.headingCheck.projection): the latest heading-to-pickup check.
    ...headingField(row, overrides.now ?? new Date()),
    ...(row.waiting ? { waiting: waitingNow(row, row.waiting as WaitingRow, overrides.now ?? new Date()) } : {}),
    ...(row.cancellation ? { cancellation: row.cancellation } : {}),
    // v0.18.9 (contract.json#onTrip): the server's ride check (every viewer) and the latest route change.
    ...(row.ride_check ? { rideCheck: row.ride_check } : {}),
    ...(row.route_change ? { routeChange: row.route_change } : {}),
    ...(viewer === "admin" && row.admin_flag ? { adminFlag: row.admin_flag } : {}),
  };
  if (row.quote_id) {
    projection["quote"] = { quoteId: row.quote_id, total: money(row.booked_fare_minor, currency), expiresAt: iso(row.quote_expires_at ?? row.created_at) };
  }
  if (viewer !== "rider") {
    const earnings = money(row.driver_earnings_minor, currency);
    if (earnings) projection["driverEarnings"] = earnings;
    const commission = money(row.commission_minor, currency);
    if (commission) projection["commission"] = commission;
  }
  if (viewer !== "rider") {
    const pickupPay = money(row.pickup_pay_minor, currency);
    if (pickupPay && pickupPay.amountMinor > 0) projection["pickupPay"] = pickupPay;
    const bonus = money(row.driver_bonus_minor, currency);
    if (bonus && bonus.amountMinor > 0) projection["driverBonus"] = bonus;
  }
  // v0.18.10 (contract.json#finish): the tip, the finish block, the driver's one number, the old debt and "who gets what".
  if (row.tip) {
    const { driverShare, ...forRider } = row.tip as Record<string, unknown>;
    projection["tip"] = viewer === "rider" ? forRider : { ...forRider, driverShare };
  }
  const finish = finishOf(row, viewer);
  if (finish) projection["finish"] = finish;
  if (viewer !== "rider" && row.driver_id) {
    projection["driverTotal"] = { amountMinor: driverTotalOf(row), currency };
    projection["earningsBreakdown"] = earningsLinesOf(row).map((l) => ({ code: l.code, amount: { amountMinor: l.amountMinor, currency } }));
    const adjustments = cappedChangeOf(row);
    if (adjustments !== 0) projection["driverAdjustments"] = { amountMinor: adjustments, currency };
  }
  const debt = debtOf(lines);
  if (viewer !== "rider" && debt > 0) projection["debtCollected"] = { amountMinor: debt, currency };
  if (viewer !== "rider") {
    const refunded = Number(row.refunded_minor ?? 0);
    const tip = tipMinor(row);
    // Checker (1): the parts always add up to what the rider paid. Movera is the rest after the driver's one number (which
    // holds the tip, pay changes and refunds taken from him) and the old fee; a refund Movera pays lowers Movera's part.
    const riderPaid = Number(row.fare_minor) + tip - refunded;
    const driverPart = row.driver_id ? driverTotalOf(row) : 0;
    // v0.18.90 BQ-M21 (contract.json#moneyBase.lostDriverPaid, owner 2026-11-13 "Movera commission is how much movera
    // keep"): what Movera paid on this trip to the driver(s) who lost it is taken off what Movera keeps — on the admin
    // view only: the driver's view stays what Movera keeps from HIS trip (another driver's money is never sent to him).
    const lost = viewer === "admin" ? lostDriverPaidOf(row) : 0;
    const movera = { amountMinor: riderPaid - driverPart - debt - lost, currency };
    if (viewer === "admin") {
      projection["moneySplit"] = {
        riderPaid: { amountMinor: riderPaid, currency },
        driverTotal: { amountMinor: driverPart, currency },
        movera,
        debtCollected: { amountMinor: debt, currency },
        ...(tip > 0 ? { tip: { amountMinor: tip, currency } } : {}),
        refunded: { amountMinor: refunded, currency },
        ...(lost > 0 ? { lostDriverPaid: { amountMinor: lost, currency } } : {}),
      };
    }
    // v0.18.87 BQ-M19 (contract.json#moneyBase.commissionRow, owner 2026-11-13 "Movera commission is how much movera
    // keep"): what Movera keeps NOW on a paid trip (= moneySplit.movera, later pay changes and bonuses included), on the
    // driver and admin views, for the "Movera commission" rows. Absent before a paid end (the apps hide the row).
    if (isPaidEnd(row)) projection["moveraKeepsNow"] = { ...movera };
  }
  // v0.18.10 (owner G8 Q4): SOS only once a driver is assigned (safety.sos.*Statuses); "Call 112" is always there.
  if (viewer === "rider") projection["sosAvailable"] = SOS_RIDER.has(row.status);
  if (viewer === "driver") projection["sosAvailable"] = SOS_DRIVER.has(row.status);
  // Owner bug 2026-11-01: the admin sees the money (and badge) per kind of offer while the trip waits for a driver.
  if (viewer === "admin" && (row.bonus_exclusive_minor !== null && row.bonus_exclusive_minor !== undefined || row.bonus_radar_minor !== null && row.bonus_radar_minor !== undefined || Number(row.driver_bonus_minor ?? 0) > 0 || row.priority)) {
    projection["driverBonusByKind"] = {
      exclusive: { amountMinor: bonusFor(row, "exclusive"), currency, priority: priorityFor(row, "exclusive") },
      radar: { amountMinor: bonusFor(row, "radar"), currency, priority: priorityFor(row, "radar") },
    };
  }
  // v0.18.33 (owner answer 2026-11-05): a live trip queued behind its driver's current trip (driver and admin views).
  if (viewer !== "rider" && row.next_after_trip_id) projection["nextAfterTripId"] = row.next_after_trip_id;
  // Owner Q3 + Q5: the rider's app shows a free cancel for a queued trip, and for a chained one from freeCancelAt.
  if (row.chained) projection["chain"] = { queued: Boolean(row.next_after_trip_id), ...(row.chain_free_cancel_at ? { freeCancelAt: new Date(row.chain_free_cancel_at).toISOString() } : {}) };
  // v0.18.33 (owner Q6, contract.json#afterTestRules.walletFirst): the rider's per-ride wallet switch (rider and admin views).
  if (viewer !== "driver") projection["walletFirst"] = (row.booking_rules as { walletFirst?: boolean } | null)?.walletFirst !== false;
  // The wallet pays first; the driver collects the rest in cash (shown once the wallet covers part of it).
  const wallet = Number(row.wallet_applied_minor ?? 0);
  if (wallet > 0) {
    projection["walletApplied"] = money(wallet, currency);
    projection["cashToCollect"] = money(Math.max(0, Number(row.fare_minor) - wallet), currency);
  }
  // The rider's latest waiting step, while searching or offered, and the busy message on an expired trip (§3.6).
  if (viewer !== "driver" && row.search_step && ["searching", "offered", "expired"].includes(row.status)) projection["searchStep"] = row.search_step;
  // Admins only: the driver sent no position for 30 minutes with the rider on board (owner decision 2026-10-26).
  if (viewer === "admin" && row.driver_silent_alert) projection["driverSilentAlert"] = row.driver_silent_alert;
  if (viewer === "driver") return hidePinFromDriver(projection);
  return viewer === "rider" ? hideDriverMoney(projection) : projection;
}
