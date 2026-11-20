import { sql } from "kysely";
import type { Db } from "../db/db.js";
import { liveDocument } from "../config/service.js";
import { ApiError } from "../http/errors.js";
import { DRIVER_ASSIGNED, RIDER_ONBOARD, TERMINAL, type TripStatus } from "../rules/transitions.js";
import { readOwnTrip } from "./commands.js";

/**
 * Contract v0.18.144 (contract.json#liveLocation; owner 2026-11-20 "add share location on both app for rider and driver so
 * they see each others"): two-way live location during an active ride. PUT /trips/{tripId}/live-location relays one
 * point of one side to the other side's open trip streams (GET /trips/{tripId}/events?live=true, `event: live_location`).
 * Privacy (GDPR): a position is NEVER stored — no table, no trip event, no log line with a position. It travels only in
 * the NOTIFY payload of its own channel (not the trip event channel, so no stream re-reads the trip log: server CPU is
 * the launch bottleneck, audits/load). No Idempotency-Key row, no version bump.
 */
export const LIVE_LOCATION_CHANNEL = "movera_live_location";

/** contract.json#configDefaults (liveLocationShare false: off until the load test passes, supervisor 2026-11-20; adjustPickupMeters, liveLocationSendEverySeconds); fixed here so an older contract copy works. */
export const LIVE_LOCATION_DEFAULTS = { share: false, adjustPickupMeters: 30, sendEverySeconds: 8 } as const;

export type LiveLocationSetting = { share: boolean; adjustPickupMeters: number; sendEverySeconds: number };
type Doc = Record<string, unknown>;
const isObject = (value: unknown): value is Doc => typeof value === "object" && value !== null && !Array.isArray(value);
const intIn = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** The zone's setting from a rider document: the stored value, else the default (a bad value = the default). */
export function liveLocationSetting(document: Doc | null | undefined): LiveLocationSetting {
  const own = isObject(document?.["liveLocation"]) ? (document["liveLocation"] as Doc) : {};
  return {
    share: typeof own["share"] === "boolean" ? own["share"] : LIVE_LOCATION_DEFAULTS.share,
    adjustPickupMeters: own["adjustPickupMeters"] === 0 || intIn(own["adjustPickupMeters"], 10, 500) ? (own["adjustPickupMeters"] as number) : LIVE_LOCATION_DEFAULTS.adjustPickupMeters,
    sendEverySeconds: intIn(own["sendEverySeconds"], 5, 10) ? own["sendEverySeconds"] : LIVE_LOCATION_DEFAULTS.sendEverySeconds,
  };
}

/** Why a rider document's liveLocation is not valid (null = valid or absent). */
export function liveLocationProblem(document: unknown): string | null {
  if (!isObject(document) || !("liveLocation" in document)) return null;
  const own = document["liveLocation"];
  if (!isObject(own)) return "liveLocation must be an object { share, adjustPickupMeters, sendEverySeconds }";
  for (const key of Object.keys(own)) if (!["share", "adjustPickupMeters", "sendEverySeconds"].includes(key)) return `liveLocation.${key} is not a field`;
  if ("share" in own && typeof own["share"] !== "boolean") return "liveLocation.share must be true or false";
  if ("adjustPickupMeters" in own && own["adjustPickupMeters"] !== 0 && !intIn(own["adjustPickupMeters"], 10, 500)) return "liveLocation.adjustPickupMeters must be 0 (banner off) or a whole number 10-500";
  if ("sendEverySeconds" in own && !intIn(own["sendEverySeconds"], 5, 10)) return "liveLocation.sendEverySeconds must be a whole number 5-10";
  return null;
}

/** GET /rider/config: liveLocation is always served with its three keys. */
export function withLiveLocation(document: Doc): Doc {
  return { ...document, liveLocation: liveLocationSetting(document) };
}

export type LiveLocationBody = { sharing: boolean; lat?: number | undefined; lng?: number | undefined; accuracyM?: number | undefined };
export type LiveLocationFrame = { tripId: string; side: "rider" | "driver"; sharing: boolean; lat?: number; lng?: number; accuracyM?: number; at: string };

/**
 * The per-side send spacing, per server copy (a phone talks to one copy at a time; a retry on another copy at worst
 * lets one extra point through). Entries are dropped when they are older than a minute.
 */
const lastSend = new Map<string, number>();
function spacingCheck(key: string, nowMs: number, everySeconds: number): void {
  const last = lastSend.get(key);
  const minMs = (everySeconds - 1) * 1000;
  if (last !== undefined && nowMs - last < minMs) {
    throw new ApiError("rate_limited", "Too many location updates.", { reason: "live_location_too_often", retryAfterSeconds: Math.max(1, Math.ceil((minMs - (nowMs - last)) / 1000)) });
  }
  lastSend.set(key, nowMs);
  if (lastSend.size > 10_000) for (const [k, at] of lastSend) if (nowMs - at > 60_000) lastSend.delete(k);
}
/** Tests only. */
export function resetLiveLocationSpacing(): void {
  lastSend.clear();
}

export async function shareLiveLocation(
  db: Db,
  who: { actor: "rider" | "driver"; subjectId: string },
  tripId: string,
  body: LiveLocationBody,
  now: Date,
): Promise<{ sharing: boolean; sendEverySeconds: number }> {
  if (body.sharing && (body.lat === undefined || body.lng === undefined)) {
    throw new ApiError("invalid_request", "Send lat and lng with sharing true.", { reason: "invalid_body" });
  }
  const trip = await readOwnTrip(db, tripId, who);
  const status = trip.status as TripStatus;
  // contract.json#liveLocation.window: accept until the rider is on board (pickup); nothing is relayed after pickup.
  if (!DRIVER_ASSIGNED.has(status) || RIDER_ONBOARD.has(status) || TERMINAL.has(status)) {
    throw new ApiError("conflict", "Location sharing is only from accept until pickup.", { reason: "live_location_not_active" });
  }
  const setting = liveLocationSetting((await liveDocument<Doc>(db, "rider_app_config", trip.zone_id))?.document);
  if (!setting.share) throw new ApiError("conflict", "Location sharing is off in this area.", { reason: "live_location_off" });
  // Turning off always passes (so a stop is never refused); a point is spaced. A stop does not reset the spacing, so
  // on / off / on cannot send points faster than sendEverySeconds.
  if (body.sharing) spacingCheck(`${tripId}\u0000${who.actor}`, now.getTime(), setting.sendEverySeconds);
  const frame: LiveLocationFrame = {
    tripId,
    side: who.actor,
    sharing: body.sharing,
    ...(body.sharing ? { lat: body.lat!, lng: body.lng!, ...(body.accuracyM !== undefined ? { accuracyM: body.accuracyM } : {}) } : {}),
    at: now.toISOString(),
  };
  // Only a NOTIFY: nothing is written. Outside a transaction it is delivered at once.
  await sql`SELECT pg_notify(${LIVE_LOCATION_CHANNEL}, ${JSON.stringify(frame)})`.execute(db);
  return { sharing: body.sharing, sendEverySeconds: setting.sendEverySeconds };
}
