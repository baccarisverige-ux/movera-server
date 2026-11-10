import { schemaProblem } from "../contract/schemas.js";
import type { Executor, Trx } from "../db/db.js";
import type { TripMessagesTable } from "../db/schema.js";
import { appendTripEvent, type TripRow } from "../db/tripLog.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { DRIVER_ASSIGNED, TERMINAL, type TripStatus } from "../rules/transitions.js";
import { lockOwnTrip, readOwnTrip } from "./commands.js";
import { tripProjection } from "./projection.js";
import type { Selectable } from "kysely";

/**
 * The trip chat (contract Message, GET and POST /trips/{tripId}/messages): the rider and the driver of a trip
 * write to each other, an admin writes as support. Each message is kept in trip_messages (for the admin's trip details
 * only, v0.18.5 G9) and goes out at once as
 * a trip event of kind message (§4) carrying the Message. A message is not a change of the trip: the event has
 * the trip's version as it is, and the apps' gate lets a message through even after the trip ended.
 *
 * contract v0.13.0 §22 (owner "chat only support roles in their zones" and 2026-10-28): an admin reads and writes
 * only with support.reply and only for a trip of the admin's zones; the rider and the driver write until drop-off
 * (no hour after it); messages are kept 90 days, those of a trip with a safety case stay with the case.
 */

export type MessageWho = { actor: "rider" | "driver" | "admin"; subjectId: string; zones?: readonly string[]; perms?: readonly string[] };
export type Message = { messageId: string; tripId: string; from: "rider" | "driver" | "support"; text: string; at: string };

type MessageRow = Selectable<TripMessagesTable>;

/** contract.json#chat.retentionDays: chat messages are deleted after 90 days unless the trip has a safety case. */
export const CHAT_RETENTION_DAYS = 90;

const messageView = (row: MessageRow): Message => ({ messageId: row.message_id, tripId: row.trip_id, from: row.sender, text: row.text, at: row.created_at.toISOString() });

/** Open while a driver is on the trip, closed at drop-off (contract.json#chat.window). Support may still write after it. */
export function chatOpen(trip: Pick<TripRow, "driver_id" | "status">, actor: MessageWho["actor"]): boolean {
  if (trip.driver_id === null) return false;
  const status = trip.status as TripStatus;
  if (DRIVER_ASSIGNED.has(status)) return true;
  return actor === "admin" && TERMINAL.has(status);
}

/** An admin needs support.reply (to read too) and the trip's zone in their zones; a Super admin ("*") has all. */
export function assertSupportScope(who: MessageWho, trip: Pick<TripRow, "zone_id">): void {
  assertAdminTripScope(who, trip, "support.reply");
}

/**
 * The admin side of a trip route: the permission and the trip's zone in the admin's zones ("*" has all). Riders and
 * drivers pass (their own-trip rule is checked by the read). Global plan step 25 (Q34): trip read and events use it
 * with trips.read, with the same answers as the trip chat.
 */
export function assertAdminTripScope(who: MessageWho, trip: Pick<TripRow, "zone_id">, permission: string): void {
  if (who.actor !== "admin") return;
  if (!(who.perms ?? []).includes(permission)) throw new ApiError("forbidden", "You do not have permission to do that.", { reason: "missing_permission" });
  const zones = who.zones ?? [];
  if (!zones.includes("*") && (trip.zone_id === null || !zones.includes(trip.zone_id))) throw new ApiError("forbidden", "This trip is outside your zones.", { reason: "zone_out_of_scope" });
}

/** POST /trips/{tripId}/messages → 201 Message. The caller's side is the token's actor; an admin writes as support. */
export async function sendMessage(trx: Trx, who: MessageWho, tripId: string, body: unknown, now: Date): Promise<Message> {
  const problem = schemaProblem("MessageRequest", body);
  if (problem !== null) throw badRequest(`The message is not valid: ${problem}.`, "invalid_body");
  const { text } = body as { text: string };
  if (text.trim() === "") throw badRequest("The message is empty.", "invalid_body");
  const trip = await lockOwnTrip(trx, tripId, who);
  assertSupportScope(who, trip);
  if (!chatOpen(trip, who.actor)) {
    throw new ApiError("invalid_transition", "You can write while a driver is on the trip; the chat closes at drop-off.", { reason: "chat_closed", projection: tripProjection(trip, who.actor) });
  }
  const from = who.actor === "admin" ? "support" : who.actor;
  const message: Message = { messageId: newId("msg", now.getTime()), tripId, from, text, at: now.toISOString() };
  // The event's sequence is the chat's order; it is taken under the trip lock held above.
  const { sequence } = await appendTripEvent(trx, { tripId, kind: "message", version: trip.version, occurredAt: now, message });
  await trx.insertInto("trip_messages").values({ message_id: message.messageId, trip_id: tripId, sequence, sender: from, sender_id: who.subjectId, text, created_at: now }).execute();
  // v0.18.5 (G9, owner "Never store messages between rider or driver in driver app or rider app"): no stored notice;
  // the other side hears of it through the trip stream's message event only (contract.json#chat.appStorage).
  return message;
}

/** GET /trips/{tripId}/messages?cursor&limit: oldest first; the cursor is the last message's place in the trip's event order. */
export async function listMessages(ex: Executor, who: MessageWho, tripId: string, input: { cursor?: string; limit: number }): Promise<{ items: Message[]; nextCursor: string | null; closed?: true }> {
  const trip = await readOwnTrip(ex, tripId, who);
  assertSupportScope(who, trip);
  // v0.18.5 (G9, chat.appStorage.afterTrip): after the trip the rider and the driver read no history; admins keep it.
  if (who.actor !== "admin" && TERMINAL.has(trip.status as TripStatus)) return { items: [], nextCursor: null, closed: true };
  let query = ex.selectFrom("trip_messages").selectAll().where("trip_id", "=", tripId);
  if (input.cursor) {
    const after = Buffer.from(input.cursor, "base64url").toString("utf8");
    if (!/^\d{1,18}$/.test(after)) throw badRequest("The cursor is not valid.", "invalid_cursor");
    query = query.where("sequence", ">", after);
  }
  const rows = await query.orderBy("sequence").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return { items: page.map(messageView), nextCursor: rows.length > input.limit && last ? Buffer.from(String(last.sequence)).toString("base64url") : null };
}

/**
 * The daily retention (contract.json#chat.retention): chat messages older than 90 days go, and so does the copy in
 * the trip's message events; a trip with any incident keeps its chat with the case. Returns how many went.
 */
export async function purgeOldMessages(trx: Trx, now: Date): Promise<number> {
  const before = new Date(now.getTime() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const safetyTrips = trx.selectFrom("incidents").select("trip_id").where("trip_id", "is not", null);
  const gone = await trx.deleteFrom("trip_messages").where("created_at", "<", before).where("trip_id", "not in", safetyTrips as never).executeTakeFirst();
  // The event stays (its sequence is the stream's order); only the text goes.
  await trx.updateTable("trip_events").set({ message: null }).where("kind", "=", "message").where("message", "is not", null).where("occurred_at", "<", before).where("trip_id", "not in", safetyTrips as never).execute();
  return Number(gone.numDeletedRows);
}
