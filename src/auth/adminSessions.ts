import type { Principal } from "./guard.js";
import { adminCoversZone } from "./guard.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, notFound } from "../http/errors.js";
import { audit } from "../admin/audit.js";
import { riderInZones, zonesOf } from "../admin/lists.js";
import { scheduleTimer } from "../jobs/timers.js";
import { NOT_HELD } from "../reservations/view.js";
import { DRIVER_ASSIGNED } from "../rules/transitions.js";
import { contract } from "../contract/contract.js";
import { sessionsRevoked } from "./sessionCache.js";

/**
 * Contract v0.18.149 (owner decisions/driver-g12.md Q6 "Real, riders + drivers (Recommended)", contract.json#adminSessions):
 * an admin sees the signed-in sessions of one rider or driver and signs one or all of them out with a reason.
 *
 * The list shows only what the server already keeps and nothing that locates the person: the app, a device label and
 * platform read from the sign-in's user agent (the push registration's platform wins), the app version of the push
 * registration, last seen (the last refresh, else the sign-in) and created. Never the address (auth_sessions.ip), the
 * raw user agent or a place.
 *
 * Sign-out ends the sessions (revoked_reason signed_out_by_movera), expires their refresh tokens and forgets their push
 * devices, then goes through sessionsRevoked (movera-server#306) so every server copy forgets them at once. The next
 * call and the next refresh of that phone answer 401 reason signed_out_by_movera (auth.signedOut.byMoveraTexts). A
 * driver with a current trip is refused like his own sign-out (409 sign_out_on_trip, auth.signOutOnTrip): he is
 * signed out only after the trip ends. A free driver left with no session is set offline and his offers withdrawn.
 */

export const SIGNED_OUT_BY_MOVERA = "signed_out_by_movera";
const REASON_MAX = 500;

export type SessionSubject = { actor: "rider" | "driver"; subjectId: string };
export type AdminSessionView = { sessionId: string; app: "rider" | "driver"; device: string | null; platform: "ios" | "android" | "web" | "unknown"; appVersion: string | null; lastSeenAt: string; createdAt: string };

/** A short device label and platform from a user agent; null / unknown when it says nothing useful (e.g. "Dart/3.5"). */
export function deviceOf(userAgent: string | null): { device: string | null; platform: AdminSessionView["platform"] } {
  const ua = userAgent ?? "";
  if (/iPad/.test(ua)) return { device: "iPad", platform: "ios" };
  if (/iPhone|iOS|CFNetwork|Darwin/.test(ua)) return { device: "iPhone", platform: "ios" };
  if (/Android/.test(ua)) return { device: "Android phone", platform: "android" };
  if (/Mozilla\//.test(ua)) return { device: "Web browser", platform: "web" };
  return { device: null, platform: "unknown" };
}

/** 403 zone_out_of_scope unless the admin may see this person (the same rules as the other admin people routes). */
export async function assertSubjectInScope(ex: Executor, who: Principal, subject: SessionSubject): Promise<{ zoneId: string | null }> {
  if (subject.actor === "driver") {
    const row = await ex.selectFrom("drivers").select(["driver_id", "zone_ids"]).where("driver_id", "=", subject.subjectId).executeTakeFirst();
    if (row === undefined) throw notFound("No such driver.", "driver_not_found");
    if (!who.zones.includes("*") && !row.zone_ids.some((z) => adminCoversZone(who, z))) throw new ApiError("forbidden", "This driver is outside your zones.", { reason: "zone_out_of_scope" });
    return { zoneId: row.zone_ids[0] ?? null };
  }
  const row = await ex.selectFrom("riders").select("rider_id").where("rider_id", "=", subject.subjectId).executeTakeFirst();
  if (row === undefined) throw notFound("No such rider.", "rider_not_found");
  const zones = zonesOf(who);
  if (zones) {
    const seen = await ex.selectFrom("riders").select("rider_id").where("rider_id", "=", subject.subjectId).where(riderInZones(zones)).executeTakeFirst();
    if (!seen) throw new ApiError("forbidden", "This rider has not ridden in your zones.", { reason: "zone_out_of_scope" });
  }
  return { zoneId: null };
}

/** The person's active sessions (neither ended nor expired), newest first. */
export async function activeSessions(ex: Executor, subject: SessionSubject, now: Date): Promise<AdminSessionView[]> {
  const rows = await ex
    .selectFrom("auth_sessions")
    .select(["session_id", "user_agent", "created_at", "last_refresh_at"])
    .where("actor", "=", subject.actor)
    .where("subject_id", "=", subject.subjectId)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", now)
    .orderBy("created_at", "desc")
    .orderBy("session_id", "desc")
    .limit(50)
    .execute();
  if (rows.length === 0) return [];
  const pushes = await ex.selectFrom("push_devices").select(["session_id", "platform", "app_version", "updated_at"]).where("session_id", "in", rows.map((r) => r.session_id)).orderBy("updated_at", "desc").execute();
  return rows.map((r) => {
    const push = pushes.find((p) => p.session_id === r.session_id);
    const guess = deviceOf(r.user_agent);
    const lastSeen = r.last_refresh_at !== null && r.last_refresh_at > r.created_at ? r.last_refresh_at : r.created_at;
    return {
      sessionId: r.session_id,
      app: subject.actor,
      device: guess.device,
      platform: push?.platform ?? guess.platform,
      appVersion: push?.app_version ?? null,
      lastSeenAt: lastSeen.toISOString(),
      createdAt: r.created_at.toISOString(),
    };
  });
}

export type SignOutBody = { sessionId?: string | undefined; all?: boolean | undefined; reason?: string | undefined };

/** `reason` 1–500 characters after trimming, else 400 invalid_request / reason_required. */
export function signOutReason(body: SignOutBody): string {
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 1 || reason.length > REASON_MAX) throw new ApiError("invalid_request", `Write why (1 to ${REASON_MAX} characters).`, { reason: "reason_required" });
  return reason;
}

type SignOutOnTrip = { reason: string };
const SIGN_OUT_ON_TRIP = (contract as unknown as { auth: { signOutOnTrip: SignOutOnTrip } }).auth.signOutOnTrip;

/**
 * POST /admin/{riders|drivers}/{id}/sessions/sign-out { sessionId | all: true, reason }: inside runIdempotent's
 * transaction. Returns how many sessions ended and the sessions left.
 */
export async function adminSignOutSessions(trx: Trx, who: Principal, subject: SessionSubject, body: SignOutBody, now: Date): Promise<{ signedOut: number; items: AdminSessionView[] }> {
  const { zoneId } = await assertSubjectInScope(trx, who, subject);
  const reason = signOutReason(body);
  const all = body.all === true;
  if (all === (body.sessionId !== undefined)) throw new ApiError("invalid_request", "Send either sessionId or all: true.", { reason: "session_or_all" });
  let driver: { online_status: string; version: number } | undefined;
  if (subject.actor === "driver") {
    // Lock the driver row (as his own sign-out does), then refuse while he has a current trip.
    driver = await trx.selectFrom("drivers").select(["online_status", "version"]).where("driver_id", "=", subject.subjectId).forUpdate().executeTakeFirst();
    const trip = await trx.selectFrom("trips").select("trip_id").where("driver_id", "=", subject.subjectId).where("status", "in", [...DRIVER_ASSIGNED]).where(NOT_HELD).executeTakeFirst();
    if (trip !== undefined) throw new ApiError("conflict", "The driver is on a trip. Sign him out after the trip ends.", { reason: SIGN_OUT_ON_TRIP.reason });
  }
  let q = trx
    .updateTable("auth_sessions")
    .set({ revoked_at: now, revoked_reason: SIGNED_OUT_BY_MOVERA })
    .where("actor", "=", subject.actor)
    .where("subject_id", "=", subject.subjectId)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", now);
  if (!all) q = q.where("session_id", "=", body.sessionId!);
  const ended = (await q.returning("session_id").execute()).map((r) => r.session_id);
  if (!all && ended.length === 0) throw notFound("No such signed-in session for this person.", "session_not_found");
  // `all: true` that ends nothing changes nothing: no audit row, no NOTIFY, no offline step.
  if (ended.length === 0) return { signedOut: 0, items: await activeSessions(trx, subject, now) };
  await trx.updateTable("refresh_tokens").set({ expires_at: now }).where("session_id", "in", ended).where("expires_at", ">", now).execute();
  await trx.deleteFrom("push_devices").where("session_id", "in", ended).execute();
  // movera-server#306: the one revoke path of the session check cache (forget here, NOTIFY every copy at commit).
  await sessionsRevoked(trx, ended);
  const left = await activeSessions(trx, subject, now);
  if (subject.actor === "driver" && driver?.online_status === "online" && left.length === 0) {
    // Like "signed in elsewhere": a free driver with no phone left goes offline and his offers are withdrawn.
    await trx.updateTable("drivers").set({ online_status: "offline", online_since: null, version: driver.version + 1, updated_at: now }).where("driver_id", "=", subject.subjectId).execute();
    await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: subject.subjectId, dueAt: now, payload: {} });
  }
  await audit(trx, { adminId: who.subjectId, action: `${subject.actor}.sessions_sign_out`, targetType: subject.actor, targetId: subject.subjectId, zoneId, detail: { reason, all, sessionIds: ended }, at: now });
  return { signedOut: ended.length, items: left };
}
