import type { Selectable } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import type { TripCallsTable } from "../db/schema.js";
import { appendTripEvent, type TripRow } from "../db/tripLog.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { cancelTimer, scheduleTimer, type TimerHandler } from "../jobs/timers.js";
import { DRIVER_ASSIGNED, type TripStatus } from "../rules/transitions.js";
import { tripProjection } from "../trips/projection.js";
import { callSettingsFor, iceServers, type CallSettings } from "./settings.js";

/**
 * v0.18.38 §62 (fix job 8, contract.json#inAppCalls; owner G15 2026-11-05 "In-app calls only", "Both rider and driver",
 * "Just 'Call failed'"): in-app (WebRTC) calls between a trip's rider and driver. The server keeps each call in
 * trip_calls and relays the offer / answer / ICE candidates as trip events; audio never passes the server.
 *
 * Rule 33: no call state lives in this copy's memory. Each step locks the call row (FOR UPDATE); "one live call per
 * trip" is a unique index; the ring timeout and the length limit are database timers any copy runs.
 */

export type Side = "rider" | "driver";
export type CallWho = { actor: Side; subjectId: string };
type CallRow = Selectable<TripCallsTable>;
export type CallView = {
  callId: string; tripId: string; from: Side; to: Side; state: CallRow["state"];
  startedAt: string; answeredAt: string | null; endedAt: string | null; endedReason: string | null; seconds: number;
};

export const CALL_RING_TIMEOUT = "call_ring_timeout";
export const CALL_MAX_LENGTH = "call_max_length";
const LIVE = ["ringing", "answered"] as const;

export function callView(row: CallRow): CallView {
  const seconds = row.answered_at && row.ended_at ? Math.max(0, Math.round((row.ended_at.getTime() - row.answered_at.getTime()) / 1000)) : 0;
  return {
    callId: row.call_id, tripId: row.trip_id, from: row.caller, to: row.callee, state: row.state,
    startedAt: row.started_at.toISOString(), answeredAt: row.answered_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null, endedReason: row.ended_reason, seconds,
  };
}

/** contract.json#inAppCalls.window: from driver assignment until callWindowAfterTripMin after a completed drop-off. */
export function callWindowOpen(trip: Pick<TripRow, "driver_id" | "status" | "ended_at">, settings: CallSettings, now: Date): boolean {
  if (trip.driver_id === null) return false;
  if (DRIVER_ASSIGNED.has(trip.status as TripStatus)) return true;
  if (trip.status !== "completed" || trip.ended_at === null) return false;
  return now.getTime() <= trip.ended_at.getTime() + settings.callWindowAfterTripMin * 60_000;
}

export function assertCallAllowed(trip: TripRow, who: CallWho, settings: CallSettings, now: Date): void {
  if (!settings.on) throw new ApiError("forbidden", "Calls are switched off.", { reason: "calls_off" });
  if (!callWindowOpen(trip, settings, now)) {
    throw new ApiError("invalid_transition", "Calls are open during the trip and for a while after drop-off.", { reason: "call_window_closed", projection: tripProjection(trip, who.actor) });
  }
}

/** POST /trips/{tripId}/call, mode in_app: the caller holds the trip lock (lockOwnTrip). */
export async function startInAppCall(trx: Trx, trip: TripRow, who: CallWho, settings: CallSettings, now: Date) {
  const live = await trx.selectFrom("trip_calls").select("call_id").where("trip_id", "=", trip.trip_id).where("state", "in", LIVE).executeTakeFirst();
  if (live) throw new ApiError("invalid_transition", "A call is already going on for this trip.", { reason: "call_busy", details: [live.call_id] });
  const callId = newId("cll", now.getTime());
  const row = await trx.insertInto("trip_calls").values({
    call_id: callId, trip_id: trip.trip_id, caller: who.actor, callee: who.actor === "rider" ? "driver" : "rider", state: "ringing", started_at: now,
  }).returningAll().executeTakeFirstOrThrow();
  await appendTripEvent(trx, { tripId: trip.trip_id, kind: "call_ringing", version: trip.version, occurredAt: now, call: callView(row) });
  await scheduleTimer(trx, { kind: CALL_RING_TIMEOUT, refId: callId, dueAt: new Date(now.getTime() + settings.ringSeconds * 1000) });
  const expiresAt = new Date(now.getTime() + settings.maxCallMin * 60_000);
  const ttl = Math.round((expiresAt.getTime() - now.getTime()) / 1000) + settings.ringSeconds;
  return {
    tripId: trip.trip_id, mode: "in_app" as const, callId, ice: iceServers(callId, now, ttl),
    ringSeconds: settings.ringSeconds, maxCallMin: settings.maxCallMin, expiresAt: expiresAt.toISOString(),
  };
}

/** The call, locked, with its trip; 404 unless the caller is the trip's rider or driver. */
async function lockOwnCall(trx: Trx, callId: string, who: CallWho): Promise<{ row: CallRow; trip: TripRow }> {
  const row = await trx.selectFrom("trip_calls").selectAll().where("call_id", "=", callId).forUpdate().executeTakeFirst();
  const trip = row ? await trx.selectFrom("trips").selectAll().where("trip_id", "=", row.trip_id).executeTakeFirst() : undefined;
  const owns = trip !== undefined && (who.actor === "rider" ? trip.rider_id === who.subjectId : trip.driver_id === who.subjectId);
  if (!row || !trip || !owns) throw new ApiError("not_found", "No such call.", { reason: "call_not_found" });
  return { row, trip };
}

const notLive = (_row: CallRow) => new ApiError("invalid_transition", "This call is over.", { reason: "call_not_live" });

async function finish(trx: Trx, row: CallRow, trip: TripRow, state: "ended" | "missed", reason: string, now: Date): Promise<CallView> {
  const done = await trx.updateTable("trip_calls").set({ state, ended_at: now, ended_reason: reason }).where("call_id", "=", row.call_id).returningAll().executeTakeFirstOrThrow();
  await cancelTimer(trx, CALL_RING_TIMEOUT, row.call_id);
  await cancelTimer(trx, CALL_MAX_LENGTH, row.call_id);
  const view = callView(done);
  await appendTripEvent(trx, { tripId: trip.trip_id, kind: state === "missed" ? "call_missed" : "call_ended", version: trip.version, occurredAt: now, call: view });
  return view;
}

/** POST /calls/{callId}/answer: only the callee, only while ringing. */
export async function answerCall(trx: Trx, who: CallWho, callId: string, now: Date): Promise<CallView> {
  const { row, trip } = await lockOwnCall(trx, callId, who);
  if (row.state !== "ringing" || row.callee !== who.actor) throw notLive(row);
  const settings = await callSettingsFor(trx, trip.zone_id);
  const answered = await trx.updateTable("trip_calls").set({ state: "answered", answered_at: now }).where("call_id", "=", callId).returningAll().executeTakeFirstOrThrow();
  await cancelTimer(trx, CALL_RING_TIMEOUT, callId);
  await scheduleTimer(trx, { kind: CALL_MAX_LENGTH, refId: callId, dueAt: new Date(now.getTime() + settings.maxCallMin * 60_000) });
  const view = callView(answered);
  await appendTripEvent(trx, { tripId: trip.trip_id, kind: "call_answered", version: trip.version, occurredAt: now, call: view });
  return view;
}

const END_REASONS = new Set(["hangup", "declined", "failed"]);
/** POST /calls/{callId}/end { reason }: either side; a call already over answers its CallView again. */
export async function endCall(trx: Trx, who: CallWho, callId: string, body: unknown, now: Date): Promise<CallView> {
  const reason = (body as { reason?: unknown } | null)?.reason;
  if (typeof reason !== "string" || !END_REASONS.has(reason)) throw badRequest("reason must be hangup, declined or failed.", "invalid_body");
  const { row, trip } = await lockOwnCall(trx, callId, who);
  if (row.state === "ended" || row.state === "missed") return callView(row);
  return finish(trx, row, trip, "ended", reason, now);
}

const SIGNAL_TYPES = new Set(["offer", "answer", "ice"]);
/** POST /calls/{callId}/signal: relayed as call_signal to the other side's stream. */
export async function relaySignal(trx: Trx, who: CallWho, callId: string, body: unknown, now: Date): Promise<void> {
  const b = (body ?? {}) as { type?: unknown; sdp?: unknown; candidate?: unknown };
  if (typeof b.type !== "string" || !SIGNAL_TYPES.has(b.type)) throw badRequest("type must be offer, answer or ice.", "invalid_body");
  if (b.sdp !== undefined && (typeof b.sdp !== "string" || b.sdp.length > 20000)) throw badRequest("sdp is not valid.", "invalid_body");
  const c = b.candidate as { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown } | undefined;
  if (c !== undefined && (typeof c !== "object" || c === null || typeof c.candidate !== "string" || c.candidate.length > 2000)) throw badRequest("candidate is not valid.", "invalid_body");
  if (b.type === "ice" ? c === undefined : typeof b.sdp !== "string") throw badRequest("An offer or answer needs sdp; ice needs candidate.", "invalid_body");
  const { row, trip } = await lockOwnCall(trx, callId, who);
  if (row.state !== "ringing" && row.state !== "answered") throw notLive(row);
  const signal = {
    callId, from: who.actor, type: b.type,
    ...(typeof b.sdp === "string" ? { sdp: b.sdp } : {}),
    ...(c ? { candidate: { candidate: c.candidate, ...(c.sdpMid !== undefined ? { sdpMid: typeof c.sdpMid === "string" ? c.sdpMid : null } : {}), ...(c.sdpMLineIndex !== undefined ? { sdpMLineIndex: typeof c.sdpMLineIndex === "number" ? c.sdpMLineIndex : null } : {}) } } : {}),
  };
  await appendTripEvent(trx, { tripId: trip.trip_id, kind: "call_signal", version: trip.version, occurredAt: now, call: signal });
}

/** GET /admin/trips/{tripId}/calls: the caller checked the admin's permission and zone (adminTrip). Newest first. */
export async function tripCallLog(ex: Executor, tripId: string): Promise<{ items: CallView[] }> {
  const rows = await ex.selectFrom("trip_calls").selectAll().where("trip_id", "=", tripId).orderBy("started_at", "desc").execute();
  return { items: rows.map(callView) };
}

/** Database timers (any server copy): not answered in ringSeconds → missed; answered past maxCallMin → ended. */
const timeout = (from: "ringing" | "answered"): TimerHandler => async (trx, timer) => {
  const row = await trx.selectFrom("trip_calls").selectAll().where("call_id", "=", timer.refId).forUpdate().executeTakeFirst();
  if (!row || row.state !== from) return;
  const trip = await trx.selectFrom("trips").selectAll().where("trip_id", "=", row.trip_id).executeTakeFirstOrThrow();
  await finish(trx, row, trip, from === "ringing" ? "missed" : "ended", from === "ringing" ? "missed" : "max_length", timer.firedAt);
};
export const callHandlers: Record<string, TimerHandler> = { [CALL_RING_TIMEOUT]: timeout("ringing"), [CALL_MAX_LENGTH]: timeout("answered") };
