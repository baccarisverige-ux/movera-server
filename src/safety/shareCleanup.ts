import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";

/**
 * Contract v0.18.116 §94 (contract.json#shareTrip.retentionDays; owner S10 Q7 "30 days"): share-my-trip rows are
 * deleted 30 days after they were made, at most `limit` per statement (jobs/housekeeping.ts cleanup_trip_shares).
 * A small module of its own, so the housekeeping jobs do not load the trip code through safety/tripShare.ts.
 */
export const SHARE_RETENTION_DAYS = (contract as unknown as { shareTrip: { retentionDays: number } }).shareTrip.retentionDays;

export async function purgeOldShares(ex: Executor, now: Date, limit: number): Promise<number> {
  const cut = new Date(now.getTime() - SHARE_RETENTION_DAYS * 24 * 3_600_000);
  const old = ex.selectFrom("trip_shares").select("share_id").where("created_at", "<", cut).limit(limit);
  const gone = await ex.deleteFrom("trip_shares").where("created_at", "<", cut).where("share_id", "in", old).executeTakeFirst();
  return Number(gone.numDeletedRows);
}
