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
import { chatSettingsFor, languageOf, ON_MY_WAY_TEXT, type ChatSettings } from "../chat/settings.js";

/**
 * The trip chat (contract Message, GET and POST /trips/{tripId}/messages): the rider and the driver of a trip
 * write to each other, an admin writes as support. Each message is kept in trip_messages (for the admin's trip details
 * only, v0.18.5 G9) and goes out at once as
 * a trip event of kind message (§4) carrying the Message. A message is not a change of the trip: the event has
 * the trip's version as it is, and the apps' gate lets a message through even after the trip ended.
 *
 * contract v0.13.0 §22 (owner "chat only support roles in their zones" and 2026-10-28): an admin reads and writes
 * only with support.reply and only for a trip of the admin's zones; the rider and the driver write until drop-off
 * (no hour after it); messages are kept CountryRules.chat.keepDays (v0.18.56, default 90), those of a trip with a
 * safety case stay with the case.
 */

export type MessageWho = { actor: "rider" | "driver" | "admin"; subjectId: string; zones?: readonly string[]; perms?: readonly string[] };
export type Message = { messageId: string; tripId: string; from: "rider" | "driver" | "support"; text: string; at: string; quickReplyId?: string; auto?: "arrived" | "on_my_way" };

type MessageRow = Selectable<TripMessagesTable>;

/**
 * contract.json#chat.retentionDays (90) is replaced in v0.18.56 §78 by CountryRules.chat.keepDays (default 90,
 * src/chat/settings.ts); this is only the default now.
 */
export const CHAT_RETENTION_DAYS = 90;

const messageView = (row: MessageRow): Message => ({
  messageId: row.message_id, tripId: row.trip_id, from: row.sender, text: row.text, at: row.created_at.toISOString(),
  ...(row.quick_reply_id ? { quickReplyId: row.quick_reply_id } : {}),
  ...(row.auto ? { auto: row.auto } : {}),
});

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

/**
 * POST /trips/{tripId}/messages → 201 Message. The caller's side is the token's actor; an admin writes as support.
 * v0.18.56 §78 (CountryRules.chat): a text over maxLength is 400 message_too_long; more than spamPerMin messages of one
 * sender on one trip in a minute is 429 too_many_requests (support is not limited); quickReplyId writes that chip of
 * the sender's side list in the reader's app language (unknown id: 400 unknown_quick_reply).
 */
export async function sendMessage(trx: Trx, who: MessageWho, tripId: string, body: unknown, now: Date): Promise<Message> {
  const problem = schemaProblem("MessageRequest", body);
  if (problem !== null) throw badRequest(`The message is not valid: ${problem}.`, "invalid_body");
  const { text: typed, quickReplyId } = body as { text: string; quickReplyId?: string };
  if (quickReplyId === undefined && typed.trim() === "") throw badRequest("The message is empty.", "invalid_body");
  const trip = await lockOwnTrip(trx, tripId, who);
  assertSupportScope(who, trip);
  if (!chatOpen(trip, who.actor)) {
    throw new ApiError("invalid_transition", "You can write while a driver is on the trip; the chat closes at drop-off.", { reason: "chat_closed", projection: tripProjection(trip, who.actor) });
  }
  const settings = await chatSettingsFor(trx, trip.zone_id);
  let text = typed;
  if (quickReplyId !== undefined) {
    const chip = who.actor === "admin" ? undefined : settings.quickReplies[who.actor].find((q) => q.id === quickReplyId);
    if (chip === undefined) throw badRequest("Unknown quick reply.", "unknown_quick_reply");
    const reader = who.actor === "rider" ? { actor: "driver" as const, subjectId: trip.driver_id } : { actor: "rider" as const, subjectId: trip.rider_id };
    text = chip.text[await languageOf(trx, reader, trip.zone_id)];
  } else if (text.length > settings.maxLength) {
    throw badRequest(`The message is longer than ${settings.maxLength} characters.`, "message_too_long");
  }
  if (who.actor !== "admin") await assertNotSpam(trx, tripId, who.subjectId, settings, now);
  const from = who.actor === "admin" ? "support" : who.actor;
  return writeMessage(trx, trip, { from, senderId: who.subjectId, text, ...(quickReplyId !== undefined ? { quickReplyId } : {}) }, now);
}

async function assertNotSpam(trx: Trx, tripId: string, senderId: string, settings: ChatSettings, now: Date): Promise<void> {
  const since = new Date(now.getTime() - 60_000);
  // Counted under the trip lock (lockOwnTrip), so two copies cannot both let the 11th through (Rule 33).
  const rows = await trx.selectFrom("trip_messages").select("created_at").where("trip_id", "=", tripId).where("sender_id", "=", senderId).where("auto", "is", null).where("created_at", ">", since).orderBy("created_at").execute();
  if (rows.length < settings.spamPerMin) return;
  const oldest = rows[rows.length - settings.spamPerMin]!.created_at.getTime();
  const wait = Math.max(1, Math.ceil((oldest + 60_000 - now.getTime()) / 1000));
  throw new ApiError("rate_limited", "Too many messages. Wait a moment and try again.", { reason: "too_many_requests", retryAfterSeconds: wait });
}

/** Stores one message and sends it as a `message` trip event. The caller holds the trip lock. */
async function writeMessage(trx: Trx, trip: TripRow, m: { from: Message["from"]; senderId: string; text: string; quickReplyId?: string; auto?: "arrived" | "on_my_way" }, now: Date): Promise<Message> {
  const message: Message = {
    messageId: newId("msg", now.getTime()), tripId: trip.trip_id, from: m.from, text: m.text, at: now.toISOString(),
    ...(m.quickReplyId ? { quickReplyId: m.quickReplyId } : {}),
    ...(m.auto ? { auto: m.auto } : {}),
  };
  // The event's sequence is the chat's order; it is taken under the trip lock held above.
  const { sequence } = await appendTripEvent(trx, { tripId: trip.trip_id, kind: "message", version: trip.version, occurredAt: now, message });
  await trx.insertInto("trip_messages").values({
    message_id: message.messageId, trip_id: trip.trip_id, sequence, sender: m.from, sender_id: m.senderId, text: m.text, created_at: now,
    quick_reply_id: m.quickReplyId ?? null, auto: m.auto ?? null,
  }).execute();
  // v0.18.5 (G9, owner "Never store messages between rider or driver in driver app or rider app"): no stored notice;
  // the other side hears of it through the trip stream's message event only (contract.json#chat.appStorage).
  return message;
}

/**
 * v0.18.56 §78 (chat.autoArrived, chat.onTheWay; owner g9 Q3, Q4, Q85): the automatic message, once per trip.
 * arrived: from the driver, CountryRules.chat.autoArrived.text in the RIDER's language (off with autoArrived.on false).
 * on_my_way: from the rider, chat.onTheWay.text in the DRIVER's language. The caller holds the trip lock, so the
 * "already written?" check cannot race (the unique index trip_messages_one_auto is the backstop).
 */
export async function writeAutoMessage(trx: Trx, trip: TripRow, auto: "arrived" | "on_my_way", now: Date): Promise<Message | null> {
  if (trip.driver_id === null) return null;
  const done = await trx.selectFrom("trip_messages").select("message_id").where("trip_id", "=", trip.trip_id).where("auto", "=", auto).executeTakeFirst();
  if (done) return null;
  if (auto === "arrived") {
    const settings = await chatSettingsFor(trx, trip.zone_id);
    if (!settings.autoArrived.on) return null;
    const lang = await languageOf(trx, { actor: "rider", subjectId: trip.rider_id }, trip.zone_id);
    return writeMessage(trx, trip, { from: "driver", senderId: trip.driver_id, text: settings.autoArrived.text[lang], auto }, now);
  }
  const lang = await languageOf(trx, { actor: "driver", subjectId: trip.driver_id }, trip.zone_id);
  return writeMessage(trx, trip, { from: "rider", senderId: trip.rider_id, text: ON_MY_WAY_TEXT[lang], auto }, now);
}

/** The message of a trip (for translate), or 404 message_not_found. */
export async function messageOfTrip(ex: Executor, tripId: string, messageId: string): Promise<Message> {
  const row = await ex.selectFrom("trip_messages").selectAll().where("trip_id", "=", tripId).where("message_id", "=", messageId).executeTakeFirst();
  if (!row) throw new ApiError("not_found", "No such message.", { reason: "message_not_found" });
  return messageView(row);
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
 * The daily retention (contract.json#chat.retention; v0.18.56 §78 chat.retentionV0_18_56): chat messages older than
 * CountryRules.chat.keepDays of the trip zone's country (default 90) go, and so does the copy in the trip's message
 * events; a trip with any incident keeps its chat with the case. Returns how many went.
 */
export async function purgeOldMessages(trx: Trx, now: Date): Promise<number> {
  const day = 24 * 60 * 60 * 1000;
  // keepDays is at least 1: only zones with a message older than a day can have anything to purge.
  const zones = await trx.selectFrom("trip_messages").innerJoin("trips", "trips.trip_id", "trip_messages.trip_id").select("trips.zone_id").distinct().where("trip_messages.created_at", "<", new Date(now.getTime() - day)).execute();
  let total = 0;
  for (const { zone_id: zoneId } of zones) {
    const before = new Date(now.getTime() - (await chatSettingsFor(trx, zoneId)).keepDays * day);
    const ofZone = trx.selectFrom("trips").select("trip_id").where((eb) => (zoneId === null ? eb("zone_id", "is", null) : eb("zone_id", "=", zoneId)));
    const safetyTrips = trx.selectFrom("incidents").select("trip_id").where("trip_id", "is not", null);
    const gone = await trx.deleteFrom("trip_messages").where("created_at", "<", before).where("trip_id", "in", ofZone as never).where("trip_id", "not in", safetyTrips as never).executeTakeFirst();
    // The event stays (its sequence is the stream's order); only the text goes.
    await trx.updateTable("trip_events").set({ message: null }).where("kind", "=", "message").where("message", "is not", null).where("occurred_at", "<", before).where("trip_id", "in", ofZone as never).where("trip_id", "not in", safetyTrips as never).execute();
    total += Number(gone.numDeletedRows);
  }
  return total;
}
