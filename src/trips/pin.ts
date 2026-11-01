import { randomBytes } from "node:crypto";
import type { Db, Executor } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { lockOwnTrip, readOwnTrip } from "./commands.js";
import { rulesOf } from "./ride.js";

/**
 * Rider PIN before Start (v0.18.8, contract.json#arrivedWaiting.pin; owner G6 decision 2, per-zone admin switch default off).
 * The tries are counted in their own transaction, so a wrong PIN is remembered although the command fails.
 */

const CHECK_STATUSES = new Set(["accepted", "driver_to_pickup", "arrived"]);
/** How long a verifiedPinToken from POST /pin/verify is shown as valid (the trip stays verified anyway). */
const TOKEN_MINUTES = 10;

type Outcome = { ok: true; token: string; expiresAt: Date } | { ok: false; error: ApiError };

/**
 * Checks the driver's PIN for a trip. Nothing happens for a trip without pinRequired or one already verified. A right PIN
 * marks the trip verified (TripProjection.pinVerified); a wrong one counts, and maxAttempts wrong ones in a row lock the
 * trip for lockMinutes (the count starts again after the lock). The error is thrown after the count is committed.
 */
export async function checkPin(db: Db, driverId: string, tripId: string, pin: string, now: Date): Promise<{ token: string; expiresAt: Date } | null> {
  const outcome = await db.transaction().execute(async (trx): Promise<Outcome | null> => {
    const trip = await lockOwnTrip(trx, tripId, { actor: "driver", subjectId: driverId });
    const token = () => ({ ok: true as const, token: randomBytes(18).toString("base64url"), expiresAt: new Date(now.getTime() + TOKEN_MINUTES * 60_000) });
    if (!trip.pin_required || trip.pickup_pin === null) return null;
    if (trip.pin_verified_at !== null) return token();
    if (!CHECK_STATUSES.has(trip.status)) return { ok: false, error: new ApiError("invalid_transition", "The code is asked at the pickup.", { reason: "pin_not_now" }) };
    if (trip.pin_locked_until !== null && trip.pin_locked_until.getTime() > now.getTime()) return { ok: false, error: locked(trip.pin_locked_until, now) };
    if (pin === trip.pickup_pin) {
      await trx.updateTable("trips").set({ pin_verified_at: now, pin_attempts: 0, pin_locked_until: null }).where("trip_id", "=", tripId).execute();
      return token();
    }
    const settings = (await rulesOf(trx, trip)).pin;
    const wrong = Number(trip.pin_attempts) + 1;
    if (wrong >= settings.maxAttempts) {
      const until = new Date(now.getTime() + settings.lockMinutes * 60_000);
      await trx.updateTable("trips").set({ pin_attempts: 0, pin_locked_until: until }).where("trip_id", "=", tripId).execute();
      return { ok: false, error: locked(until, now) };
    }
    await trx.updateTable("trips").set({ pin_attempts: wrong, pin_locked_until: null }).where("trip_id", "=", tripId).execute();
    const left = settings.maxAttempts - wrong;
    return { ok: false, error: new ApiError("invalid_request", "Wrong code.", { reason: "pin_wrong", details: [`attemptsLeft=${left}`] }) };
  });
  if (outcome === null) return null;
  if (!outcome.ok) throw outcome.error;
  return { token: outcome.token, expiresAt: outcome.expiresAt };
}

function locked(until: Date, now: Date): ApiError {
  return new ApiError("rate_limited", "Too many wrong codes. Try again later.", { reason: "pin_locked", retryAfterSeconds: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)) });
}

/** POST /trips/{tripId}/pin/verify { pin }: PinVerification; a trip without pinRequired answers 404 pin_not_required. */
export async function verifyPin(db: Db, driverId: string, tripId: string, pin: unknown, now: Date) {
  await readOwnTrip(db, tripId, { actor: "driver", subjectId: driverId });
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) throw badRequest("The code has 4 digits.", "invalid_body");
  const result = await checkPin(db, driverId, tripId, pin, now);
  if (result === null) throw new ApiError("not_found", "This trip needs no code.", { reason: "pin_not_required" });
  return { verifiedPinToken: result.token, expiresAt: result.expiresAt.toISOString() };
}

/** GET /trips/{tripId}/pin (rider): PinCode; 404 pin_not_required without a PIN. */
export async function riderPin(ex: Executor, riderId: string, tripId: string) {
  const trip = await readOwnTrip(ex, tripId, { actor: "rider", subjectId: riderId });
  if (!trip.pin_required || trip.pickup_pin === null) throw new ApiError("not_found", "This trip needs no code.", { reason: "pin_not_required" });
  const start = trip.scheduled_at ?? trip.created_at;
  const expiresAt = trip.ended_at ?? new Date(start.getTime() + 24 * 3600_000);
  return { tripId: trip.trip_id, pin: trip.pickup_pin, expiresAt: expiresAt.toISOString() };
}
