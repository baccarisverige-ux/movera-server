import { sql } from "kysely";
import type { Executor } from "../db/db.js";

/** The wallet currency of each country (contract.json walletCurrency: one balance per currency, never converted). */
export const COUNTRY_WALLET_CURRENCY: Record<string, string> = { SE: "SEK", FR: "EUR", TN: "TND" };

export type RiderPlace = { zoneId: string; country: string };

/**
 * BQ-A30c (one rule for the wallet credit and the admin rider view): each rider's zone and country — the zone of his
 * latest trip (in a known zone), else his last seen zone. A rider with neither is missing from the map.
 * One read for a whole page (index trips_rider_created per rider).
 */
export async function riderPlaces(ex: Executor, riderIds: string[]): Promise<Map<string, RiderPlace>> {
  const out = new Map<string, RiderPlace>();
  if (!riderIds.length) return out;
  const rows = await sql<{ rider_id: string; zone_id: string; country: string }>`
    select r.rider_id, z.zone_id, z.country
    from riders r
    left join lateral (
      select t.zone_id from trips t join zones tz on tz.zone_id = t.zone_id
      where t.rider_id = r.rider_id order by t.created_at desc limit 1
    ) latest on true
    join zones z on z.zone_id = coalesce(latest.zone_id, r.last_seen_zone_id)
    where r.rider_id = any(${sql.val(riderIds)}::text[])`.execute(ex);
  for (const r of rows.rows) out.set(r.rider_id, { zoneId: r.zone_id, country: r.country });
  return out;
}

/** The rider's zone and country (same order as riderPlaces); null when unknown. */
export async function riderPlace(ex: Executor, riderId: string): Promise<RiderPlace | null> {
  return (await riderPlaces(ex, [riderId])).get(riderId) ?? null;
}
