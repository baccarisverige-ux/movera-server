import type { Trx } from "../db/db.js";
import { contract } from "../contract/contract.js";
import { notify } from "../notifications/service.js";

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
const COUNTRY_LANGUAGE: Record<string, Lang> = { SE: "sv", FR: "fr" };

const isLang = (value: unknown): value is Lang => value === "sv" || value === "fr" || value === "en";

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
  const driver = await trx.selectFrom("drivers").select("language").where("driver_id", "=", driverId).executeTakeFirst();
  let language: Lang | undefined = isLang(driver?.language) ? driver.language : undefined;
  if (language === undefined) {
    const zone = await trx.selectFrom("trips").innerJoin("zones", "zones.zone_id", "trips.zone_id").select("zones.country").where("trips.trip_id", "=", tripId).executeTakeFirst();
    language = (zone && COUNTRY_LANGUAGE[zone.country]) ?? "en";
  }
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
