import { sql } from "kysely";
import type { Trx } from "../db/db.js";
import { contract } from "../contract/contract.js";
import { liveDocument } from "../config/service.js";
import { scheduleTimer } from "../jobs/timers.js";
import { markSetOffline } from "../drivers/offlineReason.js";

/**
 * contract.json#autoOffline (v0.8.0, owner 2026-10-27; v0.18.6 owner G4-E3 "Count them"): after
 * offers.autoOffline.missedExclusive (default 10, G4-E2 "Set 10 everywhere") Exclusive or hand-sent (assigned) offers of
 * live trips in a row that the driver declined or let expire, the driver goes offline. Misses of Radar offers (also an
 * admin radar group) and reservation offers, and of any offer sent while the driver was on a trip, never count.
 * ANY accepted offer (claimed) or going online (online_since) sets the count back to 0. The driver app counts the same way.
 */
const DEFAULT_LIMIT = (contract as unknown as { configDefaults: { missedExclusiveBeforeOffline: number } }).configDefaults.missedExclusiveBeforeOffline;

export async function autoOfflineLimit(trx: Trx, zoneId: string): Promise<number> {
  const doc = await liveDocument<{ offers?: { autoOffline?: { missedExclusive?: unknown } } }>(trx, "driver_app_config", zoneId);
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
  let query = trx
    .selectFrom("offers")
    .innerJoin("trips", "trips.trip_id", "offers.trip_id")
    .select(["offers.status", "offers.kind", "offers.driver_on_trip", "trips.kind as tripKind"])
    .where("offers.driver_id", "=", driverId)
    .where("offers.status", "in", ["claimed", "declined", "expired"])
    .orderBy("offers.answered_at", "desc")
    // An accept and a miss answered at the same instant: the accept counts as the newer one (the run starts again).
    .orderBy(sql`offers.status = 'claimed'`, "desc")
    .orderBy("offers.offer_id", "desc")
    .limit(500);
  if (driver.online_since !== null) query = query.where("offers.answered_at", ">=", driver.online_since);
  let run = 0;
  for (const offer of await query.execute()) {
    if (offer.status === "claimed") break;
    if (COUNTING_KINDS.includes(offer.kind) && offer.tripKind === "live" && !offer.driver_on_trip) run += 1;
    if (run >= limit) break;
  }
  if (run < limit) return false;
  await trx.updateTable("drivers").set({ online_status: "offline", online_since: null, version: driver.version + 1, updated_at: now }).where("driver_id", "=", driverId).execute();
  // v0.18.6 (owner "Send the real reason"): Driver.offlineReason missed_offers + the set_offline notice.
  await markSetOffline(trx, driverId, "missed_offers", { count: limit }, now);
  // As going offline by hand: the driver's other open offers are withdrawn by a job that locks each trip in turn.
  await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: driverId, dueAt: now, payload: {} });
  return true;
}
