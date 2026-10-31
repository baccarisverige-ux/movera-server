import type { Selectable } from "kysely";
import type { TripEventsTable } from "../db/schema.js";
import type { Viewer } from "../trips/projection.js";

/** The realtime envelope (contract §4, RealtimeEvent) for one stored event, as one viewer may see it. */

// Driver money and Movera money never reach the rider (the stored event is the admin projection).
const RIDER_HIDDEN = new Set(["driverEarnings", "commission", "pickupPay", "driverBonus"]);
const DRIVER_ONLY_LINES = new Set(["pickup_pay", "driver_bonus"]);

export function redactProjection(projection: Record<string, unknown>, viewer: Viewer): Record<string, unknown> {
  if (viewer === "admin") return projection;
  if (viewer === "driver") {
    const { searchStep: _s, driverSilentAlert: _a, driverRatingStatus, ...rest } = projection;
    // (the rider summary, v0.18.7 Q1, is the driver's to see)
    void _s;
    void _a;
    // Each side sees its own ratingStatus; the stored (admin) projection carries the driver's separately.
    return driverRatingStatus === undefined ? rest : { ...rest, ratingStatus: driverRatingStatus };
  }
  const out: Record<string, unknown> = {};
  // v0.18.7 (Q1): the rider never gets his own summary (it is the driver's view of him).
  for (const [k, v] of Object.entries(projection)) if (!RIDER_HIDDEN.has(k) && k !== "driverRatingStatus" && k !== "driverSilentAlert" && k !== "rider") out[k] = v;
  if (Array.isArray(out["fareLines"])) out["fareLines"] = (out["fareLines"] as Array<{ code: string }>).filter((l) => !DRIVER_ONLY_LINES.has(l.code));
  return out;
}

/**
 * `hideMessage` (v0.18.5 G9, contract.json#chat.appStorage.afterTrip): once the trip is terminal the rider and the driver
 * get the message events without their text; the admin's trip details keep it.
 */
export function eventEnvelope(row: Selectable<TripEventsTable>, viewer: Viewer, serverTime: Date, options: { hideMessage?: boolean } = {}): Record<string, unknown> {
  return {
    eventId: row.event_id,
    tripId: row.trip_id,
    sequence: Number(row.sequence),
    version: row.version,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
    serverTime: serverTime.toISOString(),
    ...(row.projection ? { projection: redactProjection(row.projection as Record<string, unknown>, viewer) } : {}),
    ...(row.location ? { location: row.location } : {}),
    ...(row.eta_seconds !== null ? { etaSeconds: row.eta_seconds } : {}),
    // v0.18.7 (contract.json#pickupWaiting.eta): the ETA tick's TripEta.
    ...(row.eta ? { eta: row.eta } : {}),
    ...(row.cancel_fee ? { cancelFee: row.cancel_fee } : {}),
    ...(row.message && !options.hideMessage ? { message: row.message } : {}),
  };
}
