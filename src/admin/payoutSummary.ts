import type { Executor } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { isPaidEnd, tripProjection } from "../trips/projection.js";

/**
 * v0.18.89 §90 BQ-M22 (contract.json#priceDisplay.payoutSummary; owner 2026-11-14 "It's very simple ! U show how much driver
 * get and how much movera get thats all no details"; s06:1278 "Movera gets = commission + app fee as one amount"):
 * Payout.summary { driverGets, moveraGets }, amounts only. v0.18.92 (payoutSummary.entries, supervisor MF1 / MF2 / G2):
 * - "the payout's period" = the payout's OWN entries (earnings_entries.payout_id): each entry is in one payout only, so a
 *   manual and a weekly payout never count a day twice, a late or carried entry counts in the payout that pays it, and a
 *   paid payout's numbers never move to another payout.
 * - driverGets = Σ the payout's entries (trip, tip, pickup pay, bonus, pay change, fee share, a lost-driver payment): his
 *   money once = Payout.amount + the cash he collected.
 * - moveraGets = for each trip whose `trip` entry is in the payout, what Movera keeps now on it, read with the VIEWER's
 *   moveraKeepsNow (admin: moneySplit.movera, the lost-driver payments taken off; driver: what Movera keeps from HIS trip —
 *   another driver's money is never sent to him, moneyBase.lostDriverPaid.driverView; the two views may differ) + Movera's
 *   share of each fee he has a fee_share entry of (feeColumns: the fee trip's commission). Admin view only: a bonus entry
 *   on a trip with no paid end (a lost-driver payment of a cancelled / expired trip) is taken off once, in the payout that
 *   pays it (moneyBase.lostDriverPaid.kpi). The app fee is inside the fare: never added again.
 */

type Money = { amountMinor: number; currency: string };
export type PayoutSummary = { driverGets: Money; moveraGets: Money };
type PayoutKey = { payout_id: string; currency: string };

export async function payoutSummaries(ex: Executor, payouts: readonly PayoutKey[], viewer: "admin" | "driver"): Promise<Map<string, PayoutSummary>> {
  const out = new Map<string, PayoutSummary>();
  if (payouts.length === 0) return out;
  // One read for the page on earnings_payout (0108).
  const entries = await ex
    .selectFrom("earnings_entries")
    .select(["payout_id", "kind", "trip_id", "amount_minor"])
    .where("payout_id", "in", payouts.map((p) => p.payout_id))
    .execute();
  const tripIds = [...new Set(entries.filter((e) => e.kind !== "tip" && e.kind !== "pickup_pay" && e.kind !== "adjustment").map((e) => e.trip_id).filter((id): id is string => id !== null))];
  const trips = new Map<string, TripRow>();
  if (tripIds.length) for (const t of await ex.selectFrom("trips").selectAll().where("trip_id", "in", tripIds).execute()) trips.set(t.trip_id, t as unknown as TripRow);
  const byPayout = new Map<string, typeof entries>();
  for (const e of entries) if (e.payout_id) byPayout.set(e.payout_id, [...(byPayout.get(e.payout_id) ?? []), e]);
  for (const payout of payouts) {
    let driverGets = 0;
    let moveraGets = 0;
    const counted = new Set<string>();
    for (const e of byPayout.get(payout.payout_id) ?? []) {
      const amount = Number(e.amount_minor);
      driverGets += amount;
      const trip = e.trip_id ? trips.get(e.trip_id) : undefined;
      if (!trip) continue;
      if (e.kind === "trip" && !counted.has(`trip:${trip.trip_id}`)) {
        counted.add(`trip:${trip.trip_id}`);
        moveraGets += (tripProjection(trip, viewer)["moveraKeepsNow"] as Money | undefined)?.amountMinor ?? 0;
      } else if (e.kind === "fee_share" && !counted.has(`fee:${trip.trip_id}`)) {
        counted.add(`fee:${trip.trip_id}`);
        moveraGets += Number(trip.commission_minor ?? 0);
      } else if (e.kind === "bonus" && viewer === "admin" && !isPaidEnd(trip)) {
        moveraGets -= amount;
      }
    }
    out.set(payout.payout_id, { driverGets: { amountMinor: driverGets, currency: payout.currency }, moveraGets: { amountMinor: moveraGets, currency: payout.currency } });
  }
  return out;
}
