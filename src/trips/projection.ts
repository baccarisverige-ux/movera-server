import type { TripRow } from "../db/tripLog.js";

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

export function tripProjection(row: TripRow, viewer: Viewer, overrides: { sequence?: number } = {}): Record<string, unknown> {
  const currency = row.currency;
  const lines = (row.fare_lines as Array<{ code: string; amount: Money }>) ?? [];
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
    ...(row.driver_summary ? { driver: row.driver_summary } : {}),
    ...(row.waiting ? { waiting: row.waiting } : {}),
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
  return projection;
}
