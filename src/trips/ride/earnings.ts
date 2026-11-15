import { sql } from "kysely";
import type { Executor } from "../../db/db.js";
import { badRequest } from "../../http/errors.js";

/* ---------------------------------------------------------------- earnings */

type Period = "day" | "week" | "month";

/** GET /driver/earnings (EarningsReport): periods in the zone's clock (Europe/Stockholm in the test week). */
export async function driverEarnings(ex: Executor, driverId: string, input: { period: Period; from?: string; to?: string; timeZone: string; currency: string }, now: Date) {
  const tz = input.timeZone;
  // Up to now, this instant included.
  const to = input.to ? new Date(input.to) : new Date(now.getTime() + 1);
  const from = input.from
    ? new Date(input.from)
    : (await sql<{ start: Date }>`SELECT (date_trunc(${input.period}, ${now}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS start`.execute(ex)).rows[0]!.start;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw badRequest("from must be before to.", "invalid_range");
  // S07 T5: each period's end in the same query (one more query per period before).
  const rows = await sql<{ start: Date; end: Date; trips: string; gross: string; commission: string; earnings: string; pickup: string; fees: string; tips: string; adjustments: string; bonus: string; cash: string }>`
    SELECT (date_trunc(${input.period}, at AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS start,
           ((date_trunc(${input.period}, at AT TIME ZONE ${tz}) + ${`1 ${input.period}`}::interval) AT TIME ZONE ${tz}) AS end,
           count(*) FILTER (WHERE kind = 'trip') AS trips,
           coalesce(sum(gross_minor) FILTER (WHERE kind = 'trip'), 0) AS gross,
           coalesce(sum(commission_minor) FILTER (WHERE kind = 'trip'), 0) AS commission,
           coalesce(sum(amount_minor) FILTER (WHERE kind = 'trip'), 0) AS earnings,
           coalesce(sum(amount_minor) FILTER (WHERE kind = 'pickup_pay'), 0) AS pickup,
           coalesce(sum(amount_minor) FILTER (WHERE kind = 'fee_share'), 0) AS fees,
           coalesce(sum(amount_minor) FILTER (WHERE kind = 'tip'), 0) AS tips,
           coalesce(sum(amount_minor) FILTER (WHERE kind = 'adjustment'), 0) AS adjustments,
           coalesce(sum(amount_minor) FILTER (WHERE kind = 'bonus'), 0) AS bonus,
           coalesce(sum(cash_minor) FILTER (WHERE kind IN ('trip', 'tip')), 0) AS cash
      FROM earnings_entries
     WHERE driver_id = ${driverId} AND at >= ${from} AND at < ${to} AND currency = ${input.currency}
     GROUP BY 1, 2 ORDER BY 1`.execute(ex);
  // The other currencies he earned in over the same time (the app offers a switch: kr / €).
  const others = await ex.selectFrom("earnings_entries").select("currency").distinct().where("driver_id", "=", driverId).where("at", ">=", from).where("at", "<", to).orderBy("currency").execute();
  const money = (v: string | number) => ({ amountMinor: Number(v), currency: input.currency });
  const periods = [];
  for (const r of rows.rows) {
    // BQ-NET (V44 supervisor SF1): net is what the payout pays for the period's entries, so every bonus entry counts —
    // the trip bonus at the paid end, an admin bonus after the paid end and the lost-driver payment (payouts.ts bonus line).
    const net = Number(r.earnings) + Number(r.pickup) + Number(r.fees) + Number(r.tips) + Number(r.adjustments) + Number(r.bonus);
    periods.push({
      periodStart: r.start.toISOString(),
      periodEnd: r.end.toISOString(),
      tripCount: Number(r.trips),
      gross: money(r.gross),
      commission: money(r.commission),
      pickupPay: money(r.pickup),
      tips: money(r.tips),
      adjustments: money(r.adjustments),
      cashCollected: money(r.cash),
      fees: money(r.fees),
      net: money(net),
    });
  }
  return { driverId, period: input.period, timeZone: tz, currency: input.currency, currencies: [...new Set([input.currency, ...others.map((o) => o.currency)])].sort(), periods };
}
