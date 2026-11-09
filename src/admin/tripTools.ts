import { sql } from "kysely";
import type { Principal } from "../auth/guard.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { pushSupportAnswer } from "../support/answerPush.js";
import { ticketView, TICKET_CATEGORIES } from "../support/tickets.js";
import { audit } from "./audit.js";
import { cursorOf, readCursor, zonesOf } from "./lists.js";
import { adminTrip } from "./trips.js";

/**
 * v0.18.9 (contract.json#onTrip.adminTrip, admin-fake G7 items): the admin's own trip tools — a flag, notes, a support
 * case for the rider or driver, revealing a phone number with a reason — and the ride-check list. None of them changes
 * the trip's version: the apps never see them.
 */

export type AdminFlag = { flagged: boolean; reason?: string; by: string; at: string };

export async function flagTrip(trx: Trx, who: Principal, tripId: string, body: { flagged: boolean; reason?: string }, now: Date): Promise<AdminFlag> {
  const trip = await adminTrip(trx, who, tripId);
  const flag: AdminFlag = { flagged: body.flagged, ...(body.reason ? { reason: body.reason } : {}), by: who.subjectId, at: now.toISOString() };
  await trx.updateTable("trips").set({ admin_flag: JSON.stringify(flag) }).where("trip_id", "=", tripId).execute();
  await audit(trx, { adminId: who.subjectId, action: body.flagged ? "trip.flag" : "trip.unflag", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: body.reason ? { reason: body.reason } : {}, at: now });
  return flag;
}

const noteView = (row: { note_id: string; trip_id: string; text: string; admin_id: string; at: Date; admin_name?: string | null }) => ({
  noteId: row.note_id,
  tripId: row.trip_id,
  text: row.text,
  adminId: row.admin_id,
  ...(row.admin_name ? { adminName: row.admin_name } : {}),
  at: row.at.toISOString(),
});

export async function tripNotes(ex: Executor, who: Principal, tripId: string) {
  await adminTrip(ex, who, tripId);
  const rows = await ex
    .selectFrom("admin_trip_notes")
    .leftJoin("admins", "admins.admin_id", "admin_trip_notes.admin_id")
    .select(["admin_trip_notes.note_id", "admin_trip_notes.trip_id", "admin_trip_notes.text", "admin_trip_notes.admin_id", "admin_trip_notes.at", "admins.first_name as admin_name"])
    .where("admin_trip_notes.trip_id", "=", tripId)
    .orderBy("admin_trip_notes.at", "desc")
    .orderBy("admin_trip_notes.note_id", "desc")
    .execute();
  return { items: rows.map(noteView) };
}

export async function addTripNote(trx: Trx, who: Principal, tripId: string, body: { text: string }, now: Date) {
  const trip = await adminTrip(trx, who, tripId);
  const row = { note_id: newId("tno", now.getTime()), trip_id: tripId, admin_id: who.subjectId, text: body.text, at: now };
  await trx.insertInto("admin_trip_notes").values(row).execute();
  await audit(trx, { adminId: who.subjectId, action: "trip.note", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { noteId: row.note_id }, at: now });
  return noteView(row);
}

/** A support case for the trip's rider or driver, opened by the admin: internal unless visibleToPerson (owner rule 16). */
export async function openTripCase(trx: Trx, who: Principal, tripId: string, body: { about: "rider" | "driver"; category: string; subject: string; text: string; visibleToPerson?: boolean | undefined }, now: Date) {
  const trip = await adminTrip(trx, who, tripId);
  if (!TICKET_CATEGORIES.includes(body.category)) throw badRequest(`Unknown category ${body.category}.`, "invalid_body");
  const person = body.about === "rider" ? trip.rider_id : trip.driver_id;
  if (!person) throw new ApiError("conflict", "This trip has no driver.", { reason: "no_driver" });
  const ticketId = newId("tkt", now.getTime());
  const row = await trx
    .insertInto("support_tickets")
    .values({
      ticket_id: ticketId,
      opened_by: "admin",
      visible_to_person: body.visibleToPerson === true,
      rider_id: body.about === "rider" ? person : null,
      driver_id: body.about === "driver" ? person : null,
      trip_id: tripId,
      zone_id: trip.zone_id,
      category: body.category,
      subject: body.subject,
      priority: body.category === "safety" ? "high" : "normal",
      created_at: now,
      updated_at: now,
      last_message_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const message = { message_id: newId("tmg", now.getTime()), ticket_id: ticketId, sender: "support" as const, admin_id: who.subjectId, text: body.text, at: now };
  await trx.insertInto("ticket_messages").values(message).execute();
  await audit(trx, { adminId: who.subjectId, action: "trip.case", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { ticketId, about: body.about, visibleToPerson: body.visibleToPerson === true }, at: now });
  // v0.18.53 §75 (owner Q39): the admin's first message on a case the person sees is pushed like an answer; an
  // internal case (visibleToPerson false) tells nobody (pushSupportAnswer checks it).
  await pushSupportAnswer(trx, row as never, now);
  return ticketView(row as never, [{ ...message, admin_name: null } as never]);
}

/** The rider's or driver's phone number, with a reason; the audit keeps the reason, never the number. */
export async function revealTripContact(trx: Trx, who: Principal, tripId: string, body: { who: "rider" | "driver"; reason: string }, now: Date) {
  const needed = body.who === "rider" ? "riders.viewSensitive" : "drivers.viewSensitive";
  if (!(who.perms ?? []).includes(needed)) throw new ApiError("forbidden", "You do not have permission to do that.", { reason: "missing_permission" });
  const trip = await adminTrip(trx, who, tripId);
  const phone =
    body.who === "rider"
      ? (await trx.selectFrom("riders").select("phone").where("rider_id", "=", trip.rider_id).executeTakeFirst())?.phone
      : trip.driver_id
        ? (await trx.selectFrom("drivers").select("phone").where("driver_id", "=", trip.driver_id).executeTakeFirst())?.phone
        : undefined;
  if (!phone) throw new ApiError("not_found", "No phone number for this person.", { reason: "no_contact" });
  await audit(trx, { adminId: who.subjectId, action: "trip.reveal_contact", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { who: body.who, reason: body.reason }, at: now });
  return { who: body.who, phone, revealedAt: now.toISOString() };
}

function measuredOf(position: unknown): { measured?: { value: number; unit: string }; answerSeconds?: number } {
  const p = (typeof position === "string" ? safeJson(position) : position) as { measured?: { value?: unknown; unit?: unknown }; answerSeconds?: unknown } | null;
  if (!p || typeof p !== "object") return {};
  const m = p.measured;
  return {
    ...(m && typeof m.value === "number" && typeof m.unit === "string" ? { measured: { value: m.value, unit: m.unit } } : {}),
    ...(typeof p.answerSeconds === "number" ? { answerSeconds: p.answerSeconds } : {}),
  };
}
const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export type RideCheckQuery = { cursor?: string; limit: number; zoneId?: string; tripId?: string; trigger?: string; answer?: "ok" | "need_help" | "no_answer" | "waiting"; origin?: "server" | "app"; from?: string; to?: string };

/** GET /admin/ride-checks: every check (server and app) in the admin's zones, newest first. */
export async function listRideChecks(ex: Executor, who: Principal, input: RideCheckQuery) {
  let q = ex
    .selectFrom("ride_checks")
    .innerJoin("trips", "trips.trip_id", "ride_checks.trip_id")
    .select([
      "ride_checks.trip_id", "trips.zone_id", "ride_checks.side", "ride_checks.check_id", "ride_checks.origin", "ride_checks.trigger", "ride_checks.shown_at",
      "ride_checks.answer", "ride_checks.answered_at", "ride_checks.no_answer_at", "ride_checks.incident_id", "ride_checks.position", "ride_checks.created_at",
    ]);
  const zones = zonesOf(who);
  if (zones) q = q.where("trips.zone_id", "in", zones.length ? zones : ["-"]);
  if (input.zoneId) q = q.where("trips.zone_id", "=", input.zoneId);
  if (input.tripId) q = q.where("ride_checks.trip_id", "=", input.tripId);
  if (input.trigger) q = q.where("ride_checks.trigger", "=", input.trigger);
  if (input.origin) q = q.where("ride_checks.origin", "=", input.origin);
  if (input.answer === "ok" || input.answer === "need_help") q = q.where("ride_checks.answer", "=", input.answer);
  if (input.answer === "no_answer") q = q.where("ride_checks.no_answer_at", "is not", null);
  if (input.answer === "waiting") q = q.where("ride_checks.answer", "is", null).where("ride_checks.no_answer_at", "is", null);
  if (input.from) q = q.where("ride_checks.created_at", ">=", new Date(input.from));
  if (input.to) q = q.where("ride_checks.created_at", "<", new Date(input.to));
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(ride_checks.created_at, ride_checks.trip_id || '~' || ride_checks.side || '~' || ride_checks.check_id) < (${c.at}, ${c.id})`);
  }
  const rows = await q.orderBy("ride_checks.created_at", "desc").orderBy(sql`ride_checks.trip_id || '~' || ride_checks.side || '~' || ride_checks.check_id`, "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const iso = (d: Date | null) => (d ? { v: d.toISOString() } : null);
  return {
    items: page.map((r) => ({
      tripId: r.trip_id,
      zoneId: r.zone_id,
      side: r.side,
      checkId: r.check_id,
      origin: r.origin,
      trigger: r.trigger,
      ...(iso(r.shown_at) ? { shownAt: iso(r.shown_at)!.v } : {}),
      ...(r.answer ? { answer: r.answer } : {}),
      ...(iso(r.answered_at) ? { answeredAt: iso(r.answered_at)!.v } : {}),
      ...(iso(r.no_answer_at) ? { noAnswerAt: iso(r.no_answer_at)!.v } : {}),
      ...(r.incident_id ? { incidentId: r.incident_id } : {}),
      ...(r.position ? { position: r.position } : {}),
      // G7 live fix: what the server measured and the zone's answer time when it asked (kept with the position).
      ...measuredOf(r.position),
      createdAt: r.created_at.toISOString(),
    })),
    nextCursor: rows.length > input.limit && last ? cursorOf(last.created_at, `${last.trip_id}~${last.side}~${last.check_id}`) : null,
  };
}
