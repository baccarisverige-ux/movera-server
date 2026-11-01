import type { TripRow } from "../db/tripLog.js";
import { tripTerms } from "./ride.js";

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

const ETA_STATUSES = new Set(["accepted", "driver_to_pickup", "rider_onboard", "in_trip", "approaching_dropoff"]);

type WaitingRow = { arrivedAt: string; freeUntil: string; noShowAt: string; chargedSeconds: number; noShowFee?: Money; noShowDriverShare?: Money };

/**
 * v0.18.7 (Q5, contract.json#pickupWaiting.runningTotal): while the driver waits, the paid seconds and cost so far at
 * read time (no version change): seconds after freeUntil × the trip's per-minute waiting price.
 */
function waitingNow(row: TripRow, waiting: WaitingRow, now: Date): WaitingRow & { chargedSecondsNow?: number; chargedSoFar?: Money; paidMinutes?: number } {
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
  const { pickupPin: _p, pinAttempts: _a, pinBlocked: _b, ...rest } = out;
  void _b;
  void _p;
  void _a;
  hideReversalDetails(rest);
  return rest;
}

export function tripProjection(row: TripRow, viewer: Viewer, overrides: { sequence?: number; now?: Date } = {}): Record<string, unknown> {
  const currency = row.currency;
  const lines = (row.fare_lines as Array<{ code: string; amount: Money }>) ?? [];
  const terms = tripTerms(row);
  // The stored ETA shows while the car is going somewhere (to the pickup, or to the drop-off with the rider on board).
  const eta = row.driver_id && ETA_STATUSES.has(row.status) ? (row.eta as { etaSeconds: number } | null) : null;
  const projection: Record<string, unknown> = {
    tripId: row.trip_id,
    rideId: row.trip_id,
    status: row.status,
    version: row.version,
    sequence: overrides.sequence ?? Number(row.sequence),
    kind: row.kind,
    ...(row.scheduled_at ? { scheduledAt: iso(row.scheduled_at) } : {}),
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
    stops: row.stops ?? [],
    // v0.7.1 (§3.8): the driver's arrived-at-stop / leaving-stop taps.
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
    ...(row.driver_summary ? { driver: row.driver_summary } : {}),
    // v0.18.7 (Q1): the rider as the driver sees him; never in the rider's own view.
    ...(row.rider_summary && viewer !== "rider" ? { rider: row.rider_summary } : {}),
    // v0.18.7: the rules this trip is charged by, and the server's road-route ETA (TripEta) while it has one.
    ...(terms ? { terms } : {}),
    ...(eta ? { eta, etaSeconds: eta.etaSeconds } : {}),
    ...(row.waiting ? { waiting: waitingNow(row, row.waiting as WaitingRow, overrides.now ?? new Date()) } : {}),
    ...(row.cancellation ? { cancellation: row.cancellation } : {}),
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
