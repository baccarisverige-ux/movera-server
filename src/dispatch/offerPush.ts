import type { Executor, Trx } from "../db/db.js";
import { contract } from "../contract/contract.js";
import { notify } from "../notifications/service.js";
import { ownLanguage, pickNoticeLanguage } from "../notifications/noticeLanguage.js";

/**
 * Contract v0.18.6 §31 (owner G4 decision 1 "Push + sound + vibration", E6 "Sound + vibration",
 * contract.json#driverOffers.push): every new offer also goes to the driver as a push, so a driver whose app is in the
 * background or whose phone is locked hears it. It travels through the push outbox (notifications, sent by the push
 * dispatcher after the command commits) but is not a bell notice (bell = false: never in GET /notifications), and it is
 * not sent after the offer's expiresAt. Exclusive and hand-sent (assigned) offers: the offer sound + vibration; Radar:
 * quiet. Title and body in the driver's language, else the language of the trip's country (SE sv, FR fr), else English.
 */

type Lang = "sv" | "fr" | "en";
type Texts = Record<Lang, string>;
type OfferPush = {
  kind: string;
  deepLink: string;
  sound: Record<string, "offer" | "none">;
  vibrate: Record<string, boolean>;
  texts: { title: { exclusive: Texts; radar: Texts }; body: Texts };
};

export const OFFER_PUSH: OfferPush = (contract as unknown as { driverOffers: { push: OfferPush } }).driverOffers.push;

/** The sound rule of an offer kind (E6): exclusive / assigned = offer sound + vibrate; radar and anything else quiet. */
export function offerSound(kind: string): { sound: "offer" | "none"; vibrate: boolean } {
  return { sound: OFFER_PUSH.sound[kind] ?? "none", vibrate: OFFER_PUSH.vibrate[kind] ?? false };
}

/** Writes the push for one offer_created event, inside the transaction that created the offer. */
export async function queueOfferPush(trx: Trx, driverId: string, offer: Record<string, unknown>, now: Date): Promise<void> {
  const offerId = String(offer["offerId"]);
  const tripId = String(offer["tripId"]);
  const kind = String(offer["kind"]);
  const expiresAt = String(offer["expiresAt"]);
  // v0.18.66 §87: the one notice-language rule (his language, else the trip country's, TN fr, else en).
  // The trip's country is read only when he has no language (an offer push is on the dispatch path).
  const driver = await trx.selectFrom("drivers").select("language").where("driver_id", "=", driverId).executeTakeFirst();
  const language: Lang = ownLanguage(driver?.language)
    ?? pickNoticeLanguage(null, (await trx.selectFrom("trips").innerJoin("zones", "zones.zone_id", "trips.zone_id").select("zones.country").where("trips.trip_id", "=", tripId).executeTakeFirst())?.country);
  const { sound, vibrate } = offerSound(kind);
  const title = (sound === "offer" ? OFFER_PUSH.texts.title.exclusive : OFFER_PUSH.texts.title.radar)[language];
  await notify(
    trx,
    {
      audience: "driver",
      subjectId: driverId,
      kind: OFFER_PUSH.kind,
      title,
      body: OFFER_PUSH.texts.body[language],
      deepLink: OFFER_PUSH.deepLink.replace("{offerId}", offerId),
      tripId,
      data: { offerId, tripId, offerKind: kind, sound, vibrate: vibrate ? "true" : "false", expiresAt },
      bell: false,
      pushUntil: new Date(expiresAt),
    },
    now,
  );
}

/** Checker LOW 10: new-offer push rows are useless once their offer ran out; they go a day after push_until. */
export const OFFER_PUSH_KEEP_MS = 24 * 60 * 60 * 1000;

/** S4 0.14b: `limit` = at most that many rows in one statement (the housekeeping timer comes back soon while more are left). */
export async function purgeOfferPushes(ex: Executor, now: Date, limit?: number): Promise<number> {
  const cutoff = new Date(now.getTime() - OFFER_PUSH_KEEP_MS);
  const stale = ex
    .selectFrom("notifications")
    .select("notification_id")
    .where("bell", "=", false)
    .where("kind", "=", OFFER_PUSH.kind)
    .where((eb) => eb.or([eb("push_until", "<", cutoff), eb.and([eb("push_until", "is", null), eb("created_at", "<", cutoff)])]));
  let query = ex
    .deleteFrom("notifications")
    .where("bell", "=", false)
    .where("kind", "=", OFFER_PUSH.kind)
    .where((eb) => eb.or([eb("push_until", "<", cutoff), eb.and([eb("push_until", "is", null), eb("created_at", "<", cutoff)])]));
  if (limit !== undefined) query = query.where("notification_id", "in", stale.limit(limit));
  const gone = await query.executeTakeFirst();
  return Number(gone.numDeletedRows);
}
