import type { Trx } from "../db/db.js";
import { contract } from "../contract/contract.js";
import { liveDocument } from "../config/service.js";
import { scheduleTimer } from "../jobs/timers.js";

/**
 * contract.json#autoOffline (v0.8.0, owner 2026-10-27): after offers.autoOffline.missedExclusive (default 10)
 * Exclusive offers of live trips in a row that the driver declined or let expire, the driver goes offline. Radar,
 * assigned and reservation offers never count and never break the run; an accepted Exclusive offer (claimed) or
 * going online (online_since) starts it again. The driver app counts the same way.
 */
const DEFAULT_LIMIT = (contract as unknown as { configDefaults: { missedExclusiveBeforeOffline: number } }).configDefaults.missedExclusiveBeforeOffline;

export async function autoOfflineLimit(trx: Trx, zoneId: string): Promise<number> {
  const doc = await liveDocument<{ offers?: { autoOffline?: { missedExclusive?: unknown } } }>(trx, "driver_app_config", zoneId);
  const value = doc?.document.offers?.autoOffline?.missedExclusive;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : DEFAULT_LIMIT;
}

/** Called with the driver row locked, after an Exclusive offer was declined or expired. True when it set the driver offline. */
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
    .select(["offers.status"])
    .where("offers.driver_id", "=", driverId)
    .where("offers.kind", "=", "exclusive")
    .where("trips.kind", "=", "live")
    .where("offers.status", "in", ["claimed", "declined", "expired"])
    .orderBy("offers.answered_at", "desc")
    .orderBy("offers.offer_id", "desc")
    .limit(limit);
  if (driver.online_since !== null) query = query.where("offers.answered_at", ">=", driver.online_since);
  const run = await query.execute();
  if (run.length < limit || run.some((o) => o.status === "claimed")) return false;
  await trx.updateTable("drivers").set({ online_status: "offline", online_since: null, version: driver.version + 1, updated_at: now }).where("driver_id", "=", driverId).execute();
  // As going offline by hand: the driver's other open offers are withdrawn by a job that locks each trip in turn.
  await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: driverId, dueAt: now, payload: {} });
  return true;
}
