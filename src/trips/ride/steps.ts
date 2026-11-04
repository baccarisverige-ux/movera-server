import { reservationPolicy } from "../../reservations/policy.js";
import { randomInt } from "node:crypto";
import { closeDriverSilent, openDriverSilent } from "../../safety/incidents.js";
import type { Updateable } from "kysely";
import type { TripsTable } from "../../db/schema.js";
import type { Executor, Trx } from "../../db/db.js";
import { appendTripEvent, type TripRow } from "../../db/tripLog.js";
import { ApiError } from "../../http/errors.js";
import { scheduleTimer, type TimerHandler } from "../../jobs/timers.js";
import { haversineKm } from "../../maps/routing.js";
import type { FareLine } from "../../rules/fare.js";
import { extrasOf } from "../../rules/priceExtras.js";
import { lockTripNow } from "../../dispatch/runtime.js";
import { applyCommand, expectVersion, lockOwnTrip } from "../commands.js";
import { RIDER_ONBOARD, type TripStatus } from "../../rules/transitions.js";
import { tripProjection } from "../projection.js";
import { effectiveWaiting } from "../waitingRules.js";
import { type Money, type Place, type Waiting, NEAR_DROPOFF_METERS, NEAR_DROPOFF, ARRIVE_MAX_METERS, positionMaxAge } from "./shared.js";
import { rulesOf, waitingOf, fareWithWaiting, fareColumns } from "./settings.js";
import { releaseDriver, feeSplit, walletCovers } from "./money.js";
import { pickupInRunningEvent, WAITING_PAID, WAITING_NO_SHOW } from "./timers.js";

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
    // Owner 2026-11-03 (v0.18.19 includedWaiting): a booked ride's free waiting is the ONE all-zones value of the
    // reservation policy (admin "Included waiting"); the no-show time is never before its end.
    if (trip.kind === "scheduled") {
      const policy = await reservationPolicy(trx);
      rules.freeWaitMin = policy.includedWaitingMinutes;
      rules.noShowAfterMin = Math.max(rules.noShowAfterMin, rules.freeWaitMin);
    }
    // A reservation's clock starts at the booked time, not when an early driver arrives.
    // Owner B (v0.18.19): a booked ride's free waiting counts from the pickup time, also when the driver arrives late.
    const start = trip.kind === "scheduled" && trip.scheduled_at ? trip.scheduled_at : now;
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
