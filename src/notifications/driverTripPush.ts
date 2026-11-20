import { moneyText, type CurrencyCode } from "../rules/money.js";
import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { notify } from "./service.js";
import { noticeLanguage } from "./noticeLanguage.js";

/**
 * v0.18.50 §72 (owner L1, contract.json#driverTripPush): the driver hears when his trip ends or leaves him because of
 * someone else — the rider cancels or ends early, an admin cancels, reassigns or marks a no-show — with the app closed
 * or in Waze. Bell + push, in his language (else the trip country's, else English), written in the command's
 * transaction (the push dispatcher sends it after commit), so any server copy writes it once (rule 33).
 */

type Lang = "sv" | "fr" | "en";
type Texts = Record<Lang, string>;
export type DriverTripMoment = "rider_cancelled" | "rider_ended_early" | "admin_cancelled" | "admin_reassigned" | "admin_no_show";
type Spec = { kind: string; deepLink: string; title: Texts; texts: Record<DriverTripMoment | "fee", Texts> };

export const DRIVER_TRIP_PUSH: Spec = (contract as unknown as { driverTripPush: Spec }).driverTripPush;

/** The driver's moment for a lifecycle step, or null: only steps someone else took on a trip he was on. */
export function driverMomentOf(before: Pick<TripRow, "driver_id" | "next_after_trip_id">, command: string, actor: string): DriverTripMoment | null {
  if (before.driver_id === null) return null;
  if (actor === "rider") {
    // The rider's cancel of a queued next trip has its own notice (next_trip_cancelled, owner Q3 2026-11-05).
    if (command === "cancel") return before.next_after_trip_id ? null : "rider_cancelled";
    if (command === "end_early") return "rider_ended_early";
    return null;
  }
  if (actor === "admin") {
    if (command === "cancel") return "admin_cancelled";
    if (command === "reassign") return "admin_reassigned";
    if (command === "no_show") return "admin_no_show";
  }
  return null;
}

// contract.json#moneyDisplay (owner 2026-11-14): the currency's own format in every language, whole amounts with decimals.
export const amountText = (amountMinor: number, currency: string, _lang: Lang) => moneyText({ amountMinor, currency: currency as CurrencyCode });

/** Writes the driver's notice for `moment` on the trip as it is after the step (its cancellation carries his share). */
export async function pushDriverTripMoment(ex: Executor, driverId: string, after: Pick<TripRow, "trip_id" | "zone_id" | "cancellation">, moment: DriverTripMoment, now: Date): Promise<void> {
  // v0.18.66 §87: the one notice-language rule (his language, else the trip country's, TN fr, else en).
  const lang: Lang = await noticeLanguage(ex, { actor: "driver", id: driverId }, after.zone_id);
  const share = (after.cancellation as { driverShare?: { amountMinor?: number; currency?: string } } | null)?.driverShare;
  const fee = share && typeof share.amountMinor === "number" && share.amountMinor > 0 && typeof share.currency === "string" ? { amountMinor: share.amountMinor, currency: share.currency } : null;
  const bodyIn = (l: Lang) => DRIVER_TRIP_PUSH.texts[moment][l] + (fee ? " " + DRIVER_TRIP_PUSH.texts.fee[l].replace("{amount}", amountText(fee.amountMinor, fee.currency, l)) : "");
  const body = bodyIn(lang);
  await notify(ex, {
    audience: "driver",
    subjectId: driverId,
    kind: DRIVER_TRIP_PUSH.kind,
    title: DRIVER_TRIP_PUSH.title[lang],
    body,
    deepLink: DRIVER_TRIP_PUSH.deepLink.replace("{tripId}", after.trip_id),
    tripId: after.trip_id,
    // Audit 2026-11-20 N4: every language kept, so the bell reads in the driver's language now (not the one at send time).
    data: { tripId: after.trip_id, moment, ...(fee ? { fee } : {}), texts: { title: DRIVER_TRIP_PUSH.title, body: { sv: bodyIn("sv"), fr: bodyIn("fr"), en: bodyIn("en") } } },
  }, now);
}
