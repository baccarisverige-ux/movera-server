import { sql } from "kysely";
import type { Executor } from "../db/db.js";
import { PERFORMANCE, performanceFromCounts } from "../drivers/performance.js";
import { driversAtDrivingLimit } from "../drivers/drivingTime.js";
import { missedInRowOf } from "./autoOffline.js";

/** The true run of missed offers, whatever the zone limit (or with auto-offline off); counted up to 50 (the admin shows "50+"). */
export const MISSED_IN_ROW_CAP = 50;

/**
 * Contract v0.18.21 §45 (contract.json#dispatchDriverFacts, owner 2026-11-04 "real driver facts"): what dispatch knows
 * about each online driver of a zone, for the admin Dispatch page. Facts the server does not track yet are always null
 * (the admin shows "—"); nothing is made up. Offers, cancels and rides are read in one grouped query each per zone.
 */
export type DispatchDriverFacts = {
  driverId: string;
  zoneId: string;
  state: "free" | "trip";
  rating: number | null;
  acceptancePct: number | null;
  cancelPct: number | null;
  idleMin: number | null;
  categoryIds: string[];
  missedInRow: number;
  ridesThisHour: number;
  restNeeded: boolean;
  finishingInMin: null;
  extras: null;
  female: null;
  skipsInRow: null;
  favourite: null;
  goingHome: null;
  homeDirectionOk: null;
  priorityUntilMin: null;
  queuePos: null;
};

const NOT_YET = { finishingInMin: null, extras: null, female: null, skipsInRow: null, favourite: null, goingHome: null, homeDirectionOk: null, priorityUntilMin: null, queuePos: null } as const;

export async function zoneDriverFacts(ex: Executor, zoneId: string, now: Date): Promise<{ zoneId: string; serverTime: string; items: DispatchDriverFacts[] }> {
  const rows = await ex
    .selectFrom("drivers")
    .select(["driver_id", "online_status", "online_since", "category_ids", "last_free_at", "rating_sum", "rating_count", "zone_ids", "driving_since"])
    .where("account_status", "=", "active")
    .where("online_status", "in", ["online", "on_trip"])
    .where(sql<boolean>`${zoneId} = ANY(zone_ids)`)
    .orderBy("driver_id")
    .execute();
  if (rows.length === 0) return { zoneId, serverTime: now.toISOString(), items: [] };
  const ids = rows.map((r) => r.driver_id);
  const since = new Date(now.getTime() - PERFORMANCE.windowDays * 24 * 3600_000);
  const hourAgo = new Date(now.getTime() - 3600_000);
  const offers = await ex
    .selectFrom("offers")
    .select(["driver_id", sql<string>`count(*) FILTER (WHERE status = 'claimed')`.as("took"), sql<string>`count(*) FILTER (WHERE status = 'claimed' OR (status IN ('declined', 'expired') AND NOT driver_on_trip))`.as("all")])
    .where("driver_id", "in", ids)
    .where("kind", "in", ["exclusive", "assigned"])
    .where("sent_at", ">", since)
    .where("sent_at", "<=", now)
    .groupBy("driver_id")
    .execute();
  const cancels = await ex
    .selectFrom("driver_cancels")
    .select(["driver_id", (eb) => eb.fn.countAll<string>().as("n")])
    .where("driver_id", "in", ids)
    .where("at", ">", since)
    .where("at", "<=", now)
    .groupBy("driver_id")
    .execute();
  const rides = await ex
    .selectFrom("trips")
    .select(["driver_id", (eb) => eb.fn.countAll<string>().as("n")])
    .where("driver_id", "in", ids)
    .where("status", "=", "completed")
    .where("ended_at", ">", hourAgo)
    .where("ended_at", "<=", now)
    .groupBy("driver_id")
    .execute();
  const offerOf = new Map(offers.map((o) => [o.driver_id, o]));
  const cancelOf = new Map(cancels.map((c) => [c.driver_id, Number(c.n)]));
  const rideOf = new Map(rides.map((r) => [r.driver_id as string, Number(r.n)]));
  // B1.19 (owner 2026-11-10): missed-in-a-row and the driving-time limit in one query each for all the zone's drivers
  // (was two queries per driver), with the very rules of missedInRow / drivingLimitReached.
  const missedOf = await missedInRowOf(ex, rows.map((r) => ({ driverId: r.driver_id, onlineSince: r.online_since })), MISSED_IN_ROW_CAP);
  const resting = await driversAtDrivingLimit(ex, rows, now);
  const items: DispatchDriverFacts[] = [];
  for (const row of rows) {
    const onTrip = row.online_status === "on_trip";
    const o = offerOf.get(row.driver_id);
    const perf = performanceFromCounts(since, Number(o?.all ?? 0), Number(o?.took ?? 0), cancelOf.get(row.driver_id) ?? 0, Number(row.rating_sum ?? 0), Number(row.rating_count ?? 0));
    items.push({
      driverId: row.driver_id,
      zoneId,
      state: onTrip ? "trip" : "free",
      rating: perf.rating,
      acceptancePct: perf.acceptancePct,
      cancelPct: perf.cancellationPct,
      idleMin: !onTrip && row.last_free_at ? Math.max(0, Math.floor((now.getTime() - row.last_free_at.getTime()) / 60_000)) : null,
      categoryIds: row.category_ids,
      missedInRow: missedOf.get(row.driver_id) ?? 0,
      ridesThisHour: rideOf.get(row.driver_id) ?? 0,
      restNeeded: resting.has(row.driver_id),
      ...NOT_YET,
    });
  }
  return { zoneId, serverTime: now.toISOString(), items };
}
