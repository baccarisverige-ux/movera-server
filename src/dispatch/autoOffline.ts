import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import { contract } from "../contract/contract.js";
import { liveDocument } from "../config/service.js";
import { scheduleTimer } from "../jobs/timers.js";
import { markSetOffline } from "../drivers/offlineReason.js";
import { OUTAGE_OPEN_GRACE_MS } from "../realtime/outages.js";

/**
 * contract.json#autoOffline (v0.8.0, owner 2026-10-27; v0.18.6 owner G4-E3 "Count them"): after
 * offers.autoOffline.missedExclusive (default 10, G4-E2 "Set 10 everywhere") Exclusive or hand-sent (assigned) offers of
 * live trips in a row that the driver declined or let expire, the driver goes offline. Misses of Radar offers (also an
 * admin radar group) and reservation offers, and of any offer sent while the driver was on a trip, never count.
 * ANY accepted offer (claimed) or going online (online_since) sets the count back to 0. The driver app counts the same way.
 * v0.18.120 (S4 B1.16 Q-B13, owner W1 Q78 "Do not count it"; contract.json#autoOffline.outage): an offer that EXPIRED
 * while any server copy's live link was down (its sent..answered time overlaps a realtime_outages window, an open one
 * ending at seen_at + 60 s) is skipped: it neither counts nor ends the run. A declined one always counts.
 */
const OPEN_GRACE = sql.raw(`interval '${OUTAGE_OPEN_GRACE_MS / 1000} seconds'`);

/** Q-B13: true for an expired offer whose sent..answered time overlaps an outage window of any server copy. */
const expiredInOutage = (offers: string) =>
  sql<boolean>`(${sql.ref(`${offers}.status`)} = 'expired' AND EXISTS (SELECT 1 FROM realtime_outages o
     WHERE o.down_at <= ${sql.ref(`${offers}.answered_at`)} AND coalesce(o.up_at, o.seen_at + ${OPEN_GRACE}) >= ${sql.ref(`${offers}.sent_at`)}))`;
const DEFAULT_LIMIT = (contract as unknown as { configDefaults: { missedExclusiveBeforeOffline: number } }).configDefaults.missedExclusiveBeforeOffline;

export async function autoOfflineLimit(trx: Executor, zoneId: string): Promise<number> {
  const doc = await liveDocument<{ offers?: { autoOffline?: { missedExclusive?: unknown; on?: unknown } } }>(trx, "driver_app_config", zoneId);
  // v0.18.14 (g1-g3 M8): the admin's switch DriverAppConfig.offers.autoOffline.on false = never set offline (0).
  if (doc?.document.offers?.autoOffline?.on === false) return 0;
  const value = doc?.document.offers?.autoOffline?.missedExclusive;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : DEFAULT_LIMIT;
}

/** The offer kinds whose misses count (contract.json#autoOffline.counts: exclusive, assigned). */
export const COUNTING_KINDS: readonly string[] = (contract as unknown as { autoOffline: { counts: string[] } }).autoOffline.counts;

/** Called with the driver row locked, after an Exclusive or assigned offer was declined or expired. True when it set the driver offline. */
export async function autoOfflineIfDue(trx: Trx, driverId: string, tripId: string, now: Date): Promise<boolean> {
  const driver = await trx.selectFrom("drivers").select(["online_status", "online_since", "version"]).where("driver_id", "=", driverId).executeTakeFirst();
  if (driver === undefined || driver.online_status !== "online") return false;
  const trip = await trx.selectFrom("trips").select("zone_id").where("trip_id", "=", tripId).executeTakeFirst();
  if (trip === undefined) return false;
  const limit = await autoOfflineLimit(trx, trip.zone_id);
  if (limit === 0) return false;
  const run = await missedInRow(trx, driverId, driver.online_since, limit);
  if (run < limit) return false;
  await trx.updateTable("drivers").set({ online_status: "offline", online_since: null, version: driver.version + 1, updated_at: now }).where("driver_id", "=", driverId).execute();
  // v0.18.6 (owner "Send the real reason"): Driver.offlineReason missed_offers + the set_offline notice.
  await markSetOffline(trx, driverId, "missed_offers", { count: limit }, now);
  // As going offline by hand: the driver's other open offers are withdrawn by a job that locks each trip in turn.
  await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: driverId, dueAt: now, payload: {} });
  return true;
}

/**
 * contract.json#autoOffline / #dispatchDriverFacts.real.missedInRow: Exclusive or assigned offers of live trips the
 * driver declined or let expire in a row since `onlineSince` (an accept ends the run; offers sent while on a trip and
 * Radar / reservation offers never count). Stops counting at `cap`.
 */
export async function missedInRow(trx: Executor, driverId: string, onlineSince: Date | null, cap = 500): Promise<number> {
  let query = trx
    .selectFrom("offers")
    .innerJoin("trips", "trips.trip_id", "offers.trip_id")
    .select(["offers.status", "offers.kind", "offers.driver_on_trip", "trips.kind as tripKind"])
    .select(expiredInOutage("offers").as("inOutage"))
    .where("offers.driver_id", "=", driverId)
    .where("offers.status", "in", ["claimed", "declined", "expired"])
    .orderBy("offers.answered_at", "desc")
    // An accept and a miss answered at the same instant: the accept counts as the newer one (the run starts again).
    .orderBy(sql`offers.status = 'claimed'`, "desc")
    .orderBy("offers.offer_id", "desc")
    .limit(500);
  if (onlineSince !== null) query = query.where("offers.answered_at", ">=", onlineSince);
  let run = 0;
  for (const offer of await query.execute()) {
    if (offer.status === "claimed") break;
    if (offer.inOutage) continue;
    if (COUNTING_KINDS.includes(offer.kind) && offer.tripKind === "live" && !offer.driver_on_trip) run += 1;
    if (run >= cap) break;
  }
  return run;
}

/**
 * B1.19: missedInRow for many drivers in one query (admin Dispatch page). Per driver the same newest 500 answered offers
 * in the same order; the run is the counting misses before the newest accept, capped at `cap`. Drivers with no run: absent.
 * Q-B13: an expired offer inside an outage window is not counted here either (the admin count equals the server's).
 */
export async function missedInRowOf(ex: Executor, drivers: Array<{ driverId: string; onlineSince: Date | null }>, cap = 500): Promise<Map<string, number>> {
  if (drivers.length === 0) return new Map();
  const ids = drivers.map((d) => d.driverId);
  const sinces = drivers.map((d) => d.onlineSince?.toISOString() ?? null);
  const rows = await sql<{ driver_id: string; run: string }>`
    WITH d AS (SELECT * FROM unnest(${ids}::text[], ${sinces}::timestamptz[]) AS d(driver_id, since)),
    o AS (SELECT d.driver_id, x.* FROM d CROSS JOIN LATERAL (
            SELECT offers.status, offers.kind, offers.driver_on_trip, trips.kind AS trip_kind, ${expiredInOutage("offers")} AS in_outage,
                   row_number() OVER (ORDER BY offers.answered_at DESC, (offers.status = 'claimed') DESC, offers.offer_id DESC) AS rn
              FROM offers INNER JOIN trips ON trips.trip_id = offers.trip_id
             WHERE offers.driver_id = d.driver_id AND offers.status IN ('claimed', 'declined', 'expired')
               AND (d.since IS NULL OR offers.answered_at >= d.since)
             ORDER BY offers.answered_at DESC, (offers.status = 'claimed') DESC, offers.offer_id DESC
             LIMIT 500) x),
    f AS (SELECT o.*, min(rn) FILTER (WHERE status = 'claimed') OVER (PARTITION BY driver_id) AS first_claim FROM o)
    SELECT driver_id, count(*) AS run FROM f
     WHERE rn < coalesce(first_claim, 1000000) AND kind IN (${sql.join(COUNTING_KINDS)}) AND trip_kind = 'live' AND NOT coalesce(driver_on_trip, false) AND NOT in_outage
     GROUP BY driver_id`.execute(ex);
  return new Map(rows.rows.map((r) => [r.driver_id, Math.min(cap, Number(r.run))]));
}
