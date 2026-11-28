import { contract } from "../contract/contract.js";

/**
 * v0.18.17 Book later (CONTRACT.md §41, contract.json#bookLater): the zone's booked-ride settings
 * (DriverAppConfig.reservations, Admin › Dispatch › Reservations) and the pure timeline of one booked ride.
 * fixtures/book_later.json holds the cases; the reference check and this module agree on every one.
 */

export type RideTypeKey = "normal" | "airport" | "longTrip" | "comfortPremium" | "event";
export type RideTypeTimes = { onlineBeforeMin: number; spareMin: number; reminderMin: number[] };
export type ListTo = "all" | "category" | "rating" | "random" | "nearNow" | "group" | "areaRegulars" | "homeNear" | "favourites" | "nearAtTime";

export type ReservationSettings = {
  on: boolean;
  minAheadMin: number;
  maxAheadDays: number;
  soonBeforeMin: number;
  exclusiveBeforeMin: number;
  radarBeforeMin: number;
  homePopup: boolean;
  homePopupAfterMin: number;
  noticeOn: boolean;
  noticeMaxDrivers: number;
  listTo: ListTo;
  listMinRating: number;
  listGroupSize: number;
  listNearKm: number;
  listAreaTrips: number;
  listGroupId: string | null;
  listOpenAll: boolean;
  listOpenAllAfterMin: number;
  noDriverAlertMin: number;
  riderReminderMin: number;
  freeChangeBeforeMin: number;
  /** null = no limit (owner BL-Q5). */
  maxTripKm: number | null;
  dispatchBeforeMin: number;
  listHomeKm: number;
  listAtTimeKm: number;
  listAtTimeMin: number;
  changeAnswerMin: number;
  /** Owner: arrive this many minutes before the pickup time (default 10). */
  arriveEarlyMin: number;
  offlineBackupAfterMin: number;
  hideClashing: boolean;
  longTripKm: number;
  driverLateCancelHours: number;
  /** v0.18.35 job 4 (contract.json#bookedTakeBack): take a held booked ride back only when more than this many minutes late… */
  takeBackLateMin: number;
  /** …and more than this many minutes' drive from the pickup… */
  takeBackKeepIfDriveMin: number;
  /** …and the pickup is at least this many minutes away. */
  takeBackUntilMinBeforePickup: number;
  /** v0.18.39 §63 (P17, owner "15 min after pickup past"): a booked ride with no driver ends this many minutes after its pickup time. */
  noDriverStopAfterMin: number;
  /** v0.18.81 B1.34 (contract.json#bookLater.riderCap, owner Q94 "A) Yes", 2026-11-13: default 3): booked rides a rider may hold that have not ended. */
  maxOpenPerRider: number;
  /** v0.18.172 (contract.json#preferredAreas.maxPerDriver): the most preferred areas one driver may keep (1-30, default 10). */
  preferredAreasMax: number;
  rideTypes: Record<RideTypeKey, RideTypeTimes>;
};

type Defaults = ReservationSettings & { note?: string };
export const RESERVATION_DEFAULTS = (contract as unknown as { configDefaults: { reservations: Defaults } }).configDefaults.reservations;
const LIST_TO = (contract as unknown as { bookLater: { listTo: { values: ListTo[] } } }).bookLater.listTo.values;
export const RIDE_TYPE_KEYS: RideTypeKey[] = ["normal", "airport", "longTrip", "comfortPremium", "event"];

const num = (value: unknown, min: number, max: number, fallback: number, whole = true): number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!whole || Number.isInteger(value)) ? value : fallback;
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

/** The zone's settings: every field optional on read, a missing or invalid one keeps the contract default. */
export function reservationSettings(raw: unknown): ReservationSettings {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = RESERVATION_DEFAULTS;
  const types = (r["rideTypes"] !== null && typeof r["rideTypes"] === "object" ? r["rideTypes"] : {}) as Record<string, Record<string, unknown> | undefined>;
  const rideTypes = Object.fromEntries(RIDE_TYPE_KEYS.map((key) => {
    const own = types[key] ?? {};
    const base = d.rideTypes[key];
    const reminders = Array.isArray(own["reminderMin"]) && own["reminderMin"].length <= 4 && own["reminderMin"].every((m) => Number.isInteger(m) && m >= 1 && m <= 1440) ? (own["reminderMin"] as number[]) : base.reminderMin;
    return [key, { onlineBeforeMin: num(own["onlineBeforeMin"], 5, 240, base.onlineBeforeMin), spareMin: num(own["spareMin"], 0, 60, base.spareMin), reminderMin: [...reminders] }];
  })) as Record<RideTypeKey, RideTypeTimes>;
  return {
    on: bool(r["on"], d.on),
    minAheadMin: num(r["minAheadMin"], 5, 240, d.minAheadMin),
    maxAheadDays: num(r["maxAheadDays"], 1, 365, d.maxAheadDays),
    soonBeforeMin: num(r["soonBeforeMin"], 0, 240, d.soonBeforeMin),
    exclusiveBeforeMin: num(r["exclusiveBeforeMin"], 1, 180, d.exclusiveBeforeMin),
    radarBeforeMin: num(r["radarBeforeMin"], 1, 180, d.radarBeforeMin),
    homePopup: bool(r["homePopup"], d.homePopup),
    homePopupAfterMin: num(r["homePopupAfterMin"], 1, 1440, d.homePopupAfterMin),
    noticeOn: bool(r["noticeOn"], d.noticeOn),
    noticeMaxDrivers: num(r["noticeMaxDrivers"], 1, 500, d.noticeMaxDrivers),
    listTo: LIST_TO.includes(r["listTo"] as ListTo) ? (r["listTo"] as ListTo) : d.listTo,
    listMinRating: num(r["listMinRating"], 1, 5, d.listMinRating, false),
    listGroupSize: num(r["listGroupSize"], 1, 500, d.listGroupSize),
    listNearKm: num(r["listNearKm"], 0.5, 50, d.listNearKm, false),
    listAreaTrips: num(r["listAreaTrips"], 1, 200, d.listAreaTrips),
    listGroupId: typeof r["listGroupId"] === "string" && r["listGroupId"] ? (r["listGroupId"] as string) : null,
    listOpenAll: bool(r["listOpenAll"], d.listOpenAll),
    listOpenAllAfterMin: num(r["listOpenAllAfterMin"], 1, 1440, d.listOpenAllAfterMin),
    noDriverAlertMin: num(r["noDriverAlertMin"], 1, 120, d.noDriverAlertMin),
    riderReminderMin: num(r["riderReminderMin"], 0, 1440, d.riderReminderMin),
    freeChangeBeforeMin: num(r["freeChangeBeforeMin"], 0, 1440, d.freeChangeBeforeMin),
    maxTripKm: r["maxTripKm"] === null ? null : typeof r["maxTripKm"] === "number" ? num(r["maxTripKm"], 1, 1000, d.maxTripKm ?? 1000, false) : d.maxTripKm,
    dispatchBeforeMin: num(r["dispatchBeforeMin"], 5, 240, d.dispatchBeforeMin),
    listHomeKm: num(r["listHomeKm"], 0.5, 50, d.listHomeKm, false),
    listAtTimeKm: num(r["listAtTimeKm"], 0.5, 50, d.listAtTimeKm, false),
    listAtTimeMin: num(r["listAtTimeMin"], 5, 240, d.listAtTimeMin),
    changeAnswerMin: num(r["changeAnswerMin"], 1, 120, d.changeAnswerMin),
    arriveEarlyMin: num(r["arriveEarlyMin"], 0, 60, d.arriveEarlyMin),
    offlineBackupAfterMin: num(r["offlineBackupAfterMin"], 1, 60, d.offlineBackupAfterMin),
    hideClashing: bool(r["hideClashing"], d.hideClashing),
    longTripKm: num(r["longTripKm"], 10, 500, d.longTripKm, false),
    driverLateCancelHours: num(r["driverLateCancelHours"], 0.5, 72, d.driverLateCancelHours, false),
    takeBackLateMin: num(r["takeBackLateMin"], 1, 60, d.takeBackLateMin),
    takeBackKeepIfDriveMin: num(r["takeBackKeepIfDriveMin"], 0, 60, d.takeBackKeepIfDriveMin),
    takeBackUntilMinBeforePickup: num(r["takeBackUntilMinBeforePickup"], 0, 180, d.takeBackUntilMinBeforePickup),
    noDriverStopAfterMin: num(r["noDriverStopAfterMin"], 1, 240, d.noDriverStopAfterMin),
    maxOpenPerRider: num(r["maxOpenPerRider"], 1, 50, d.maxOpenPerRider),
    preferredAreasMax: num(r["preferredAreasMax"], 1, 30, d.preferredAreasMax),
    rideTypes,
  };
}

export type BookingWindowError = "booking_too_soon" | "booking_too_far";

/** Q1: the booking window (minAheadMin .. maxAheadDays). */
export function windowError(bookedAt: Date, scheduledAt: Date, s: Pick<ReservationSettings, "minAheadMin" | "maxAheadDays">): BookingWindowError | null {
  const ahead = (scheduledAt.getTime() - bookedAt.getTime()) / 60_000;
  if (ahead < s.minAheadMin) return "booking_too_soon";
  if (ahead > s.maxAheadDays * 1440) return "booking_too_far";
  return null;
}

export type Plan = {
  mode: "now" | "list";
  dispatchAt: Date;
  popupAt: Date | null;
  openAllAt: Date | null;
  noDriverAt: Date;
  riderReminderAt: Date | null;
  freeChangeUntil: Date;
};

const minus = (at: Date, minutes: number) => new Date(at.getTime() - minutes * 60_000);
const plus = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000);
const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

/** Q2–Q6: when each step of a booked ride happens (contract.json#bookLater.plan). */
export function planOf(bookedAt: Date, scheduledAt: Date, s: ReservationSettings): Plan {
  const ahead = (scheduledAt.getTime() - bookedAt.getTime()) / 60_000;
  const mode = ahead < s.soonBeforeMin ? "now" : "list";
  const dispatchAt = mode === "now" ? bookedAt : later(bookedAt, minus(scheduledAt, s.dispatchBeforeMin));
  const before = (at: Date | null) => (at !== null && at.getTime() < dispatchAt.getTime() ? at : null);
  const popupAt = mode === "list" && s.homePopup ? before(plus(bookedAt, s.homePopupAfterMin)) : null;
  const openAllAt = mode === "list" && s.listTo !== "all" && s.listOpenAll ? before(plus(bookedAt, s.listOpenAllAfterMin)) : null;
  const reminder = s.riderReminderMin > 0 ? minus(scheduledAt, s.riderReminderMin) : null;
  return {
    mode,
    dispatchAt,
    popupAt,
    openAllAt,
    noDriverAt: later(bookedAt, minus(scheduledAt, s.noDriverAlertMin)),
    riderReminderAt: reminder !== null && reminder.getTime() > bookedAt.getTime() ? reminder : null,
    freeChangeUntil: minus(scheduledAt, s.freeChangeBeforeMin),
  };
}

/**
 * Q6: a booking may be changed (reschedule) more than freeChangeBeforeMin minutes before pickup. v0.18.49 §71 (owner
 * Q10): this no longer makes a cancel free; a booked cancel follows the category's cancel fee rule only.
 */
export const freeByTime = (now: Date, scheduledAt: Date, s: Pick<ReservationSettings, "freeChangeBeforeMin">): boolean =>
  (scheduledAt.getTime() - now.getTime()) / 60_000 > s.freeChangeBeforeMin;

/** Q5 driver: reminder times still ahead of the accept, the go-online time and the offline check. */
export function driverTimes(acceptedAt: Date, scheduledAt: Date, times: RideTypeTimes, offlineBackupAfterMin: number) {
  const reminders = [...times.reminderMin].sort((a, b) => b - a).map((m) => minus(scheduledAt, m)).filter((at) => at.getTime() > acceptedAt.getTime());
  const goOnlineAt = minus(scheduledAt, times.onlineBeforeMin);
  return { reminders, goOnlineAt, offlineCheckAt: plus(goOnlineAt, offlineBackupAfterMin) };
}

/** contract.json#bookLater.driver.rideType. */
export function rideTypeOf(trip: { category_id: string; distance_meters: number | null }, airport: boolean, s: Pick<ReservationSettings, "longTripKm">): RideTypeKey {
  if (airport) return "airport";
  if ((trip.distance_meters ?? 0) / 1000 > s.longTripKm) return "longTrip";
  if (trip.category_id === "comfort" || trip.category_id === "premium") return "comfortPremium";
  return "normal";
}

/** contract.json#bookLater.card (owner Q4 "Charge at booking"): a booked ride paid by card is charged in full when it is booked. */
export const chargedAtBooking = (kind: string, paymentMethod: string): boolean => kind === "scheduled" && (paymentMethod === "card" || paymentMethod === "apple_pay");

/** Owner (v0.18.19 leaveOnTime): when to start driving so the driver arrives arriveEarlyMin before the pickup. */
export function leaveAtOf(scheduledAt: Date, driveSeconds: number, arriveEarlyMin: number): Date {
  return new Date(scheduledAt.getTime() - arriveEarlyMin * 60_000 - driveSeconds * 1000);
}
