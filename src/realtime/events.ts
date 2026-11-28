import type { Selectable } from "kysely";
import type { TripEventsTable } from "../db/schema.js";
import { contract } from "../contract/contract.js";
import { hideDriverMoney, hidePinFromDriver, type Viewer } from "../trips/projection.js";

/** The realtime envelope (contract §4, RealtimeEvent) for one stored event, as one viewer may see it. */

// Driver money and Movera money never reach the rider (the stored event is the admin projection).
const RIDER_HIDDEN = new Set(["driverEarnings", "commission", "pickupPay", "driverBonus"]);
const SOS = (contract as unknown as { safety: { sos: { riderStatuses: string[]; driverStatuses: string[] } } }).safety.sos;
const DRIVER_ONLY_LINES = new Set(["pickup_pay", "driver_bonus"]);

export function redactProjection(projection: Record<string, unknown>, viewer: Viewer): Record<string, unknown> {
  if (viewer === "admin") return projection;
  if (viewer === "driver") {
    const { searchStep: _s, driverSilentAlert: _a, driverRatingStatus, ...rest } = projection;
    // (the rider summary, v0.18.7 Q1, is the driver's to see)
    void _s;
    void _a;
    // Each side sees its own ratingStatus; the stored (admin) projection carries the driver's separately.
    // v0.18.8: never the rider's PIN or the tries count on the driver's stream.
    const shown = withSos(hidePinFromDriver(rest), "driver");
    // v0.18.10: the finish block's ratingAllowed is the driver's own (the stored projection carries the rider's).
    const finish = shown["finish"] as Record<string, unknown> | undefined;
    if (finish && driverRatingStatus !== undefined) shown["finish"] = { ...finish, ratingAllowed: driverRatingStatus === "pending" };
    return driverRatingStatus === undefined ? shown : { ...shown, ratingStatus: driverRatingStatus };
  }
  const out: Record<string, unknown> = {};
  // v0.18.7 (Q1): the rider never gets his own summary (it is the driver's view of him).
  for (const [k, v] of Object.entries(projection)) if (!RIDER_HIDDEN.has(k) && k !== "driverRatingStatus" && k !== "driverSilentAlert" && k !== "rider") out[k] = v;
  if (Array.isArray(out["fareLines"])) out["fareLines"] = (out["fareLines"] as Array<{ code: string }>).filter((l) => !DRIVER_ONLY_LINES.has(l.code));
  return withSos(hideDriverMoney(out), "rider");
}

/** v0.18.10 (owner G8 Q4): sosAvailable for the side's stream, from the trip status (the stored admin view has none). */
function withSos(out: Record<string, unknown>, side: "rider" | "driver"): Record<string, unknown> {
  const statuses = side === "rider" ? SOS.riderStatuses : SOS.driverStatuses;
  return typeof out["status"] === "string" ? { ...out, sosAvailable: statuses.includes(out["status"]) } : out;
}

/** TripEta without legRoute (the driver's and the admin's copy of a location event). */
export function withoutLegRoute(eta: unknown): unknown {
  if (typeof eta !== "object" || eta === null || !("legRoute" in eta)) return eta;
  const { legRoute: _l, ...rest } = eta as Record<string, unknown>;
  void _l;
  return rest;
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
    // v0.18.171 (contract.json#googleRoadLines.riderEvent): eta.legRoute is the rider's only (streams and GET events).
    ...(row.eta ? { eta: viewer === "rider" ? row.eta : withoutLegRoute(row.eta) } : {}),
    ...(row.cancel_fee ? { cancelFee: row.cancel_fee } : {}),
    ...(row.message && !options.hideMessage ? { message: row.message } : {}),
    // v0.18.38 §62: call events carry the CallView as `call`, call_signal the relayed signal as `signal`.
    ...(row.call ? (row.kind === "call_signal" ? { signal: row.call } : { call: row.call }) : {}),
  };
}
