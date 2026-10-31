import type { Executor, Trx } from "../db/db.js";
import { cancelTimer } from "../jobs/timers.js";

/**
 * Contract v0.18.6 §32 (G4-F4): the repeating radar-zone send of a trip, seen by every admin on GET /admin/trips/{tripId}
 * (TripProjection.radarZoneSend while active) and ended at once when the trip is taken, cancelled or its search ends
 * (checker LOW 2), not only when the next repeat timer fires.
 */

export const RADAR_ZONE_REPEAT = "radar_zone_repeat";
export type StopReason = "admin" | "accepted" | "search_ended" | "trip_over" | "replaced";
export type SendRow = {
  send_id: string; trip_id: string; radar_zone_id: string; rule_id: string; seconds: number; max_drivers: number; repeat: boolean; active: boolean; rounds: number;
  started_by: string | null; started_at: Date; stopped_at: Date | null; stopped_by: string | null; stop_reason: string | null;
};

export const sendView = (r: SendRow) => ({
  sendId: r.send_id, tripId: r.trip_id, radarZoneId: r.radar_zone_id, ruleId: r.rule_id, seconds: r.seconds, intervalSeconds: r.seconds, maxDrivers: r.max_drivers, repeat: r.repeat, active: r.active, rounds: r.rounds,
  startedAt: r.started_at.toISOString(), ...(r.stopped_at ? { stoppedAt: r.stopped_at.toISOString() } : {}), ...(r.stop_reason ? { stopReason: r.stop_reason } : {}),
});

/** The trip's active send, for the admin trip view; undefined when none runs. */
export async function activeSendOf(ex: Executor, tripId: string) {
  const row = (await ex.selectFrom("radar_zone_sends").selectAll().where("trip_id", "=", tripId).where("active", "=", true).executeTakeFirst()) as SendRow | undefined;
  return row === undefined ? undefined : sendView(row);
}

/** Ends every active send of the trip now (accept, cancel, search end), cancelling its repeat timer. */
export async function endTripSends(trx: Trx, tripId: string, reason: StopReason, by: string | null, now: Date): Promise<void> {
  const rows = await trx.selectFrom("radar_zone_sends").select("send_id").where("trip_id", "=", tripId).where("active", "=", true).execute();
  for (const r of rows) {
    await trx.updateTable("radar_zone_sends").set({ active: false, stopped_at: now, stopped_by: by, stop_reason: reason }).where("send_id", "=", r.send_id).execute();
    await cancelTimer(trx, RADAR_ZONE_REPEAT, r.send_id);
  }
}
