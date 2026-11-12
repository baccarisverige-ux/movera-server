import { sql } from "kysely";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { audit } from "../admin/audit.js";
import { cursorOf, readCursor } from "../admin/lists.js";
import { countTotal, withTotal } from "../admin/listTotal.js";
import { permissionsOf, isAdminRole } from "../admin/permissions.js";
import * as desk from "./desk.js";
import { pokeAlerts } from "../alerts/detector.js";
import { pushSupportAnswer } from "./answerPush.js";

/**
 * Support tickets (contract v0.9.0 §16, contract.json#support; owner, 2026-10-27): the rider and driver apps open
 * them (ride disputes, help requests), Admin › Support lists and answers them, the app reads the answers.
 */

const SUPPORT = (contract as unknown as { support: { categories: string[]; replyStatuses: string[] } }).support;
export const TICKET_CATEGORIES: readonly string[] = SUPPORT.categories;

type Who = { actor: "rider" | "driver"; subjectId: string };
type TicketRow = {
  ticket_id: string;
  /** v0.18.9: admin = an internal case an admin opened for the trip's rider or driver (contract.json#onTrip.adminTrip.new.case). */
  opened_by: "rider" | "driver" | "admin";
  /** v0.18.9 owner rule 16: an admin-opened case the person sees (absent on old rows = false). */
  visible_to_person?: boolean;
  rider_id: string | null;
  driver_id: string | null;
  trip_id: string | null;
  zone_id: string | null;
  category: string;
  subject: string;
  status: "open" | "pending" | "resolved" | "closed";
  priority: "low" | "normal" | "high" | "urgent";
  created_at: Date;
  updated_at: Date;
  last_message_at: Date;
  /** v0.18.15 support desk (migration 0049). */
  assigned_admin_id?: string | null;
  solved_by?: string | null;
  solved_at?: Date | null;
  incident_id?: string | null;
  first_reply_at?: Date | null;
  country?: string | null;
  feedback_text?: string | null;
  feedback_at?: Date | null;
};
type MessageRow = { message_id: string; sender: "rider" | "driver" | "support"; text: string; at: Date; admin_name?: string | null; admin_first?: string | null };

/** v0.18.15: `person` = the rider's / driver's own view (support names = first name only, QO-2); `extra` = admin desk fields. */
export function ticketView(row: TicketRow, messages?: readonly MessageRow[], opts: { person?: boolean; extra?: Record<string, unknown> | undefined } = {}) {
  // v0.18.18 (owner "Real name from Team"): the first name set in Team; never an e-mail. The person's apps fall back
  // to the first word of the name only when it is not an e-mail (older accounts).
  // Checker LOW4: without a first name the apps show only "Movera Support" (no word of the old name).
  const nameOf = (m: MessageRow) => m.admin_first || undefined;
  return {
    ticketId: row.ticket_id,
    ...(row.trip_id ? { tripId: row.trip_id } : {}),
    openedBy: row.opened_by,
    ...(row.rider_id ? { riderId: row.rider_id } : {}),
    ...(row.driver_id ? { driverId: row.driver_id } : {}),
    category: row.category,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.zone_id ? { zoneId: row.zone_id } : {}),
    lastMessageAt: row.last_message_at.toISOString(),
    ...(row.opened_by === "admin" ? { visibleToPerson: row.visible_to_person === true } : {}),
    ...(messages
      ? {
          messages: messages.map((m) => {
            const name = m.sender === "support" ? nameOf(m) : undefined;
            return { messageId: m.message_id, from: m.sender, text: m.text, at: m.at.toISOString(), ...(name ? { adminName: name, ...(opts.person ? { supportName: name } : {}) } : {}) };
          }),
        }
      : {}),
    ...(row.feedback_text && row.feedback_at ? { feedback: { text: row.feedback_text, at: row.feedback_at.toISOString() } } : {}),
    ...(opts.extra ?? {}),
  };
}

async function messagesOf(ex: Executor, ticketId: string): Promise<MessageRow[]> {
  return ex
    .selectFrom("ticket_messages")
    .leftJoin("admins", "admins.admin_id", "ticket_messages.admin_id")
    .select(["ticket_messages.message_id", "ticket_messages.sender", "ticket_messages.text", "ticket_messages.at", "admins.first_name as admin_first", "admins.name as admin_name"])
    .where("ticket_messages.ticket_id", "=", ticketId)
    .orderBy("ticket_messages.n")
    .execute();
}

/** POST /support/tickets: a rider or driver opens a ticket; the text is its first message. */
export async function openTicket(trx: Trx, who: Who, body: { tripId?: string; category: string; subject: string; text: string }, now: Date) {
  if (!TICKET_CATEGORIES.includes(body.category)) throw badRequest(`Unknown category ${body.category}.`, "invalid_ticket_category");
  let zoneId: string | null = null;
  if (body.tripId) {
    const trip = await trx.selectFrom("trips").select(["rider_id", "driver_id", "zone_id"]).where("trip_id", "=", body.tripId).executeTakeFirst();
    const own = trip && (who.actor === "rider" ? trip.rider_id === who.subjectId : trip.driver_id === who.subjectId);
    if (!own) throw notFound("No such trip.", "trip_not_found");
    zoneId = trip.zone_id;
  } else if (who.actor === "driver") {
    const driver = await trx.selectFrom("drivers").select("zone_ids").where("driver_id", "=", who.subjectId).executeTakeFirst();
    zoneId = driver?.zone_ids[0] ?? null;
  } else {
    const last = await trx.selectFrom("trips").select("zone_id").where("rider_id", "=", who.subjectId).orderBy("created_at", "desc").limit(1).executeTakeFirst();
    zoneId = last?.zone_id ?? null;
  }
  const country = await desk.personCountry(trx, who);
  await desk.assertTopicOn(trx, zoneId, body.category, country);
  const assignee = await desk.autoAssignee(trx, zoneId, body.category, country, (role) => (isAdminRole(role) ? permissionsOf(role) : []));
  const ticketId = newId("tkt", now.getTime());
  const row = await trx
    .insertInto("support_tickets")
    .values({
      ticket_id: ticketId,
      opened_by: who.actor,
      rider_id: who.actor === "rider" ? who.subjectId : null,
      driver_id: who.actor === "driver" ? who.subjectId : null,
      trip_id: body.tripId ?? null,
      zone_id: zoneId,
      country: (await desk.countryOfZone(trx, zoneId)) ?? country,
      category: body.category,
      subject: body.subject,
      // A ride dispute or a safety question is looked at first.
      priority: body.category === "safety" ? "high" : "normal",
      ...(assignee ? { assigned_admin_id: assignee } : {}),
      created_at: now,
      updated_at: now,
      last_message_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await trx.insertInto("ticket_messages").values({ message_id: newId("tmg", now.getTime()), ticket_id: ticketId, sender: who.actor, admin_id: null, text: body.text, at: now }).execute();
  // v0.18.23: the "Support ticket waiting" admin alert at once.
  await pokeAlerts(trx, now);
  return ticketView(row as TicketRow, await messagesOf(trx, ticketId), { person: true });
}

const ownColumn = (who: Who) => (who.actor === "rider" ? "rider_id" : "driver_id");

/** GET /support/tickets: the person's own tickets, newest change first. */
export async function ownTickets(ex: Executor, who: Who, input: { cursor?: string; limit: number; status?: string }) {
  // v0.18.9: cases an admin opened are internal; the person does not see them.
  let q = ex.selectFrom("support_tickets").selectAll().where(ownColumn(who), "=", who.subjectId).where((eb) => eb.or([eb("opened_by", "!=", "admin"), eb("visible_to_person", "=", true)]));
  if (input.status) q = q.where("status", "=", input.status as TicketRow["status"]);
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(updated_at, ticket_id) < (${c.at}, ${c.id})`);
  }
  const rows = await q.orderBy("updated_at", "desc").orderBy("ticket_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return { items: page.map((r) => ticketView(r as TicketRow)), nextCursor: rows.length > input.limit && last ? cursorOf(last.updated_at, last.ticket_id) : null };
}

/** GET /support/tickets/{ticketId}: one own ticket with the messages (the admins' answers included). */
export async function ownTicket(ex: Executor, who: Who, ticketId: string) {
  const row = await ex.selectFrom("support_tickets").selectAll().where("ticket_id", "=", ticketId).where(ownColumn(who), "=", who.subjectId).where((eb) => eb.or([eb("opened_by", "!=", "admin"), eb("visible_to_person", "=", true)])).executeTakeFirst();
  if (row === undefined) throw notFound("No such ticket.", "ticket_not_found");
  return ticketView(row as TicketRow, await messagesOf(ex, ticketId), { person: true });
}

/** v0.18.15 (owner QO-1, chat-style): the person writes on their own ticket; it is open again for the desk. */
export async function writeOwnTicket(trx: Trx, who: Who, ticketId: string, text: string, now: Date) {
  const row = await trx.selectFrom("support_tickets").selectAll().where("ticket_id", "=", ticketId).where(ownColumn(who), "=", who.subjectId).where((eb) => eb.or([eb("opened_by", "!=", "admin"), eb("visible_to_person", "=", true)])).forUpdate().executeTakeFirst();
  if (row === undefined) throw notFound("No such ticket.", "ticket_not_found");
  if (row.status === "closed") throw new ApiError("invalid_transition", "This ticket is closed.", { reason: "ticket_closed" });
  // Owner 2026-11-02 "Can't write": a solved ticket takes no more messages; the person opens a new ticket.
  if (row.status === "resolved") throw new ApiError("invalid_transition", "This ticket is solved. Open a new ticket.", { reason: "ticket_solved" });
  await trx.insertInto("ticket_messages").values({ message_id: newId("tmg", now.getTime()), ticket_id: ticketId, sender: who.actor, admin_id: null, text, at: now }).execute();
  await trx.updateTable("support_tickets").set({ status: "open", updated_at: now, last_message_at: now }).where("ticket_id", "=", ticketId).execute();
  return ownTicket(trx, who, ticketId);
}

/** v0.18.15 (owner "Not rating only comment suggestions"): an optional comment once the ticket is solved; no stars. */
export async function giveFeedback(trx: Trx, who: Who, ticketId: string, text: string, now: Date) {
  const row = await trx.selectFrom("support_tickets").selectAll().where("ticket_id", "=", ticketId).where(ownColumn(who), "=", who.subjectId).where((eb) => eb.or([eb("opened_by", "!=", "admin"), eb("visible_to_person", "=", true)])).forUpdate().executeTakeFirst();
  if (row === undefined) throw notFound("No such ticket.", "ticket_not_found");
  if (row.status !== "resolved" && row.status !== "closed") throw new ApiError("invalid_transition", "This ticket is not solved yet.", { reason: "ticket_not_solved" });
  if (row.feedback_text) throw new ApiError("invalid_transition", "You already left a comment.", { reason: "feedback_given" });
  await trx.updateTable("support_tickets").set({ feedback_text: text.trim(), feedback_at: now }).where("ticket_id", "=", ticketId).execute();
  return ownTicket(trx, who, ticketId);
}

/** contract v0.13.0 §22: an admin sees tickets of their zones; a ticket without a zone only a Super admin ("*"). */
/** Owner 2026-11-03: a ticket without zone belongs to its country's team (the country from the phone prefix). */
async function inScope(ex: Executor, who: Principal, zoneId: string | null, country: string | null): Promise<boolean> {
  if (zoneId !== null) return adminCoversZone(who, zoneId);
  if (who.zones.includes("*")) return true;
  if (!country || who.zones.length === 0) return false;
  return (await ex.selectFrom("zones").select("zone_id").where("country", "=", country).where("zone_id", "in", who.zones).executeTakeFirst()) !== undefined;
}

export async function adminTickets(ex: Executor, who: Principal, input: { cursor?: string; limit: number; status?: string[]; priority?: string; tripId?: string; riderId?: string; driverId?: string; q?: string; assignedTo?: string }, now: Date = new Date()) {
  let q = ex.selectFrom("support_tickets").selectAll();
  // v0.18.15: me | none | an admin id (a claim never runs out by itself, owner "Never").
  if (input.assignedTo === "none") q = q.where("assigned_admin_id", "is", null);
  else if (input.assignedTo) q = q.where("assigned_admin_id", "=", input.assignedTo === "me" ? who.subjectId : input.assignedTo);
  if (!who.zones.includes("*")) {
    // Owner 2026-11-03: zone-less tickets of the countries the admin has zones in.
    const countries = who.zones.length ? [...new Set((await ex.selectFrom("zones").select("country").where("zone_id", "in", who.zones).execute()).map((z) => z.country).filter((c): c is string => Boolean(c)))] : [];
    q = q.where((eb) => eb.or([eb("zone_id", "in", who.zones.length ? who.zones : ["-"]), eb.and([eb("zone_id", "is", null), eb("country", "in", countries.length ? countries : ["-"])])]));
  }
  if (input.status?.length) q = q.where("status", "in", input.status as TicketRow["status"][]);
  if (input.priority) q = q.where("priority", "=", input.priority as TicketRow["priority"]);
  if (input.tripId) q = q.where("trip_id", "=", input.tripId);
  if (input.riderId) q = q.where("rider_id", "=", input.riderId);
  if (input.driverId) q = q.where("driver_id", "=", input.driverId);
  if (input.q) {
    const like = `%${input.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    q = q.where((eb) => eb.or([eb("subject", "ilike", like), eb("ticket_id", "=", input.q!), eb("trip_id", "=", input.q!)]));
  }
  // L78-S (v0.18.78 adminListFilters.total).
  const counting = input.cursor ? undefined : countTotal(ex, q);
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(updated_at, ticket_id) < (${c.at}, ${c.id})`);
  }
  const rows = await q.orderBy("updated_at", "desc").orderBy("ticket_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const extras = await desk.deskExtras(ex, page as TicketRow[], now);
  return withTotal({ items: page.map((r) => ticketView(r as TicketRow, undefined, { extra: extras.get(r.ticket_id) })), nextCursor: rows.length > input.limit && last ? cursorOf(last.updated_at, last.ticket_id) : null }, await counting);
}

async function ticketForAdmin(ex: Executor, who: Principal, ticketId: string, lock = false): Promise<TicketRow> {
  let q = ex.selectFrom("support_tickets").selectAll().where("ticket_id", "=", ticketId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (row === undefined) throw notFound("No such ticket.", "ticket_not_found");
  if (!(await inScope(ex, who, row.zone_id, row.country ?? null))) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
  return row as TicketRow;
}

export async function adminTicket(ex: Executor, who: Principal, ticketId: string, now: Date = new Date()) {
  const row = await ticketForAdmin(ex, who, ticketId);
  const extras = await desk.deskExtras(ex, [row], now);
  return ticketView(row, await messagesOf(ex, ticketId), { extra: extras.get(ticketId) });
}

/** v0.18.15: Admin › Support claim | assign | topic | waiting | solve | reopen | case (contract.json#supportDesk.adminCommands). */
export type DeskCommand =
  | { verb: "claim" }
  | { verb: "leave" }
  | { verb: "assign"; adminId: string | null; reason: string }
  | { verb: "topic"; category: string }
  | { verb: "waiting"; waiting: boolean }
  | { verb: "solve"; note?: string | undefined }
  | { verb: "reopen"; reason: string }
  | { verb: "case"; reason: string };

/** Owner 2026-11-02 "Never" + "Leave ticket": a claimed ticket is the claimer's alone until he leaves or solves it. */
function assertMine(who: Principal, row: TicketRow): void {
  if (row.assigned_admin_id && row.assigned_admin_id !== who.subjectId) throw new ApiError("conflict", "Another admin works on this ticket.", { reason: "ticket_not_yours" });
}

export async function adminDeskCommand(trx: Trx, who: Principal, ticketId: string, command: DeskCommand, now: Date) {
  const row = await ticketForAdmin(trx, who, ticketId, true);
  if (command.verb !== "claim" && command.verb !== "leave") assertMine(who, row);
  const r = { ...row, assigned_admin_id: row.assigned_admin_id ?? null, incident_id: row.incident_id ?? null };
  switch (command.verb) {
    case "claim": await desk.claim(trx, who, r, now); break;
    case "leave": await desk.leave(trx, who, r, now); break;
    case "assign": await desk.assign(trx, who, r, command, now, (role) => (isAdminRole(role) ? permissionsOf(role) : [])); break;
    case "topic": await desk.setTopic(trx, who, r, command.category, now); break;
    case "waiting": await desk.setWaiting(trx, who, r, command.waiting, now); break;
    case "solve": await desk.solve(trx, who, r, command.note, now); break;
    case "reopen": await desk.reopen(trx, who, r, command.reason, now); break;
    case "case": await desk.openCase(trx, who, r, command.reason, now); break;
  }
  return adminTicket(trx, who, ticketId, now);
}

/** POST /admin/tickets/{ticketId}/reply: the answer goes on the ticket; the status is pending unless said otherwise. */
export async function adminReply(trx: Trx, who: Principal, ticketId: string, body: { text: string; status?: "pending" | "resolved" | "closed" }, now: Date) {
  const row = await ticketForAdmin(trx, who, ticketId, true);
  assertMine(who, row);
  if (row.status === "closed") throw new ApiError("invalid_transition", "This ticket is closed.", { reason: "ticket_closed" });
  const status = body.status ?? "pending";
  await trx.insertInto("ticket_messages").values({ message_id: newId("tmg", now.getTime()), ticket_id: ticketId, sender: "support", admin_id: who.subjectId, text: body.text, at: now }).execute();
  await trx.updateTable("support_tickets").set({ status, updated_at: now, last_message_at: now, ...(row.first_reply_at ? {} : { first_reply_at: now }), ...(status === "resolved" ? { solved_by: who.subjectId, solved_at: now, assigned_admin_id: null } : {}) }).where("ticket_id", "=", ticketId).execute();
  await audit(trx, { adminId: who.subjectId, action: "ticket.reply", targetType: "ticket", targetId: ticketId, zoneId: row.zone_id, detail: { status }, at: now });
  // v0.18.53 §75 (owner Q39): the answer pushes the ticket's owner at once (never for a case the person cannot see).
  await pushSupportAnswer(trx, row, now);
  return adminTicket(trx, who, ticketId, now);
}
