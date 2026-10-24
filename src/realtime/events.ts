import type { Selectable } from "kysely";
import type { TripEventsTable } from "../db/schema.js";
import type { Viewer } from "../trips/projection.js";

/** The realtime envelope (contract §4, RealtimeEvent) for one stored event, as one viewer may see it. */

const RIDER_HIDDEN = new Set(["driverEarnings", "commission"]);
const DRIVER_ONLY_LINES = new Set(["pickup_pay", "driver_bonus"]);

export function redactProjection(projection: Record<string, unknown>, viewer: Viewer): Record<string, unknown> {
  if (viewer !== "rider") {
    const { searchStep: _s, ...rest } = projection;
    void _s;
    return rest;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(projection)) if (!RIDER_HIDDEN.has(k)) out[k] = v;
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
