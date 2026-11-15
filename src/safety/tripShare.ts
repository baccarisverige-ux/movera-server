import { createHash, createHmac } from "node:crypto";
import { audit } from "../admin/audit.js";
import { liveDocument } from "../config/service.js";
import { shareTripOn } from "../config/shareTrip.js";
import { contract } from "../contract/contract.js";
import type { Db, Executor, Trx } from "../db/db.js";
import { lockTrip } from "../db/tripLog.js";
import { ApiError, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { TERMINAL, type TripStatus } from "../rules/transitions.js";
import { statusTarget } from "../trips/etaNow.js";
import { tripProjection } from "../trips/projection.js";

/**
 * Contract v0.18.116 §94 (contract.json#shareTrip; BQ-S10, owner 2026-11-02 Q1 "Build it for real", Rules
 * decisions/driver-g14.md:11, and the S10 answers Q1-Q7 of 2026-11-15): the rider's live trip link.
 *
 * Privacy rules this module keeps:
 * - Only the SHA-256 of a token is stored (trip_shares.token_hash). The token is made from the link's id with the
 *   server's secret (HMAC), so the stored idempotency answer needs no URL and a database copy opens no link.
 * - A token is never logged, never put in an error message and never written to the audit.
 * - The public answer is built field by field from the contract's allow-list (publicView), never from
 *   tripProjection (which carries addresses, names and money).
 */

type ShareContract = {
  statuses: string[];
  maxHours: number;
  retentionDays: number;
  link: { tokenPattern: string };
  public: { fields: string[]; car: string[]; phases: Record<string, string[]>; refreshSeconds: number; positionMaxAgeSeconds: number; positionLink: string };
  limits: { maxActivePerTrip: number; perAddressPerMinute: number; perTokenPerMinute: number };
  texts: Record<"sv" | "fr" | "en", Record<string, string>>;
};
export const SHARE = (contract as unknown as { shareTrip: ShareContract }).shareTrip;

const LIVE_STATUSES: ReadonlySet<string> = new Set(SHARE.statuses);
const PHASE_OF: Record<string, string> = Object.fromEntries(Object.entries(SHARE.public.phases).flatMap(([phase, statuses]) => statuses.map((status) => [status, phase])));
const TOKEN = new RegExp(SHARE.link.tokenPattern);
const HOUR_MS = 3_600_000;

/** The link's token: 128 bits from the link's id and the server's secret. Never stored, never logged. */
export function shareToken(secret: string, shareId: string): string {
  return createHmac("sha256", secret).update(`movera-trip-share-v1:${shareId}`).digest().subarray(0, 16).toString("base64url");
}
export const tokenHash = (token: string): Buffer => createHash("sha256").update(token).digest();
/** What a token looks like at all (22 base64url characters); anything else is a miss before any database work. */
export const looksLikeToken = (token: string): boolean => TOKEN.test(token);

export type ShareItem = { shareId: string; tripId: string; createdAt: string; expiresAt: string; endsAtDropoff: true };
type ShareRow = { share_id: string; trip_id: string; created_at: Date; expires_at: Date };
const itemOf = (row: ShareRow): ShareItem => ({ shareId: row.share_id, tripId: row.trip_id, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), endsAtDropoff: true });

/** A trip a link can be made for and read on: a driver is assigned and the rider is shown him (not a held booked ride). */
const shareable = (trip: { status: string; kind: string }): boolean => LIVE_STATUSES.has(trip.status) && !(trip.kind === "scheduled" && trip.status === "accepted");

/** The zone's switch: its live rider document (its own, else the country standard), else the default (on). */
export async function zoneShareOn(ex: Executor, zoneId: string): Promise<boolean> {
  return shareTripOn((await liveDocument<Record<string, unknown>>(ex, "rider_app_config", zoneId))?.document);
}

const liveRows = (ex: Executor, tripId: string, now: Date) =>
  ex.selectFrom("trip_shares").select(["share_id", "trip_id", "created_at", "expires_at"]).where("trip_id", "=", tripId).where("revoked_at", "is", null).where("expires_at", ">", now).orderBy("created_at").orderBy("share_id").execute();

async function ownTrip(trx: Trx, riderId: string, tripId: string) {
  const trip = await lockTrip(trx, tripId);
  if (trip.rider_id !== riderId) throw notFound("No such trip.", "trip_not_found");
  return trip;
}

/** POST /rider/trips/{tripId}/share. The answer has no url: the route adds it (so the idempotency store never holds it). */
export async function createShare(trx: Trx, riderId: string, tripId: string, secret: string, now: Date): Promise<ShareItem> {
  const trip = await ownTrip(trx, riderId, tripId);
  if (!shareable(trip)) throw new ApiError("invalid_transition", "A trip can be shared only while a driver is on it.", { reason: "trip_not_live", projection: tripProjection(trip, "rider") });
  if (!(await zoneShareOn(trx, trip.zone_id))) throw new ApiError("forbidden", "Trip sharing is switched off in this zone.", { reason: "share_trip_off" });
  const live = await liveRows(trx, tripId, now);
  if (live.length >= SHARE.limits.maxActivePerTrip) {
    throw new ApiError("invalid_transition", `A trip has at most ${SHARE.limits.maxActivePerTrip} live links. Stop sharing to make a new one.`, { reason: "too_many_shares", projection: tripProjection(trip, "rider") });
  }
  const shareId = newId("shr", now.getTime());
  const row = { share_id: shareId, trip_id: tripId, created_at: now, expires_at: new Date(now.getTime() + SHARE.maxHours * HOUR_MS) };
  await trx.insertInto("trip_shares").values({ ...row, token_hash: tokenHash(shareToken(secret, shareId)), rider_id: riderId, zone_id: trip.zone_id }).execute();
  await audit(trx, { adminId: null, action: "trip.share_started", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { tripId, count: live.length + 1 }, at: now });
  return itemOf(row);
}

/** GET /rider/trips/{tripId}/share: the links that still work, oldest first. Never a url. */
export async function listShares(db: Db, riderId: string, tripId: string, now: Date): Promise<{ items: ShareItem[] }> {
  const trip = await db.selectFrom("trips").select(["rider_id", "status", "kind", "zone_id"]).where("trip_id", "=", tripId).executeTakeFirst();
  if (trip === undefined || trip.rider_id !== riderId) throw notFound("No such trip.", "trip_not_found");
  if (!shareable(trip) || !(await zoneShareOn(db, trip.zone_id))) return { items: [] };
  return { items: (await liveRows(db, tripId, now)).map(itemOf) };
}

/** DELETE /rider/trips/{tripId}/share: every live link of the trip ends now. */
export async function revokeShares(trx: Trx, riderId: string, tripId: string, now: Date): Promise<void> {
  const trip = await ownTrip(trx, riderId, tripId);
  const ended = await trx.updateTable("trip_shares").set({ revoked_at: now }).where("trip_id", "=", tripId).where("revoked_at", "is", null).where("expires_at", ">", now).returning("share_id").execute();
  if (ended.length > 0) await audit(trx, { adminId: null, action: "trip.share_stopped", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { tripId, count: ended.length }, at: now });
}

/** contract.json#shareTrip.public: PublicTripShare. Every field is named here; nothing else can leave. */
export type PublicShare = {
  state: "live";
  phase: string;
  car: { make: string; model: string; color: string; plate: string };
  eta: { minutes: number; target: "pickup" | "dropoff"; arriveAround: string } | null;
  position: { lat: number; lng: number; at: string } | null;
  updatedAt: string;
  refreshSeconds: number;
};
export type ShareRead = { state: "live"; view: PublicShare; country: string; timeZone: string } | { state: "ended"; country: string } | { state: "not_found" };

const text = (value: unknown): string => (typeof value === "string" ? value.slice(0, 80) : "");
const round5 = (value: number): number => Math.round(value * 1e5) / 1e5;
/** HH:MM in the zone's time zone. */
export function clockTime(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
}

/**
 * The public read of one token. One query; the end of the link is decided here, when it is read: a terminal trip
 * (drop-off, any cancel, no-show, expired, failed), a stopped link, the zone's switch off, or the 6 h cap.
 */
export async function readShare(db: Db, token: string, now: Date): Promise<ShareRead> {
  if (!looksLikeToken(token)) return { state: "not_found" };
  const row = await db
    .selectFrom("trip_shares as s")
    .innerJoin("trips as t", "t.trip_id", "s.trip_id")
    .innerJoin("zones as z", "z.zone_id", "t.zone_id")
    .leftJoin("driver_locations as l", "l.driver_id", "t.driver_id")
    .select(["s.share_id", "s.expires_at", "s.revoked_at", "t.status", "t.kind", "t.driver_id", "t.zone_id", "t.driver_summary", "t.eta", "z.country", "z.time_zone", "l.lat", "l.lng", "l.measured_at"])
    .where("s.token_hash", "=", tokenHash(token))
    .executeTakeFirst();
  if (row === undefined) return { state: "not_found" };
  const ended: ShareRead = { state: "ended", country: row.country };
  if (row.revoked_at !== null || row.expires_at.getTime() <= now.getTime() || TERMINAL.has(row.status as TripStatus)) return ended;
  if (!(await zoneShareOn(db, row.zone_id))) {
    // Kept: a link seen while the switch is off stays ended when the switch is turned on again.
    await db.updateTable("trip_shares").set({ revoked_at: now }).where("share_id", "=", row.share_id).where("revoked_at", "is", null).execute();
    return ended;
  }
  // No driver on the trip right now (he cancelled and a new search runs): nothing to show, but not ended for good.
  if (row.driver_id === null || !shareable(row)) return ended;

  const vehicle = ((row.driver_summary as { vehicle?: Record<string, unknown> } | null)?.vehicle ?? {}) as Record<string, unknown>;
  const target = statusTarget(row.status);
  const stored = row.eta as { etaSeconds?: unknown; target?: unknown; at?: unknown } | null;
  let eta: PublicShare["eta"] = null;
  if (target !== null && stored && stored.target === target && typeof stored.etaSeconds === "number" && typeof stored.at === "string" && Number.isFinite(Date.parse(stored.at))) {
    const left = Math.max(0, stored.etaSeconds - (now.getTime() - Date.parse(stored.at)) / 1000);
    eta = { minutes: Math.max(1, Math.ceil(left / 60)), target, arriveAround: clockTime(new Date(now.getTime() + left * 1000), row.time_zone) };
  }
  const fresh = row.measured_at !== null && row.lat !== null && row.lng !== null && now.getTime() - row.measured_at.getTime() <= SHARE.public.positionMaxAgeSeconds * 1000;
  const view: PublicShare = {
    state: "live",
    phase: PHASE_OF[row.status]!,
    car: { make: text(vehicle["make"]), model: text(vehicle["model"]), color: text(vehicle["color"]), plate: text(vehicle["plate"]) },
    eta,
    position: fresh ? { lat: round5(row.lat!), lng: round5(row.lng!), at: row.measured_at!.toISOString() } : null,
    updatedAt: now.toISOString(),
    refreshSeconds: SHARE.public.refreshSeconds,
  };
  return { state: "live", view, country: row.country, timeZone: row.time_zone };
}
