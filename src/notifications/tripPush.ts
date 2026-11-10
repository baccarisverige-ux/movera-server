import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { notify } from "./service.js";

/**
 * v0.18.13 (G13 recheck, audit 2026-11-02 H5, contract.json#riderTripPush): the rider hears about the key moments of
 * his trip even with the app closed — driver found, almost there, arrived, a new driver is being found, trip cancelled
 * (never for the rider's own cancel). Push + bell (v0.18.51 §73: riderTripPush bell true), in the rider's language (else the trip country's, else
 * English), and only while Rider.consents.rideUpdates is not false (the rider's notification setting, default on).
 */

type Lang = "sv" | "fr" | "en";
type Texts = Record<Lang, string>;
export type TripMoment = "driver_found" | "driver_arriving" | "driver_arrived" | "driver_changed" | "trip_cancelled" | "no_driver_found" | "trip_failed";
type Spec = { kind: string; deepLink: string; arrivingSeconds: number; texts: Record<TripMoment, { title: Texts; body: Texts }>; driverFallback: Texts };

export const RIDER_TRIP_PUSH: Spec = (contract as unknown as { riderTripPush: Spec }).riderTripPush;
const COUNTRY_LANGUAGE: Record<string, Lang> = { SE: "sv", FR: "fr" };

/**
 * v0.18.53 §75 (owner Q36-Q39 2026-11-09, contract.json#riderTripPush.consent, #support.answerPush, #bookLater.push.note):
 * Rider.consents.rideUpdates false stops ONLY the optional moments driver_found and driver_arriving. Always pushed,
 * whatever the switch: the trip moments below, the ride check, the booked-ride no-driver kinds (reservation_no_driver,
 * reservation_no_driver_found; reservation_lost is a DRIVER push) and a support answer.
 * The push dispatcher applies this in ONE place (src/push/dispatcher.ts pushOne); the bell row is always stored.
 */
export const RIDER_OPTIONAL_MOMENTS: ReadonlySet<string> = new Set<TripMoment>(["driver_found", "driver_arriving"]);
const ALWAYS_MOMENTS: ReadonlySet<string> = new Set<TripMoment>(["driver_arrived", "driver_changed", "trip_cancelled", "no_driver_found", "trip_failed"]);
const SUPPORT_ANSWER_KIND = (contract as unknown as { support: { answerPush: { kind: string } } }).support.answerPush.kind;
const BOOK_LATER_KINDS = (contract as unknown as { bookLater: { push: { kinds: string[] } } }).bookLater.push.kinds;
const RIDER_ALWAYS_KINDS: ReadonlySet<string> = new Set([
  "ride_check",
  SUPPORT_ANSWER_KIND,
  // v0.18.56 §78 (inAppCalls.push.when, owner A2): an incoming call always rings, whatever the ride-updates switch.
  "call_ringing",
  ...["reservation_no_driver", "reservation_no_driver_found"].filter((k) => BOOK_LATER_KINDS.includes(k)),
]);

/** True when a rider push goes even with rideUpdates false (unknown kinds: no, as before). */
export function riderPushAlwaysSent(kind: string, data: Record<string, unknown> | null | undefined): boolean {
  if (kind === RIDER_TRIP_PUSH.kind) {
    const moment = data?.["moment"];
    return typeof moment === "string" && ALWAYS_MOMENTS.has(moment);
  }
  return RIDER_ALWAYS_KINDS.has(kind);
}
const isLang = (value: unknown): value is Lang => value === "sv" || value === "fr" || value === "en";
// v0.18.50 §72 (owner L11): expired and failed have their own words (no_driver_found, trip_failed).
const CANCELLED_NOT_BY_RIDER = new Set(["cancelled_by_driver", "cancelled_by_admin", "cancelled_by_system"]);
const HAD_DRIVER = new Set(["accepted", "driver_to_pickup", "arrived"]);

/** The moment a lifecycle step is for the rider, or null (most steps are not pushed). */
export function momentOf(before: Pick<TripRow, "status" | "driver_id">, after: Pick<TripRow, "status"> & { kind?: string }): TripMoment | null {
  if (before.status === after.status) return null;
  // v0.18.17 (contract.json#bookLater.driver.accept): a booked ride taken from Scheduled rides sends its own message.
  if (after.status === "accepted" && before.status === "requested") return null;
  // v0.18.19 (liveFixes.driverFoundOnce): a booked ride tells the rider once per driver (reservations/service.ts).
  if (after.status === "accepted" && (after as { kind?: string }).kind === "scheduled") return null;
  if (after.status === "accepted") return "driver_found";
  if (after.status === "arrived") return "driver_arrived";
  if (after.status === "searching" && before.driver_id && HAD_DRIVER.has(before.status)) return "driver_changed";
  if (CANCELLED_NOT_BY_RIDER.has(after.status)) return "trip_cancelled";
  if (after.status === "expired") return "no_driver_found";
  if (after.status === "failed") return "trip_failed";
  return null;
}

/** Writes the push for one moment (inside the command's transaction; the push dispatcher sends it after commit). */
export async function pushTripMoment(ex: Executor, trip: Pick<TripRow, "trip_id" | "rider_id" | "zone_id" | "driver_summary">, moment: TripMoment, now: Date): Promise<boolean> {
  const rider = await ex.selectFrom("riders").select(["language", "consents"]).where("rider_id", "=", trip.rider_id).executeTakeFirst();
  if (!rider) return false;
  // Owner 2026-11-02 (decisions/driver-g13.md, last line) + v0.18.53 §75: "ride updates" off stops only "driver found"
  // and "arriving" (no row at all for those); every other moment is stored and the dispatcher always pushes it.
  if ((rider.consents as { rideUpdates?: unknown } | null)?.rideUpdates === false && RIDER_OPTIONAL_MOMENTS.has(moment)) return false;
  let language: Lang | undefined = isLang(rider.language) ? rider.language : undefined;
  if (language === undefined) {
    const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", trip.zone_id).executeTakeFirst();
    language = (zone && COUNTRY_LANGUAGE[zone.country]) ?? "en";
  }
  const text = RIDER_TRIP_PUSH.texts[moment];
  const name = (trip.driver_summary as { firstName?: string } | null)?.firstName?.trim() || RIDER_TRIP_PUSH.driverFallback[language];
  await notify(ex, {
    audience: "rider",
    subjectId: trip.rider_id,
    kind: RIDER_TRIP_PUSH.kind,
    title: text.title[language],
    body: text.body[language].replace("{driver}", name),
    deepLink: RIDER_TRIP_PUSH.deepLink.replace("{tripId}", trip.trip_id),
    tripId: trip.trip_id,
    // Deep fix 2026-11-02 (live sweep M-8): kept in the rider's Notifications list too (bell), with every language so
    // the list shows the rider's language of the moment he reads it.
    data: { tripId: trip.trip_id, moment, texts: { title: text.title, body: Object.fromEntries(Object.entries(text.body).map(([l, b]) => [l, b.replace("{driver}", (trip.driver_summary as { firstName?: string } | null)?.firstName?.trim() || RIDER_TRIP_PUSH.driverFallback[l as Lang])])) } },
  }, now);
  return true;
}

/** "Almost there": once per driver, when the server ETA to the pickup is at most arrivingSeconds. */
export async function maybePushArriving(ex: Executor, trip: TripRow, etaSeconds: number, now: Date): Promise<void> {
  if (etaSeconds > RIDER_TRIP_PUSH.arrivingSeconds || !trip.accepted_at || !HAD_DRIVER.has(trip.status) || trip.status === "arrived") return;
  const sent = await ex
    .selectFrom("notifications")
    .select("notification_id")
    .where("trip_id", "=", trip.trip_id)
    .where("kind", "=", RIDER_TRIP_PUSH.kind)
    .where("audience", "=", "rider")
    .where("created_at", ">=", trip.accepted_at)
    .where(sql<boolean>`data->>'moment' = 'driver_arriving'`)
    .executeTakeFirst();
  if (sent) return;
  await pushTripMoment(ex, trip, "driver_arriving", now);
}
