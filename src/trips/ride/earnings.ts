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
  // v0.18.146 (contract.json#driverRideCounts, audit N5, owner "Must see all kind"): the same query also counts his rides
  // of each period by kind FROM TRIPS (a cancel that earned nothing counts too); a period with rides but no entry is sent.
  const rows = await sql<{ start: Date; end: Date; trips: string; gross: string; commission: string; earnings: string; pickup: string; fees: string; tips: string; adjustments: string; bonus: string; cash: string; rides_completed: string; rides_cancelled: string; rides_no_show: string }>`
    WITH e AS (
    SELECT (date_trunc(${input.period}, at AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS start,
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
     GROUP BY 1),
    r AS (
    SELECT (date_trunc(${input.period}, coalesce(ended_at, updated_at) AT TIME ZONE ${tz}) AT TIME ZONE ${tz}) AS start,
           count(*) FILTER (WHERE status = 'completed') AS rides_completed,
           count(*) FILTER (WHERE status IN ('cancelled_by_rider', 'cancelled_by_driver', 'cancelled_by_admin', 'cancelled_by_system')) AS rides_cancelled,
           count(*) FILTER (WHERE status = 'no_show') AS rides_no_show
      FROM trips
     WHERE driver_id = ${driverId} AND currency = ${input.currency}
       AND status IN ('completed', 'cancelled_by_rider', 'cancelled_by_driver', 'cancelled_by_admin', 'cancelled_by_system', 'no_show')
       AND coalesce(ended_at, updated_at) >= ${from} AND coalesce(ended_at, updated_at) < ${to}
     GROUP BY 1)
    SELECT start,
           ((start AT TIME ZONE ${tz} + ${`1 ${input.period}`}::interval) AT TIME ZONE ${tz}) AS end,
           coalesce(e.trips, 0) AS trips, coalesce(e.gross, 0) AS gross, coalesce(e.commission, 0) AS commission,
           coalesce(e.earnings, 0) AS earnings, coalesce(e.pickup, 0) AS pickup, coalesce(e.fees, 0) AS fees,
           coalesce(e.tips, 0) AS tips, coalesce(e.adjustments, 0) AS adjustments, coalesce(e.bonus, 0) AS bonus,
           coalesce(e.cash, 0) AS cash, coalesce(r.rides_completed, 0) AS rides_completed,
           coalesce(r.rides_cancelled, 0) AS rides_cancelled, coalesce(r.rides_no_show, 0) AS rides_no_show
      FROM e FULL JOIN r USING (start)
     ORDER BY 1`.execute(ex);
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
      // v0.18.110 BQ-V44 (bonusCampaigns.money.earnings; NET supervisor V44-N1/N3): every bonus entry of the period (trip
      // bonuses and campaigns) as its own field — the SAME sum BQ-NET already puts in net, so net does not change.
      bonus: money(r.bonus),
      net: money(net),
      rideCounts: { completed: Number(r.rides_completed), cancelled: Number(r.rides_cancelled), noShow: Number(r.rides_no_show) },
    });
  }
  return { driverId, period: input.period, timeZone: tz, currency: input.currency, currencies: [...new Set([input.currency, ...others.map((o) => o.currency)])].sort(), periods };
}
