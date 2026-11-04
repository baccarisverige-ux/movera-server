import { sql } from "kysely";
import type { Executor } from "../db/db.js";
import { driverPerformance } from "../drivers/performance.js";
import { drivingLimitReached } from "../drivers/drivingTime.js";
import { missedInRow } from "./autoOffline.js";

/**
 * Contract v0.18.21 §45 (contract.json#dispatchDriverFacts, owner 2026-11-04 "real driver facts"): what dispatch knows
 * about each online driver of a zone, for the admin Dispatch page. Facts the server does not track yet are always null
 * (the admin shows "—"); nothing is made up.
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
    .select(["driver_id", "online_status", "online_since", "category_ids", "last_free_at"])
    .where("account_status", "=", "active")
    .where("online_status", "in", ["online", "on_trip"])
    .where(sql<boolean>`${zoneId} = ANY(zone_ids)`)
    .orderBy("driver_id")
    .execute();
  const hourAgo = new Date(now.getTime() - 3600_000);
  const items: DispatchDriverFacts[] = [];
  for (const row of rows) {
    const onTrip = row.online_status === "on_trip";
    const perf = await driverPerformance(ex, row.driver_id, now);
    const rides = await ex
      .selectFrom("trips")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("driver_id", "=", row.driver_id)
      .where("status", "=", "completed")
      .where("ended_at", ">", hourAgo)
      .where("ended_at", "<=", now)
      .executeTakeFirstOrThrow();
    items.push({
      driverId: row.driver_id,
      zoneId,
      state: onTrip ? "trip" : "free",
      rating: perf.rating,
      acceptancePct: perf.acceptancePct,
      cancelPct: perf.cancellationPct,
      idleMin: !onTrip && row.last_free_at ? Math.max(0, Math.floor((now.getTime() - row.last_free_at.getTime()) / 60_000)) : null,
      categoryIds: row.category_ids,
      missedInRow: await missedInRow(ex, row.driver_id, row.online_since),
      ridesThisHour: Number(rides.n),
      restNeeded: await drivingLimitReached(ex, row.driver_id, now),
      ...NOT_YET,
    });
  }
  return { zoneId, serverTime: now.toISOString(), items };
}
