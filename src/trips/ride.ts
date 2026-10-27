import { closeDriverSilent, incidentHandlers, openDriverSilent } from "../safety/incidents.js";
import { sql, type Updateable } from "kysely";
import type { TripsTable } from "../db/schema.js";
import { contract } from "../contract/contract.js";
import { schemaProblem } from "../contract/schemas.js";
import { liveDocument } from "../config/service.js";
import type { Executor, Trx } from "../db/db.js";
import { appendTripEvent, type TripRow } from "../db/tripLog.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { scheduleTimer, type TimerHandler } from "../jobs/timers.js";
import { haversineKm } from "../maps/routing.js";
import { cancelFee, type FeeRule } from "../rules/cancelFees.js";
import { priceFare, type Fare, type FareLine, type PricingDocument } from "../rules/fare.js";
import { extrasOf } from "../rules/priceExtras.js";
import { lockTripNow, startSearch, stopSearch } from "../dispatch/runtime.js";
import { applyCommand, expectVersion, lockOwnTrip } from "./commands.js";
import { nextStatus, RIDER_ONBOARD, type TripStatus } from "../rules/transitions.js";
import { tripProjection } from "./projection.js";

/**
 * The ride after a driver accepted (contract §3, §3.5, §3.7): the driver's steps, the waiting clock and no-show,
 * driver cancels (back to dispatch, or ended on board), the rider ending early, completion with cash, the rider's
 * cancel fee after accept, unpaid fees and ratings. Cash only in the test week (owner decision).
 */

type Money = { amountMinor: number; currency: string };
type Place = { lat: number; lng: number };
type Waiting = { arrivedAt: string; freeUntil: string; noShowAt: string; chargedSeconds: number };
type Who = { actor: "rider" | "driver" | "admin"; subjectId: string };

const C = contract as unknown as {
  cancelReasons: Record<string, string[]>;
  configDefaults: { noShowDriverSharePct: number };
};
const REASONS = C.cancelReasons;
const DEFAULT_NO_SHOW_SHARE = C.configDefaults.noShowDriverSharePct;

/** Within this distance of the drop-off the trip shows "Almost there" (near_dropoff). */
export const NEAR_DROPOFF_METERS = 500;
export const NEAR_DROPOFF = "near_dropoff";
/**
 * The rider-cancel "was the driver really coming?" check (owner decision 25, 2026-10-24): after the free minutes the
 * rider pays only when the driver came closer to the pickup by at least half of what a normal car covers in the
 * minutes since accepting (24 km/h = 400 m a minute, the dispatch pickup speed). A driver at the pickup counts.
 */
export const NORMAL_PICKUP_METERS_PER_MIN = 400;
export const CAME_CLOSER_SHARE = 0.5;
/** "Arrived" is accepted within this distance of the pickup (the driver's latest fix). */
export const ARRIVE_MAX_METERS = 300;
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
};
type AppDocs = {
  rider: { cancelFees?: { live?: Record<string, FeeRule>; reservation?: Record<string, FeeRule> } } | undefined;
  driver: { cancelFees?: { driverSharePct?: unknown }; waiting?: { driverSharePct?: unknown; driverShareWaitPct?: unknown } } | undefined;
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
  return {
    cancelRule: cancelRuleOf(docs, kind, categoryId),
    cancelDriverSharePct: sharePct(docs.driver?.cancelFees?.driverSharePct, DEFAULT_CANCEL_SHARE),
    waiting: pricing?.categories[categoryId]?.waiting ?? null,
    noShowDriverSharePct: sharePct(docs.driver?.waiting?.driverSharePct, DEFAULT_NO_SHOW_SHARE),
    waitDriverSharePct: sharePct(docs.driver?.waiting?.driverShareWaitPct, 100),
  };
}

/** The trip's kept rules; a trip booked before v0.8.0 has none and reads today's settings. */
async function rulesOf(ex: Executor, trip: TripRow): Promise<BookingRules> {
  const kept = trip.booking_rules as BookingRules | null;
  if (kept !== null && typeof kept === "object") return kept;
  return bookingRulesFor(ex, trip.zone_id, trip.kind, trip.category_id, null);
}

async function waitingOf(ex: Executor, trip: TripRow): Promise<CategoryWaitingRules> {
  const kept = (trip.booking_rules as BookingRules | null)?.waiting;
  return kept ?? waitingRules(await pricingOf(ex, trip), trip.category_id);
}

const outstandingLine = (trip: TripRow) => ((trip.fare_lines as FareLine[]) ?? []).find((l) => l.code === "outstanding_fee");

/** The fare with the quote's route and the waiting so far (§3.5 "Quote and fare"). */
export async function fareWithWaiting(ex: Executor, trip: TripRow, chargedSeconds: number): Promise<Fare> {
  const doc = await pricingOf(ex, trip);
  const owed = outstandingLine(trip);
  return priceFare(doc, {
    categoryId: trip.category_id,
    km: (trip.distance_meters ?? 0) / 1000,
    minutes: (trip.duration_seconds ?? 0) / 60,
    kind: trip.kind,
    surgeMultiplier: Number(trip.surge_multiplier),
    waitingChargedSeconds: chargedSeconds,
    stopWaitSeconds: ((trip.stops as unknown[]) ?? []).map(() => 0),
    // v0.6.0 (§3.5): the seats, airport and fixed route the rider booked are priced again at the end.
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
  const doc = await pricingOf(ex, trip);
  const since = trip.boarded_at ?? now;
  const km = Math.round((await kmOnBoard(ex, trip, since)) * 1000) / 1000;
  const minutes = Math.round(Math.max(0, now.getTime() - since.getTime()) / 600) / 100;
  const owed = outstandingLine(trip);
  const booked = Number(trip.booked_fare_minor) - (owed ? owed.amount.amountMinor : 0);
  return priceFare(doc, {
    categoryId: trip.category_id,
    km,
    minutes,
    kind: trip.kind,
    surgeMultiplier: Number(trip.surge_multiplier),
    endEarly: { kmDriven: km, minutesOnBoard: minutes, bookedFare: { amountMinor: booked, currency: trip.currency } },
  });
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
  return {
    fare_minor: fareMinor,
    // The lines stay; one "adjustment" line carries the difference, so they still add up to the fare.
    fare_lines: JSON.stringify([...((trip.fare_lines as FareLine[]) ?? []), ...(fareMinor !== before ? [{ code: "adjustment", amount: { amountMinor: fareMinor - before, currency: trip.currency } }] : [])]),
    driver_earnings_minor: earnings,
    commission_minor: fareMinor - earnings - pickupPay - Number(trip.driver_bonus_minor ?? 0),
  };
}

/** The trip columns for a fare: Movera keeps fare − driverEarnings − pickupPay (§3.2). */
function fareColumns(trip: TripRow, fare: Fare) {
  const pickupPay = Number(trip.pickup_pay_minor ?? 0);
  return {
    fare_minor: fare.total.amountMinor,
    fare_lines: JSON.stringify(fare.fareLines),
    driver_earnings_minor: fare.driverEarnings.amountMinor,
    commission_minor: fare.total.amountMinor - fare.driverEarnings.amountMinor - pickupPay - Number(trip.driver_bonus_minor ?? 0),
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
}

export async function credit(trx: Trx, entry: { driverId: string; tripId: string; kind: "trip" | "pickup_pay" | "fee_share" | "bonus" | "adjustment"; currency: string; amount: number; gross?: number; commission?: number; cash?: number }, now: Date) {
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

/** Rider.outstanding = the sum of owed fees; the oldest one names the source trip (§3.7). */
export async function refreshOutstanding(trx: Trx, riderId: string, now: Date) {
  const owed = await trx.selectFrom("rider_fees").select(["trip_id", "amount_minor"]).where("rider_id", "=", riderId).where("status", "=", "owed").orderBy("created_at").orderBy("trip_id").execute();
  const total = owed.reduce((sum, f) => sum + Number(f.amount_minor), 0);
  await trx.updateTable("riders").set({ outstanding_minor: total, outstanding_source_trip_id: owed[0]?.trip_id ?? null, updated_at: now }).where("rider_id", "=", riderId).execute();
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
  const owed = await trx.selectFrom("rider_fees").select(["trip_id", "amount_minor"]).where("rider_id", "=", trip.rider_id).where("status", "=", "owed").orderBy("created_at").orderBy("trip_id").forUpdate().execute();
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
async function spendWallet(trx: Trx, trip: TripRow, fareMinor: number, now: Date): Promise<number> {
  const rider = await trx.selectFrom("riders").select("wallet_minor").where("rider_id", "=", trip.rider_id).forUpdate().executeTakeFirstOrThrow();
  const applied = Math.max(0, Math.min(Number(rider.wallet_minor), fareMinor, Number(trip.wallet_applied_minor ?? 0)));
  if (applied > 0) {
    await trx.updateTable("riders").set({ wallet_minor: sql`wallet_minor - ${applied}`, updated_at: now }).where("rider_id", "=", trip.rider_id).execute();
    await trx.insertInto("wallet_entries").values({ entry_id: newId("wlt", now.getTime()), rider_id: trip.rider_id, kind: "charge", currency: trip.currency, amount_minor: -applied, trip_id: trip.trip_id, at: now }).execute();
  }
  return applied;
}

/* ---------------------------------------------------------------- the driver's steps */

type StepCommand = "head_to_pickup" | "arrive" | "board" | "start_trip";

export async function driverStep(trx: Trx, driverId: string, tripId: string, command: StepCommand, expectedVersion: number, now: Date, location?: Place): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, { actor: "driver", subjectId: driverId });
  expectVersion(trip, expectedVersion, "driver");
  if (command === "arrive") {
    if (trip.status === "driver_to_pickup") {
      const here = location ?? (await trx.selectFrom("driver_locations").select(["lat", "lng"]).where("driver_id", "=", driverId).executeTakeFirst());
      if (!here || haversineKm(here, trip.pickup as Place) * 1000 > ARRIVE_MAX_METERS) {
        throw new ApiError("invalid_transition", "You are not at the pickup yet.", { reason: "not_at_pickup", projection: tripProjection(trip, "driver") });
      }
    }
    const rules = await waitingOf(trx, trip);
    // A reservation's clock starts at the booked time, not when an early driver arrives.
    const start = trip.scheduled_at && trip.scheduled_at.getTime() > now.getTime() ? trip.scheduled_at : now;
    const at = (min: number) => new Date(start.getTime() + min * 60_000).toISOString();
    const waiting: Waiting = { arrivedAt: now.toISOString(), freeUntil: at(rules.freeWaitMin), noShowAt: at(rules.noShowAfterMin), chargedSeconds: 0 };
    return applyCommand(trx, trip, { command, actor: "driver", now, set: { arrived_at: now, waiting: JSON.stringify(waiting) } });
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
  if (command === "start_trip") return applyCommand(trx, trip, { command, actor: "driver", now, set: { started_at: now } });
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
  const rules = await waitingOf(trx, trip);
  const fee: Money | null = !waive && rules.noShowFee.amountMinor > 0 ? { amountMinor: rules.noShowFee.amountMinor, currency: trip.currency } : null;
  const share = (await rulesOf(trx, trip)).noShowDriverSharePct;
  const cancellation = { actor, reasonCode: "rider_no_show", at: now.toISOString(), fee, ...(fee ? { feeStatus: "owed" } : {}) };
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
 * inside the free minutes; a live trip is charged only when the driver was really coming (see
 * NORMAL_PICKUP_METERS_PER_MIN). The fee is on the booked fare without an outstanding fee.
 */
export async function riderCancelFee(ex: Executor, trip: TripRow, now: Date): Promise<Money | null> {
  if (trip.accepted_at === null || trip.driver_id === null) return null;
  const rule = (await rulesOf(ex, trip)).cancelRule;
  if (rule === null) return null;
  const owed = outstandingLine(trip);
  const fare = { amountMinor: Number(trip.booked_fare_minor) - (owed ? owed.amount.amountMinor : 0), currency: trip.currency };
  const minutesSinceAccept = (now.getTime() - trip.accepted_at.getTime()) / 60_000;
  const minutesBeforePickup = trip.scheduled_at ? (trip.scheduled_at.getTime() - now.getTime()) / 60_000 : 0;
  const amount = cancelFee({ kind: trip.kind === "scheduled" ? "reservation" : "live", rule, fare: fare as Parameters<typeof cancelFee>[0]["fare"], minutesSinceAccept, minutesBeforePickup });
  if (amount.amountMinor <= 0) return null;
  if (trip.kind === "live" && trip.status !== "arrived" && trip.accept_pickup_meters !== null) {
    // No position from the driver means no proof they were coming: no fee.
    const fix = await ex.selectFrom("driver_locations").select(["lat", "lng"]).where("driver_id", "=", trip.driver_id).executeTakeFirst();
    if (!fix) return null;
    const nowMeters = haversineKm(fix, trip.pickup as Place) * 1.25 * 1000;
    const atPickup = haversineKm(fix, trip.pickup as Place) * 1000 <= ARRIVE_MAX_METERS;
    const needed = minutesSinceAccept * NORMAL_PICKUP_METERS_PER_MIN * CAME_CLOSER_SHARE;
    if (!atPickup && trip.accept_pickup_meters - nowMeters < needed) return null;
  }
  return amount;
}

/** After the rider's cancel: the driver is free again and gets their share of a fee (owed by the rider). */
export async function riderFeeColumns(ex: Executor, trip: TripRow, fee: Money) {
  return feeColumns(fee, (await rulesOf(ex, trip)).cancelDriverSharePct);
}

export async function afterRiderCancel(trx: Trx, before: TripRow, cancelled: TripRow, fee: Money | null, now: Date) {
  if (fee && before.driver_id) {
    const share = (await rulesOf(trx, before)).cancelDriverSharePct;
    await chargeRiderFee(trx, cancelled, "cancel", fee, now);
    await credit(trx, { driverId: before.driver_id, tripId: before.trip_id, kind: "fee_share", currency: fee.currency, amount: feeSplit(fee, share).driver }, now);
  }
  await releaseDriver(trx, before.driver_id, now);
}

/* ---------------------------------------------------------------- the driver's cancel */

export async function driverCancel(trx: Trx, driverId: string, tripId: string, body: { expectedVersion: number; reasonCode: string; note?: string }, now: Date): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, { actor: "driver", subjectId: driverId });
  expectVersion(trip, body.expectedVersion, "driver");
  if (nextStatus(trip.status as never, "cancel", "driver", trip.kind) === null) {
    throw new ApiError("invalid_transition", `A driver cannot cancel a trip that is ${trip.status}.`, { projection: tripProjection(trip, "driver") });
  }
  const onboard = ONBOARD.includes(trip.status);
  const allowed = onboard ? REASONS["driverDuringTrip"]! : trip.kind === "scheduled" ? [...REASONS["scheduled"]!, ...REASONS["driverBeforeTrip"]!] : REASONS["driverBeforeTrip"]!;
  if (!allowed.includes(body.reasonCode)) throw badRequest(`${body.reasonCode} is not a reason for a driver cancel now.`, "invalid_reason_code");
  // The driver's note is for Movera only (driver_cancels); the rider sees the reason code.
  const cancellation = { actor: "driver", reasonCode: body.reasonCode, at: now.toISOString(), fee: null };
  // Counts in the driver's cancel rate (§3 "counts in cancel rate").
  await trx.insertInto("driver_cancels").values({ trip_id: tripId, driver_id: driverId, at: now, from_status: trip.status, reason_code: body.reasonCode, note: body.note ?? null }).execute();

  if (onboard) {
    // Ended on board: the rider pays for what was driven, in cash, like an early end (owner decision 8).
    const fare = await drivenFare(trx, trip, now);
    const wallet = await spendWallet(trx, trip, fare.total.amountMinor, now);
    const ended = await applyCommand(trx, trip, {
      command: "cancel",
      actor: "driver",
      now,
      set: { ...fareColumns(trip, fare), cancellation: JSON.stringify(cancellation), ended_by_command: "cancel", ended_at: now, payment_status: "captured", cash_collected_minor: fare.total.amountMinor - wallet, wallet_applied_minor: wallet },
    });
    await creditTrip(trx, ended, now);
    await releaseDriver(trx, driverId, now);
    return ended;
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
      accept_pickup_meters: null,
      pickup_pay_minor: 0,
      driver_earnings_minor: earnings,
      commission_minor: Number(trip.fare_minor) - earnings - Number(trip.driver_bonus_minor ?? 0),
      wallet_applied_minor: 0,
      search_step: null,
      ...(input.exclude ? { cancelled_driver_ids: sql<string[]>`array_append(cancelled_driver_ids, ${input.exclude})` } : {}),
      ...(trip.status === "accepted" && trip.kind === "scheduled" ? {} : { search_started_at: now }),
    },
  });
  await stopSearch(trx, back, now);
  await releaseDriver(trx, trip.driver_id, now);
  if (back.status === "searching") await startSearch(trx, back, now);
  return back;
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
  const fare = await drivenFare(trx, trip, now);
  const wallet = await spendWallet(trx, trip, fare.total.amountMinor, now);
  const cancellation = { actor: "rider", reasonCode: body.reasonCode ?? "something_else", at: now.toISOString(), fee: null, ...(body.note ? { note: body.note } : {}) };
  const ended = await applyCommand(trx, trip, {
    command: "end_early",
    actor: "rider",
    now,
    // An owed fee the trip carried stays owed: the trip did not complete (§3.7).
    set: { ...fareColumns(trip, fare), cancellation: JSON.stringify(cancellation), ended_by_command: "end_early", ended_at: now, payment_status: "captured", cash_collected_minor: fare.total.amountMinor - wallet, wallet_applied_minor: wallet, rating_status: "pending" },
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

export async function completeTrip(trx: Trx, who: { actor: "driver" | "admin"; subjectId: string }, tripId: string, body: { expectedVersion: number; cashCollected?: Money; fare?: Money }, now: Date): Promise<TripRow> {
  const trip = await lockOwnTrip(trx, tripId, who);
  if (body.fare && body.fare.currency !== trip.currency) throw badRequest(`The fare is in ${trip.currency}.`, "currency_mismatch");
  expectVersion(trip, body.expectedVersion, who.actor);
  if (body.cashCollected && body.cashCollected.currency !== trip.currency) throw badRequest(`Cash is counted in ${trip.currency}.`, "currency_mismatch");
  // Finished before the destination (owner decision 28, like the rider's early end): the rider pays for what was
  // driven, never more than booked. An admin's fare is taken as given; at the drop-off the booked fare stands.
  const early = body.fare === undefined && who.actor === "driver" && (await endedBeforeDropoff(trx, trip));
  const measured = early ? await drivenFare(trx, trip, now) : null;
  // Only when it is less than booked: at the cap the booked fare and its lines stand as they are.
  const driven = measured !== null && measured.total.amountMinor < Number(trip.fare_minor) ? measured : null;
  const fare = body.fare?.amountMinor ?? driven?.total.amountMinor ?? Number(trip.fare_minor);
  const money = body.fare ? scaledFare(trip, fare) : driven ? fareColumns(trip, driven) : {};
  const wallet = await spendWallet(trx, trip, fare, now);
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
  return done;
}

/* ---------------------------------------------------------------- ratings */

type RatingBody = { stars?: number; tags?: string[]; comment?: string; skip?: boolean; tip?: Money };

export async function rateTrip(trx: Trx, who: { actor: "rider" | "driver"; subjectId: string }, tripId: string, body: unknown, now: Date): Promise<{ status: number; body: unknown }> {
  const problem = schemaProblem("RatingRequest", body);
  if (problem !== null) throw badRequest(`The rating is not valid: ${problem}.`, "invalid_body");
  const rating = body as RatingBody;
  if (!rating.skip && rating.stars === undefined) throw badRequest("Give 1 to 5 stars, or skip.", "stars_missing");
  if (rating.tip) throw badRequest("Tips are not available yet.", "tips_not_available");
  const trip = await lockOwnTrip(trx, tripId, who);
  const allowed =
    trip.status === "completed" ||
    (who.actor === "rider" && trip.status === "cancelled_by_rider" && trip.ended_by_command === "end_early");
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
    await trx.insertInto("ratings").values({ trip_id: tripId, rater: who.actor, stars, tags, comment: rating.comment ?? null, at: now }).execute();
    await trx.updateTable("trips").set({ [column]: "submitted" }).where("trip_id", "=", tripId).execute();
    // The rider rates the driver; the driver rates the rider.
    if (who.actor === "rider" && trip.driver_id) {
      await trx.updateTable("drivers").set({ rating_sum: sql`rating_sum + ${stars}`, rating_count: sql`rating_count + 1` }).where("driver_id", "=", trip.driver_id).execute();
    } else if (who.actor === "driver") {
      await trx.updateTable("riders").set({ rating_sum: sql`rating_sum + ${stars}`, rating_count: sql`rating_count + 1` }).where("rider_id", "=", trip.rider_id).execute();
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
           coalesce(sum(cash_minor) FILTER (WHERE kind = 'trip'), 0) AS cash
      FROM earnings_entries
     WHERE driver_id = ${driverId} AND at >= ${from} AND at < ${to}
     GROUP BY 1 ORDER BY 1`.execute(ex);
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
  return { driverId, period: input.period, timeZone: tz, periods };
}

export const rideHandlers: Record<string, TimerHandler> = { [NEAR_DROPOFF]: nearDropoffHandler, [DRIVER_SILENCE]: driverSilenceHandler, ...incidentHandlers };
export type { Who };
