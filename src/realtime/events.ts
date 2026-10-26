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
    void _s;
    void _a;
    // Each side sees its own ratingStatus; the stored (admin) projection carries the driver's separately.
    return driverRatingStatus === undefined ? rest : { ...rest, ratingStatus: driverRatingStatus };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(projection)) if (!RIDER_HIDDEN.has(k) && k !== "driverRatingStatus" && k !== "driverSilentAlert") out[k] = v;
  if (Array.isArray(out["fareLines"])) out["fareLines"] = (out["fareLines"] as Array<{ code: string }>).filter((l) => !DRIVER_ONLY_LINES.has(l.code));
  return out;
}

export function eventEnvelope(row: Selectable<TripEventsTable>, viewer: Viewer, serverTime: Date): Record<string, unknown> {
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
    ...(row.cancel_fee ? { cancelFee: row.cancel_fee } : {}),
    ...(row.message ? { message: row.message } : {}),
  };
}
