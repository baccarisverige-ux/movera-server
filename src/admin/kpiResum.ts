import { sql } from "kysely";
import type { Db, Trx } from "../db/db.js";
import { summarizeDay } from "./kpis.js";

/**
 * v0.18.82 S5 J5 (owner 107 "Yes, count + fix old days (Rec.)", contract.json#moneyBase.kpiMoney): the ONE-OFF re-sum of
 * every stored kpi_days row with the v0.18.82 money rule. Only the summary rows are rewritten (by design, like the nightly
 * job); trips, earnings entries, fees and refunds are only read. No new day is added. Safe to run again (the second run
 * changes nothing). Run by hand: `npm run admin -- kpi-resum` (R29: staging before/after first, owner OK + quiet hour).
 */

export type ResumTotals = { currency: string; rows: number; gross: number; commission: number; moveraEarnings: number; driverEarnings: number; pickupPay: number; driverBonus: number };
export type ResumResult = { rows: number; changed: number; before: ResumTotals[]; after: ResumTotals[] };

async function totals(trx: Trx): Promise<ResumTotals[]> {
  // J5 supervisor S4: driverEarnings, pickupPay and driverBonus too (J5 reads them from the earnings entries, no longer
  // from the trip columns), so the staging before/after shows any old paid trip without entries.
  const rows = await sql<{ currency: string; rows: string; gross: string; commission: string; movera: string; earnings: string; pickup: string; bonus: string }>`
    SELECT currency, count(*) AS rows, coalesce(sum(gross_minor), 0) AS gross, coalesce(sum(commission_minor), 0) AS commission,
           coalesce(sum(movera_earnings_minor), 0) AS movera, coalesce(sum(driver_earnings_minor), 0) AS earnings,
           coalesce(sum(pickup_pay_minor), 0) AS pickup, coalesce(sum(driver_bonus_minor), 0) AS bonus
      FROM kpi_days GROUP BY currency ORDER BY currency`.execute(trx);
  return rows.rows.map((r) => ({
    currency: r.currency, rows: Number(r.rows), gross: Number(r.gross), commission: Number(r.commission), moveraEarnings: Number(r.movera),
    driverEarnings: Number(r.earnings), pickupPay: Number(r.pickup), driverBonus: Number(r.bonus),
  }));
}

/** A stored row's numbers, to tell which rows the re-sum changed. */
const FINGERPRINT = sql<string>`concat_ws('|', completed_trips, cancelled_trips, no_shows, gross_minor, commission_minor, driver_earnings_minor,
  pickup_pay_minor, driver_bonus_minor, cash_collected_minor, wallet_applied_minor, new_riders, new_drivers, tips_minor, refunds_minor, fees_minor,
  movera_earnings_minor)`;

export async function resumStoredKpiDays(trx: Trx, now: Date): Promise<ResumResult> {
  const before = await totals(trx);
  const stored = await sql<{ zone_id: string; time_zone: string; currency: string; day: string; print: string }>`
    SELECT k.zone_id, z.time_zone, z.currency, to_char(k.day, 'YYYY-MM-DD') AS day, ${FINGERPRINT} AS print
      FROM kpi_days k JOIN zones z ON z.zone_id = k.zone_id
     ORDER BY k.zone_id, k.day`.execute(trx);
  let changed = 0;
  for (const row of stored.rows) {
    await summarizeDay(trx, { zone_id: row.zone_id, time_zone: row.time_zone, currency: row.currency }, row.day, now);
    const after = await sql<{ print: string }>`SELECT ${FINGERPRINT} AS print FROM kpi_days WHERE zone_id = ${row.zone_id} AND day = ${row.day}::date`.execute(trx);
    if (after.rows[0]?.print !== row.print) changed += 1;
  }
  return { rows: stored.rows.length, changed, before, after: await totals(trx) };
}

const ROLLBACK = new Error("kpi-resum dry run");

/**
 * `npm run admin -- kpi-resum [--dry-run]`: one transaction; a dry run computes the same before/after and rolls back, so
 * nothing is written (J5 supervisor S3/S5: the CLI also skips the migrations on a dry run).
 */
export async function runKpiResum(db: Db, now: Date, dryRun: boolean): Promise<ResumResult> {
  let result: ResumResult | undefined;
  await db.transaction().execute(async (trx) => {
    result = await resumStoredKpiDays(trx, now);
    if (dryRun) throw ROLLBACK;
  }).catch((error: unknown) => { if (error !== ROLLBACK) throw error; });
  return result!;
}

/** One printed line per currency, before or after. */
export function totalsLine(when: "before" | "after", t: ResumTotals): string {
  return `${when.padEnd(6)} ${t.currency}: ${t.rows} rows, gross ${t.gross}, commission ${t.commission}, moveraEarnings ${t.moveraEarnings}, driverEarnings ${t.driverEarnings}, pickupPay ${t.pickupPay}, driverBonus ${t.driverBonus}`;
}
