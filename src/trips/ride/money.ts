import { sql } from "kysely";
import type { OfflineReason } from "../../db/schema.js";
import { markSetOffline } from "../../drivers/offlineReason.js";
import { clearNextTripsOff, settleOfflineAfterTrip } from "../../drivers/presence.js";
import { offlineIfDocumentsExpired } from "../../drivers/reminders.js";
import type { Executor, Trx } from "../../db/db.js";
import type { TripRow } from "../../db/tripLog.js";
import { newId } from "../../ids.js";
import type { Money } from "./shared.js";
import { outstandingLine } from "./settings.js";
import { moveWallet, walletBalance } from "../../riders/wallet.js";
import { appendTripEvent } from "../../db/tripLog.js";
import { scheduleTimer } from "../../jobs/timers.js";
import { NOT_HELD } from "../../reservations/view.js";
import { tripProjection } from "../projection.js";
import { scrubText } from "../../telemetry/scrub.js";

/* ---------------------------------------------------------------- money records */

export async function releaseDriver(trx: Trx, driverId: string | null, now: Date): Promise<void> {
  if (driverId === null) return;
  // v0.18.33 (owner answer 2026-11-05): he still drives a current trip (a queued or held one just ended): he stays on it.
  const still = await trx.selectFrom("trips").select("trip_id").where("driver_id", "=", driverId)
    .where("status", "in", ["accepted", "driver_to_pickup", "arrived", "rider_onboard", "in_trip", "approaching_dropoff"]).where(NOT_HELD).executeTakeFirst();
  // v0.18.65 §86 (owner "Yes, prove + fix" 2026-11-11): the trip sheet's "stop next trips" belongs to the trip he drives;
  // a queued or held next trip that ends keeps it. Only when that trip ends is it cleared: the next one starts with it on.
  if (still) return;
  await clearNextTripsOff(trx, driverId, now);
  // A live trip he took as an Exclusive while on that trip starts now: it is his current trip, the ETA starts ticking.
  // Rule 33: in this same transaction, with the queued row locked (FOR UPDATE), so two server copies never start it twice.
  const queued = await trx.selectFrom("trips").selectAll().where("driver_id", "=", driverId).where("status", "=", "accepted").where("next_after_trip_id", "is not", null).orderBy("accepted_at").forUpdate().executeTakeFirst();
  if (queued) {
    const started = await trx.updateTable("trips").set({ next_after_trip_id: null, version: sql`version + 1`, updated_at: now }).where("trip_id", "=", queued.trip_id).returningAll().executeTakeFirstOrThrow();
    await appendTripEvent(trx, { tripId: started.trip_id, kind: "trip_projection", version: started.version, occurredAt: now, projection: tripProjection(started, "admin", { sequence: Number(started.sequence) + 1 }) });
    await scheduleTimer(trx, { kind: "trip_eta", refId: started.trip_id, dueAt: now, payload: {} });
    await trx.updateTable("drivers").set({ online_status: "on_trip", updated_at: now }).where("driver_id", "=", driverId).execute();
    return;
  }
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
  // v0.18.33 (owner Q4 2026-11-05): a held booked ride whose time to drive has come (reservation.leaveAt reached)
  // starts now; else he is simply free. Only when he was on a trip and may still drive.
  if (blockedBy === null && before?.online_status === "on_trip") await startDueBooked(trx, driverId, now);
  // v0.18.37 §61: he tapped Go offline during the trip: offline now unless a due booked ride just started.
  await settleOfflineAfterTrip(trx, driverId, now);
}

async function startDueBooked(trx: Trx, driverId: string, now: Date): Promise<void> {
  const held = await trx.selectFrom("trips").select(["trip_id", "reservation"]).where("driver_id", "=", driverId).where("kind", "=", "scheduled").where("status", "=", "accepted")
    .where(sql<boolean>`coalesce(reservation->>'held', 'false') = 'true'`).where(sql<boolean>`(reservation->>'leaveAt')::timestamptz <= ${now}`).orderBy("scheduled_at").forUpdate().executeTakeFirst();
  if (!held) return;
  const { startReservation } = await import("../../reservations/service.js");
  // Rule 28/33: the start runs in a SAVEPOINT. Any failure (a refusal or a database error) rolls back only this step:
  // the driver's release stands, he is free, the booked ride stays held, and the admin sees it as "not started".
  await sql`SAVEPOINT start_due_booked`.execute(trx);
  try {
    await releaseHooks.beforeBookedStart?.(trx);
    await startReservation(trx, driverId, held.trip_id, undefined, now);
    await sql`RELEASE SAVEPOINT start_due_booked`.execute(trx);
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT start_due_booked`.execute(trx);
    await sql`RELEASE SAVEPOINT start_due_booked`.execute(trx);
    await trx.updateTable("trips")
      .set({ reservation: sql`coalesce(reservation, '{}'::jsonb) || jsonb_build_object('notStarted', true, 'startFailedAt', ${now.toISOString()}::text)` })
      .where("trip_id", "=", held.trip_id).execute();
    console.warn(JSON.stringify({ msg: "booked ride not started after the driver's trip", tripId: held.trip_id, error: (error as { code?: string }).code ?? scrubText(String((error as Error)?.message ?? error)) }));
  }
}

/** Test seam (rule 28): lets a test make the due booked start fail with a database error. */
export const releaseHooks: { beforeBookedStart?: (trx: Trx) => Promise<void> } = {};

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
export async function chargeRiderFee(trx: Trx, trip: TripRow, kind: "cancel" | "no_show", fee: Money, now: Date) {
  await trx.insertInto("rider_fees").values({ trip_id: trip.trip_id, rider_id: trip.rider_id, kind, currency: fee.currency, amount_minor: fee.amountMinor, status: "owed", created_at: now }).execute();
  await refreshOutstanding(trx, trip.rider_id, now);
}

export function feeSplit(fee: Money, sharePct: number) {
  const driver = Math.floor((fee.amountMinor * sharePct * 2 + 100) / 200);
  return { driver, movera: fee.amountMinor - driver };
}

/**
 * v0.18.92 (supervisor G1, contract.json#moneyBase.commissionRow.admin): an end with no paid ride and no fee (a free rider
 * cancel, an admin cancel) pays nobody: the quote's pay and commission are not kept on the trip (driverTotal 0, commission 0).
 */
export const FREE_END_COLUMNS = { driver_earnings_minor: 0, pickup_pay_minor: 0, driver_bonus_minor: 0, commission_minor: 0 } as const;

/** The fee becomes the trip's money: fare = fee (cancel_fee line), the driver's share as earnings. */
export function feeColumns(fee: Money, sharePct: number) {
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
export async function settleCarriedFees(trx: Trx, trip: TripRow, cash: number, now: Date) {
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
export async function walletCovers(ex: Executor, riderId: string, currency: string, fareMinor: number): Promise<number> {
  return Math.max(0, Math.min(await walletBalance(ex, riderId, currency), fareMinor));
}

/**
 * The trip is paid: the wallet pays the part the driver was shown at boarding (never more, so money that reaches
 * the wallet later stays there), the driver collects the rest in cash.
 */
/** What the rider's wallet pays of a fare (the part reserved on the trip, at most the wallet and the fare). */
export function walletPart(walletMinor: number, trip: TripRow, fareMinor: number): number {
  return Math.max(0, Math.min(walletMinor, fareMinor, Number(trip.wallet_applied_minor ?? 0)));
}

export async function spendWallet(trx: Trx, trip: TripRow, fareMinor: number, now: Date): Promise<number> {
  // v0.18.28 (owner Q4): only the balance in the trip's currency pays it.
  const applied = walletPart(await walletBalance(trx, trip.rider_id, trip.currency, true), trip, fareMinor);
  if (applied > 0) {
    await moveWallet(trx, trip.rider_id, trip.currency, -applied, now);
    await trx.insertInto("wallet_entries").values({ entry_id: newId("wlt", now.getTime()), rider_id: trip.rider_id, kind: "charge", currency: trip.currency, amount_minor: -applied, trip_id: trip.trip_id, at: now }).execute();
  }
  return applied;
}
