import type { Executor } from "../../db/db.js";
import { appendTripEvent, type TripRow } from "../../db/tripLog.js";
import type { TimerHandler } from "../../jobs/timers.js";
import { haversineKm } from "../../maps/routing.js";
import { lockTripNow } from "../../dispatch/runtime.js";
import { tripProjection } from "../projection.js";
import type { WaitingExtras } from "../waitingRules.js";
import { inPolygon, type Polygon } from "../../zones/geometry.js";
import type { Place, WaitingAlert, Waiting } from "./shared.js";

/* ---------------------------------------------------------------- waiting rules and island alerts (v0.18.8) */

/**
 * contract.json#arrivedWaiting.rules.match.event: an admin event of the trip's country that is on and running now (until
 * endsAt + afterEndMin), with the pickup inside its polygon, or within radiusMeters of its location when it has none.
 */
export async function pickupInRunningEvent(ex: Executor, trip: TripRow, rules: WaitingExtras, now: Date): Promise<boolean> {
  const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", trip.zone_id).executeTakeFirst();
  if (!zone) return false;
  const after = rules.rideTypes.event.afterEndMin * 60_000;
  const events = await ex.selectFrom("area_events").select(["lat", "lng", "polygon", "ends_at"]).where("country", "=", zone.country).where("is_on", "=", true).where("starts_at", "<=", now).execute();
  const pickup = trip.pickup as Place;
  return events.some((e) => {
    if (e.ends_at.getTime() + after < now.getTime()) return false;
    const polygon = e.polygon as Polygon | null;
    if (polygon) return inPolygon(pickup.lat, pickup.lng, polygon);
    return haversineKm(pickup, { lat: e.lat, lng: e.lng }) * 1000 <= rules.rideTypes.event.radiusMeters;
  });
}

export const WAITING_PAID = "waiting_paid";
export const WAITING_NO_SHOW = "waiting_no_show";

/** One island alert on the trip (no version change) and a trip_projection event, while the driver still waits from the same arrival. */
export function waitingAlertHandler(kind: WaitingAlert["kind"]): TimerHandler {
  return async (trx, timer) => {
    const trip = await lockTripNow(trx, timer.refId);
    const waiting = trip?.waiting as Waiting | null | undefined;
    if (!trip || trip.status !== "arrived" || !waiting) return;
    if ((timer.payload as { arrivedAt?: string } | null)?.arrivedAt !== waiting.arrivedAt) return;
    if ((waiting.alerts ?? []).some((a) => a.kind === kind)) return;
    const next: Waiting = { ...waiting, alerts: [...(waiting.alerts ?? []), { kind, at: timer.firedAt.toISOString() }] };
    await trx.updateTable("trips").set({ waiting: JSON.stringify(next) }).where("trip_id", "=", trip.trip_id).execute();
    const updated = await trx.selectFrom("trips").selectAll().where("trip_id", "=", trip.trip_id).executeTakeFirstOrThrow();
    await appendTripEvent(trx, { tripId: trip.trip_id, kind: "trip_projection", version: updated.version, occurredAt: timer.firedAt, projection: tripProjection(updated, "admin", { sequence: Number(updated.sequence) + 1, now: timer.firedAt }) });
  };
}
