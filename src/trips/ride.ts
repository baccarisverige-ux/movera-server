import { afterBackToRequested, freeCancelByTime } from "../reservations/service.js";
import { randomInt } from "node:crypto";
import { applyPersonRules, hasBadWord, ratingRules } from "../admin/reviewRules.js";
import { commissionOf } from "../rules/commission.js";
import { checkTags } from "../admin/ratings.js";
import { closeDriverSilent, incidentHandlers, openDriverSilent } from "../safety/incidents.js";
import { rideCheckHandlers } from "../safety/rideCheck.js";
import { askUnexpectedEnd, rideCheckScanHandler } from "../safety/rideCheckServer.js";
import { routeChangeExpireHandler } from "./routeChange.js";
import { sql, type Updateable } from "kysely";
import type { OfflineReason, TripsTable } from "../db/schema.js";
import { markSetOffline } from "../drivers/offlineReason.js";
import { offlineIfDocumentsExpired } from "../drivers/reminders.js";
import { contract } from "../contract/contract.js";
import { schemaProblem } from "../contract/schemas.js";
import { liveDocument } from "../config/service.js";
import type { Executor, Trx } from "../db/db.js";
import { appendTripEvent, type TripRow } from "../db/tripLog.js";
import { stopWaitSeconds } from "./stops.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { scheduleTimer, type TimerHandler } from "../jobs/timers.js";
import { haversineKm } from "../maps/routing.js";
import { cancelFee, isFreeCancel, type FeeRule } from "../rules/cancelFees.js";
import { priceFare, type Fare, type FareLine, type PricingDocument } from "../rules/fare.js";
import { extrasOf } from "../rules/priceExtras.js";
import { lockTripNow, startSearch, stopSearch } from "../dispatch/runtime.js";
import { applyCommand, expectVersion, lockOwnTrip, readOwnTrip } from "./commands.js";
import { nextStatus, RIDER_ONBOARD, type TripStatus } from "../rules/transitions.js";
import { driverTotalOf, earningsLinesOf, tripProjection, type EndInfo } from "./projection.js";
import { effectiveWaiting, waitingExtrasOf, type WaitingExtras, type WaitingRuleId } from "./waitingRules.js";
import { inPolygon, type Polygon } from "../zones/geometry.js";
import { headingSettingsFor, isFreeCancel as headingFreeCancel, NOT_HEADING_REASON, noticeTakenBack, type HeadingState } from "./headingCheck.js";

/**
 * The ride after a driver accepted (contract §3, §3.5, §3.7): the driver's steps, the waiting clock and no-show,
 * driver cancels (back to dispatch, or ended on board), the rider ending early, completion with cash, the rider's
 * cancel fee after accept, unpaid fees and ratings. Cash only in the test week (owner decision).
 */

type Money = { amountMinor: number; currency: string };
type Place = { lat: number; lng: number };
type WaitingAlert = { kind: "paid_waiting_started" | "no_show_possible"; at: string };
/** v0.18.8 (contract.json#arrivedWaiting): the effective rule numbers set at arrive, and the island alerts sent. */
type Waiting = {
  arrivedAt: string; freeUntil: string; noShowAt: string; chargedSeconds: number; noShowFee?: Money; noShowDriverShare?: Money;
  rules?: WaitingRuleId[]; freeWaitMin?: number; perMin?: Money; noShowAfterMin?: number; alerts?: WaitingAlert[];
};
type Who = { actor: "rider" | "driver" | "admin"; subjectId: string };

const C = contract as unknown as {
  cancelReasons: Record<string, string[]>;
  configDefaults: { noShowDriverSharePct: number; maxPickupMoveMeters: number; cancelAfterArrivedIsNoShow: boolean };
  pickupWaiting: { pickupMove: { range: [number, number] } };
};
const REASONS = C.cancelReasons;
const DEFAULT_NO_SHOW_SHARE = C.configDefaults.noShowDriverSharePct;
/** v0.18.7 (contract.json#pickupWaiting): the pickup move limit and the cancel-after-arrival rule, per zone, with their defaults. */
export const DEFAULT_MAX_PICKUP_MOVE_METERS = C.configDefaults.maxPickupMoveMeters;
export const DEFAULT_CANCEL_AFTER_ARRIVED_IS_NO_SHOW = C.configDefaults.cancelAfterArrivedIsNoShow;
const PICKUP_MOVE_RANGE = C.pickupWaiting.pickupMove.range;
export const validPickupMoveMeters = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= PICKUP_MOVE_RANGE[0] && value <= PICKUP_MOVE_RANGE[1] ? value : null;

/** Within this distance of the drop-off the trip shows "Almost there" (near_dropoff). */
export const NEAR_DROPOFF_METERS = 500;
export const NEAR_DROPOFF = "near_dropoff";
/* v0.18.13: the old came-closer check (400 m/min × 50 %, once at the cancel) is replaced by the heading check (headingCheck.ts). */
/** "Arrived" is accepted within this distance of the pickup (the driver's latest fix). */
export const ARRIVE_MAX_METERS = 300;
const POSITION_MAX_AGE = (contract as unknown as { arrivedWaiting: { positionMaxAge: { default: number; range: [number, number] } } }).arrivedWaiting.positionMaxAge;

/** v0.18.14: DriverAppConfig.waiting.positionMaxAgeSeconds of the zone (default 60, range 15–600). */
export async function positionMaxAge(ex: Executor, zoneId: string): Promise<number> {
  const doc = await liveDocument<{ waiting?: { positionMaxAgeSeconds?: unknown } }>(ex, "driver_app_config", zoneId);
  const v = doc?.document.waiting?.positionMaxAgeSeconds;
  return typeof v === "number" && Number.isInteger(v) && v >= POSITION_MAX_AGE.range[0] && v <= POSITION_MAX_AGE.range[1] ? v : POSITION_MAX_AGE.default;
}
/** A trip completed farther than this from the drop-off (the driver's latest fix) ended early: the rider pays what was driven. */
export const COMPLETE_NEAR_DROPOFF_METERS = 300;

const ONBOARD = ["rider_onboard", "in_trip", "approaching_dropoff"];

/* ---------------------------------------------------------------- prices and settings */

/**
 * The pricing document the trip was quoted with (its version, in the zone's or v0.8.0 the country standard's
 * history), else the live one.
 */
export async function pricingOf(ex: Executor, trip: TripRow): Promise<PricingDocument> {
  if (trip.pricing_version !== null) {
    const scope = trip.pricing_scope ?? trip.zone_id;
    const kept = await ex.selectFrom("config_history").select("document").where("doc", "=", "pricing").where("zone_id", "=", scope).where("version", "=", trip.pricing_version).executeTakeFirst();
    if (kept) return kept.document as PricingDocument;
  }
  const live = await liveDocument<PricingDocument>(ex, "pricing", trip.zone_id);
  if (live === null) throw new ApiError("unavailable", "Prices are not set for this area.", { reason: "pricing_not_published", retryAfterSeconds: 60 });
  return live.document;
}

function waitingRules(doc: PricingDocument, categoryId: string) {
  const category = doc.categories[categoryId];
  if (category === undefined) throw new ApiError("unavailable", "Prices for this car type are missing.", { reason: "pricing_invalid" });
  return category.waiting;
}

/**
 * The driver's share of a rider's late cancel fee (owner decision 26): all of it by default; an admin sets another
 * share as DriverAppConfig.cancelFees.driverSharePct (v0.8.0, Admin › Dispatch, per zone).
 */
export const DEFAULT_CANCEL_SHARE = (contract as unknown as { configDefaults: { cancelDriverSharePct: number } }).configDefaults.cancelDriverSharePct;
export const DEFAULT_LIVE_CANCEL_RULE: FeeRule = { freeMin: 2, type: "fixed", value: 6500, min: null, max: null };

const sharePct = (pct: unknown, fallback: number) => (typeof pct === "number" && pct >= 0 && pct <= 100 ? pct : fallback);

type CategoryWaitingRules = ReturnType<typeof waitingRules>;
/** contract.json#bookingSnapshot (v0.8.0): every rule a booked trip keeps from booking time. */
export type BookingRules = {
  cancelRule: FeeRule | null;
  cancelDriverSharePct: number;
  waiting: CategoryWaitingRules | null;
  noShowDriverSharePct: number;
  waitDriverSharePct: number;
  /** v0.18.7 (Q2): the zone's "cancel after the driver arrived counts as a no-show" at booking time. */
  cancelAfterArrivedIsNoShow: boolean;
  /** v0.18.7 (status item 4): the zone's pickup move limit at booking time. */
  maxPickupMoveMeters: number;
  /** v0.18.8 (contract.json#arrivedWaiting.rules): the zone's far pickup / ride type rules at booking time (null: none, booked before v0.18.8). */
  waitingRules: WaitingExtras | null;
  /** v0.18.8: free minutes at each middle stop (0 = none). */
  stopFreeWaitMin: number;
  /** v0.18.8 (contract.json#arrivedWaiting.pin): the zone's pickupPin settings at booking time. */
  pin: PinSettings;
  /** v0.18.9 (contract.json#onTrip.stopWaiting): the category's price per minute at a middle stop at booking time (absent before v0.18.9). */
  stopWaitPerMin?: Money;
  /** v0.18.10 (contract.json#finish.earlyEnd.driver): the zone's re-price limits at booking time (absent before v0.18.10). */
  earlyEnd?: EarlyEndSettings;
};
export type EarlyEndSettings = { repriceOverKm: number; repriceOverMin: number };
const EARLY_END = contract as unknown as { configDefaults: { earlyEnd: EarlyEndSettings }; finish: { earlyEnd: { settings: { ranges: Record<keyof EarlyEndSettings, [number, number]> } } } };
const EARLY_END_DEFAULTS = EARLY_END.configDefaults.earlyEnd;
const EARLY_END_RANGES = EARLY_END.finish.earlyEnd.settings.ranges;
/** DriverAppConfig.cancelFees.earlyEnd of a driver document; a missing or out-of-range number takes the default (2 km, 8 min). */
export function earlyEndSettingsOf(doc: unknown): EarlyEndSettings {
  const e = (doc as { cancelFees?: { earlyEnd?: Record<string, unknown> } } | undefined)?.cancelFees?.earlyEnd;
  const pick = (k: keyof EarlyEndSettings) => {
    const v = e?.[k];
    const [lo, hi] = EARLY_END_RANGES[k];
    return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : EARLY_END_DEFAULTS[k];
  };
  return { repriceOverKm: pick("repriceOverKm"), repriceOverMin: pick("repriceOverMin") };
}
export type PinSettings = { required: boolean; maxAttempts: number; lockMinutes: number };
const PIN_DEFAULTS = (contract as unknown as { configDefaults: { pickupPin: PinSettings } }).configDefaults.pickupPin;
const intIn = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);
/** DriverAppConfig.pickupPin of a zone's live driver document, with the defaults (off, 5 tries, 5 min). */
export function pinSettingsOf(doc: unknown): PinSettings {
  const p = (doc as { pickupPin?: Record<string, unknown> } | undefined)?.pickupPin;
  return {
    required: typeof p?.["required"] === "boolean" ? p["required"] : PIN_DEFAULTS.required,
    maxAttempts: intIn(p?.["maxAttempts"], 1, 10, PIN_DEFAULTS.maxAttempts),
    lockMinutes: intIn(p?.["lockMinutes"], 1, 60, PIN_DEFAULTS.lockMinutes),
  };
}
type AppDocs = {
  rider: { cancelFees?: { live?: Record<string, FeeRule>; reservation?: Record<string, FeeRule> } } | undefined;
  driver:
    | { currency?: unknown; cancelFees?: { driverSharePct?: unknown }; waiting?: { driverSharePct?: unknown; driverShareWaitPct?: unknown; cancelAfterArrivedIsNoShow?: unknown }; booking?: { maxPickupMoveMeters?: unknown }; pickupPin?: unknown }
    | undefined;
};

async function appDocs(ex: Executor, zoneId: string): Promise<AppDocs> {
  const rider = await liveDocument<NonNullable<AppDocs["rider"]>>(ex, "rider_app_config", zoneId);
  const driver = await liveDocument<NonNullable<AppDocs["driver"]>>(ex, "driver_app_config", zoneId);
  return { rider: rider?.document, driver: driver?.document };
}

/** RiderAppConfig.cancelFees.live|reservation[categoryId]; the owner's 65 kr after 2 free minutes for a live trip without one. */
function cancelRuleOf(docs: AppDocs, kind: string, categoryId: string): FeeRule | null {
  const table = kind === "scheduled" ? docs.rider?.cancelFees?.reservation : docs.rider?.cancelFees?.live;
  return table?.[categoryId] ?? (kind === "live" ? DEFAULT_LIVE_CANCEL_RULE : null);
}

/** At POST /trips (contract.json#bookingSnapshot): the rules of this moment, kept on the trip. */
export async function bookingRulesFor(ex: Executor, zoneId: string, kind: string, categoryId: string, pricing: PricingDocument | null): Promise<BookingRules> {
  const docs = await appDocs(ex, zoneId);
  // v0.18.7: the waiting terms always get kept (TripProjection.terms): the quoted pricing document, else the live one.
  const priced = pricing ?? (await liveDocument<PricingDocument>(ex, "pricing", zoneId))?.document ?? null;
  return {
    cancelRule: cancelRuleOf(docs, kind, categoryId),
    cancelDriverSharePct: sharePct(docs.driver?.cancelFees?.driverSharePct, DEFAULT_CANCEL_SHARE),
    waiting: priced?.categories[categoryId]?.waiting ?? null,
    ...(priced?.categories[categoryId]?.stopWaitPerMin ? { stopWaitPerMin: priced.categories[categoryId]!.stopWaitPerMin } : {}),
    noShowDriverSharePct: sharePct(docs.driver?.waiting?.driverSharePct, DEFAULT_NO_SHOW_SHARE),
    waitDriverSharePct: sharePct(docs.driver?.waiting?.driverShareWaitPct, 100),
    cancelAfterArrivedIsNoShow: cancelAfterArrivedOf(docs.driver),
    maxPickupMoveMeters: validPickupMoveMeters(docs.driver?.booking?.maxPickupMoveMeters) ?? DEFAULT_MAX_PICKUP_MOVE_METERS,
    ...waitingAndPinOf(docs.driver, priced?.currency ?? (typeof docs.driver?.currency === "string" ? docs.driver.currency : null)),
    earlyEnd: earlyEndSettingsOf(docs.driver),
  };
}

/** v0.18.8: the zone's waiting rules, stop free minutes and PIN switch of a driver document (none without a currency). */
function waitingAndPinOf(driverDoc: AppDocs["driver"], currency: string | null): Pick<BookingRules, "waitingRules" | "stopFreeWaitMin" | "pin"> {
  const extras = currency ? waitingExtrasOf(driverDoc?.waiting, currency) : null;
  return { waitingRules: extras, stopFreeWaitMin: extras?.stopFreeWaitMin ?? 0, pin: pinSettingsOf(driverDoc) };
}

/** v0.18.7 (Q2): DriverAppConfig.waiting.cancelAfterArrivedIsNoShow of a zone's live driver document, default on. */
export function cancelAfterArrivedOf(driverDoc: AppDocs["driver"]): boolean {
  const value = driverDoc?.waiting?.cancelAfterArrivedIsNoShow;
  return typeof value === "boolean" ? value : DEFAULT_CANCEL_AFTER_ARRIVED_IS_NO_SHOW;
}

/** The pickup move limit of a zone now (its live driver document), for a trip booked before v0.18.7. */
export async function pickupMoveLimitOf(ex: Executor, zoneId: string): Promise<number> {
  const doc = await liveDocument<NonNullable<AppDocs["driver"]>>(ex, "driver_app_config", zoneId);
  return validPickupMoveMeters(doc?.document.booking?.maxPickupMoveMeters) ?? DEFAULT_MAX_PICKUP_MOVE_METERS;
}

/** The trip's kept rules; a trip booked before v0.8.0 has none and reads today's settings; one booked before v0.18.7 lacks the new fields and takes the defaults. */
export async function rulesOf(ex: Executor, trip: TripRow): Promise<BookingRules> {
  const kept = trip.booking_rules as Partial<BookingRules> | null;
  if (kept !== null && typeof kept === "object" && kept.cancelRule !== undefined) {
    const old = kept as Omit<BookingRules, "cancelAfterArrivedIsNoShow" | "maxPickupMoveMeters" | "waitingRules" | "stopFreeWaitMin" | "pin"> & Partial<BookingRules>;
    // v0.18.8: a trip booked before has no extra waiting rules, no free stop minutes and no PIN (as it was booked).
    return {
      ...old,
      cancelAfterArrivedIsNoShow: old.cancelAfterArrivedIsNoShow ?? DEFAULT_CANCEL_AFTER_ARRIVED_IS_NO_SHOW,
      maxPickupMoveMeters: old.maxPickupMoveMeters ?? DEFAULT_MAX_PICKUP_MOVE_METERS,
      waitingRules: old.waitingRules ?? null,
      stopFreeWaitMin: old.stopFreeWaitMin ?? 0,
      pin: old.pin ?? { ...PIN_DEFAULTS, required: false },
    };
  }
  return bookingRulesFor(ex, trip.zone_id, trip.kind, trip.category_id, null);
}

/**
 * v0.18.7 (contract.json#pickupWaiting.terms): TripProjection.terms, the rules this trip is charged by, from its kept
 * booking rules (null for a trip with none: the apps fall back to the served config).
 */
export function tripTerms(trip: Pick<TripRow, "booking_rules" | "currency"> & { waiting?: unknown }): Record<string, unknown> | null {
  const kept = trip.booking_rules as Partial<BookingRules> | null;
  if (kept === null || typeof kept !== "object" || !kept.waiting) return null;
  // v0.18.8 (contract.json#arrivedWaiting.projection.terms): from arrive the effective numbers of the applied rule.
  const arrived = (trip.waiting ?? null) as Waiting | null;
  const w = arrived?.freeWaitMin !== undefined
    ? { freeWaitMin: arrived.freeWaitMin, perMin: arrived.perMin ?? kept.waiting.perMin, noShowAfterMin: arrived.noShowAfterMin ?? kept.waiting.noShowAfterMin, noShowFee: arrived.noShowFee ?? kept.waiting.noShowFee }
    : kept.waiting;
  return {
    currency: trip.currency,
    freeWaitMin: w.freeWaitMin,
    waitPerMin: w.perMin,
    noShowAfterMin: w.noShowAfterMin,
    noShowFee: w.noShowFee,
    waitingRules: arrived?.rules ?? [],
    stopFreeWaitMin: kept.stopFreeWaitMin ?? 0,
    // v0.18.9 (contract.json#onTrip.stopWaiting): the price per minute at a middle stop, so both apps show it.
    ...(kept.stopWaitPerMin ? { stopWaitPerMin: kept.stopWaitPerMin } : {}),
    noShowDriverSharePct: kept.noShowDriverSharePct ?? DEFAULT_NO_SHOW_SHARE,
    cancelRule: kept.cancelRule ?? null,
    cancelDriverSharePct: kept.cancelDriverSharePct ?? DEFAULT_CANCEL_SHARE,
    cancelAfterArrivedIsNoShow: kept.cancelAfterArrivedIsNoShow ?? DEFAULT_CANCEL_AFTER_ARRIVED_IS_NO_SHOW,
    maxPickupMoveMeters: kept.maxPickupMoveMeters ?? DEFAULT_MAX_PICKUP_MOVE_METERS,
  };
}

async function waitingOf(ex: Executor, trip: TripRow): Promise<CategoryWaitingRules> {
  const kept = (trip.booking_rules as BookingRules | null)?.waiting;
  return kept ?? waitingRules(await pricingOf(ex, trip), trip.category_id);
}

const outstandingLine = (trip: TripRow) => ((trip.fare_lines as FareLine[]) ?? []).find((l) => l.code === "outstanding_fee");

/** The fare with the quote's route and the waiting so far (§3.5 "Quote and fare"). */
export async function fareWithWaiting(ex: Executor, trip: TripRow, chargedSeconds: number, now?: Date): Promise<Fare> {
  const doc = await pricingOf(ex, trip);
  const owed = outstandingLine(trip);
  return priceFare(doc, {
    categoryId: trip.category_id,
    km: (trip.distance_meters ?? 0) / 1000,
    minutes: (trip.duration_seconds ?? 0) / 60,
    kind: trip.kind,
    surgeMultiplier: Number(trip.surge_multiplier),
    waitingChargedSeconds: chargedSeconds,
    // v0.18.8: the effective per-minute price of the rule applied at arrive.
    ...((trip.waiting as Waiting | null)?.perMin ? { waitingPerMin: (trip.waiting as Waiting).perMin! } : {}),
    // v0.7.1 (§3.8): from the driver's arrived-at-stop to leaving-stop, no free minutes.
    stopWaitSeconds: stopWaitSeconds(trip, now ?? new Date()),
    // The fixed route and the airport zones of the booking are priced again at the end.
    ...extrasOf(trip.price_extras),
    ...(owed ? { outstandingFee: owed.amount, ...(owed.sourceTripId ? { outstandingSourceTripId: owed.sourceTripId } : {}) } : {}),
  });
}

/** Km driven on board: the driver's trace since boarding, else the straight line from the pickup × 1.25. */
async function kmOnBoard(ex: Executor, trip: TripRow, since: Date): Promise<number> {
  const fixes = await ex.selectFrom("trip_locations").select(["lat", "lng", "accuracy", "measured_at"]).where("trip_id", "=", trip.trip_id).where("measured_at", ">=", since).where("accuracy", "<=", 50).orderBy("measured_at").execute();
  if (fixes.length >= 2) {
    // Count a step only once the car moved 25 m (parked jitter), and never faster than 150 km/h (a wild fix).
    let km = 0;
    let from = fixes[0]!;
    for (const next of fixes.slice(1)) {
      const step = haversineKm(from, next);
      if (step < 0.025) continue;
      const hours = Math.max(1, next.measured_at.getTime() - from.measured_at.getTime()) / 3_600_000;
      if (step / hours > 150) continue;
      km += step;
      from = next;
    }
    return km;
  }
  const last = trip.driver_id ? await ex.selectFrom("driver_locations").select(["lat", "lng"]).where("driver_id", "=", trip.driver_id).executeTakeFirst() : undefined;
  return last ? haversineKm(trip.pickup as Place, last) * 1.25 : 0;
}

/** What was driven (owner decisions 8, 19): the rider ends early, or the driver ends the trip on board. */
async function drivenFare(ex: Executor, trip: TripRow, now: Date): Promise<Fare> {
  return (await driven(ex, trip, now)).fare;
}

/** The driven fare with the km and minutes on board it was priced from. */
async function driven(ex: Executor, trip: TripRow, now: Date): Promise<{ fare: Fare; km: number; minutes: number }> {
  const doc = await pricingOf(ex, trip);
  const since = trip.boarded_at ?? now;
  const km = Math.round((await kmOnBoard(ex, trip, since)) * 1000) / 1000;
  const minutes = Math.round(Math.max(0, now.getTime() - since.getTime()) / 600) / 100;
  const owed = outstandingLine(trip);
  // Deep fix 2026-11-02 (g7-g9 H1): the cap is the booked fare moved by every accepted route change.
  const booked = Number(trip.booked_fare_minor) + Number(trip.route_delta_minor ?? 0) - (owed ? owed.amount.amountMinor : 0);
  const waiting = trip.waiting as Waiting | null;
  const fare = priceFare(doc, {
    categoryId: trip.category_id,
    km,
    minutes,
    kind: trip.kind,
    surgeMultiplier: Number(trip.surge_multiplier),
    // P2-H1: the paid pickup waiting and the booking's extras (seat, airport, reservation fee) are kept on an early end.
    waitingChargedSeconds: waiting?.chargedSeconds ?? 0,
    ...(waiting?.perMin ? { waitingPerMin: waiting.perMin } : {}),
    ...extrasOf(trip.price_extras),
    endEarly: { kmDriven: km, minutesOnBoard: minutes, bookedFare: { amountMinor: booked, currency: trip.currency } },
  });
  return { fare, km, minutes };
}

/**
 * v0.18.10 (owner G8 Q2, contract.json#finish.earlyEnd): the driven fare's columns PLUS the paid waiting at the middle
 * stops (fee and minutes are kept on every early end).
 */
async function drivenColumns(ex: Executor, trip: TripRow, fare: Fare, now: Date) {
  const base = fareColumns(trip, fare);
  const asDriven = { ...trip, fare_minor: String(base.fare_minor), fare_lines: fare.fareLines, driver_earnings_minor: String(base.driver_earnings_minor) } as TripRow;
  return (await withStopWaiting(ex, asDriven, now)) ?? base;
}

/** The re-price limits of a trip: kept at booking (v0.18.10), else the zone's live driver document. */
async function earlyEndOf(ex: Executor, trip: TripRow): Promise<EarlyEndSettings> {
  const kept = (trip.booking_rules as Partial<BookingRules> | null)?.earlyEnd;
  if (kept) return earlyEndSettingsOf({ cancelFees: { earlyEnd: kept } });
  return earlyEndSettingsOf((await liveDocument(ex, "driver_app_config", trip.zone_id))?.document);
}

/** The driver's latest fix is farther than COMPLETE_NEAR_DROPOFF_METERS from the drop-off (no fix: not early). */
async function endedBeforeDropoff(ex: Executor, trip: TripRow): Promise<boolean> {
  if (!trip.driver_id) return false;
  const fix = await ex.selectFrom("driver_locations").select(["lat", "lng"]).where("driver_id", "=", trip.driver_id).executeTakeFirst();
  if (!fix) return false;
  return haversineKm(fix, trip.dropoff as Place) * 1000 > COMPLETE_NEAR_DROPOFF_METERS;
}

/** An admin sets the fare by hand: the driver's part keeps its share of the fare. */
export function scaledFare(trip: TripRow, fareMinor: number) {
  const before = Number(trip.fare_minor);
  const earnings = before > 0 ? Math.round((Number(trip.driver_earnings_minor ?? 0) * fareMinor) / before) : 0;
  const pickupPay = Number(trip.pickup_pay_minor ?? 0);
  const lines = [...((trip.fare_lines as FareLine[]) ?? []), ...(fareMinor !== before ? [{ code: "adjustment", amount: { amountMinor: fareMinor - before, currency: trip.currency } }] : [])];
  return {
    fare_minor: fareMinor,
    // The lines stay; one "adjustment" line carries the difference, so they still add up to the fare.
    fare_lines: JSON.stringify(lines),
    driver_earnings_minor: earnings,
    commission_minor: commissionOf(fareMinor, lines, earnings, pickupPay, Number(trip.driver_bonus_minor ?? 0)),
  };
}

/** The trip columns for a fare: Movera keeps fare − driverEarnings − pickupPay (§3.2). */
/**
 * v0.7.1 (§3.8): the trip's fare plus what the middle stops added (the stop_waiting line, its app fee and rounding):
 * the difference between the fare with the stop waits and without them, so every other line (a raise, an
 * outstanding fee) stays as it is. Null when no stop was waited at.
 */
async function withStopWaiting(ex: Executor, trip: TripRow, now: Date) {
  const waits = stopWaitSeconds(trip, now);
  if (!waits.some((s) => s > 0)) return null;
  const charged = (trip.waiting as Waiting | null)?.chargedSeconds ?? 0;
  const withStops = await fareWithWaiting(ex, trip, charged, now);
  const without = await fareWithWaiting(ex, { ...trip, stop_visits: [] }, charged, now);
  const delta = new Map<string, number>();
  for (const l of withStops.fareLines) delta.set(l.code, (delta.get(l.code) ?? 0) + l.amount.amountMinor);
  for (const l of without.fareLines) delta.set(l.code, (delta.get(l.code) ?? 0) - l.amount.amountMinor);
  const lines = ((trip.fare_lines as FareLine[]) ?? []).map((l) => ({ ...l, amount: { ...l.amount } }));
  for (const [code, amount] of delta) {
    if (amount === 0) continue;
    const line = lines.find((l) => l.code === code);
    if (line) line.amount.amountMinor += amount;
    else lines.splice(Math.max(0, lines.findIndex((l) => l.code === "app_fee")), 0, { code, amount: { amountMinor: amount, currency: trip.currency } });
  }
  const kept = lines.filter((l) => l.amount.amountMinor !== 0 || ["base", "distance", "time", "fixed_route"].includes(l.code));
  const total = Number(trip.fare_minor) + withStops.total.amountMinor - without.total.amountMinor;
  const driver = Number(trip.driver_earnings_minor) + withStops.driverEarnings.amountMinor - without.driverEarnings.amountMinor;
  const pickupPay = Number(trip.pickup_pay_minor ?? 0);
  return { fare_minor: total, fare_lines: JSON.stringify(kept), driver_earnings_minor: driver, commission_minor: commissionOf(total, kept, driver, pickupPay, Number(trip.driver_bonus_minor ?? 0)) };
}

function fareColumns(trip: TripRow, fare: Fare) {
  const pickupPay = Number(trip.pickup_pay_minor ?? 0);
  return {
    fare_minor: fare.total.amountMinor,
    fare_lines: JSON.stringify(fare.fareLines),
    driver_earnings_minor: fare.driverEarnings.amountMinor,
    commission_minor: commissionOf(fare.total.amountMinor, fare.fareLines, fare.driverEarnings.amountMinor, pickupPay, Number(trip.driver_bonus_minor ?? 0)),
  };
}

/* ---------------------------------------------------------------- money records */

export async function releaseDriver(trx: Trx, driverId: string | null, now: Date): Promise<void> {
  if (driverId === null) return;
  // A driver, car or fleet blocked during the trip kept the trip to its end (DECISIONS.md): at the end the driver goes
  // offline instead of back online, as if the block had come when they were free (lists.ts, peopleRoutes.ts).
  const mayDrive = sql<boolean>`account_status = 'active'
    AND (vehicle_id IS NULL OR EXISTS (SELECT 1 FROM vehicles v WHERE v.vehicle_id = drivers.vehicle_id AND v.status = 'approved'))
    AND (fleet_id IS NULL OR EXISTS (SELECT 1 FROM fleets f WHERE f.fleet_id = drivers.fleet_id AND f.status = 'approved'))`;
  // v0.18.6 (owner "Send the real reason"): which block keeps him offline at the end of the trip.
  const before = await trx
    .selectFrom("drivers")
    .leftJoin("vehicles", "vehicles.vehicle_id", "drivers.vehicle_id")
    .leftJoin("fleets", "fleets.fleet_id", "drivers.fleet_id")
    .select(["drivers.online_status", "drivers.account_status", "drivers.vehicle_id", "vehicles.status as vehicleStatus", "drivers.fleet_id", "fleets.status as fleetStatus"])
    .where("drivers.driver_id", "=", driverId)
    .executeTakeFirst();
  const blockedBy: OfflineReason | null =
    before === undefined || before.online_status !== "on_trip" ? null
    : before.account_status !== "active" ? "account_status"
    : before.vehicle_id !== null && before.vehicleStatus !== "approved" ? "vehicle_blocked"
    : before.fleet_id !== null && before.fleetStatus !== "approved" ? "fleet_removed"
    : null;
  await trx
    .updateTable("drivers")
    .set({
      online_status: sql`CASE WHEN online_status = 'on_trip' THEN (CASE WHEN ${mayDrive} THEN 'online' ELSE 'offline' END) ELSE online_status END`,
      online_since: sql`CASE WHEN online_status = 'on_trip' AND NOT (${mayDrive}) THEN NULL ELSE online_since END`,
      last_free_at: now,
      version: sql`version + 1`,
      updated_at: now,
    })
    .where("driver_id", "=", driverId)
    .execute();
  if (blockedBy !== null) await markSetOffline(trx, driverId, blockedBy, {}, now);
  // Deep fix 2026-11-02 (g1-g3 H1): a document that expired during the trip takes him offline at its end.
  else await offlineIfDocumentsExpired(trx, now, driverId);
}

export async function credit(trx: Trx, entry: { driverId: string; tripId: string; kind: "trip" | "pickup_pay" | "fee_share" | "bonus" | "adjustment" | "tip"; currency: string; amount: number; gross?: number; commission?: number; cash?: number }, now: Date) {
  if (entry.amount === 0 && entry.kind !== "trip") return;
  await trx
    .insertInto("earnings_entries")
    .values({
      entry_id: newId("ern", now.getTime()),
      driver_id: entry.driverId,
      trip_id: entry.tripId,
      kind: entry.kind,
      currency: entry.currency,
      amount_minor: entry.amount,
      gross_minor: entry.gross ?? null,
      commission_minor: entry.commission ?? null,
      cash_minor: entry.cash ?? null,
      at: now,
    })
    // At most one trip / pickup pay / fee share entry per trip (bonuses and adjustments may repeat).
    .onConflict((c) => c.columns(["driver_id", "trip_id", "kind"]).where("kind", "in", ["trip", "pickup_pay", "fee_share"]).doNothing())
    .execute();
}

/**
 * Rider.outstanding = the sum of owed fees in ONE currency, the oldest owed fee's; that fee names the source trip (§3.7).
 * v0.18.7 (Q3, contract.json#pickupWaiting.debtByCurrency): a fee is never summed into another currency; the quote reads
 * rider_fees itself for its own currency.
 */
export async function refreshOutstanding(trx: Trx, riderId: string, now: Date) {
  const owed = await trx.selectFrom("rider_fees").select(["trip_id", "amount_minor", "currency"]).where("rider_id", "=", riderId).where("status", "=", "owed").orderBy("created_at").orderBy("trip_id").execute();
  const currency = owed[0]?.currency ?? null;
  const total = owed.filter((f) => f.currency === currency).reduce((sum, f) => sum + Number(f.amount_minor), 0);
  await trx.updateTable("riders").set({ outstanding_minor: total, outstanding_currency: currency, outstanding_source_trip_id: owed[0]?.trip_id ?? null, updated_at: now }).where("rider_id", "=", riderId).execute();
}

/**
 * A rider fee in cash nobody collected: owed by the rider (carried to the next trip), the driver's share credited
 * at once; Movera carries the risk (§3.7, owner decision 7).
 */
async function chargeRiderFee(trx: Trx, trip: TripRow, kind: "cancel" | "no_show", fee: Money, now: Date) {
  await trx.insertInto("rider_fees").values({ trip_id: trip.trip_id, rider_id: trip.rider_id, kind, currency: fee.currency, amount_minor: fee.amountMinor, status: "owed", created_at: now }).execute();
  await refreshOutstanding(trx, trip.rider_id, now);
}

export function feeSplit(fee: Money, sharePct: number) {
  const driver = Math.floor((fee.amountMinor * sharePct * 2 + 100) / 200);
  return { driver, movera: fee.amountMinor - driver };
}

/** The fee becomes the trip's money: fare = fee (cancel_fee line), the driver's share as earnings. */
function feeColumns(fee: Money, sharePct: number) {
  const split = feeSplit(fee, sharePct);
  return {
    fare_minor: fee.amountMinor,
    fare_lines: JSON.stringify([{ code: "cancel_fee", amount: fee }]),
    driver_earnings_minor: split.driver,
    commission_minor: split.movera,
    pickup_pay_minor: 0,
  };
}

/**
 * A cash trip that carried an owed fee completed and was paid: the fees it carried are paid (§3.7). The line holds
 * the sum owed when the rider was quoted, so the oldest owed fees up to that sum are the ones it paid.
 */
async function settleCarriedFees(trx: Trx, trip: TripRow, cash: number, now: Date) {
  const line = outstandingLine(trip);
  if (!line) return;
  // The ride is paid first; only cash beyond it pays old fees (a short count leaves them owed).
  const towardFees = Math.max(0, Math.min(line.amount.amountMinor, cash - (Number(trip.fare_minor) - line.amount.amountMinor)));
  // v0.18.7 (Q3): a cash trip pays only the fees owed in its own currency.
  const owed = await trx.selectFrom("rider_fees").select(["trip_id", "amount_minor"]).where("rider_id", "=", trip.rider_id).where("status", "=", "owed").where("currency", "=", trip.currency).orderBy("created_at").orderBy("trip_id").forUpdate().execute();
  let left = towardFees;
  for (const fee of owed) {
    const amount = Number(fee.amount_minor);
    if (amount > left) break;
    left -= amount;
    await trx.updateTable("rider_fees").set({ status: "paid", carried_by: trip.trip_id, settled_at: now }).where("trip_id", "=", fee.trip_id).execute();
    const source = await trx.selectFrom("trips").select("cancellation").where("trip_id", "=", fee.trip_id).executeTakeFirst();
    if (source?.cancellation) await trx.updateTable("trips").set({ cancellation: JSON.stringify({ ...(source.cancellation as object), feeStatus: "paid" }) }).where("trip_id", "=", fee.trip_id).execute();
  }
  await refreshOutstanding(trx, trip.rider_id, now);
}

/* ---------------------------------------------------------------- the wallet */

/** What the rider's wallet would pay of this fare now (used first, contract §1 Payment methods). */
async function walletCovers(ex: Executor, riderId: string, fareMinor: number): Promise<number> {
  const rider = await ex.selectFrom("riders").select("wallet_minor").where("rider_id", "=", riderId).executeTakeFirstOrThrow();
  return Math.max(0, Math.min(Number(rider.wallet_minor), fareMinor));
}

/**
 * The trip is paid: the wallet pays the part the driver was shown at boarding (never more, so money that reaches
 * the wallet later stays there), the driver collects the rest in cash.
 */
/** What the rider's wallet pays of a fare (the part reserved on the trip, at most the wallet and the fare). */
function walletPart(walletMinor: number, trip: TripRow, fareMinor: number): number {
  return Math.max(0, Math.min(walletMinor, fareMinor, Number(trip.wallet_applied_minor ?? 0)));
}

async function spendWallet(trx: Trx, trip: TripRow, fareMinor: number, now: Date): Promise<number> {
  const rider = await trx.selectFrom("riders").select("wallet_minor").where("rider_id", "=", trip.rider_id).forUpdate().executeTakeFirstOrThrow();
  const applied = walletPart(Number(rider.wallet_minor), trip, fareMinor);
  if (applied > 0) {
    await trx.updateTable("riders").set({ wallet_minor: sql`wallet_minor - ${applied}`, updated_at: now }).where("rider_id", "=", trip.rider_id).execute();
    await trx.insertInto("wallet_entries").values({ entry_id: newId("wlt", now.getTime()), rider_id: trip.rider_id, kind: "charge", currency: trip.currency, amount_minor: -applied, trip_id: trip.trip_id, at: now }).execute();
  }
  return applied;
}

/* ---------------------------------------------------------------- the driver's steps */

type StepCommand = "head_to_pickup" | "arrive" | "board" | "start_trip";

/** A fresh 4-digit rider PIN (contract.json#arrivedWaiting.pin). */
export const newPin = () => String(randomInt(0, 10_000)).padStart(4, "0");

export async function driverStep(trx: Trx, driverId: string, tripId: string, command: StepCommand, expectedVersion: number, now: Date, location?: Place, options: { legacyPosition?: boolean } = {}): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, { actor: "driver", subjectId: driverId });
  expectVersion(trip, expectedVersion, "driver");
  if (command === "arrive") {
    if (trip.status === "driver_to_pickup") {
      // Deep fix 2026-11-02 (MED stale / fake GPS for arrive): a position counts only while it is at most the zone's
      // DriverAppConfig.waiting.positionMaxAgeSeconds old (default 60): the one sent with the step when it says when it
      // was measured, else the server's latest fix. An old one is 409 position_stale (turn on location).
      const maxAge = options.legacyPosition ? Number.POSITIVE_INFINITY : await positionMaxAge(trx, trip.zone_id);
      const fresh = (at: unknown) => options.legacyPosition || (typeof at === "string" || at instanceof Date ? Math.abs(now.getTime() - new Date(at).getTime()) <= maxAge * 1000 : false);
      const sent = location && fresh((location as Place & { measuredAt?: string }).measuredAt) ? location : null;
      const stored = sent ? undefined : await trx.selectFrom("driver_locations").select(["lat", "lng", "measured_at"]).where("driver_id", "=", driverId).executeTakeFirst();
      const here = sent ?? (stored && fresh(stored.measured_at) ? stored : null);
      if (!here && (location || stored)) throw new ApiError("invalid_transition", "Your position is too old. Turn on location and try again.", { reason: "position_stale", projection: tripProjection(trip, "driver") });
      if (!here || haversineKm(here, trip.pickup as Place) * 1000 > ARRIVE_MAX_METERS) {
        throw new ApiError("invalid_transition", "You are not at the pickup yet.", { reason: "not_at_pickup", projection: tripProjection(trip, "driver") });
      }
    }
    const base = await waitingOf(trx, trip);
    const kept = await rulesOf(trx, trip);
    // v0.18.8 (contract.json#arrivedWaiting.rules): the matching admin rule (airport / scheduled / event, far pickup) is
    // picked now and its numbers are the trip's from here on.
    const rules = effectiveWaiting(base, kept.waitingRules, {
      kind: trip.kind,
      pickupInAirportZone: extrasOf(trip.price_extras).pickupInAirportZone === true,
      inEvent: kept.waitingRules !== null && kept.waitingRules.rideTypes.event.on ? await pickupInRunningEvent(trx, trip, kept.waitingRules, now) : false,
      acceptPickupMeters: trip.accept_pickup_meters,
    });
    // A reservation's clock starts at the booked time, not when an early driver arrives.
    const start = trip.scheduled_at && trip.scheduled_at.getTime() > now.getTime() ? trip.scheduled_at : now;
    const at = (min: number) => new Date(start.getTime() + min * 60_000).toISOString();
    // v0.18.7 (Q6): the no-show fee and the driver's part of it ride on the trip, so the confirm can say "You get X kr".
    const noShowFee: Money = { amountMinor: rules.noShowFee.amountMinor, currency: trip.currency };
    const noShowShare = kept.noShowDriverSharePct;
    const waiting: Waiting = {
      arrivedAt: now.toISOString(),
      freeUntil: at(rules.freeWaitMin),
      noShowAt: at(rules.noShowAfterMin),
      chargedSeconds: 0,
      noShowFee,
      noShowDriverShare: { amountMinor: feeSplit(noShowFee, noShowShare).driver, currency: trip.currency },
      rules: rules.rules,
      freeWaitMin: rules.freeWaitMin,
      perMin: { amountMinor: rules.perMin.amountMinor, currency: trip.currency },
      noShowAfterMin: rules.noShowAfterMin,
      alerts: [],
    };
    // v0.18.8 (contract.json#arrivedWaiting.alerts): the island messages at the end of the free wait and at the no-show time.
    await scheduleTimer(trx, { kind: WAITING_PAID, refId: tripId, dueAt: new Date(waiting.freeUntil), payload: { arrivedAt: waiting.arrivedAt } });
    await scheduleTimer(trx, { kind: WAITING_NO_SHOW, refId: tripId, dueAt: new Date(waiting.noShowAt), payload: { arrivedAt: waiting.arrivedAt } });
    return applyCommand(trx, trip, { command, actor: "driver", now, set: { arrived_at: now, waiting: JSON.stringify(waiting) } });
  }
  if ((command === "board" || command === "start_trip") && trip.pin_required && trip.pin_verified_at === null && ["arrived", "driver_to_pickup", "accepted"].includes(trip.status)) {
    // v0.18.8 (contract.json#arrivedWaiting.pin): the rider's PIN first (checked by checkPin before this transaction).
    throw new ApiError("invalid_transition", "Ask the rider for the 4-digit code first.", { reason: "pin_required", projection: tripProjection(trip, "driver") });
  }
  if (command === "board") {
    // The waiting clock stops: every second after the free wait is charged, 100 % the driver's (§3.5).
    const waiting = trip.waiting as Waiting | null;
    const charged = waiting ? Math.max(0, Math.floor((now.getTime() - Date.parse(waiting.freeUntil)) / 1000)) : 0;
    const set: Updateable<TripsTable> = { boarded_at: now };
    if (waiting) set["waiting"] = JSON.stringify({ ...waiting, chargedSeconds: charged });
    if (charged > 0 && trip.status === "arrived") Object.assign(set, fareColumns(trip, await fareWithWaiting(trx, trip, charged)));
    // The wallet pays first: the driver sees the cash to collect from boarding on.
    set.wallet_applied_minor = await walletCovers(trx, trip.rider_id, Number(set.fare_minor ?? trip.fare_minor));
    const boarded = await applyCommand(trx, trip, { command, actor: "driver", now, set });
    // From now on the server watches for the driver going silent (owner decision 2026-10-26).
    await scheduleTimer(trx, { kind: DRIVER_SILENCE, refId: tripId, dueAt: new Date(now.getTime() + SILENT_ALERT_MS), payload: {} });
    return boarded;
  }
  if (command === "start_trip") {
    // v0.18.7 (Q5): the fare the rider sees from Start trip includes the charged waiting (set at board; set again here
    // so a trip boarded by an older build shows the same total the driver asks for).
    const waiting = trip.waiting as Waiting | null;
    const set: Updateable<TripsTable> = { started_at: now };
    if (waiting && waiting.chargedSeconds > 0 && !((trip.fare_lines as FareLine[]) ?? []).some((l) => l.code === "waiting")) {
      Object.assign(set, fareColumns(trip, await fareWithWaiting(trx, trip, waiting.chargedSeconds)));
    }
    return applyCommand(trx, trip, { command, actor: "driver", now, set });
  }
  return applyCommand(trx, trip, { command, actor: "driver", now });
}

/** Rider at the drop-off soon: the system's near_dropoff, from the driver's fixes (a timer, so it locks the trip on its own). */
export async function maybeNearDropoff(trx: Trx, trip: { trip_id: string; status: string }, fix: Place, now: Date) {
  if (trip.status !== "in_trip") return;
  const row = await trx.selectFrom("trips").select("dropoff").where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  if (haversineKm(fix, row.dropoff as Place) * 1000 > NEAR_DROPOFF_METERS) return;
  await scheduleTimer(trx, { kind: NEAR_DROPOFF, refId: trip.trip_id, dueAt: now, payload: {} });
}

export const nearDropoffHandler: TimerHandler = async (trx, timer) => {
  const trip = await lockTripNow(trx, timer.refId);
  if (!trip || trip.status !== "in_trip") return;
  await applyCommand(trx, trip, { command: "near_dropoff", actor: "system", now: timer.firedAt });
};

/* ---------------------------------------------------------------- the driver goes silent on board */

/**
 * Owner decision 2026-10-26: a driver's phone dies or the app breaks with the rider on board, and nobody presses
 * Finish. Without this the trip stays open for good: the rider cannot book (trips_one_live_per_rider) and the
 * driver gets no offers (trips_one_active_per_driver, on_trip).
 *   no driver position for 30 min → an alert for admins (TripProjection.driverSilentAlert, admin view only);
 *   still none after 3 h            → the server fails the trip (system `fail`), no charge, both are free again.
 * Silence counts from the driver's latest position as the server received it (driver_locations.received_at), or
 * from boarding when that is later. Before pickup nothing happens: the rider cancels and books again.
 * One durable timer per trip, booked at `board`; each check books the next one.
 */
export const DRIVER_SILENCE = "driver_silence";
export const SILENT_ALERT_MS = 30 * 60_000;
export const SILENT_FAIL_MS = 3 * 3600_000;
/** While the alert is up the server looks again this often: it goes when positions come back. */
export const SILENT_RECHECK_MS = 5 * 60_000;

type SilentAlert = { kind: "driver_silent"; silentSince: string; lastFixAt: string | null; at: string; autoFailAt: string };

/** Puts the alert on the trip (or takes it off) without a version change, like a search step (§3.6). */
async function showSilentAlert(trx: Trx, trip: TripRow, alert: SilentAlert | null, now: Date) {
  // Car lost (contract v0.7.0 §15): the alert also opens a driver_silent incident, which closes itself when it goes.
  if (alert === null) await closeDriverSilent(trx, trip.trip_id, now);
  else if (!trip.driver_silent_alert) await openDriverSilent(trx, trip, now);
  await trx.updateTable("trips").set({ driver_silent_alert: alert === null ? null : JSON.stringify(alert) }).where("trip_id", "=", trip.trip_id).execute();
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
  await appendTripEvent(trx, { tripId: trip.trip_id, kind: "trip_projection", version: updated.version, occurredAt: now, projection: tripProjection(updated, "admin", { sequence: Number(updated.sequence) + 1 }) });
}

/**
 * The trip fails with no charge: no fare, no driver earnings, nothing captured (payment_status stays empty), the
 * wallet untouched. An owed fee the trip carried stays owed (§3.7). The booked price stays on the quote.
 */
async function failSilentTrip(trx: Trx, trip: TripRow, alert: SilentAlert, now: Date): Promise<TripRow> {
  const cancellation = { actor: "system", reasonCode: "system_error", at: now.toISOString(), fee: null };
  const failed = await applyCommand(trx, trip, {
    command: "fail",
    actor: "system",
    now,
    set: {
      fare_minor: 0,
      fare_lines: JSON.stringify([]),
      driver_earnings_minor: 0,
      pickup_pay_minor: 0,
      commission_minor: 0,
      wallet_applied_minor: 0,
      cash_collected_minor: 0,
      payment_status: null,
      cancellation: JSON.stringify(cancellation),
      ended_by_command: "fail",
      ended_at: now,
      driver_silent_alert: JSON.stringify(alert),
    },
  });
  await releaseDriver(trx, trip.driver_id, now);
  return failed;
}

export const driverSilenceHandler: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  const trip = await lockTripNow(trx, timer.refId);
  if (!trip) return;
  if (!RIDER_ONBOARD.has(trip.status as TripStatus)) {
    // The trip ended (the driver finished it, or an admin did) while the car was lost: the car is back if its
    // position came after the silence began.
    const shownAlert = trip.driver_silent_alert as SilentAlert | null;
    if (shownAlert && trip.status !== "failed" && trip.driver_id) {
      const back = await trx.selectFrom("driver_locations").select("received_at").where("driver_id", "=", trip.driver_id).executeTakeFirst();
      if (back && back.received_at.getTime() > Date.parse(shownAlert.silentSince)) await closeDriverSilent(trx, trip.trip_id, now);
    }
    return;
  }
  const fix = trip.driver_id ? await trx.selectFrom("driver_locations").select("received_at").where("driver_id", "=", trip.driver_id).executeTakeFirst() : undefined;
  const lastFixAt = fix?.received_at ?? null;
  const since = new Date(Math.max(lastFixAt?.getTime() ?? 0, (trip.boarded_at ?? trip.updated_at).getTime()));
  const silentMs = now.getTime() - since.getTime();
  const shown = trip.driver_silent_alert as SilentAlert | null;
  const next = (at: number) => scheduleTimer(trx, { kind: DRIVER_SILENCE, refId: trip.trip_id, dueAt: new Date(at), payload: {} });
  if (silentMs < SILENT_ALERT_MS) {
    // The driver is there (again): no alert, look again 30 minutes after the latest position.
    if (shown) await showSilentAlert(trx, trip, null, now);
    await next(since.getTime() + SILENT_ALERT_MS);
    return;
  }
  const alert: SilentAlert = {
    kind: "driver_silent",
    silentSince: since.toISOString(),
    lastFixAt: lastFixAt?.toISOString() ?? null,
    at: shown && shown.silentSince === since.toISOString() ? shown.at : now.toISOString(),
    autoFailAt: new Date(since.getTime() + SILENT_FAIL_MS).toISOString(),
  };
  if (silentMs >= SILENT_FAIL_MS) {
    await failSilentTrip(trx, trip, alert, now);
    return;
  }
  if (!shown || shown.silentSince !== alert.silentSince) await showSilentAlert(trx, trip, alert, now);
  await next(Math.min(since.getTime() + SILENT_FAIL_MS, now.getTime() + SILENT_RECHECK_MS));
};

/** Books a silence check for every trip with the rider on board that has none (trips boarded before the check existed). */
export async function bookSilenceChecks(ex: Executor, now: Date): Promise<void> {
  const onboard = await ex.selectFrom("trips").select("trip_id").where("status", "in", [...RIDER_ONBOARD]).execute();
  if (onboard.length === 0) return;
  await ex
    .insertInto("timers")
    .values(onboard.map((t) => ({ kind: DRIVER_SILENCE, ref_id: t.trip_id, due_at: now })))
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
}

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

/* ---------------------------------------------------------------- the rider ends early */

export async function endEarly(trx: Trx, riderId: string, tripId: string, body: { expectedVersion: number; reasonCode?: string; note?: string }, now: Date): Promise<TripRow> {
  const problem = schemaProblem("EndEarlyCommand", body);
  if (problem !== null) throw badRequest(`The request is not valid: ${problem}.`, "invalid_body");
  if (body.reasonCode !== undefined && !REASONS["rider"]!.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not a rider reason.`, "invalid_reason_code");
  const trip = await lockOwnTrip(trx, tripId, { actor: "rider", subjectId: riderId });
  expectVersion(trip, body.expectedVersion, "rider");
  if (!ONBOARD.includes(trip.status)) {
    throw new ApiError("invalid_transition", `A rider cannot end_early a trip that is ${trip.status}.`, { projection: tripProjection(trip, "rider") });
  }
  // v0.18.10 (owner G8 Q1/Q2): what was driven plus the paid waiting at the stops.
  const money = await drivenColumns(trx, trip, await drivenFare(trx, trip, now), now);
  const wallet = await spendWallet(trx, trip, money.fare_minor, now);
  const reasonCode = body.reasonCode ?? "something_else";
  const cancellation = { actor: "rider", reasonCode, at: now.toISOString(), fee: null, ...(body.note ? { note: body.note } : {}) };
  const info: EndInfo = { endedEarly: true, endedBy: "rider", reasonCode };
  const ended = await applyCommand(trx, trip, {
    command: "end_early",
    actor: "rider",
    now,
    // An owed fee the trip carried stays owed: the trip did not complete (§3.7). v0.18.10 (owner G8 Q1): the driver gets
    // the normal finish (TripProjection.finish) and rates the rider.
    set: { ...money, cancellation: JSON.stringify(cancellation), end_info: JSON.stringify(info), ended_by_command: "end_early", ended_at: now, payment_status: "captured", cash_collected_minor: money.fare_minor - wallet, wallet_applied_minor: wallet, rating_status: "pending", driver_rating_status: "pending" },
  });
  await creditTrip(trx, ended, now);
  await releaseDriver(trx, trip.driver_id, now);
  return ended;
}

/* ---------------------------------------------------------------- completion */

export async function creditTrip(trx: Trx, trip: TripRow, now: Date) {
  if (trip.driver_id === null) return;
  const fare = Number(trip.fare_minor);
  const earnings = Number(trip.driver_earnings_minor ?? 0);
  const owed = outstandingLine(trip);
  const owedMinor = trip.status === "completed" && owed ? owed.amount.amountMinor : 0;
  await credit(trx, { driverId: trip.driver_id, tripId: trip.trip_id, kind: "trip", currency: trip.currency, amount: earnings, gross: fare - owedMinor, commission: fare - owedMinor - earnings, cash: Number(trip.cash_collected_minor ?? 0) }, now);
  await credit(trx, { driverId: trip.driver_id, tripId: trip.trip_id, kind: "pickup_pay", currency: trip.currency, amount: Number(trip.pickup_pay_minor ?? 0) }, now);
  // A Movera bonus on the trip is paid when the trip ends with this driver.
  await credit(trx, { driverId: trip.driver_id, tripId: trip.trip_id, kind: "bonus", currency: trip.currency, amount: Number(trip.driver_bonus_minor ?? 0) }, now);
}

/**
 * The fare complete sets (one code path for complete and its preview, contract v0.18.1 §26). Finished before the
 * destination (owner decision 28, like the rider's early end): the rider pays for what was driven, never more than
 * booked. An admin's fare is taken as given; at the drop-off the booked fare stands.
 */
async function finalPrice(ex: Executor, trip: TripRow, actor: "driver" | "admin", adminFare: Money | undefined, now: Date) {
  const early = adminFare === undefined && actor === "driver" && (await endedBeforeDropoff(ex, trip));
  // v0.7.1 (§3.8): the waiting at the middle stops is added, from each arrival to leaving. v0.18.10 (owner G8 Q2): also
  // when the driver ends early.
  const stopped = adminFare === undefined ? await withStopWaiting(ex, trip, now) : null;
  let info: EndInfo = { endedEarly: false };
  let money: FrozenMoney = adminFare ? scaledFare(trip, adminFare.amountMinor) : (stopped ?? {});
  if (early) {
    ({ money, info } = await earlyEndPrice(ex, trip, now, stopped));
  }
  const fare = money.fare_minor ?? Number(trip.fare_minor);
  return { early, fare, money: { ...money, end_info: JSON.stringify(info) } as FrozenMoney, info };
}

/** v0.18.10 (owner G8 Q2): the driver ended before the drop-off — driven price only over the admin's km / minutes, stop waiting kept. */
async function earlyEndPrice(ex: Executor, trip: TripRow, now: Date, stoppedIn?: Awaited<ReturnType<typeof withStopWaiting>>): Promise<{ money: FrozenMoney; info: EndInfo }> {
  const stopped = stoppedIn !== undefined ? stoppedIn : await withStopWaiting(ex, trip, now);
  let money: FrozenMoney = stopped ?? {};
  {
    const measured = await driven(ex, trip, now);
    const limits = await earlyEndOf(ex, trip);
    // How much shorter than booked (never negative): the booked road km and minutes against what was driven on board.
    const shortKm = Math.round(Math.max(0, (trip.distance_meters ?? 0) / 1000 - measured.km) * 100) / 100;
    const shortMin = Math.round(Math.max(0, (trip.duration_seconds ?? 0) / 60 - measured.minutes) * 100) / 100;
    // A new price only when more than repriceOverKm or repriceOverMin shorter, and only when it is less than booked
    // (at the cap the booked fare and its lines stand as they are).
    const repriced = (shortKm > limits.repriceOverKm || shortMin > limits.repriceOverMin) && measured.fare.total.amountMinor < Number(trip.fare_minor);
    if (repriced) money = await drivenColumns(ex, trip, measured.fare, now);
    return { money, info: { endedEarly: true, endedBy: "driver", reasonCode: "ended_before_dropoff", repriced, shortKm, shortMin } };
  }
}

/** contract v0.18.1 §26: how long a preview's price holds. */
export const PREVIEW_FREEZE_SECONDS = (contract as unknown as { completePreview: { freezeSeconds: number } }).completePreview.freezeSeconds;

type FrozenMoney = { fare_minor?: number; fare_lines?: string; driver_earnings_minor?: number; commission_minor?: number; end_info?: string };

/** The CompletePreview body of a frozen price. */
function previewBody(trip: TripRow, row: { previewId: string; expiresAt: Date; early: boolean; fare: number; wallet: number; money: FrozenMoney }) {
  const lines = row.money.fare_lines !== undefined ? (JSON.parse(row.money.fare_lines) as FareLine[]) : ((trip.fare_lines as FareLine[]) ?? []);
  const sum = (amountMinor: number): Money => ({ amountMinor, currency: trip.currency });
  const earnings = row.money.driver_earnings_minor ?? Number(trip.driver_earnings_minor ?? 0);
  const info = row.money.end_info !== undefined ? (JSON.parse(row.money.end_info) as EndInfo) : null;
  // v0.18.10 (owner G8 Q3): the same one number the finished screen shows (incl. pickup pay, bonus, Movera's changes).
  const asEnded = { ...trip, driver_earnings_minor: String(earnings) };
  return {
    previewId: row.previewId,
    expiresAt: row.expiresAt.toISOString(),
    tripId: trip.trip_id,
    total: sum(row.fare),
    cashDue: sum(row.fare - row.wallet),
    driverEarnings: sum(earnings),
    driverTotal: sum(driverTotalOf(asEnded)),
    earningsBreakdown: earningsLinesOf(asEnded).map((l) => ({ code: l.code, amount: sum(l.amountMinor) })),
    earlyEnd: row.early,
    ...(info?.endedEarly ? { repriced: info.repriced === true, shortKm: info.shortKm ?? 0, shortMin: info.shortMin ?? 0 } : {}),
    fareLines: lines,
  };
}

/**
 * GET /driver/trips/{tripId}/complete-preview (contract v0.18.1 §26): what complete would set now (the same
 * finalPrice), frozen for PREVIEW_FREEZE_SECONDS under a new previewId that replaces the trip's earlier one. The trip
 * and the wallet are not changed.
 */
export async function completePreview(ex: Executor, driverId: string, tripId: string, now: Date) {
  const trip = await readOwnTrip(ex, tripId, { actor: "driver", subjectId: driverId });
  if (!ONBOARD.includes(trip.status)) {
    throw new ApiError("invalid_transition", "The rider is not on board.", { reason: "trip_not_on_board", projection: tripProjection(trip, "driver") });
  }
  const { early, fare, money } = await finalPrice(ex, trip, "driver", undefined, now);
  const rider = await ex.selectFrom("riders").select("wallet_minor").where("rider_id", "=", trip.rider_id).executeTakeFirstOrThrow();
  const wallet = walletPart(Number(rider.wallet_minor), trip, fare);
  const previewId = newId("cpv", now.getTime());
  const expiresAt = new Date(now.getTime() + PREVIEW_FREEZE_SECONDS * 1000);
  const row = { preview_id: previewId, driver_id: driverId, expires_at: expiresAt, early_end: early, fare_minor: fare, wallet_minor: wallet, money: JSON.stringify(money), created_at: now };
  await ex.insertInto("complete_previews").values({ trip_id: tripId, ...row }).onConflict((c) => c.column("trip_id").doUpdateSet(row)).execute();
  return previewBody(trip, { previewId, expiresAt, early, fare, wallet, money });
}

/** Thrown inside complete's transaction; the route answers 409 price_changed with a fresh preview made after it. */
export class PriceChanged extends Error {
  constructor(readonly tripId: string) {
    super("The price changed.");
  }
}

export async function completeTrip(trx: Trx, who: { actor: "driver" | "admin"; subjectId: string }, tripId: string, body: { expectedVersion: number; cashCollected?: Money; fare?: Money; previewId?: string }, now: Date): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, who);
  if (body.fare && body.fare.currency !== trip.currency) throw badRequest(`The fare is in ${trip.currency}.`, "currency_mismatch");
  expectVersion(trip, body.expectedVersion, who.actor);
  if (body.cashCollected && body.cashCollected.currency !== trip.currency) throw badRequest(`Cash is counted in ${trip.currency}.`, "currency_mismatch");
  // contract v0.18.1 §26: the driver's latest unexpired preview is the price, exactly (no early-end flip, no extra
  // minutes); otherwise the trip is priced as now.
  const previewed = who.actor === "driver" && body.fare === undefined && body.previewId !== undefined;
  const frozen = previewed
    ? await trx.selectFrom("complete_previews").selectAll().where("trip_id", "=", trip.trip_id).where("preview_id", "=", body.previewId!).where("driver_id", "=", who.subjectId).where("expires_at", ">", now).executeTakeFirst()
    : undefined;
  const { fare, money } = frozen
    ? { fare: Number(frozen.fare_minor), money: frozen.money as FrozenMoney }
    : await finalPrice(trx, trip, who.actor, body.fare, now);
  const wallet = await spendWallet(trx, trip, fare, now);
  // With a previewId the cash shown must be the cash part of this price; if not, nothing is completed and the app
  // gets a fresh price to show (409 price_changed, never a 400 that leaves the driver stuck).
  if (previewed && body.cashCollected && body.cashCollected.amountMinor !== fare - wallet) throw new PriceChanged(trip.trip_id);
  // The rider owes the fare (outstanding fees included) less what the wallet paid; more cash than that is a miscount,
  // and it would raise the driver's cash balance and the trip's refund room above the fare.
  if (body.cashCollected && body.cashCollected.amountMinor > fare - wallet) {
    throw badRequest(`At most ${(fare - wallet) / 100} ${trip.currency} is collected in cash on this trip.`, "cash_above_fare");
  }
  const cash = body.cashCollected?.amountMinor ?? fare - wallet;
  const done = await applyCommand(trx, trip, {
    command: "complete",
    actor: who.actor,
    now,
    set: { ...money, ended_by_command: "complete", ended_at: now, payment_status: "captured", cash_collected_minor: cash, wallet_applied_minor: wallet, rating_status: "pending", driver_rating_status: "pending" },
  });
  await creditTrip(trx, done, now);
  if (done.payment_method === "cash") await settleCarriedFees(trx, done, cash + wallet, now);
  await releaseDriver(trx, done.driver_id, now);
  // v0.18.9 (contract.json#onTrip.rideCheck): the driver ended the trip far from the drop-off → "Is everything OK?" to both.
  if (who.actor === "driver") {
    await askUnexpectedEnd(trx, done, now);
    return trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  }
  return done;
}

/* ---------------------------------------------------------------- ratings */

type RatingBody = { stars?: number; tags?: string[]; comment?: string; skip?: boolean; tip?: Money };

export async function rateTrip(trx: Trx, who: { actor: "rider" | "driver"; subjectId: string }, tripId: string, body: unknown, now: Date): Promise<{ status: number; body: unknown }> {
  const problem = schemaProblem("RatingRequest", body);
  if (problem !== null) throw badRequest(`The rating is not valid: ${problem}.`, "invalid_body");
  const rating = body as RatingBody;
  if (!rating.skip && rating.stars === undefined) throw badRequest("Give 1 to 5 stars, or skip.", "stars_missing");
  // v0.18.10 (contract.json#finish.tips): the rider's tip is given by the rating route after the rating (giveTip).
  if (rating.tip && who.actor !== "rider") throw badRequest("Only the rider tips.", "tip_not_allowed");
  // contract v0.9.0: tags from the fixed list for this rater (contract.json#ratings.tags).
  if (!rating.skip) checkTags(who.actor, rating.tags ?? []);
  const trip = await lockOwnTrip(trx, tripId, who);
  const allowed =
    trip.status === "completed" ||
    // v0.18.10 (owner G8 Q1): after the rider's early end both sides rate.
    (trip.status === "cancelled_by_rider" && trip.ended_by_command === "end_early");
  const column = who.actor === "rider" ? "rating_status" : "driver_rating_status";
  if (!allowed || trip[column] !== "pending") {
    throw new ApiError("invalid_transition", allowed ? "This trip was already rated." : "This trip cannot be rated.", { reason: allowed ? "already_rated" : "rating_not_allowed", projection: tripProjection(trip, who.actor) });
  }
  let answer: Record<string, unknown> | null = null;
  if (rating.skip) {
    await trx.updateTable("trips").set({ [column]: "skipped" }).where("trip_id", "=", tripId).execute();
  } else {
    const stars = rating.stars!;
    const tags = rating.tags ?? [];
    // v0.18.15 (contract.json#reviewRules, owner G14 Q6): a comment with a listed word is hidden at once, like an admin hide.
    const { rules, country } = await ratingRules(trx, trip);
    const badWord = hasBadWord(rating.comment, rules);
    await trx.insertInto("ratings").values({ trip_id: tripId, rater: who.actor, stars, tags, comment: rating.comment ?? null, at: now, ...(badWord ? { hidden: true, hidden_by: "system", hidden_at: now, hide_reason: "bad_word" } : {}) }).execute();
    await trx.updateTable("trips").set({ [column]: "submitted" }).where("trip_id", "=", tripId).execute();
    // The rider rates the driver; the driver rates the rider. A hidden rating does not count.
    if (who.actor === "rider" && trip.driver_id) {
      if (!badWord) await trx.updateTable("drivers").set({ rating_sum: sql`rating_sum + ${stars}`, rating_count: sql`rating_count + 1` }).where("driver_id", "=", trip.driver_id).execute();
      await applyPersonRules(trx, "driver", trip.driver_id, country, rules, now);
    } else if (who.actor === "driver") {
      if (!badWord) await trx.updateTable("riders").set({ rating_sum: sql`rating_sum + ${stars}`, rating_count: sql`rating_count + 1` }).where("rider_id", "=", trip.rider_id).execute();
      await applyPersonRules(trx, "rider", trip.rider_id, country, rules, now);
    }
    answer = { tripId, from: who.actor, stars, tags, ...(rating.comment ? { comment: rating.comment } : {}) };
  }
  // Not a lifecycle change: no new version; rating_updated passes the terminal gate (§4).
  const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow();
  await appendTripEvent(trx, { tripId, kind: "rating_updated", version: updated.version, occurredAt: now, projection: tripProjection(updated, "admin", { sequence: Number(updated.sequence) + 1 }) });
  return answer === null ? { status: 204, body: null } : { status: 201, body: answer };
}

/* ---------------------------------------------------------------- earnings */

type Period = "day" | "week" | "month";

/** GET /driver/earnings (EarningsReport): periods in the zone's clock (Europe/Stockholm in the test week). */
export async function driverEarnings(ex: Executor, driverId: string, input: { period: Period; from?: string; to?: string; timeZone: string; currency: string }, now: Date) {
  const tz = input.timeZone;
  // Up to now, this instant included.
  const to = input.to ? new Date(input.to) : new Date(now.getTime() + 1);
  const from = input.from
    ? new Date(input.from)
    : (await sql<{ start: Date }>`SELECT (date_trunc(${input.period}, ${now}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS start`.execute(ex)).rows[0]!.start;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw badRequest("from must be before to.", "invalid_range");
  const rows = await sql<{ start: Date; trips: string; gross: string; commission: string; earnings: string; pickup: string; fees: string; tips: string; adjustments: string; cash: string }>`
    SELECT (date_trunc(${input.period}, at AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS start,
           count(*) FILTER (WHERE kind = 'trip') AS trips,
           coalesce(sum(gross_minor) FILTER (WHERE kind = 'trip'), 0) AS gross,
           coalesce(sum(commission_minor) FILTER (WHERE kind = 'trip'), 0) AS commission,
           coalesce(sum(amount_minor) FILTER (WHERE kind = 'trip'), 0) AS earnings,
           coalesce(sum(amount_minor) FILTER (WHERE kind = 'pickup_pay'), 0) AS pickup,
           coalesce(sum(amount_minor) FILTER (WHERE kind = 'fee_share'), 0) AS fees,
           coalesce(sum(amount_minor) FILTER (WHERE kind = 'tip'), 0) AS tips,
           coalesce(sum(amount_minor) FILTER (WHERE kind = 'adjustment'), 0) AS adjustments,
           coalesce(sum(cash_minor) FILTER (WHERE kind IN ('trip', 'tip')), 0) AS cash
      FROM earnings_entries
     WHERE driver_id = ${driverId} AND at >= ${from} AND at < ${to} AND currency = ${input.currency}
     GROUP BY 1 ORDER BY 1`.execute(ex);
  // The other currencies he earned in over the same time (the app offers a switch: kr / €).
  const others = await ex.selectFrom("earnings_entries").select("currency").distinct().where("driver_id", "=", driverId).where("at", ">=", from).where("at", "<", to).orderBy("currency").execute();
  const money = (v: string | number) => ({ amountMinor: Number(v), currency: input.currency });
  const periods = [];
  for (const r of rows.rows) {
    const end = (await sql<{ end: Date }>`SELECT ((${r.start}::timestamptz AT TIME ZONE ${tz} + ${`1 ${input.period}`}::interval) AT TIME ZONE ${tz}) AS end`.execute(ex)).rows[0]!.end;
    const net = Number(r.earnings) + Number(r.pickup) + Number(r.fees) + Number(r.tips) + Number(r.adjustments);
    periods.push({
      periodStart: r.start.toISOString(),
      periodEnd: end.toISOString(),
      tripCount: Number(r.trips),
      gross: money(r.gross),
      commission: money(r.commission),
      pickupPay: money(r.pickup),
      tips: money(r.tips),
      adjustments: money(r.adjustments),
      cashCollected: money(r.cash),
      fees: money(r.fees),
      net: money(net),
    });
  }
  return { driverId, period: input.period, timeZone: tz, currency: input.currency, currencies: [...new Set([input.currency, ...others.map((o) => o.currency)])].sort(), periods };
}

/* ---------------------------------------------------------------- waiting rules and island alerts (v0.18.8) */

/**
 * contract.json#arrivedWaiting.rules.match.event: an admin event of the trip's country that is on and running now (until
 * endsAt + afterEndMin), with the pickup inside its polygon, or within radiusMeters of its location when it has none.
 */
async function pickupInRunningEvent(ex: Executor, trip: TripRow, rules: WaitingExtras, now: Date): Promise<boolean> {
  const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", trip.zone_id).executeTakeFirst();
  if (!zone) return false;
  const after = rules.rideTypes.event.afterEndMin * 60_000;
  const events = await ex.selectFrom("area_events").select(["lat", "lng", "polygon", "ends_at"]).where("country", "=", zone.country).where("is_on", "=", true).where("starts_at", "<=", now).execute();
  const pickup = trip.pickup as Place;
  return events.some((e) => {
    if (e.ends_at.getTime() + after < now.getTime()) return false;
    const polygon = e.polygon as Polygon | null;
    if (polygon) return inPolygon(pickup.lat, pickup.lng, polygon);
    return haversineKm(pickup, { lat: e.lat, lng: e.lng }) * 1000 <= rules.rideTypes.event.radiusMeters;
  });
}

export const WAITING_PAID = "waiting_paid";
export const WAITING_NO_SHOW = "waiting_no_show";

/** One island alert on the trip (no version change) and a trip_projection event, while the driver still waits from the same arrival. */
function waitingAlertHandler(kind: WaitingAlert["kind"]): TimerHandler {
  return async (trx, timer) => {
    const trip = await lockTripNow(trx, timer.refId);
    const waiting = trip?.waiting as Waiting | null | undefined;
    if (!trip || trip.status !== "arrived" || !waiting) return;
    if ((timer.payload as { arrivedAt?: string } | null)?.arrivedAt !== waiting.arrivedAt) return;
    if ((waiting.alerts ?? []).some((a) => a.kind === kind)) return;
    const next: Waiting = { ...waiting, alerts: [...(waiting.alerts ?? []), { kind, at: timer.firedAt.toISOString() }] };
    await trx.updateTable("trips").set({ waiting: JSON.stringify(next) }).where("trip_id", "=", trip.trip_id).execute();
    const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
    await appendTripEvent(trx, { tripId: trip.trip_id, kind: "trip_projection", version: updated.version, occurredAt: timer.firedAt, projection: tripProjection(updated, "admin", { sequence: Number(updated.sequence) + 1, now: timer.firedAt }) });
  };
}

export const rideHandlers: Record<string, TimerHandler> = {
  [NEAR_DROPOFF]: nearDropoffHandler,
  [DRIVER_SILENCE]: driverSilenceHandler,
  [WAITING_PAID]: waitingAlertHandler("paid_waiting_started"),
  [WAITING_NO_SHOW]: waitingAlertHandler("no_show_possible"),
  ...incidentHandlers,
  ...rideCheckHandlers,
  // v0.18.9: without a router the off-route check measures straight lines (main.ts passes the road router). A literal key
  // and a lazy call, so this object never touches rideCheckServer.js while the import cycle is still loading.
  ride_check_scan: (trx, timer) => rideCheckScanHandler()(trx, timer),
  // v0.18.9 (contract.json#onTrip.routeChange): the driver did not answer in time.
  route_change_expire: (trx, timer) => routeChangeExpireHandler(trx, timer),
};
export type { Who };
