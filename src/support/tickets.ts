import { sql } from "kysely";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { audit } from "../admin/audit.js";
import { cursorOf, readCursor } from "../admin/lists.js";

/**
 * Support tickets (contract v0.9.0 §16, contract.json#support; owner, 2026-10-27): the rider and driver apps open
 * them (ride disputes, help requests), Admin › Support lists and answers them, the app reads the answers.
 */

const SUPPORT = (contract as unknown as { support: { categories: string[]; replyStatuses: string[] } }).support;
export const TICKET_CATEGORIES: readonly string[] = SUPPORT.categories;

type Who = { actor: "rider" | "driver"; subjectId: string };
type TicketRow = {
  ticket_id: string;
  opened_by: "rider" | "driver";
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
};
type MessageRow = { message_id: string; sender: "rider" | "driver" | "support"; text: string; at: Date; admin_name?: string | null };

export function ticketView(row: TicketRow, messages?: readonly MessageRow[]) {
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
    ...(messages
      ? { messages: messages.map((m) => ({ messageId: m.message_id, from: m.sender, text: m.text, at: m.at.toISOString(), ...(m.sender === "support" && m.admin_name ? { adminName: m.admin_name } : {}) })) }
      : {}),
  };
}

async function messagesOf(ex: Executor, ticketId: string): Promise<MessageRow[]> {
  return ex
    .selectFrom("ticket_messages")
    .leftJoin("admins", "admins.admin_id", "ticket_messages.admin_id")
    .select(["ticket_messages.message_id", "ticket_messages.sender", "ticket_messages.text", "ticket_messages.at", "admins.name as admin_name"])
    .where("ticket_messages.ticket_id", "=", ticketId)
    .orderBy("ticket_messages.n")
    .execute();
}

/** POST /support/tickets: a rider or driver opens a ticket; the text is its first message. */
export async function openTicket(trx: Trx, who: Who, body: { tripId?: string; category: string; subject: string; text: string }, now: Date) {
  if (!TICKET_CATEGORIES.includes(body.category)) throw badRequest(`Unknown category ${body.category}.`, "invalid_body");
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
      category: body.category,
      subject: body.subject,
      // A ride dispute or a safety question is looked at first.
      priority: body.category === "safety" ? "high" : "normal",
      created_at: now,
      updated_at: now,
      last_message_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await trx.insertInto("ticket_messages").values({ message_id: newId("tmg", now.getTime()), ticket_id: ticketId, sender: who.actor, admin_id: null, text: body.text, at: now }).execute();
  return ticketView(row as TicketRow, await messagesOf(trx, ticketId));
}

const ownColumn = (who: Who) => (who.actor === "rider" ? "rider_id" : "driver_id");

/** GET /support/tickets: the person's own tickets, newest change first. */
export async function ownTickets(ex: Executor, who: Who, input: { cursor?: string; limit: number; status?: string }) {
  let q = ex.selectFrom("support_tickets").selectAll().where(ownColumn(who), "=", who.subjectId);
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
  const row = await ex.selectFrom("support_tickets").selectAll().where("ticket_id", "=", ticketId).where(ownColumn(who), "=", who.subjectId).executeTakeFirst();
  if (row === undefined) throw notFound("No such ticket.", "ticket_not_found");
  return ticketView(row as TicketRow, await messagesOf(ex, ticketId));
}

/** An admin sees tickets of their zones, and tickets without a zone (a rider who never rode). */
function inScope(who: Principal, zoneId: string | null): boolean {
  return zoneId === null || adminCoversZone(who, zoneId);
}

export async function adminTickets(ex: Executor, who: Principal, input: { cursor?: string; limit: number; status?: string[]; priority?: string; tripId?: string; riderId?: string; driverId?: string; q?: string }) {
  let q = ex.selectFrom("support_tickets").selectAll();
  if (!who.zones.includes("*")) q = q.where((eb) => eb.or([eb("zone_id", "is", null), eb("zone_id", "in", who.zones.length ? who.zones : ["-"])]));
  if (input.status?.length) q = q.where("status", "in", input.status as TicketRow["status"][]);
  if (input.priority) q = q.where("priority", "=", input.priority as TicketRow["priority"]);
  if (input.tripId) q = q.where("trip_id", "=", input.tripId);
  if (input.riderId) q = q.where("rider_id", "=", input.riderId);
  if (input.driverId) q = q.where("driver_id", "=", input.driverId);
  if (input.q) {
    const like = `%${input.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    q = q.where((eb) => eb.or([eb("subject", "ilike", like), eb("ticket_id", "=", input.q!), eb("trip_id", "=", input.q!)]));
  }
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(updated_at, ticket_id) < (${c.at}, ${c.id})`);
  }
  const rows = await q.orderBy("updated_at", "desc").orderBy("ticket_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return { items: page.map((r) => ticketView(r as TicketRow)), nextCursor: rows.length > input.limit && last ? cursorOf(last.updated_at, last.ticket_id) : null };
}

async function ticketForAdmin(ex: Executor, who: Principal, ticketId: string, lock = false): Promise<TicketRow> {
  let q = ex.selectFrom("support_tickets").selectAll().where("ticket_id", "=", ticketId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (row === undefined) throw notFound("No such ticket.", "ticket_not_found");
  if (!inScope(who, row.zone_id)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
  return row as TicketRow;
}

export async function adminTicket(ex: Executor, who: Principal, ticketId: string) {
  const row = await ticketForAdmin(ex, who, ticketId);
  return ticketView(row, await messagesOf(ex, ticketId));
}

/** POST /admin/tickets/{ticketId}/reply: the answer goes on the ticket; the status is pending unless said otherwise. */
export async function adminReply(trx: Trx, who: Principal, ticketId: string, body: { text: string; status?: "pending" | "resolved" | "closed" }, now: Date) {
  const row = await ticketForAdmin(trx, who, ticketId, true);
  if (row.status === "closed") throw new ApiError("invalid_transition", "This ticket is closed.", { reason: "ticket_closed" });
  const status = body.status ?? "pending";
  await trx.insertInto("ticket_messages").values({ message_id: newId("tmg", now.getTime()), ticket_id: ticketId, sender: "support", admin_id: who.subjectId, text: body.text, at: now }).execute();
  await trx.updateTable("support_tickets").set({ status, updated_at: now, last_message_at: now }).where("ticket_id", "=", ticketId).execute();
  await audit(trx, { adminId: who.subjectId, action: "ticket.reply", targetType: "ticket", targetId: ticketId, zoneId: row.zone_id, detail: { status }, at: now });
  return adminTicket(trx, who, ticketId);
}
