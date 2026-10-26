import { schemaProblem } from "../contract/schemas.js";
import type { Executor, Trx } from "../db/db.js";
import type { TripMessagesTable } from "../db/schema.js";
import { appendTripEvent, type TripRow } from "../db/tripLog.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { notify, type Audience } from "../notifications/service.js";
import { DRIVER_ASSIGNED, TERMINAL, type TripStatus } from "../rules/transitions.js";
import { lockOwnTrip, readOwnTrip } from "./commands.js";
import { tripProjection } from "./projection.js";
import type { Selectable } from "kysely";

/**
 * The trip chat (contract Message, GET and POST /trips/{tripId}/messages): the rider and the driver of a trip
 * write to each other, an admin writes as support. Each message is kept in trip_messages and goes out at once as
 * a trip event of kind message (§4) carrying the Message. A message is not a change of the trip: the event has
 * the trip's version as it is, and the apps' gate lets a message through even after the trip ended.
 */

export type MessageWho = { actor: "rider" | "driver" | "admin"; subjectId: string };
export type Message = { messageId: string; tripId: string; from: "rider" | "driver" | "support"; text: string; at: string };

type MessageRow = Selectable<TripMessagesTable>;

/** The chat stays open for an hour after the trip ended: a forgotten bag, a wrong door. */
const OPEN_AFTER_END_MS = 60 * 60 * 1000;

const messageView = (row: MessageRow): Message => ({ messageId: row.message_id, tripId: row.trip_id, from: row.sender, text: row.text, at: row.created_at.toISOString() });

/** Open from the moment a driver is on the trip until an hour after it ended; never before a driver, never later. */
function chatOpen(trip: TripRow, now: Date): boolean {
  if (trip.driver_id === null) return false;
  const status = trip.status as TripStatus;
  if (DRIVER_ASSIGNED.has(status)) return true;
  return TERMINAL.has(status) && trip.ended_at !== null && now.getTime() - trip.ended_at.getTime() <= OPEN_AFTER_END_MS;
}

/** POST /trips/{tripId}/messages → 201 Message. The caller's side is the token's actor; an admin writes as support. */
export async function sendMessage(trx: Trx, who: MessageWho, tripId: string, body: unknown, now: Date): Promise<Message> {
  const problem = schemaProblem("MessageRequest", body);
  if (problem !== null) throw badRequest(`The message is not valid: ${problem}.`, "invalid_body");
  const { text } = body as { text: string };
  if (text.trim() === "") throw badRequest("The message is empty.", "invalid_body");
  const trip = await lockOwnTrip(trx, tripId, who);
  if (!chatOpen(trip, now)) {
    throw new ApiError("invalid_transition", "You can write once a driver is on the trip, and for an hour after it ends.", { reason: "chat_closed", projection: tripProjection(trip, who.actor) });
  }
  const from = who.actor === "admin" ? "support" : who.actor;
  const message: Message = { messageId: newId("msg", now.getTime()), tripId, from, text, at: now.toISOString() };
  // The event's sequence is the chat's order; it is taken under the trip lock held above.
  const { sequence } = await appendTripEvent(trx, { tripId, kind: "message", version: trip.version, occurredAt: now, message });
  await trx.insertInto("trip_messages").values({ message_id: message.messageId, trip_id: tripId, sequence, sender: from, sender_id: who.subjectId, text, created_at: now }).execute();
  await tellTheOtherSide(trx, trip, message, now);
  return message;
}

/** GET /trips/{tripId}/messages?cursor&limit: oldest first; the cursor is the last message's place in the trip's event order. */
export async function listMessages(ex: Executor, who: MessageWho, tripId: string, input: { cursor?: string; limit: number }): Promise<{ items: Message[]; nextCursor: string | null }> {
  await readOwnTrip(ex, tripId, who);
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

const TITLE: Record<Message["from"], Record<string, string>> = {
  rider: { sv: "Meddelande från din passagerare", fr: "Message de votre passager", en: "Message from your rider" },
  driver: { sv: "Meddelande från din förare", fr: "Message de votre chauffeur", en: "Message from your driver" },
  support: { sv: "Meddelande från Movera", fr: "Message de Movera", en: "Message from Movera" },
};

/**
 * The other side is told in the app (GET /notifications, kind trip_message), the way the apps hear of anything
 * while push is off (contract §8): the rider's message reaches the driver, the driver's the rider, support's both.
 */
async function tellTheOtherSide(trx: Trx, trip: TripRow, message: Message, now: Date): Promise<void> {
  const sides: Array<{ audience: Audience; subjectId: string }> = [];
  if (message.from !== "rider") sides.push({ audience: "rider", subjectId: trip.rider_id });
  if (message.from !== "driver" && trip.driver_id !== null) sides.push({ audience: "driver", subjectId: trip.driver_id });
  for (const side of sides) {
    const row =
      side.audience === "rider"
        ? await trx.selectFrom("riders").select("language").where("rider_id", "=", side.subjectId).executeTakeFirst()
        : await trx.selectFrom("drivers").select("language").where("driver_id", "=", side.subjectId).executeTakeFirst();
    const title = TITLE[message.from][row?.language ?? "en"] ?? TITLE[message.from]["en"]!;
    await notify(trx, { ...side, kind: "trip_message", title, body: message.text, tripId: trip.trip_id, data: { messageId: message.messageId, from: message.from } }, now);
  }
}
