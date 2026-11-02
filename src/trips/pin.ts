import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Db, Executor, Trx } from "../db/db.js";
import { TERMINAL, type TripStatus } from "../rules/transitions.js";
import { ApiError, badRequest } from "../http/errors.js";
import { lockOwnTrip, readOwnTrip, touchTrip } from "./commands.js";
import { rulesOf } from "./ride.js";

/**
 * Rider PIN before Start (v0.18.8, contract.json#arrivedWaiting.pin; owner G6 decision 2, per-zone admin switch default off).
 * Checker round 1: guesses only while arrived (M2); maxAttempts wrong in a row lock for lockMinutes, 3 × maxAttempts wrong in
 * all block the PIN until an admin unlocks it (M2); constant-time compare (L6); a right PIN bumps the version with a
 * trip_projection event so the rider's pinVerified updates (L5). The tries are counted in their own transaction, so a wrong
 * PIN is remembered although the command fails.
 */

/** Total wrong tries per trip before an admin must unlock: TOTAL_FACTOR × maxAttempts. */
export const PIN_TOTAL_FACTOR = 3;
const sameCode = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

type Outcome = { ok: true; token: string; expiresAt: Date; version: number; bumped: boolean } | { ok: false; error: ApiError };

/**
 * Checks the driver's PIN for a trip. Null for a trip without pinRequired. A right PIN marks the trip verified (version + 1,
 * trip_projection); a trip already verified answers ok without a change.
 */
export async function checkPin(db: Db, driverId: string, tripId: string, pin: string, now: Date): Promise<{ token: string; expiresAt: Date; version: number; bumped: boolean } | null> {
  const outcome = await db.transaction().execute(async (trx): Promise<Outcome | null> => {
    const trip = await lockOwnTrip(trx, tripId, { actor: "driver", subjectId: driverId });
    const ok = (version: number, bumped: boolean) => ({ ok: true as const, token: randomBytes(18).toString("base64url"), expiresAt: new Date(now.getTime() + 10 * 60_000), version, bumped });
    if (!trip.pin_required || trip.pickup_pin === null) return null;
    if (trip.pin_verified_at !== null) return ok(trip.version, false);
    if (trip.status !== "arrived") return { ok: false, error: new ApiError("invalid_transition", "The code is asked when you are at the pickup.", { reason: "pin_not_now" }) };
    if (trip.pin_blocked) return { ok: false, error: blocked() };
    if (trip.pin_locked_until !== null && trip.pin_locked_until.getTime() > now.getTime()) return { ok: false, error: locked(trip.pin_locked_until, now) };
    if (sameCode(pin, trip.pickup_pin)) {
      const done = await touchTrip(trx, trip, { pin_verified_at: now, pin_attempts: 0, pin_locked_until: null }, now);
      return ok(done.version, true);
    }
    const settings = (await rulesOf(trx, trip)).pin;
    const wrong = Number(trip.pin_attempts) + 1;
    const total = Number(trip.pin_wrong_total) + 1;
    if (total >= PIN_TOTAL_FACTOR * settings.maxAttempts) {
      await trx.updateTable("trips").set({ pin_attempts: 0, pin_wrong_total: total, pin_blocked: true, pin_locked_until: null }).where("trip_id", "=", tripId).execute();
      return { ok: false, error: blocked() };
    }
    if (wrong >= settings.maxAttempts) {
      const until = new Date(now.getTime() + settings.lockMinutes * 60_000);
      await trx.updateTable("trips").set({ pin_attempts: 0, pin_wrong_total: total, pin_locked_until: until }).where("trip_id", "=", tripId).execute();
      return { ok: false, error: locked(until, now) };
    }
    await trx.updateTable("trips").set({ pin_attempts: wrong, pin_wrong_total: total, pin_locked_until: null }).where("trip_id", "=", tripId).execute();
    return { ok: false, error: new ApiError("invalid_request", "Wrong code.", { reason: "pin_wrong", details: [`attemptsLeft=${settings.maxAttempts - wrong}`] }) };
  });
  if (outcome === null) return null;
  if (!outcome.ok) throw outcome.error;
  return { token: outcome.token, expiresAt: outcome.expiresAt, version: outcome.version, bumped: outcome.bumped };
}

function locked(until: Date, now: Date): ApiError {
  return new ApiError("rate_limited", "Too many wrong codes. Try again later.", { reason: "pin_locked", retryAfterSeconds: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)) });
}
function blocked(): ApiError {
  return new ApiError("rate_limited", "Too many wrong codes. Call Movera support.", { reason: "pin_blocked" });
}

/** POST /trips/{tripId}/pin/verify { pin }: PinVerification (+ version, v0.18.8 checker L5); 404 pin_not_required without a PIN. */
export async function verifyPin(db: Db, driverId: string, tripId: string, pin: unknown, now: Date) {
  await readOwnTrip(db, tripId, { actor: "driver", subjectId: driverId });
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) throw badRequest("The code has 4 digits.", "invalid_body");
  const result = await checkPin(db, driverId, tripId, pin, now);
  if (result === null) throw new ApiError("not_found", "This trip needs no code.", { reason: "pin_not_required" });
  return { verifiedPinToken: result.token, expiresAt: result.expiresAt.toISOString(), version: result.version };
}

/** GET /trips/{tripId}/pin (rider): PinCode; 404 pin_not_required without a PIN, 404 pin_trip_over once the trip ended (L8). */
export async function riderPin(ex: Executor, riderId: string, tripId: string) {
  const trip = await readOwnTrip(ex, tripId, { actor: "rider", subjectId: riderId });
  if (!trip.pin_required || trip.pickup_pin === null) throw new ApiError("not_found", "This trip needs no code.", { reason: "pin_not_required" });
  if (TERMINAL.has(trip.status as TripStatus)) throw new ApiError("not_found", "This trip is over.", { reason: "pin_trip_over" });
  const start = trip.scheduled_at ?? trip.created_at;
  return { tripId: trip.trip_id, pin: trip.pickup_pin, expiresAt: new Date(start.getTime() + 24 * 3600_000).toISOString() };
}

/** POST /admin/trips/{tripId}/pin/unlock (checker M2): clears the lock, the block and the counts; the trip keeps its PIN. */
export async function adminUnlockPin(trx: Trx, trip: Parameters<typeof touchTrip>[1], now: Date) {
  if (!trip.pin_required) throw new ApiError("invalid_transition", "This trip needs no code.", { reason: "pin_not_required" });
  return touchTrip(trx, trip, { pin_attempts: 0, pin_wrong_total: 0, pin_locked_until: null, pin_blocked: false }, now);
}
