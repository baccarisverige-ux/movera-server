import type { Executor } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { driverTotalOf, isPaidEnd, tripProjection } from "../trips/projection.js";

/**
 * v0.18.89 §90 BQ-M22 (contract.json#priceDisplay.payoutSummary; owner 2026-11-14 "It's very simple ! U show how much driver
 * get and how much movera get thats all no details"; s06:1278 "Movera gets = commission + app fee as one amount"):
 * Payout.summary { driverGets, moveraGets } for the payout's period, driver and admin views, amounts only.
 * - driverGets = each of the period's trips' driverTotal (what he gets now: tips, bonuses and pay changes inside) + each of his
 *   entries of the period that is in no trip's driverTotal (cancel / no-show shares, a lost-driver payment, a share taken
 *   back), each once.
 * - moveraGets = what Movera keeps now on each of the period's trips (the admin view's TripProjection.moveraKeepsNow =
 *   moneySplit.movera, moneyBase.commissionRow; the app fee is inside the fare, so it is never added again) + Movera's share
 *   of the period's cancel / no-show fees (the fee trip's commission, feeColumns). v0.18.90 (moneyBase.lostDriverPaid.kpi):
 *   a lost-driver payment is taken off once, through that trip's admin moneySplit.movera, never again from the lost
 *   driver's own entry (here it is only his driverGets).
 * The period's trips are the trips of his `trip` entries in [periodStart, periodEnd) (the paid end writes that entry).
 */

type Money = { amountMinor: number; currency: string };
export type PayoutSummary = { driverGets: Money; moveraGets: Money };
type PayoutKey = { payout_id: string; driver_id: string; currency: string };

export async function payoutSummaries(ex: Executor, payouts: readonly PayoutKey[]): Promise<Map<string, PayoutSummary>> {
  const out = new Map<string, PayoutSummary>();
  if (payouts.length === 0) return out;
  // One read for the page: each payout's period entries on the earnings_driver (driver_id, at) index.
  const entries = await ex
    .selectFrom("payouts as p")
    .innerJoin("earnings_entries as e", (join) => join.onRef("e.driver_id", "=", "p.driver_id").onRef("e.at", ">=", "p.period_start").onRef("e.at", "<", "p.period_end").onRef("e.currency", "=", "p.currency"))
    .select(["p.payout_id", "e.kind", "e.trip_id", "e.amount_minor"])
    .where("p.payout_id", "in", payouts.map((p) => p.payout_id))
    .execute();
  const tripIds = [...new Set(entries.map((e) => e.trip_id).filter((id): id is string => id !== null))];
  const trips = new Map<string, TripRow>();
  if (tripIds.length) for (const t of await ex.selectFrom("trips").selectAll().where("trip_id", "in", tripIds).execute()) trips.set(t.trip_id, t as unknown as TripRow);
  const byPayout = new Map<string, typeof entries>();
  for (const e of entries) byPayout.set(e.payout_id, [...(byPayout.get(e.payout_id) ?? []), e]);
  for (const payout of payouts) {
    let driverGets = 0;
    let moveraGets = 0;
    const tripsCounted = new Set<string>();
    const feesCounted = new Set<string>();
    for (const e of byPayout.get(payout.payout_id) ?? []) {
      const trip = e.trip_id ? trips.get(e.trip_id) : undefined;
      if (e.kind === "trip" && trip) {
        if (tripsCounted.has(trip.trip_id)) continue;
        tripsCounted.add(trip.trip_id);
        driverGets += driverTotalOf(trip);
        moveraGets += (tripProjection(trip, "admin")["moveraKeepsNow"] as Money | undefined)?.amountMinor ?? 0;
        continue;
      }
      // Tips, pickup pay, bonuses and pay changes on his own paid trip are inside that trip's driverTotal.
      if (trip && trip.driver_id === payout.driver_id && isPaidEnd(trip)) continue;
      driverGets += Number(e.amount_minor);
      // Movera's share of a cancel / no-show fee he has a share of (feeColumns: the fee trip's commission), once per trip.
      if (e.kind === "fee_share" && trip && !feesCounted.has(trip.trip_id)) {
        feesCounted.add(trip.trip_id);
        moveraGets += Number(trip.commission_minor ?? 0);
      }
    }
    out.set(payout.payout_id, { driverGets: { amountMinor: driverGets, currency: payout.currency }, moveraGets: { amountMinor: moveraGets, currency: payout.currency } });
  }
  return out;
}
