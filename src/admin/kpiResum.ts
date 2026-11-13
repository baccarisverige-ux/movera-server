import { sql } from "kysely";
import type { Trx } from "../db/db.js";
import { summarizeDay } from "./kpis.js";

/**
 * v0.18.82 S5 J5 (owner 107 "Yes, count + fix old days (Rec.)", contract.json#moneyBase.kpiMoney): the ONE-OFF re-sum of
 * every stored kpi_days row with the v0.18.82 money rule. Only the summary rows are rewritten (by design, like the nightly
 * job); trips, earnings entries, fees and refunds are only read. No new day is added. Safe to run again (the second run
 * changes nothing). Run by hand: `npm run admin -- kpi-resum` (R29: staging before/after first, owner OK + quiet hour).
 */

export type ResumTotals = { currency: string; rows: number; gross: number; commission: number; moveraEarnings: number };
export type ResumResult = { rows: number; changed: number; before: ResumTotals[]; after: ResumTotals[] };

async function totals(trx: Trx): Promise<ResumTotals[]> {
  const rows = await sql<{ currency: string; rows: string; gross: string; commission: string; movera: string }>`
    SELECT currency, count(*) AS rows, coalesce(sum(gross_minor), 0) AS gross, coalesce(sum(commission_minor), 0) AS commission,
           coalesce(sum(movera_earnings_minor), 0) AS movera
      FROM kpi_days GROUP BY currency ORDER BY currency`.execute(trx);
  return rows.rows.map((r) => ({ currency: r.currency, rows: Number(r.rows), gross: Number(r.gross), commission: Number(r.commission), moveraEarnings: Number(r.movera) }));
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
