import { sql } from "kysely";
import { zoneAt } from "../config/zoneLookup.js";
import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";

/**
 * Contract v0.18.4 §29 (contract.json#driverHome.ridersOnline, owner G3-R4 "Real numbers only"): a rider is online in
 * a zone while his map (GET /rider/nearby-vehicles) or a price (POST /quotes) was asked there in the last
 * windowSeconds, or while he has an open live request there. Nothing is invented.
 */
const WINDOW_SECONDS = (contract as unknown as { driverHome: { ridersOnline: { windowSeconds: number } } }).driverHome.ridersOnline.windowSeconds;
/** One write per rider per this many seconds while he stays in one zone. */
const THROTTLE_MS = 30_000;
const OPEN_REQUEST = ["requested", "searching", "offered"] as const;

export async function markRiderSeen(ex: Executor, riderId: string, point: { lat: number; lng: number }, now: Date): Promise<void> {
  const zone = await zoneAt(ex, point);
  if (zone === null) return;
  await ex
    .updateTable("riders")
    .set({ last_seen_at: now, last_seen_zone_id: zone.zoneId })
    .where("rider_id", "=", riderId)
    .where((eb) => eb.or([eb("last_seen_at", "is", null), eb("last_seen_at", "<", new Date(now.getTime() - THROTTLE_MS)), eb("last_seen_at", ">", now), eb("last_seen_zone_id", "is distinct from", zone.zoneId)]))
    .execute();
}

/** [{ zoneId, count }] for every open operating zone the admin covers ("*" = all), 0 included. */
export async function ridersOnlineByZone(ex: Executor, zones: string[], now: Date): Promise<Array<{ zoneId: string; count: number }>> {
  const since = new Date(now.getTime() - WINDOW_SECONDS * 1000);
  const rows = await sql<{ zone_id: string; n: string }>`
    SELECT zone_id, count(DISTINCT rider_id) AS n FROM (
      SELECT rider_id, last_seen_zone_id AS zone_id FROM riders WHERE last_seen_at > ${since} AND last_seen_at <= ${now} AND last_seen_zone_id IS NOT NULL
      UNION
      SELECT rider_id, zone_id FROM trips WHERE kind = 'live' AND status IN (${sql.join(OPEN_REQUEST.map((s) => sql`${s}`))})
    ) seen GROUP BY zone_id`.execute(ex);
  let q = ex.selectFrom("zones").select("zone_id").where("open", "=", true).where("kind", "=", "operating").orderBy("zone_id");
  if (!zones.includes("*")) q = zones.length ? q.where("zone_id", "in", zones) : q.where(sql<boolean>`false`);
  const list = (await q.execute()).map((z) => z.zone_id);
  return list.map((zoneId) => ({ zoneId, count: Number(rows.rows.find((r) => r.zone_id === zoneId)?.n ?? 0) }));
}

export const RIDERS_ONLINE_WINDOW_SECONDS = WINDOW_SECONDS;
