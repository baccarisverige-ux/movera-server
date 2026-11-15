import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { newId } from "../ids.js";
import { scrubText } from "../telemetry/scrub.js";
import type { Polygon } from "../zones/geometry.js";
import { foldFixes, insideArea, samePhone, type HoursFix, type HoursState, type Window } from "./rules.js";

/**
 * v0.18.103 BQ-V44 (contract.json#bonusCampaigns.counting / .award): counting trips and online time, and the award.
 * - MF1 award: the gate is `UPDATE bonus_progress SET earned_at = now … WHERE earned_at IS NULL AND done ≥ target
 *   RETURNING` (the row lock gives one winner); only the winner inserts the entry, `ON CONFLICT (driver_id, bonus_id)
 *   WHERE bonus_id IS NOT NULL DO NOTHING` (the unique index earnings_bonus_once is the second guard). A lost race is a
 *   no-op. The counting runs in a SAVEPOINT, so nothing here can fail the trip end (creditTrip) or POST /driver/location.
 *   Several campaigns: in bonus_id order (no deadlock between two copies).
 * - MF2: every counting UPDATE re-checks in SQL status = 'active' and that now is inside the window (starts_at, ends_at);
 *   the campaign cache below is only a pre-filter.
 * - MF5: only drivers whose zone_ids include the campaign's zone, account active.
 * - MF3 (online_hours) in rules.ts foldFixes; one guarded write per batch and campaign, only when a fix was counted.
 * - MF7 (trips): one rider once per driver, campaign and zone-local day (bonus_rider_days); never his own phone.
 * earnedAt and the entry's at are the server's now.
 */

export type CampaignRow = Window & {
  bonusId: string;
  zoneId: string;
  measure: "trips" | "online_hours";
  target: number;
  amountMinor: number;
  currency: string;
  timeZone: string;
  polygon: Polygon;
  south: number;
  west: number;
  north: number;
  east: number;
};

type RawCampaign = {
  bonus_id: string; zone_id: string; measure: "trips" | "online_hours"; target: number; amount_minor: string; currency: string; time_zone: string;
  polygon: Polygon; south: number; west: number; north: number; east: number; status: string; pauses: Array<[string, string | null]>;
  ended_at: Date | null; starts_at: Date; ends_at: Date;
};
const campaignOf = (r: RawCampaign): CampaignRow => ({
  bonusId: r.bonus_id, zoneId: r.zone_id, measure: r.measure, target: Number(r.target), amountMinor: Number(r.amount_minor), currency: r.currency.trim(), timeZone: r.time_zone,
  polygon: r.polygon, south: Number(r.south), west: Number(r.west), north: Number(r.north), east: Number(r.east), status: r.status, pauses: r.pauses ?? [],
  endedAt: r.ended_at, startsAt: r.starts_at, endsAt: r.ends_at,
});
const CAMPAIGN_COLUMNS = sql`c.bonus_id, c.zone_id, c.measure, c.target, c.amount_minor, c.currency, z.time_zone, c.polygon, c.south, c.west, c.north, c.east, c.status, c.pauses, c.ended_at, c.starts_at, c.ends_at`;

/** MF2: the SQL re-check of every counting UPDATE (campaign row aliased c). */
const stillActive = (now: Date) => sql`c.status = 'active' AND c.starts_at <= ${now} AND ${now} < c.ends_at`;

/* ---------------------------------------------------------------- the campaign cache (pre-filter only) */

/** Rule 33: active online_hours campaigns kept about 30 s per server copy, so a fix outside every area writes nothing. */
export const CACHE_SECONDS = 30;
const cache: { loadedAt: number; until: number; rows: CampaignRow[] } = { loadedAt: 0, until: 0, rows: [] };

/** Forget the cached campaigns (this copy wrote one; other copies follow within CACHE_SECONDS, MF2 guards the rest). */
export function forgetBonusCampaigns(): void {
  cache.until = 0;
}

async function hoursCampaigns(ex: Executor, now: Date): Promise<CampaignRow[]> {
  const t = now.getTime();
  if (t < cache.until && t >= cache.loadedAt) return cache.rows;
  const rows = await sql<RawCampaign>`
    SELECT ${CAMPAIGN_COLUMNS} FROM bonus_campaigns c JOIN zones z ON z.zone_id = c.zone_id
     WHERE c.status <> 'ended' AND c.measure = 'online_hours' AND c.ends_at > ${now}
     ORDER BY c.bonus_id`.execute(ex);
  cache.rows = rows.rows.map(campaignOf);
  cache.loadedAt = t;
  cache.until = t + CACHE_SECONDS * 1000;
  return cache.rows;
}

/* ---------------------------------------------------------------- the award (MF1) */

/**
 * The driver reached the target: the earned_at gate (one winner), then one entry kind bonus with bonus_id, trip_id
 * NULL, the campaign's amount and currency, at = now. Returns the entry id when this call won, else null.
 */
export async function award(trx: Trx, c: CampaignRow, driverId: string, now: Date): Promise<string | null> {
  const done = c.measure === "trips" ? sql`p.trips >= ${c.target}` : sql`p.online_seconds >= ${c.target * 3600}`;
  const won = await sql<{ driver_id: string }>`
    UPDATE bonus_progress p SET earned_at = ${now}, updated_at = ${now}
     WHERE p.bonus_id = ${c.bonusId} AND p.driver_id = ${driverId} AND p.earned_at IS NULL AND ${done}
    RETURNING p.driver_id`.execute(trx);
  if (won.rows.length === 0) return null;
  const entryId = newId("ern", now.getTime());
  const inserted = await sql<{ entry_id: string }>`
    INSERT INTO earnings_entries (entry_id, driver_id, trip_id, kind, currency, amount_minor, gross_minor, commission_minor, cash_minor, at, bonus_id)
    VALUES (${entryId}, ${driverId}, NULL, 'bonus', ${c.currency}, ${c.amountMinor}, NULL, NULL, NULL, ${now}, ${c.bonusId})
    ON CONFLICT (driver_id, bonus_id) WHERE bonus_id IS NOT NULL DO NOTHING
    RETURNING entry_id`.execute(trx);
  const paid = inserted.rows[0]?.entry_id ?? null;
  const id = paid ?? (await trx.selectFrom("earnings_entries").select("entry_id").where("driver_id", "=", driverId).where("bonus_id", "=", c.bonusId).executeTakeFirst())?.entry_id ?? null;
  await trx.updateTable("bonus_progress").set({ entry_id: id }).where("bonus_id", "=", c.bonusId).where("driver_id", "=", driverId).execute();
  return paid;
}

/** Runs one counting step in a savepoint: any error rolls back only the counting, never the caller (MF1.3). */
async function safely(trx: Trx, what: string, ids: Record<string, string>, run: () => Promise<void>): Promise<void> {
  await sql`SAVEPOINT bonus_count`.execute(trx);
  try {
    await run();
    await sql`RELEASE SAVEPOINT bonus_count`.execute(trx);
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT bonus_count`.execute(trx);
    await sql`RELEASE SAVEPOINT bonus_count`.execute(trx);
    console.warn(JSON.stringify({ msg: `bonus ${what} not counted`, ...ids, error: (error as { code?: string }).code ?? scrubText(String((error as Error)?.message ?? error)) }));
  }
}

/** Test seam (rule 28): lets a test make the counting step fail with a database error. */
export const countingHooks: { beforeCount?: (trx: Trx) => Promise<void> } = {};

/* ---------------------------------------------------------------- trips */

type TripFacts = { zone_ids: string[]; account_status: string; driver_phone: string; rider_phone: string | null };

/**
 * counting.trips: called by creditTrip, the one step every PAID end goes through, in the same transaction. The trip
 * counts in every active trips campaign of the driver's zones whose area holds its pickup point (D5, D14), once per
 * campaign (bonus_trips_counted), unless the rider limit says no (MF7).
 */
export async function countTrip(trx: Trx, trip: TripRow, now: Date): Promise<void> {
  if (trip.driver_id === null) return;
  const driverId = trip.driver_id;
  const pickup = trip.pickup as { lat?: number; lng?: number } | null;
  if (typeof pickup?.lat !== "number" || typeof pickup.lng !== "number") return;
  const { lat, lng } = pickup as { lat: number; lng: number };
  await safely(trx, "trip", { tripId: trip.trip_id, driverId }, async () => {
    await countingHooks.beforeCount?.(trx);
    const facts = (await sql<TripFacts>`
      SELECT d.zone_ids, d.account_status, d.phone AS driver_phone, (SELECT r.phone FROM riders r WHERE r.rider_id = ${trip.rider_id}) AS rider_phone
        FROM drivers d WHERE d.driver_id = ${driverId}`.execute(trx)).rows[0];
    if (!facts || facts.account_status !== "active" || facts.zone_ids.length === 0) return;
    const rows = await sql<RawCampaign>`
      SELECT ${CAMPAIGN_COLUMNS} FROM bonus_campaigns c JOIN zones z ON z.zone_id = c.zone_id
       WHERE c.measure = 'trips' AND ${stillActive(now)} AND c.zone_id = ANY(${facts.zone_ids}::text[])
         AND c.south <= ${lat} AND c.north >= ${lat} AND c.west <= ${lng} AND c.east >= ${lng}
       ORDER BY c.bonus_id`.execute(trx);
    for (const c of rows.rows.map(campaignOf)) {
      if (!insideArea(c, lat, lng)) continue;
      await sql`INSERT INTO bonus_progress (bonus_id, driver_id, updated_at) VALUES (${c.bonusId}, ${driverId}, ${now}) ON CONFLICT DO NOTHING`.execute(trx);
      // MF1.3: the progress rows are locked in bonus_id order (the loop's order).
      const progress = (await sql<{ earned_at: Date | null }>`SELECT earned_at FROM bonus_progress WHERE bonus_id = ${c.bonusId} AND driver_id = ${driverId} FOR UPDATE`.execute(trx)).rows[0];
      if (!progress || progress.earned_at !== null) continue;
      // MF7 (2): a rider account with the driver's own phone never counts.
      if (samePhone(facts.rider_phone, facts.driver_phone)) continue;
      const first = await sql`INSERT INTO bonus_trips_counted (bonus_id, trip_id, counted_at) VALUES (${c.bonusId}, ${trip.trip_id}, ${now}) ON CONFLICT DO NOTHING RETURNING trip_id`.execute(trx);
      if (first.rows.length === 0) continue;
      // MF7 (1): one rider at most once per driver, campaign and zone-local day (the day of the paid end).
      const day = await sql`
        INSERT INTO bonus_rider_days (bonus_id, driver_id, rider_id, local_day)
        VALUES (${c.bonusId}, ${driverId}, ${trip.rider_id}, (${now}::timestamptz AT TIME ZONE ${c.timeZone})::date)
        ON CONFLICT DO NOTHING RETURNING rider_id`.execute(trx);
      if (day.rows.length === 0) continue;
      const counted = await sql<{ trips: number }>`
        UPDATE bonus_progress p SET trips = p.trips + 1, updated_at = ${now}
          FROM bonus_campaigns c
         WHERE c.bonus_id = p.bonus_id AND p.bonus_id = ${c.bonusId} AND p.driver_id = ${driverId} AND p.earned_at IS NULL AND ${stillActive(now)}
        RETURNING p.trips`.execute(trx);
      if ((counted.rows[0]?.trips ?? 0) >= c.target) await award(trx, c, driverId, now);
    }
  });
}

/* ---------------------------------------------------------------- online hours */

export type FixFacts = { driver_id: string; zone_ids: string[]; online_status: string; online_since: Date | null; account_status?: string };

/**
 * counting.onlineHours: called by POST /driver/location with the batch's fresh fixes. The cache picks the campaigns
 * of his zones whose bounds hold a fix; for each (bonus_id order) the batch is folded in memory (rules.ts foldFixes)
 * and written once, guarded: the row must still hold the last counted fix this copy read (two copies, a fix twice or
 * out of order: one wins, the other is a no-op) and the campaign must still be active now (MF2).
 */
export async function countFixes(trx: Trx, facts: FixFacts, fixes: readonly HoursFix[], now: Date): Promise<void> {
  if (fixes.length === 0 || facts.account_status !== "active") return;
  const all = await hoursCampaigns(trx, now);
  const near = all.filter((c) => facts.zone_ids.includes(c.zoneId) && fixes.some((f) => f.lat >= c.south && f.lat <= c.north && f.lng >= c.west && f.lng <= c.east));
  if (near.length === 0) return;
  await safely(trx, "fixes", { driverId: facts.driver_id }, async () => {
    await countingHooks.beforeCount?.(trx);
    // The cache only picked them: the rows are read again here (status, pauses, end), MF2.
    const fresh = await sql<RawCampaign>`
      SELECT ${CAMPAIGN_COLUMNS} FROM bonus_campaigns c JOIN zones z ON z.zone_id = c.zone_id
       WHERE c.bonus_id = ANY(${near.map((c) => c.bonusId)}::text[]) ORDER BY c.bonus_id`.execute(trx);
    for (const c of fresh.rows.map(campaignOf)) await countCampaignFixes(trx, c, facts, fixes, now);
  });
}

type ProgressRow = { online_seconds: number; last_inside_at: Date | null; last_received_at: Date | null; last_lat: number | null; last_lng: number | null; earned_at: Date | null };

async function countCampaignFixes(trx: Trx, c: CampaignRow, facts: FixFacts, fixes: readonly HoursFix[], now: Date): Promise<void> {
  const row = (await sql<ProgressRow>`
    SELECT online_seconds, last_inside_at, last_received_at, last_lat, last_lng, earned_at FROM bonus_progress WHERE bonus_id = ${c.bonusId} AND driver_id = ${facts.driver_id}`.execute(trx)).rows[0];
  if (row?.earned_at) return;
  const start: HoursState = row
    ? { seconds: Number(row.online_seconds), lastAt: row.last_inside_at, lastReceivedAt: row.last_received_at, lastLat: row.last_lat === null ? null : Number(row.last_lat), lastLng: row.last_lng === null ? null : Number(row.last_lng) }
    : { seconds: 0, lastAt: null, lastReceivedAt: null, lastLat: null, lastLng: null };
  const need = c.target * 3600;
  const { state, counted } = foldFixes(start, fixes, { now, statusCounts: facts.online_status === "online" || facts.online_status === "on_trip", onlineSince: facts.online_since, campaign: c, needSeconds: need });
  if (!counted) return;
  const values = sql`${state.seconds}::int, ${state.lastAt}::timestamptz, ${state.lastReceivedAt}::timestamptz, ${state.lastLat}::double precision, ${state.lastLng}::double precision`;
  let written: { online_seconds: number }[];
  if (row === undefined) {
    written = (await sql<{ online_seconds: number }>`
      INSERT INTO bonus_progress (bonus_id, driver_id, online_seconds, last_inside_at, last_received_at, last_lat, last_lng, updated_at)
      SELECT ${c.bonusId}::text, ${facts.driver_id}::text, ${values}, ${now}::timestamptz FROM bonus_campaigns c WHERE c.bonus_id = ${c.bonusId} AND ${stillActive(now)}
      ON CONFLICT DO NOTHING RETURNING online_seconds`.execute(trx)).rows;
  } else {
    written = (await sql<{ online_seconds: number }>`
      UPDATE bonus_progress p SET (online_seconds, last_inside_at, last_received_at, last_lat, last_lng) = (${values}), updated_at = ${now}
        FROM bonus_campaigns c
       WHERE c.bonus_id = p.bonus_id AND p.bonus_id = ${c.bonusId} AND p.driver_id = ${facts.driver_id} AND p.earned_at IS NULL
         AND p.last_inside_at IS NOT DISTINCT FROM ${row.last_inside_at} AND ${stillActive(now)}
      RETURNING p.online_seconds`.execute(trx)).rows;
  }
  if (Number(written[0]?.online_seconds ?? 0) >= need) await award(trx, c, facts.driver_id, now);
}
