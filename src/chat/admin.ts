import { sql } from "kysely";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import { audit } from "../admin/audit.js";
import { narrowToZones, type ZoneFilter } from "../admin/zoneFilter.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { DRIVER_ASSIGNED } from "../rules/transitions.js";
import * as desk from "../support/desk.js";
import { ticketView } from "../support/tickets.js";

/** v0.18.56 §78 (chat.adminChats, AUDIT A15 N16): GET /admin/chats → AdminChatPage. No text, no phone. */
export async function adminChats(ex: Executor, who: Principal, input: ZoneFilter & { cursor?: string | undefined; limit: number }) {
  const narrowed = await narrowToZones(ex, who, input);
  const all = narrowed.zones.includes("*");
  if (!all && narrowed.zones.length === 0) return { items: [], nextCursor: null };
  const last = ex.selectFrom("trip_messages as m")
    .select(["m.trip_id", sql<number>`count(*)::int`.as("message_count"), sql<Date>`max(m.created_at)`.as("last_at"), sql<string>`max(m.sequence)`.as("last_seq")])
    .groupBy("m.trip_id").as("c");
  let q = ex.selectFrom("trips as t").innerJoin(last, "c.trip_id", "t.trip_id")
    .select(["t.trip_id", "t.zone_id", "t.status", "t.rider_summary", "t.driver_summary", "c.message_count", "c.last_at", "c.last_seq"])
    .where("t.status", "in", [...DRIVER_ASSIGNED])
    .where("t.zone_id", "is not", null);
  if (!all) q = q.where("t.zone_id", "in", narrowed.zones);
  if (input.cursor) {
    const [at, id] = Buffer.from(input.cursor, "base64url").toString("utf8").split("|");
    if (!at || !id || Number.isNaN(Date.parse(at))) throw badRequest("The cursor is not valid.", "invalid_cursor");
    q = q.where(sql<boolean>`(c.last_at, t.trip_id) < (${new Date(at)}, ${id})`);
  }
  const rows = await q.orderBy("c.last_at", "desc").orderBy("t.trip_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const senders = page.length
    ? await ex.selectFrom("trip_messages").select(["trip_id", "sequence", "sender"]).where(sql<boolean>`(trip_id, sequence) in (${sql.join(page.map((r) => sql`(${r.trip_id}, ${r.last_seq}::bigint)`))})`).execute()
    : [];
  const fromOf = new Map(senders.map((s) => [s.trip_id, s.sender]));
  const first = (summary: unknown) => {
    const name = (summary as { firstName?: unknown } | null)?.firstName;
    return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
  };
  const end = page[page.length - 1];
  return {
    items: page.map((r) => ({
      tripId: r.trip_id, zoneId: r.zone_id!, status: r.status, riderFirstName: first(r.rider_summary), driverFirstName: first(r.driver_summary),
      messageCount: Number(r.message_count), lastMessageAt: new Date(r.last_at).toISOString(), lastFrom: fromOf.get(r.trip_id) ?? "support",
    })),
    nextCursor: rows.length > input.limit && end ? Buffer.from(`${new Date(end.last_at).toISOString()}|${end.trip_id}`).toString("base64url") : null,
  };
}

/**
 * v0.18.56 §78 (chat.adminMessage, owner g9 Q5): POST /admin/{drivers|riders}/{id}/message { text } → 201 SupportTicket
 * in the person's Support inbox (openedBy admin, topic help, visible to the person). Audited without the text. No
 * push yet (G13, IN-OTHER.1).
 */
export async function adminMessagePerson(trx: Trx, who: Principal, actor: "rider" | "driver", personId: string, body: unknown, now: Date) {
  let zoneIds: string[];
  if (actor === "driver") {
    const driver = await trx.selectFrom("drivers").select("zone_ids").where("driver_id", "=", personId).executeTakeFirst();
    if (!driver) throw notFound("No such driver.", "driver_not_found");
    zoneIds = driver.zone_ids;
  } else {
    const rider = await trx.selectFrom("riders").select("rider_id").where("rider_id", "=", personId).executeTakeFirst();
    if (!rider) throw notFound("No such rider.", "rider_not_found");
    const trips = await trx.selectFrom("trips").select("zone_id").where("rider_id", "=", personId).where("zone_id", "is not", null).orderBy("created_at", "desc").limit(50).execute();
    zoneIds = [...new Set(trips.map((t) => t.zone_id!))];
  }
  const covered = zoneIds.filter((z) => adminCoversZone(who, z));
  if (!who.zones.includes("*") && covered.length === 0) throw new ApiError("forbidden", "This person is outside your zones.", { reason: "zone_out_of_scope" });
  // Authorization first (the person and the zone), then the body.
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || text.trim() === "" || text.length > 2000) throw badRequest("text (1–2000 characters) is needed.", "invalid_body");
  const zoneId = zoneIds[0] ?? null;
  const ticketId = newId("tkt", now.getTime());
  const country = (await desk.countryOfZone(trx, zoneId)) ?? (await desk.personCountry(trx, { actor, subjectId: personId }));
  const row = await trx.insertInto("support_tickets").values({
    ticket_id: ticketId, opened_by: "admin", visible_to_person: true,
    rider_id: actor === "rider" ? personId : null, driver_id: actor === "driver" ? personId : null,
    trip_id: null, zone_id: zoneId, country, category: "help", subject: "Message from Movera Support",
    priority: "normal", assigned_admin_id: who.subjectId, first_reply_at: now,
    created_at: now, updated_at: now, last_message_at: now,
  }).returningAll().executeTakeFirstOrThrow();
  await trx.insertInto("ticket_messages").values({ message_id: newId("tmg", now.getTime()), ticket_id: ticketId, sender: "support", admin_id: who.subjectId, text, at: now }).execute();
  await audit(trx, { adminId: who.subjectId, action: `${actor}.message`, targetType: actor, targetId: personId, zoneId, detail: { ticketId }, at: now });
  const messages = await trx.selectFrom("ticket_messages").leftJoin("admins", "admins.admin_id", "ticket_messages.admin_id")
    .select(["ticket_messages.message_id", "ticket_messages.sender", "ticket_messages.text", "ticket_messages.at", "admins.first_name as admin_first", "admins.name as admin_name"])
    .where("ticket_messages.ticket_id", "=", ticketId).orderBy("ticket_messages.n").execute();
  return ticketView(row as never, messages);
}
