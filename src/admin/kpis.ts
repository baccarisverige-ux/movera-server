import { sql } from "kysely";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";

/**
 * Key numbers per zone and zone-local day (contract v0.9.0 §16, contract.json#kpis; owner, 2026-10-27): today is
 * counted live from the trips, earlier days come from kpi_days, written each night by the summary job (a re-run
 * replaces the same rows) and by the backfill command.
 */

const MAX_DAYS = (contract as unknown as { kpis: { maxDays: number } }).kpis.maxDays;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type Figures = {
  completedTrips: number;
  cancelledTrips: number;
  noShows: number;
  gross: number;
  commission: number;
  driverEarnings: number;
  pickupPay: number;
  driverBonus: number;
  cashCollected: number;
  walletApplied: number;
  newRiders: number;
  newDrivers: number;
  /** v0.10.3 (contract.json#kpis.money): tips apart, refunds on the trip's day, cancel/no-show fees, what Movera keeps. */
  tips: number;
  refunds: number;
  fees: number;
  moveraEarnings: number;
};

type Zone = { zone_id: string; time_zone: string; currency: string };

/** The figures of one zone for one zone-local day (YYYY-MM-DD), counted from the trips. */
export async function countDay(ex: Executor, zone: Zone, day: string): Promise<Figures> {
  const bounds = sql`(${day}::date::timestamp AT TIME ZONE ${zone.time_zone})`;
  const next = sql`((${day}::date + 1)::timestamp AT TIME ZONE ${zone.time_zone})`;
  const trips = await sql<Record<string, string>>`
    SELECT count(*) FILTER (WHERE status = 'completed') AS completed,
           count(*) FILTER (WHERE status LIKE 'cancelled_by_%') AS cancelled,
           count(*) FILTER (WHERE status = 'no_show' AND NOT coalesce(cancellation ? 'reversal', false)) AS no_shows,
           coalesce(sum(fare_minor) FILTER (WHERE status = 'completed'), 0) AS gross,
           coalesce(sum(commission_minor) FILTER (WHERE status = 'completed'), 0) AS commission,
           coalesce(sum(driver_earnings_minor) FILTER (WHERE status = 'completed'), 0) AS earnings,
           coalesce(sum(pickup_pay_minor) FILTER (WHERE status = 'completed'), 0) AS pickup,
           coalesce(sum(driver_bonus_minor) FILTER (WHERE status = 'completed'), 0) AS bonus,
           coalesce(sum(cash_collected_minor), 0) AS cash,
           coalesce(sum(wallet_applied_minor) FILTER (WHERE status = 'completed'), 0) AS wallet
      FROM trips
     WHERE zone_id = ${zone.zone_id} AND coalesce(ended_at, updated_at) >= ${bounds} AND coalesce(ended_at, updated_at) < ${next}
       AND status IN ('completed', 'no_show', 'cancelled_by_rider', 'cancelled_by_driver', 'cancelled_by_admin', 'cancelled_by_system')`.execute(ex);
  // A new rider: their first trip ever was booked that day in this zone. A new driver: signed up that day, this zone first.
  const riders = await sql<{ n: string }>`
    SELECT count(*) AS n FROM (
      SELECT DISTINCT ON (rider_id) rider_id, zone_id, created_at FROM trips ORDER BY rider_id, created_at, trip_id) first
     WHERE zone_id = ${zone.zone_id} AND created_at >= ${bounds} AND created_at < ${next}`.execute(ex);
  const drivers = await sql<{ n: string }>`
    SELECT count(*) AS n FROM drivers WHERE zone_ids[1] = ${zone.zone_id} AND created_at >= ${bounds} AND created_at < ${next}`.execute(ex);
  // v0.10.3 money of the same trips (the trip's day): fees charged (not waived), the driver's share of them, tips, refunds done.
  const money = await sql<Record<string, string>>`
    WITH day_trips AS (
      SELECT trip_id FROM trips
       WHERE zone_id = ${zone.zone_id} AND coalesce(ended_at, updated_at) >= ${bounds} AND coalesce(ended_at, updated_at) < ${next}
         AND status IN ('completed', 'no_show', 'cancelled_by_rider', 'cancelled_by_driver', 'cancelled_by_admin', 'cancelled_by_system'))
    SELECT (SELECT coalesce(sum(amount_minor), 0) FROM rider_fees WHERE status <> 'waived' AND trip_id IN (SELECT trip_id FROM day_trips)) AS fees,
           (SELECT coalesce(sum(amount_minor), 0) FROM earnings_entries WHERE kind = 'fee_share' AND trip_id IN (SELECT trip_id FROM day_trips)) AS fee_share,
           (SELECT coalesce(sum(amount_minor), 0) FROM earnings_entries WHERE kind = 'tip' AND trip_id IN (SELECT trip_id FROM day_trips)) AS tips,
           (SELECT coalesce(sum(amount_minor), 0) FROM refunds WHERE status = 'done' AND trip_id IN (SELECT trip_id FROM day_trips)) AS refunds`.execute(ex);
  const t = trips.rows[0]!;
  const m = money.rows[0]!;
  const fees = Number(m["fees"]);
  return {
    completedTrips: Number(t["completed"]),
    cancelledTrips: Number(t["cancelled"]),
    noShows: Number(t["no_shows"]),
    gross: Number(t["gross"]) + fees,
    commission: Number(t["commission"]),
    driverEarnings: Number(t["earnings"]),
    pickupPay: Number(t["pickup"]),
    driverBonus: Number(t["bonus"]),
    cashCollected: Number(t["cash"]),
    walletApplied: Number(t["wallet"]),
    newRiders: Number(riders.rows[0]!.n),
    newDrivers: Number(drivers.rows[0]!.n),
    tips: Number(m["tips"]),
    refunds: Number(m["refunds"]),
    fees,
    moveraEarnings: Number(t["commission"]) + fees - Number(m["fee_share"]) - Number(t["pickup"]) - Number(t["bonus"]),
  };
}

/** Today's date in the zone (YYYY-MM-DD). */
export async function zoneToday(ex: Executor, timeZone: string, now: Date): Promise<string> {
  const row = await sql<{ d: string }>`SELECT to_char(${now}::timestamptz AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS d`.execute(ex);
  return row.rows[0]!.d;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Writes (or rewrites) one zone-day row of the summary. */
export async function summarizeDay(trx: Trx, zone: Zone, day: string, now: Date): Promise<void> {
  const f = await countDay(trx, zone, day);
  const values = {
    currency: zone.currency,
    completed_trips: f.completedTrips,
    cancelled_trips: f.cancelledTrips,
    no_shows: f.noShows,
    gross_minor: f.gross,
    commission_minor: f.commission,
    driver_earnings_minor: f.driverEarnings,
    pickup_pay_minor: f.pickupPay,
    driver_bonus_minor: f.driverBonus,
    cash_collected_minor: f.cashCollected,
    wallet_applied_minor: f.walletApplied,
    new_riders: f.newRiders,
    new_drivers: f.newDrivers,
    tips_minor: f.tips,
    refunds_minor: f.refunds,
    fees_minor: f.fees,
    movera_earnings_minor: f.moveraEarnings,
    computed_at: now,
  };
  await trx
    .insertInto("kpi_days")
    .values({ zone_id: zone.zone_id, day, ...values })
    .onConflict((c) => c.columns(["zone_id", "day"]).doUpdateSet(values))
    .execute();
}

/**
 * The nightly summary: for every zone, every day from `from` (default: the day after the last summarized one, else
 * the first trip's day of any zone) up to yesterday in the zone's time. Safe to run again. Returns the zone-days written.
 */
export async function summarize(trx: Trx, now: Date, from?: string): Promise<number> {
  if (from !== undefined && !DATE.test(from)) throw badRequest("from must be YYYY-MM-DD.", "invalid_range");
  const zones = await trx.selectFrom("zones").select(["zone_id", "time_zone", "currency"]).execute();
  let written = 0;
  for (const zone of zones) {
    const today = await zoneToday(trx, zone.time_zone, now);
    let start = from;
    if (start === undefined) {
      const last = await trx.selectFrom("kpi_days").select(sql<string>`to_char(max(day), 'YYYY-MM-DD')`.as("d")).where("zone_id", "=", zone.zone_id).executeTakeFirst();
      if (last?.d) start = addDays(last.d, 1);
      else {
        // From the first trip anywhere: a zone without trips gets real zero rows, so a period total is never
        // "not connected" only because a quiet zone had nothing to sum.
        const first = await sql<{ d: string | null }>`SELECT to_char(min(created_at) AT TIME ZONE ${zone.time_zone}, 'YYYY-MM-DD') AS d FROM trips`.execute(trx);
        if (!first.rows[0]?.d) continue;
        start = first.rows[0].d;
      }
    }
    for (let day = start; day < today; day = addDays(day, 1)) {
      await summarizeDay(trx, zone, day, now);
      written += 1;
    }
  }
  return written;
}

const FIELD_COLUMNS: [keyof Figures, string][] = [
  ["completedTrips", "completed_trips"], ["cancelledTrips", "cancelled_trips"], ["noShows", "no_shows"], ["gross", "gross_minor"], ["commission", "commission_minor"],
  ["driverEarnings", "driver_earnings_minor"], ["pickupPay", "pickup_pay_minor"], ["driverBonus", "driver_bonus_minor"], ["cashCollected", "cash_collected_minor"],
  ["walletApplied", "wallet_applied_minor"], ["newRiders", "new_riders"], ["newDrivers", "new_drivers"],
  ["tips", "tips_minor"], ["refunds", "refunds_minor"], ["fees", "fees_minor"], ["moveraEarnings", "movera_earnings_minor"],
];

/**
 * v0.10.3: a refund counts on its trip's day, so a refund for a trip of an earlier day re-sums that day's summary row
 * at once (today's row is live anyway).
 */
export async function resumTripDay(trx: Trx, tripId: string, now: Date): Promise<void> {
  const row = await sql<{ zone_id: string; time_zone: string; currency: string; d: string }>`
    SELECT z.zone_id, z.time_zone, z.currency, to_char(coalesce(t.ended_at, t.updated_at) AT TIME ZONE z.time_zone, 'YYYY-MM-DD') AS d
      FROM trips t JOIN zones z ON z.zone_id = t.zone_id WHERE t.trip_id = ${tripId}`.execute(trx);
  const r = row.rows[0];
  if (!r) return;
  if (r.d >= (await zoneToday(trx, r.time_zone, now))) return;
  await summarizeDay(trx, r, r.d, now);
}

/** GET /admin/kpis: one KpiDay per zone and day in [fromDate, toDate]; today live, earlier days from the summary. */
export async function kpis(ex: Executor, who: Principal, input: { zoneId?: string; fromDate?: string; toDate?: string }, now: Date) {
  if (input.zoneId && !adminCoversZone(who, input.zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
  let zones = await ex.selectFrom("zones").select(["zone_id", "time_zone", "currency"]).orderBy("zone_id").execute();
  zones = zones.filter((z) => (input.zoneId ? z.zone_id === input.zoneId : adminCoversZone(who, z.zone_id)));
  const days = [];
  for (const zone of zones) {
    const today = await zoneToday(ex, zone.time_zone, now);
    const to = input.toDate ?? today;
    const from = input.fromDate ?? to;
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw badRequest("fromDate and toDate are YYYY-MM-DD, fromDate first.", "invalid_range");
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > MAX_DAYS) throw badRequest(`At most ${MAX_DAYS} days.`, "invalid_range");
    const stored = await ex.selectFrom("kpi_days").selectAll().select(sql<string>`to_char(day, 'YYYY-MM-DD')`.as("d")).where("zone_id", "=", zone.zone_id).where("day", ">=", from).where("day", "<=", to < today ? to : addDays(today, -1)).execute();
    const byDay = new Map(stored.map((row) => [row.d, row as unknown as Record<string, string | number>]));
    for (let day = from; day <= to && day <= today; day = addDays(day, 1)) {
      if (day === today) {
        days.push({ date: day, zoneId: zone.zone_id, source: "live" as const, currency: zone.currency, ...(await countDay(ex, zone, day)) });
        continue;
      }
      const row = byDay.get(day);
      // A past day the summary has not reached yet is left out (never shown as zeros).
      if (!row) continue;
      days.push({ date: day, zoneId: zone.zone_id, source: "summary" as const, currency: zone.currency, ...(Object.fromEntries(FIELD_COLUMNS.map(([field, column]) => [field, Number(row[column])])) as Figures) });
    }
  }
  return { days, generatedAt: now.toISOString() };
}
