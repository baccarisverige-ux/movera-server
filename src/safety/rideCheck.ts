import { sql, type Selectable } from "kysely";
import type { Trx } from "../db/db.js";
import type { RideChecksTable } from "../db/schema.js";
import { lockTrip, type TripRow } from "../db/tripLog.js";
import { lockTripNow } from "../dispatch/runtime.js";
import { ApiError, notFound } from "../http/errors.js";
import { cancelTimer, scheduleTimer, type TimerHandler } from "../jobs/timers.js";
import { tripProjection } from "../trips/projection.js";
import { appendIncidentEvent, ESCALATE_MS, INCIDENT_ESCALATE, openIncident, openOf, SAFETY, type IncidentRow } from "./incidents.js";
import { rideCheckSettings } from "../trips/onTripSettings.js";
import { sendRideCheckEvent, type ServerRideCheck } from "./rideCheckServer.js";

/**
 * Ride check answers (contract v0.12.0 §22, owner safety part 2 decisions 2026-10-28).
 *
 * The apps open the "Is everything OK?" card themselves and report each check: once when it shows (no answer), once
 * with the answer. ok is only kept here (ride_checks, on the trip). need_help opens or joins the trip's one open
 * ride_check incident with the alarm (rings like an SOS, escalates after 2 minutes untaken). A shown check with no
 * answer within noAnswerSeconds opens that incident without the alarm (the cases list, no sound, never escalated).
 */

type RideCheckRules = { noAnswerSeconds: number; riderStatuses: string[]; driverStatuses: string[]; completedWithinMinutes: number };
const RULES = (SAFETY as unknown as { rideCheck: RideCheckRules }).rideCheck;
export const RIDE_CHECK_NO_ANSWER = "ride_check_no_answer";
/** The contract's default; v0.18.9: each zone's DriverAppConfig.rideCheck.noAnswerSeconds is used (contract.json#onTrip.rideCheck). */
export const NO_ANSWER_MS = RULES.noAnswerSeconds * 1000;
const KIND = "ride_check";

type Side = "rider" | "driver";
type Answer = "ok" | "need_help";
type Position = { lat: number; lng: number; accuracyM?: number; at: string };
export type RideCheckBody = { checkId: string; trigger: string; at: string; answer?: Answer | undefined; position?: Position | undefined };
type CheckRow = Selectable<RideChecksTable>;

const timerRef = (tripId: string, side: Side, checkId: string) => `${tripId}|${side}|${checkId}`;

/** v0.18.9: the trip's current server check (TripProjection.rideCheck), when this report answers it. */
const serverCheckOf = (trip: TripRow, checkId: string): ServerRideCheck | null => {
  const check = trip.ride_check as ServerRideCheck | null;
  return check && check.checkId === checkId ? check : null;
};

function mayReport(trip: TripRow, side: Side, now: Date, checkId?: string): boolean {
  // v0.18.9: a server check may be answered within completedWithinMinutes of the end, whatever ended the trip.
  if (checkId && serverCheckOf(trip, checkId)) {
    return trip.ended_at === null || now.getTime() - trip.ended_at.getTime() <= RULES.completedWithinMinutes * 60_000;
  }
  const statuses = side === "rider" ? RULES.riderStatuses : RULES.driverStatuses;
  if (!statuses.includes(trip.status)) return false;
  if (trip.status !== "completed") return true;
  return trip.ended_at !== null && now.getTime() - trip.ended_at.getTime() <= RULES.completedWithinMinutes * 60_000;
}

function rideCheckOf(check: CheckRow, answer: "need_help" | "no_answer", answerSeconds?: number) {
  const out: Record<string, unknown> = { checkId: check.check_id, trigger: check.trigger, by: check.side, answer };
  // G7 live fix: the time the person had to answer (the zone's noAnswerSeconds when asked), for the admin's case text.
  if (answer === "no_answer" && answerSeconds !== undefined) out["answerSeconds"] = answerSeconds;
  if (check.shown_at) out["shownAt"] = check.shown_at.toISOString();
  if (answer === "need_help" && check.answered_at) out["answeredAt"] = check.answered_at.toISOString();
  return out;
}

async function updateIncident(trx: Trx, incident: IncidentRow, set: { alarm?: boolean; raised_by?: "rider" | "driver"; rideCheck: Record<string, unknown>; position?: Position | undefined }, now: Date) {
  const updated = await trx
    .updateTable("incidents")
    .set({
      version: sql`version + 1`,
      updated_at: now,
      ride_check: JSON.stringify(set.rideCheck),
      ...(set.alarm !== undefined ? { alarm: set.alarm } : {}),
      ...(set.raised_by ? { raised_by: set.raised_by } : {}),
      ...(set.position && !incident.position ? { position: JSON.stringify(set.position) } : {}),
    })
    .where("incident_id", "=", incident.incident_id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await appendIncidentEvent(trx, updated, "incident_updated", now);
  return updated;
}

/** need_help: open the trip's ride_check incident with the alarm, turn a silent one into an alarm, or join an alarm one. */
async function raiseHelp(trx: Trx, trip: TripRow, check: CheckRow, position: Position | undefined, now: Date): Promise<string> {
  const open = await openOf(trx, trip.trip_id, KIND);
  if (!open) {
    const row = await openIncident(trx, trip, { kind: KIND, raisedBy: check.side, position, alarm: true, rideCheck: rideCheckOf(check, "need_help") }, now);
    return row.incident_id;
  }
  if (!open.alarm) {
    await updateIncident(trx, open, { alarm: true, raised_by: check.side, rideCheck: rideCheckOf(check, "need_help"), position }, now);
    if (open.status === "open") await scheduleTimer(trx, { kind: INCIDENT_ESCALATE, refId: open.incident_id, dueAt: new Date(now.getTime() + ESCALATE_MS) });
  }
  return open.incident_id;
}

export async function reportRideCheck(trx: Trx, who: { actor: Side; subjectId: string }, tripId: string, body: RideCheckBody, now: Date) {
  const trip = await lockTrip(trx, tripId);
  const own = who.actor === "rider" ? trip.rider_id === who.subjectId : trip.driver_id === who.subjectId;
  if (!own) throw notFound("No such trip.", "trip_not_found");
  if (!mayReport(trip, who.actor, now, body.checkId)) {
    throw new ApiError("invalid_transition", "Ride check works only during the trip.", { reason: "trip_not_live", projection: tripProjection(trip, who.actor) });
  }
  let check = await trx.selectFrom("ride_checks").selectAll().where("trip_id", "=", tripId).where("side", "=", who.actor).where("check_id", "=", body.checkId).executeTakeFirst();
  const position = body.position;
  if (!check) {
    check = await trx
      .insertInto("ride_checks")
      .values({
        trip_id: tripId,
        side: who.actor,
        check_id: body.checkId,
        trigger: body.trigger,
        subject_id: who.subjectId,
        shown_at: body.answer ? null : now,
        position: position ? JSON.stringify(position) : null,
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (!body.answer) {
      const seconds = (await rideCheckSettings(trx, trip.zone_id)).noAnswerSeconds;
      await scheduleTimer(trx, { kind: RIDE_CHECK_NO_ANSWER, refId: timerRef(tripId, who.actor, body.checkId), dueAt: new Date(now.getTime() + seconds * 1000) });
    }
  }

  const next: Answer | null = body.answer === undefined ? check.answer : check.answer === "need_help" ? "need_help" : body.answer;
  if (next !== check.answer) {
    await cancelTimer(trx, RIDE_CHECK_NO_ANSWER, timerRef(tripId, who.actor, body.checkId));
    check = await trx
      .updateTable("ride_checks")
      .set({ answer: next, answered_at: now, ...(position && !check.position ? { position: JSON.stringify(position) } : {}) })
      .where("trip_id", "=", tripId)
      .where("side", "=", who.actor)
      .where("check_id", "=", body.checkId)
      .returningAll()
      .executeTakeFirstOrThrow();
    let incidentId = check.incident_id;
    if (next === "need_help") {
      incidentId = await raiseHelp(trx, trip, check, position ?? (check.position as Position | null) ?? undefined, now);
    } else if (check.no_answer_at && check.incident_id) {
      // ok after the no-answer case opened: keep it on the case; the admin closes it.
      const incident = await trx.selectFrom("incidents").selectAll().where("incident_id", "=", check.incident_id).forUpdate().executeTakeFirst();
      const rc = incident?.ride_check as Record<string, unknown> | null | undefined;
      if (incident && (incident.status === "open" || incident.status === "investigating") && rc && rc["checkId"] === check.check_id && rc["by"] === check.side && rc["answer"] === "no_answer") {
        await updateIncident(trx, incident, { rideCheck: { ...rc, lateAnswer: "ok", answeredAt: now.toISOString() } }, now);
      }
    }
    // v0.18.9: the answer to a server check shows on the trip for both apps and the admin (no version change).
    const server = serverCheckOf(trip, body.checkId);
    if (server && next) {
      await trx.updateTable("trips").set({ ride_check: JSON.stringify({ ...server, answers: { ...server.answers, [who.actor]: next } }) }).where("trip_id", "=", tripId).execute();
      await sendRideCheckEvent(trx, tripId, now);
    }
    if (incidentId !== check.incident_id) {
      check = await trx
        .updateTable("ride_checks")
        .set({ incident_id: incidentId })
        .where("trip_id", "=", tripId)
        .where("side", "=", who.actor)
        .where("check_id", "=", body.checkId)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
  }
  return receiptOf(check, now);
}

function receiptOf(check: CheckRow, now: Date) {
  const out: Record<string, unknown> = { checkId: check.check_id, tripId: check.trip_id, receivedAt: now.toISOString() };
  if (check.answer) out["answer"] = check.answer;
  if (check.incident_id) out["incidentId"] = check.incident_id;
  return out;
}

/** Two minutes after the card showed, still no answer: open (or join) the trip's ride_check case without the alarm. */
export const noAnswerHandler: TimerHandler = async (trx, timer) => {
  const [tripId, side, checkId] = timer.refId.split("|") as [string, Side, string];
  const trip = await lockTripNow(trx, tripId);
  if (!trip) return;
  const check = await trx.selectFrom("ride_checks").selectAll().where("trip_id", "=", tripId).where("side", "=", side).where("check_id", "=", checkId).executeTakeFirst();
  if (!check || check.answer !== null || check.no_answer_at !== null) return;
  const now = timer.firedAt;
  const open = await openOf(trx, tripId, KIND);
  // v0.18.9 (contract.json#onTrip.rideCheck): the zone's noAnswerAlarm (default false = the safety list without sound, as v0.12.0).
  const zoneRules = await rideCheckSettings(trx, trip.zone_id);
  const alarm = zoneRules.noAnswerAlarm;
  const pos = (typeof check.position === "string" ? JSON.parse(check.position) : check.position) as { answerSeconds?: unknown } | null;
  const answerSeconds = typeof pos?.answerSeconds === "number" ? pos.answerSeconds : zoneRules.noAnswerSeconds;
  let incidentId = open?.incident_id;
  if (!incidentId) {
    incidentId = (await openIncident(trx, trip, { kind: KIND, raisedBy: "system", position: (check.position as Position | null) ?? undefined, alarm, rideCheck: rideCheckOf(check, "no_answer", answerSeconds) }, now)).incident_id;
    if (alarm) await scheduleTimer(trx, { kind: INCIDENT_ESCALATE, refId: incidentId, dueAt: new Date(now.getTime() + ESCALATE_MS) });
  }
  await trx.updateTable("ride_checks").set({ no_answer_at: now, incident_id: incidentId }).where("trip_id", "=", tripId).where("side", "=", side).where("check_id", "=", checkId).execute();
  // v0.18.9: a server check nobody answered in time shows the safety alert on the trip.
  const server = serverCheckOf(trip, checkId);
  if (server && !server.alertedAt) {
    await trx.updateTable("trips").set({ ride_check: JSON.stringify({ ...server, alertedAt: now.toISOString() }) }).where("trip_id", "=", tripId).execute();
    await sendRideCheckEvent(trx, tripId, now);
  }
};

export const rideCheckHandlers: Record<string, TimerHandler> = { [RIDE_CHECK_NO_ANSWER]: noAnswerHandler };
