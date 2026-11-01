import { contract } from "../contract/contract.js";
import type { Trx } from "../db/db.js";
import { notify } from "../notifications/service.js";

/**
 * v0.18.9 owner rule 16 (2026-11-01, G7 open question 3, contract.json#onTrip.rideCheck.push): every server ride check
 * is also sent as a push to the rider and the driver (safety), so a phone in the background or locked still asks. Push
 * only (bell false), not sent after answerBy. Title texts.title, body texts.<trigger>, in the person's language, else
 * the trip's country language (SE sv, FR fr), else English.
 */

type Lang = "sv" | "fr" | "en";
type Texts = Record<Lang, string>;
type RideCheckContract = {
  push: { kind: string; deepLink: Record<"rider" | "driver", string>; sound: string; vibrate: boolean };
  texts: Record<string, Texts>;
};
const RC = (contract as unknown as { onTrip: { rideCheck: RideCheckContract } }).onTrip.rideCheck;
export const RIDE_CHECK_PUSH = RC.push;
const COUNTRY_LANGUAGE: Record<string, Lang> = { SE: "sv", FR: "fr" };
const isLang = (v: unknown): v is Lang => v === "sv" || v === "fr" || v === "en";

export async function queueRideCheckPush(
  trx: Trx,
  trip: { trip_id: string; zone_id: string },
  side: "rider" | "driver",
  subjectId: string,
  check: { checkId: string; trigger: string; answerBy: string },
  now: Date,
): Promise<void> {
  const person =
    side === "rider"
      ? await trx.selectFrom("riders").select("language").where("rider_id", "=", subjectId).executeTakeFirst()
      : await trx.selectFrom("drivers").select("language").where("driver_id", "=", subjectId).executeTakeFirst();
  let language: Lang | undefined = isLang(person?.language) ? person.language : undefined;
  if (language === undefined) {
    const zone = await trx.selectFrom("zones").select("country").where("zone_id", "=", trip.zone_id).executeTakeFirst();
    language = (zone && COUNTRY_LANGUAGE[zone.country]) ?? "en";
  }
  const body = RC.texts[check.trigger] ?? RC.texts["title"]!;
  await notify(
    trx,
    {
      audience: side,
      subjectId,
      kind: RC.push.kind,
      title: RC.texts["title"]![language],
      body: body[language],
      deepLink: RC.push.deepLink[side].replace("{tripId}", trip.trip_id),
      tripId: trip.trip_id,
      data: { tripId: trip.trip_id, checkId: check.checkId, trigger: check.trigger, answerBy: check.answerBy, sound: RC.push.sound, vibrate: RC.push.vibrate ? "true" : "false" },
      bell: false,
      pushUntil: new Date(check.answerBy),
    },
    now,
  );
}
