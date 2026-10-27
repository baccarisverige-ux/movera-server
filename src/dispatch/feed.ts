import type { Principal } from "../auth/guard.js";
import type { Executor } from "../db/db.js";
import { offerView } from "./runtime.js";
import { tripProjection } from "../trips/projection.js";

/**
 * The admin dispatch feed (contract §4 AdminDispatchEvent, GET /admin/dispatch/stream): offers sent, declined,
 * expired, withdrawn and accepted, the lock and driver bonuses. Rows come from dispatch_events, which triggers on
 * offers and trips write (migration 0022), so no dispatch path can forget one.
 */

export const DISPATCH_EVENTS_CHANNEL = "movera_dispatch_events";

export type DispatchEventRow = { sequence: string; event_id: string; kind: string; trip_id: string; zone_id: string | null; offer_id: string | null; group_id: string | null; occurred_at: Date };

export async function dispatchEventsAfter(ex: Executor, after: number, limit: number, zoneId?: string): Promise<DispatchEventRow[]> {
  let q = ex.selectFrom("dispatch_events").selectAll().where("sequence", ">", String(after));
  if (zoneId) q = q.where("zone_id", "=", zoneId);
  return q.orderBy("sequence").limit(limit).execute();
}

/** Only events of the admin's zones. */
export function mayHearDispatch(who: Principal, row: DispatchEventRow): boolean {
  return who.zones.includes("*") || (row.zone_id !== null && who.zones.includes(row.zone_id));
}

/** The AdminDispatchEvent of a row, with the offer and the trip as they are now. */
export async function dispatchEventOf(ex: Executor, row: DispatchEventRow, serverTime: Date) {
  const trip = await ex.selectFrom("trips").selectAll().where("trip_id", "=", row.trip_id).executeTakeFirst();
  const offer = row.offer_id ? await ex.selectFrom("offers").selectAll().where("offer_id", "=", row.offer_id).executeTakeFirst() : undefined;
  return {
    eventId: row.event_id,
    sequence: Number(row.sequence),
    kind: row.kind,
    tripId: row.trip_id,
    ...(row.group_id ? { groupId: row.group_id } : {}),
    ...(offer && trip ? { offer: { ...offerView(offer, trip), driverId: offer.driver_id } } : {}),
    ...(trip ? { projection: tripProjection(trip, "admin") } : {}),
    occurredAt: row.occurred_at.toISOString(),
    serverTime: serverTime.toISOString(),
  };
}
