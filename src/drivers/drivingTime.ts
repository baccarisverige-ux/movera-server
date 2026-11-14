import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import { liveDocument } from "../config/service.js";
import type { Executor } from "../db/db.js";

/**
 * v0.18.13 (owner 2026-11-02, decisions/driving-time-limits.md, contract.json#drivingLimits): the server enforces the
 * driving-time limit. Counted time = driving to the pickup (accept → arrived) + on trip (rider on board → end); online,
 * waiting at the pickup and idle time never count. Default 12 h (DriverAppConfig.drivingLimits.maxHoursPerDay of the
 * driver's first zone or its country standard; 0 = no limit). The counter starts again once the driver was offline
 * resetAfterOfflineHours (default 6) in a row; otherwise it covers at most the last 24 hours. After the limit: no new
 * offers and no going online; a running trip is always finished.
 */

export type DrivingLimits = { maxHoursPerDay: number; resetAfterOfflineHours: number };
export type DrivingTime = { drivenMinutes: number; maxMinutes: number; reached: boolean; resetAfterOfflineHours: number; canDriveAt?: string };

const DEFAULTS = (contract as unknown as { configDefaults: { drivingLimits: DrivingLimits } }).configDefaults.drivingLimits;
const DAY_MS = 24 * 3600_000;
const TERMINAL = ["completed", "cancelled_by_rider", "cancelled_by_driver", "cancelled_by_admin", "cancelled_by_system", "no_show", "expired", "failed"];

const num = (value: unknown, min: number, max: number, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback);

export function drivingLimitsOf(doc: { drivingLimits?: Partial<DrivingLimits> } | null | undefined): DrivingLimits {
  const d = doc?.drivingLimits ?? {};
  return { maxHoursPerDay: num(d.maxHoursPerDay, 0, 24, DEFAULTS.maxHoursPerDay), resetAfterOfflineHours: num(d.resetAfterOfflineHours, 1, 24, DEFAULTS.resetAfterOfflineHours) };
}

export async function drivingLimitsFor(ex: Executor, zoneId: string | undefined): Promise<DrivingLimits> {
  if (!zoneId) return drivingLimitsOf(null);
  const live = await liveDocument<{ drivingLimits?: Partial<DrivingLimits> }>(ex, "driver_app_config", zoneId);
  return drivingLimitsOf(live?.document);
}

/**
 * Stress T-A follow-up (B1.11): the trips of a driver that can count in [from, now). A finished trip's legs end at
 * one of arrived/boarded/ended/updated_at, so it counts only when the latest of them is after `from`; a trip that is
 * not over counts until now. Exactly the rows the old full read kept, found by trips_driver_last / trips_driver_open.
 */
function inWindow(t: ReturnType<typeof sql>, from: Date | ReturnType<typeof sql>) {
  return sql`(greatest(${t}.arrived_at, ${t}.boarded_at, ${t}.ended_at, ${t}.updated_at) > ${from}::timestamptz OR ${t}.status NOT IN (${sql.join(TERMINAL.map((s) => sql.lit(s)))}))`;
}

/** Seconds of counted driving of a driver in [from, now). */
export async function countedSeconds(ex: Executor, driverId: string, from: Date, now: Date): Promise<number> {
  // A trip that is over without an end time stops at its last change; a running one counts until now.
  const open = sql`CASE WHEN status IN (${sql.join(TERMINAL)}) THEN updated_at ELSE ${now}::timestamptz END`;
  // To the pickup: accept → arrived (else boarded / end / now). On trip: on board → end (else now). Clipped to [from, now).
  // Stress T-A follow-up: only the trips that can reach into the window (inWindow), on indexes trips_driver_last/_open.
  const row = await sql<{ s: string | null }>`
    WITH t AS (SELECT * FROM trips WHERE driver_id = ${driverId} AND ${inWindow(sql`trips`, from)}),
    legs AS (
      -- Checker 5: a booked ride accepted early counts from when the driver must leave (pickup time − his ETA).
      SELECT CASE WHEN kind = 'scheduled' AND scheduled_at IS NOT NULL
                  THEN greatest(accepted_at, scheduled_at - make_interval(secs => coalesce((eta->>'etaSeconds')::numeric, 0)))
                  ELSE accepted_at END AS a,
             coalesce(arrived_at, boarded_at, ended_at, ${open}) AS b FROM t
       WHERE accepted_at IS NOT NULL
      UNION ALL
      SELECT boarded_at AS a, coalesce(ended_at, ${open}) AS b FROM t
       WHERE boarded_at IS NOT NULL)
    SELECT sum(extract(epoch FROM (least(b, ${now}::timestamptz) - greatest(a, ${from}::timestamptz)))) AS s
      FROM legs WHERE b > ${from}::timestamptz AND a < ${now}::timestamptz AND b > a`.execute(ex);
  return Math.max(0, Math.round(Number(row.rows[0]?.s ?? 0)));
}

/**
 * Driver.drivingTime now. BQ-V21 (decisions/driving-time-limits.md:4 "6 hours offline so reset all time"): pass
 * `offlineSince` (went_offline_at of a driver who is offline now) and the projection is the server's real numbers for
 * him: after resetAfterOfflineHours offline in a row the count is already rested (he sees 0, not "Rest until"), and while
 * resting canDriveAt = went offline + resetAfterOfflineHours (before: now + resetAfterOfflineHours on every read, a time
 * that moved away). Without it (online, dispatch) the count is as before and canDriveAt = now + the reset.
 */
export async function drivingTimeOf(ex: Executor, driver: { driver_id: string; zone_ids: string[]; driving_since: Date | null; offlineSince?: Date | null }, now: Date): Promise<DrivingTime> {
  const limits = await drivingLimitsFor(ex, driver.zone_ids[0]);
  const resetMs = limits.resetAfterOfflineHours * 3600_000;
  const offlineSince = driver.offlineSince && driver.offlineSince.getTime() <= now.getTime() ? driver.offlineSince : null;
  const restedAt = offlineSince && now.getTime() - offlineSince.getTime() >= resetMs ? offlineSince.getTime() + resetMs : 0;
  const from = new Date(Math.max(now.getTime() - DAY_MS, driver.driving_since?.getTime() ?? 0, restedAt));
  const seconds = await countedSeconds(ex, driver.driver_id, from, now);
  const maxMinutes = Math.round(limits.maxHoursPerDay * 60);
  const reached = maxMinutes > 0 && seconds >= maxMinutes * 60;
  return {
    drivenMinutes: Math.floor(seconds / 60),
    maxMinutes,
    reached,
    resetAfterOfflineHours: limits.resetAfterOfflineHours,
    ...(reached ? { canDriveAt: new Date((offlineSince ?? now).getTime() + resetMs).toISOString() } : {}),
  };
}

/** Going online: the counter starts again after resetAfterOfflineHours offline in a row. Returns the new driving_since. */
export async function resetOnOnline(ex: Executor, driver: { driver_id: string; zone_ids: string[]; went_offline_at: Date | null; driving_since: Date | null }, now: Date): Promise<Date | null> {
  if (driver.went_offline_at === null) return driver.driving_since;
  const limits = await drivingLimitsFor(ex, driver.zone_ids[0]);
  if (now.getTime() - driver.went_offline_at.getTime() < limits.resetAfterOfflineHours * 3600_000) return driver.driving_since;
  await ex.updateTable("drivers").set({ driving_since: now }).where("driver_id", "=", driver.driver_id).execute();
  return now;
}

/** Dispatch: no new offers once the limit is reached. */
export async function drivingLimitReached(ex: Executor, driverId: string, now: Date): Promise<boolean> {
  const driver = await ex.selectFrom("drivers").select(["driver_id", "zone_ids", "driving_since"]).where("driver_id", "=", driverId).executeTakeFirst();
  if (!driver) return false;
  return (await drivingTimeOf(ex, driver, now)).reached;
}

/**
 * Job 1 (fix plan R1 d; the per-driver countedSeconds was the top query by time in the stress test): the drivers of
 * `drivers` who reached their driving-time limit, with the very rules of drivingTimeOf, in one query for all of them.
 */
export async function driversAtDrivingLimit(ex: Executor, drivers: Array<{ driver_id: string; zone_ids: string[]; driving_since: Date | null }>, now: Date): Promise<Set<string>> {
  if (drivers.length === 0) return new Set();
  const limitOf = new Map<string, DrivingLimits>();
  for (const zoneId of new Set(drivers.map((d) => d.zone_ids[0] ?? ""))) limitOf.set(zoneId, await drivingLimitsFor(ex, zoneId || undefined));
  const limited = drivers.filter((d) => limitOf.get(d.zone_ids[0] ?? "")!.maxHoursPerDay > 0);
  if (limited.length === 0) return new Set();
  const ids = limited.map((d) => d.driver_id);
  const froms = limited.map((d) => new Date(Math.max(now.getTime() - DAY_MS, d.driving_since?.getTime() ?? 0)).toISOString());
  const open = sql`CASE WHEN t.status IN (${sql.join(TERMINAL)}) THEN t.updated_at ELSE ${now}::timestamptz END`;
  const rows = await sql<{ driver_id: string; s: string | null }>`
    WITH d AS (SELECT * FROM unnest(${ids}::text[], ${froms}::timestamptz[]) AS d(driver_id, f)),
    t AS (SELECT t.*, d.f FROM d CROSS JOIN LATERAL (SELECT * FROM trips WHERE trips.driver_id = d.driver_id AND ${inWindow(sql`trips`, sql`d.f`)} OFFSET 0) t),
    legs AS (
      SELECT t.driver_id, t.f,
             CASE WHEN t.kind = 'scheduled' AND t.scheduled_at IS NOT NULL
                  THEN greatest(t.accepted_at, t.scheduled_at - make_interval(secs => coalesce((t.eta->>'etaSeconds')::numeric, 0)))
                  ELSE t.accepted_at END AS a,
             coalesce(t.arrived_at, t.boarded_at, t.ended_at, ${open}) AS b
        FROM t WHERE t.accepted_at IS NOT NULL
      UNION ALL
      SELECT t.driver_id, t.f, t.boarded_at AS a, coalesce(t.ended_at, ${open}) AS b
        FROM t WHERE t.boarded_at IS NOT NULL)
    SELECT driver_id, sum(extract(epoch FROM (least(b, ${now}::timestamptz) - greatest(a, f)))) AS s
      FROM legs WHERE b > f AND a < ${now}::timestamptz AND b > a GROUP BY driver_id`.execute(ex);
  const out = new Set<string>();
  for (const row of rows.rows) {
    const driver = limited.find((d) => d.driver_id === row.driver_id)!;
    const maxMinutes = Math.round(limitOf.get(driver.zone_ids[0] ?? "")!.maxHoursPerDay * 60);
    if (Math.max(0, Math.round(Number(row.s ?? 0))) >= maxMinutes * 60) out.add(row.driver_id);
  }
  return out;
}
