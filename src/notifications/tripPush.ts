import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { notify } from "./service.js";

/**
 * v0.18.13 (G13 recheck, audit 2026-11-02 H5, contract.json#riderTripPush): the rider hears about the key moments of
 * his trip even with the app closed — driver found, almost there, arrived, a new driver is being found, trip cancelled
 * (never for the rider's own cancel). Push only (bell false), in the rider's language (else the trip country's, else
 * English), and only while Rider.consents.rideUpdates is not false (the rider's notification setting, default on).
 */

type Lang = "sv" | "fr" | "en";
type Texts = Record<Lang, string>;
export type TripMoment = "driver_found" | "driver_arriving" | "driver_arrived" | "driver_changed" | "trip_cancelled";
type Spec = { kind: string; deepLink: string; arrivingSeconds: number; texts: Record<TripMoment, { title: Texts; body: Texts }>; driverFallback: Texts };

export const RIDER_TRIP_PUSH: Spec = (contract as unknown as { riderTripPush: Spec }).riderTripPush;
const COUNTRY_LANGUAGE: Record<string, Lang> = { SE: "sv", FR: "fr" };
const isLang = (value: unknown): value is Lang => value === "sv" || value === "fr" || value === "en";
const CANCELLED_NOT_BY_RIDER = new Set(["cancelled_by_driver", "cancelled_by_admin", "cancelled_by_system", "expired", "failed"]);
const HAD_DRIVER = new Set(["accepted", "driver_to_pickup", "arrived"]);

/** The moment a lifecycle step is for the rider, or null (most steps are not pushed). */
export function momentOf(before: Pick<TripRow, "status" | "driver_id">, after: Pick<TripRow, "status">): TripMoment | null {
  if (before.status === after.status) return null;
  if (after.status === "accepted") return "driver_found";
  if (after.status === "arrived") return "driver_arrived";
  if (after.status === "searching" && before.driver_id && HAD_DRIVER.has(before.status)) return "driver_changed";
  if (CANCELLED_NOT_BY_RIDER.has(after.status)) return "trip_cancelled";
  return null;
}

/** Writes the push for one moment (inside the command's transaction; the push dispatcher sends it after commit). */
export async function pushTripMoment(ex: Executor, trip: Pick<TripRow, "trip_id" | "rider_id" | "zone_id" | "driver_summary">, moment: TripMoment, now: Date): Promise<boolean> {
  const rider = await ex.selectFrom("riders").select(["language", "consents"]).where("rider_id", "=", trip.rider_id).executeTakeFirst();
  if (!rider) return false;
  if ((rider.consents as { rideUpdates?: unknown } | null)?.rideUpdates === false) return false;
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
    data: { tripId: trip.trip_id, moment },
    bell: false,
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
