import { ApiError, badRequest } from "../http/errors.js";
import type { Executor } from "../db/db.js";
import { TERMINAL, type TripStatus } from "../rules/transitions.js";
import { readOwnTrip } from "../trips/commands.js";
import { messageOfTrip } from "../trips/messages.js";
import { tripProjection } from "../trips/projection.js";
import { chatSettingsFor, isLang, languageOf, type Lang } from "./settings.js";

/**
 * v0.18.56 §78 (chat.translate; owner g9 2b, 3 and A1 2026-11-10): POST /trips/{tripId}/messages/translate. The
 * target is the reading user's own app language. The provider is a plug-in: until one is configured (keys only in
 * the server environment; owner: "provider later") the route answers 503 coming_soon.
 *
 * v0.18.64 §85 (chat.autoTranslate; owner 2026-11-11 "the language must arrive with the receiver language"): the apps
 * ask by themselves as a message arrives (`auto: true`, 403 auto_translate_off when the admin turned that off); a chip or
 * an automatic message already in the target language answers its own text with no provider call (typed text: lang is a
 * hint, the provider reads it, 2026-11-12); a translation is made once per
 * message and language and kept (trip_message_translations, migration 0097), so another device, a reopen, a retry or
 * another server copy reads the kept text (Rule 33: the cache is in the database, never in one copy's memory).
 */
export interface Translator {
  translate(text: string, to: Lang): Promise<string>;
}

export type TranslatedMessage = { messageId: string; to: Lang; text: string };

export async function translateMessage(ex: Executor, translator: Translator | undefined, who: { actor: "rider" | "driver"; subjectId: string }, tripId: string, body: unknown, now: Date = new Date()): Promise<TranslatedMessage> {
  // Who may see the trip first (404 for anyone else), then the body.
  const trip = await readOwnTrip(ex, tripId, who);
  const b = (body ?? {}) as { messageId?: unknown; to?: unknown; auto?: unknown };
  if (typeof b.messageId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(b.messageId) || !isLang(b.to) || (b.auto !== undefined && typeof b.auto !== "boolean")) {
    throw badRequest("messageId and to (sv, fr or en) are needed; auto is true or false.", "invalid_body");
  }
  if (trip.driver_id === null || TERMINAL.has(trip.status as TripStatus)) {
    throw new ApiError("invalid_transition", "The chat is closed.", { reason: "chat_closed", projection: tripProjection(trip, who.actor) });
  }
  const settings = await chatSettingsFor(ex, trip.zone_id);
  if (!settings.translation) throw new ApiError("forbidden", "Translation is switched off.", { reason: "translation_off" });
  if (b.auto === true && !settings.autoTranslate) throw new ApiError("forbidden", "Automatic translation is switched off.", { reason: "auto_translate_off" });
  const own = await languageOf(ex, who, trip.zone_id);
  if (b.to !== own) throw badRequest("Messages are translated to your own app language only.", "translate_target_not_allowed");
  const message = await messageOfTrip(ex, tripId, b.messageId);
  const answer = (text: string): TranslatedMessage => ({ messageId: message.messageId, to: own, text });
  // chat.autoTranslate.sameLanguage: already in the reader's language. Only a chip or an automatic message is known to
  // be (its lang is exact); typed text's lang is the sender's app language, a hint only (sourceLanguage): a person may
  // type in another language, so the provider reads the text (live bug 2026-11-12: English from a fr app stayed English).
  if (message.lang === own && (message.quickReplyId !== undefined || message.auto !== undefined)) return answer(message.text);
  const kept = await keptTranslation(ex, message.messageId, own);
  if (kept !== null) return answer(kept);
  if (translator === undefined) throw new ApiError("unavailable", "Translation coming soon.", { reason: "coming_soon" });
  const text = (await translator.translate(message.text, own)).trim();
  if (text === "") throw new ApiError("unavailable", "Translation coming soon.", { reason: "coming_soon" });
  // Two requests at once may both ask the provider: the first kept text wins and both answer it.
  await ex.insertInto("trip_message_translations").values({ message_id: message.messageId, lang: own, text, created_at: now })
    .onConflict((oc) => oc.columns(["message_id", "lang"]).doNothing()).execute();
  return answer((await keptTranslation(ex, message.messageId, own)) ?? text);
}

async function keptTranslation(ex: Executor, messageId: string, lang: Lang): Promise<string | null> {
  const row = await ex.selectFrom("trip_message_translations").select("text").where("message_id", "=", messageId).where("lang", "=", lang).executeTakeFirst();
  return row?.text ?? null;
}
