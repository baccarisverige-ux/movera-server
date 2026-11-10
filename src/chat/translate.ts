import { ApiError, badRequest } from "../http/errors.js";
import type { Executor } from "../db/db.js";
import { TERMINAL, type TripStatus } from "../rules/transitions.js";
import { readOwnTrip } from "../trips/commands.js";
import { messageOfTrip } from "../trips/messages.js";
import { tripProjection } from "../trips/projection.js";
import { chatSettingsFor, isLang, languageOf, type Lang } from "./settings.js";

/**
 * v0.18.56 §78 (chat.translate; owner g9 2b, 3 and A1 2026-11-10): POST /trips/{tripId}/messages/translate. The
 * target is the reading user's own app language; nothing is stored. The provider is a plug-in: until one is
 * configured (keys only in the server environment; owner: "provider later") the route answers 503 coming_soon.
 */
export interface Translator {
  translate(text: string, to: Lang): Promise<string>;
}

export async function translateMessage(ex: Executor, translator: Translator | undefined, who: { actor: "rider" | "driver"; subjectId: string }, tripId: string, body: unknown) {
  const b = (body ?? {}) as { messageId?: unknown; to?: unknown };
  if (typeof b.messageId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(b.messageId) || !isLang(b.to)) throw badRequest("messageId and to (sv, fr or en) are needed.", "invalid_body");
  const trip = await readOwnTrip(ex, tripId, who);
  if (trip.driver_id === null || TERMINAL.has(trip.status as TripStatus)) {
    throw new ApiError("invalid_transition", "The chat is closed.", { reason: "chat_closed", projection: tripProjection(trip, who.actor) });
  }
  const settings = await chatSettingsFor(ex, trip.zone_id);
  if (!settings.translation) throw new ApiError("forbidden", "Translation is switched off.", { reason: "translation_off" });
  const own = await languageOf(ex, who, trip.zone_id);
  if (b.to !== own) throw badRequest("Messages are translated to your own app language only.", "translate_target_not_allowed");
  const message = await messageOfTrip(ex, tripId, b.messageId);
  if (translator === undefined) throw new ApiError("unavailable", "Translation coming soon.", { reason: "coming_soon" });
  return { messageId: message.messageId, to: own, text: await translator.translate(message.text, own) };
}
