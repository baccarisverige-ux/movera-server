import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";

/**
 * Contract v0.18.4 §29 (contract.json#driverHome.performance, owner G3-D2 "Real numbers"): the driver's acceptance %,
 * cancellation % and rating over the last windowDays days. The same counts are the dispatch score inputs (§3.6 factors
 * acceptance and cancel); a number below its minimum is null for the apps, dispatch uses any data it has.
 */
type Rules = { windowDays: number; minOffers: number; minTrips: number; minRatings: number };
export const PERFORMANCE = (contract as unknown as { driverHome: { performance: Rules } }).driverHome.performance;

export type DriverPerformance = {
  windowDays: number;
  from: string;
  offersAnswerable: number;
  offersAccepted: number;
  tripsCancelled: number;
  ratingCount: number;
  acceptancePct: number | null;
  cancellationPct: number | null;
  rating: number | null;
};

export async function driverPerformance(ex: Executor, driverId: string, now: Date): Promise<DriverPerformance> {
  const since = new Date(now.getTime() - PERFORMANCE.windowDays * 24 * 3600_000);
  const offers = await ex
    .selectFrom("offers")
    .select([sql<string>`count(*) FILTER (WHERE status = 'claimed')`.as("took"), sql<string>`count(*) FILTER (WHERE status IN ('claimed', 'declined', 'expired'))`.as("all")])
    .where("driver_id", "=", driverId)
    .where("kind", "in", ["exclusive", "assigned"])
    .where("sent_at", ">", since)
    .where("sent_at", "<=", now)
    .executeTakeFirstOrThrow();
  const cancels = await ex
    .selectFrom("driver_cancels")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("driver_id", "=", driverId)
    .where("at", ">", since)
    .where("at", "<=", now)
    .executeTakeFirstOrThrow();
  const driver = await ex.selectFrom("drivers").select(["rating_sum", "rating_count"]).where("driver_id", "=", driverId).executeTakeFirst();
  return performanceFromCounts(since, Number(offers.all), Number(offers.took), Number(cancels.n), Number(driver?.rating_sum ?? 0), Number(driver?.rating_count ?? 0));
}

/** The same numbers from counts already read (also used by the batched admin dispatch facts, one query per zone). */
export function performanceFromCounts(since: Date, answerable: number, accepted: number, cancelled: number, ratingSum: number, ratingCount: number): DriverPerformance {
  return {
    windowDays: PERFORMANCE.windowDays,
    from: since.toISOString(),
    offersAnswerable: answerable,
    offersAccepted: accepted,
    tripsCancelled: cancelled,
    ratingCount,
    acceptancePct: answerable >= PERFORMANCE.minOffers ? Math.round((accepted / answerable) * 100) : null,
    cancellationPct: accepted >= PERFORMANCE.minTrips ? Math.round(Math.min(100, (cancelled / accepted) * 100)) : null,
    rating: ratingCount >= PERFORMANCE.minRatings && ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 100) / 100 : null,
  };
}

/**
 * The §3.6 score inputs from the same counts: dispatch uses the real value as soon as there is any data (the minimums
 * only decide what the apps show); with no data at all the engine uses its default (4.7, 85 %, 5 %).
 */
export function scoreInputs(p: DriverPerformance): { rating?: number; acceptancePct?: number; cancelPct?: number } {
  return {
    ...(p.rating !== null ? { rating: p.rating } : {}),
    ...(p.offersAnswerable > 0 ? { acceptancePct: (p.offersAccepted / p.offersAnswerable) * 100 } : {}),
    ...(p.offersAccepted > 0 ? { cancelPct: Math.min(100, (p.tripsCancelled / p.offersAccepted) * 100) } : {}),
  };
}
