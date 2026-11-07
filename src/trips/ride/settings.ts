import { extrasOf } from "../../rules/priceExtras.js";
import { commissionOf } from "../../rules/commission.js";
import { contract } from "../../contract/contract.js";
import { liveDocument } from "../../config/service.js";
import type { Executor } from "../../db/db.js";
import type { TripRow } from "../../db/tripLog.js";
import { stopWaitSeconds } from "../stops.js";
import { ApiError } from "../../http/errors.js";
import { haversineKm } from "../../maps/routing.js";
import { cancelFee, type FeeRule } from "../../rules/cancelFees.js";
import { priceFare, type Fare, type FareLine, type PricingDocument } from "../../rules/fare.js";
import { waitingExtrasOf, type WaitingExtras } from "../waitingRules.js";
import { type Money, type Place, type Waiting, DEFAULT_NO_SHOW_SHARE, DEFAULT_MAX_PICKUP_MOVE_METERS, DEFAULT_CANCEL_AFTER_ARRIVED_IS_NO_SHOW, validPickupMoveMeters, COMPLETE_NEAR_DROPOFF_METERS } from "./shared.js";

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

export const sharePct = (pct: unknown, fallback: number) => (typeof pct === "number" && pct >= 0 && pct <= 100 ? pct : fallback);

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
  /** v0.18.33 (contract.json#afterTestRules.walletFirst): the wallet pays first on this trip (absent before v0.18.33 = true). */
  walletFirst?: boolean;
};
/** v0.18.33 (owner Q6): does the rider's wallet pay first on this trip? Trips booked before v0.18.33 keep the old rule (yes). */
export const walletFirstOf = (trip: Pick<TripRow, "booking_rules">): boolean => (trip.booking_rules as BookingRules | null)?.walletFirst !== false;
export type EarlyEndSettings = { repriceOverKm: number; repriceOverMin: number };
const EARLY_END = contract as unknown as { configDefaults: { earlyEnd: EarlyEndSettings }; finish: { earlyEnd: { settings: { ranges: Record<keyof EarlyEndSettings, [number, number]> } } } };
const EARLY_END_DEFAULTS = EARLY_END.configDefaults.earlyEnd;
const EARLY_END_RANGES = EARLY_END.finish.earlyEnd.settings.ranges;
/** DriverAppConfig.cancelFees.earlyEnd of a driver document; a missing or out-of-range number takes the default (2 km, 10 min; v0.18.33). */
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
  rider: { cancelFees?: { live?: Record<string, FeeRule>; reservation?: Record<string, FeeRule> }; features?: { wallet?: unknown }; wallet?: { usedFirst?: unknown } } | undefined;
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
export async function bookingRulesFor(ex: Executor, zoneId: string, kind: string, categoryId: string, pricing: PricingDocument | null, walletAsked?: boolean): Promise<BookingRules> {
  const docs = await appDocs(ex, zoneId);
  // v0.18.33 (owner Q6, contract.json#afterTestRules.walletFirst): the rider's per-ride switch (missing = on), unless the
  // zone turned the wallet or "Use wallet first" off (Admin › Payments).
  const walletFirst = walletAsked !== false && docs.rider?.features?.wallet !== false && docs.rider?.wallet?.usedFirst !== false;
  // v0.18.7: the waiting terms always get kept (TripProjection.terms): the quoted pricing document, else the live one.
  const priced = pricing ?? (await liveDocument<PricingDocument>(ex, "pricing", zoneId))?.document ?? null;
  return {
    walletFirst,
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

export async function waitingOf(ex: Executor, trip: TripRow): Promise<CategoryWaitingRules> {
  const kept = (trip.booking_rules as BookingRules | null)?.waiting;
  return kept ?? waitingRules(await pricingOf(ex, trip), trip.category_id);
}

export const outstandingLine = (trip: TripRow) => ((trip.fare_lines as FareLine[]) ?? []).find((l) => l.code === "outstanding_fee");

/**
 * v0.18.51 §73 (owner 2026-11-07 "Booked fees", contract.json#bookedRide0_18_51.fees): a booked ride's no-show costs the
 * SAME booking fee as a late rider cancel — the trip's reservation cancel rule on the booked fare (without an owed fee),
 * as charged outside its free minutes. No rule for the category = no fee (null).
 */
export async function bookedNoShowFee(ex: Executor, trip: TripRow): Promise<Money | null> {
  const rule = (await rulesOf(ex, trip)).cancelRule;
  if (rule === null) return null;
  const owed = outstandingLine(trip);
  const fare = { amountMinor: Number(trip.booked_fare_minor) - (owed ? owed.amount.amountMinor : 0), currency: trip.currency };
  const fee = cancelFee({ kind: "reservation", rule, fare: fare as Parameters<typeof cancelFee>[0]["fare"], minutesBeforePickup: rule.freeMin - 1 });
  return fee.amountMinor > 0 ? { amountMinor: fee.amountMinor, currency: trip.currency } : null;
}

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
export async function drivenFare(ex: Executor, trip: TripRow, now: Date): Promise<Fare> {
  return (await driven(ex, trip, now)).fare;
}

/** The driven fare with the km and minutes on board it was priced from. */
export async function driven(ex: Executor, trip: TripRow, now: Date): Promise<{ fare: Fare; km: number; minutes: number }> {
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
export async function drivenColumns(ex: Executor, trip: TripRow, fare: Fare, now: Date) {
  const base = fareColumns(trip, fare);
  const asDriven = { ...trip, fare_minor: String(base.fare_minor), fare_lines: fare.fareLines, driver_earnings_minor: String(base.driver_earnings_minor) } as TripRow;
  return (await withStopWaiting(ex, asDriven, now)) ?? base;
}

/** The re-price limits of a trip: kept at booking (v0.18.10), else the zone's live driver document. */
export async function earlyEndOf(ex: Executor, trip: TripRow): Promise<EarlyEndSettings> {
  const kept = (trip.booking_rules as Partial<BookingRules> | null)?.earlyEnd;
  if (kept) return earlyEndSettingsOf({ cancelFees: { earlyEnd: kept } });
  return earlyEndSettingsOf((await liveDocument(ex, "driver_app_config", trip.zone_id))?.document);
}

/** The driver's latest fix is farther than COMPLETE_NEAR_DROPOFF_METERS from the drop-off (no fix: not early). */
export async function endedBeforeDropoff(ex: Executor, trip: TripRow): Promise<boolean> {
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
export async function withStopWaiting(ex: Executor, trip: TripRow, now: Date) {
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

export function fareColumns(trip: TripRow, fare: Fare) {
  const pickupPay = Number(trip.pickup_pay_minor ?? 0);
  return {
    fare_minor: fare.total.amountMinor,
    fare_lines: JSON.stringify(fare.fareLines),
    driver_earnings_minor: fare.driverEarnings.amountMinor,
    commission_minor: commissionOf(fare.total.amountMinor, fare.fareLines, fare.driverEarnings.amountMinor, pickupPay, Number(trip.driver_bonus_minor ?? 0)),
  };
}
