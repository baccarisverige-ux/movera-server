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
 *   money once = Payout.amount + the cash he collected − what he paid Movera (J8 paid_to_movera entries are left out).
 * - moveraGets = for each trip whose `trip` entry is in the payout, what Movera keeps now on it, read with the VIEWER's
 *   moveraKeepsNow (admin: moneySplit.movera, the lost-driver payments taken off; driver: what Movera keeps from HIS trip —
 *   another driver's money is never sent to him, moneyBase.lostDriverPaid.driverView; the two views may differ) + Movera's
 *   share of each fee he has a fee_share entry of (feeColumns: the fee trip's commission). Admin view only: a bonus entry
 *   on a trip with no paid end (a lost-driver payment of a cancelled / expired trip) is taken off once, in the payout that
 *   pays it (moneyBase.lostDriverPaid.kpi). The app fee is inside the fare: never added again.
 * v0.18.110 BQ-V44 (payoutSummary.campaignBonus, MF4): a campaign entry (kind bonus with bonus_id) is in driverGets and
 * taken off moveraGets in both views (moveraGets may go below 0, sent as it is).
 * v0.18.95 BQ-M26 (payoutSummary.frozenWhenPaid; M24 supervisor N1): a PAID payout's numbers never change. Both views are
 * worked out once when the payout is marked paid and kept in payouts.paid_summary (migration 0109); a paid payout is
 * served from there, so a later pay change, refund or bonus on one of its trips never moves it (that change shows in the
 * live numbers of the unpaid payouts only). Payouts paid before 0109 are frozen once at start (freezePaidPayoutSummaries:
 * freeze at deploy, the values of that moment). Unpaid payouts stay live.
 * BQ-M28 (V44 supervisor, Rules audits/impact/v44-driver-bonuses-supervisor.md §2.3; owner s06:1263 "Movera commission is
 * how much Movera keeps, everywhere"): a paid trip's own bonus entries (the driver's, written at or after the paid end:
 * the end bonus and an admin bonus after the paid end, BQ-M19 afterPaidEnd) are inside that trip's moveraKeepsNow, but
 * such an entry can be booked in a LATER payout than the trip entry. Each one lowers Movera gets once, in the payout that
 * pays it: the trip's payout adds back its bonus entries booked elsewhere (or not booked yet), and a payout with such a
 * bonus entry but not the trip's entry takes it off. A lost-driver payment (written before the end) is not one of them.
 */

type Money = { amountMinor: number; currency: string };
export type PayoutSummary = { driverGets: Money; moveraGets: Money };
type PayoutKey = { payout_id: string; currency: string; status?: string; paid_summary?: unknown };
/** payouts.paid_summary (0109): both views, frozen when the payout was marked paid. */
export type FrozenSummary = { admin: PayoutSummary; driver: PayoutSummary };

const frozenOf = (p: PayoutKey, viewer: "admin" | "driver"): PayoutSummary | undefined =>
  p.status === "paid" && p.paid_summary !== null && typeof p.paid_summary === "object" ? (p.paid_summary as Partial<FrozenSummary>)[viewer] : undefined;

export async function payoutSummaries(ex: Executor, all: readonly PayoutKey[], viewer: "admin" | "driver"): Promise<Map<string, PayoutSummary>> {
  const out = new Map<string, PayoutSummary>();
  // BQ-M26: a paid payout with its frozen summary is served as frozen; only the others are worked out live.
  for (const p of all) {
    const frozen = frozenOf(p, viewer);
    if (frozen) out.set(p.payout_id, frozen);
  }
  const payouts = all.filter((p) => !out.has(p.payout_id));
  if (payouts.length === 0) return out;
  // One read for the page on earnings_payout (0108).
  const entries = await ex
    .selectFrom("earnings_entries")
    .select(["payout_id", "kind", "trip_id", "driver_id", "amount_minor", "at", "bonus_id"])
    .where("payout_id", "in", payouts.map((p) => p.payout_id))
    .execute();
  const tripIds = [...new Set(entries.filter((e) => e.kind !== "tip" && e.kind !== "pickup_pay" && e.kind !== "adjustment").map((e) => e.trip_id).filter((id): id is string => id !== null))];
  const trips = new Map<string, TripRow>();
  if (tripIds.length) for (const t of await ex.selectFrom("trips").selectAll().where("trip_id", "in", tripIds).execute()) trips.set(t.trip_id, t as unknown as TripRow);
  const byPayout = new Map<string, typeof entries>();
  for (const e of entries) if (e.payout_id) byPayout.set(e.payout_id, [...(byPayout.get(e.payout_id) ?? []), e]);
  // BQ-M28: the trip's own bonus entries (any payout or none) of the paid trips whose trip entry is on this page.
  const ownBonus = (e: { kind: string; driver_id: string; at: Date | string }, trip: TripRow) =>
    e.kind === "bonus" && isPaidEnd(trip) && e.driver_id === trip.driver_id && (trip.ended_at === null || new Date(e.at).getTime() >= new Date(trip.ended_at).getTime());
  const paidTripIds = [...new Set(entries.filter((e) => e.kind === "trip" && e.trip_id !== null && trips.has(e.trip_id) && isPaidEnd(trips.get(e.trip_id)!)).map((e) => e.trip_id!))];
  const bonusesOf = new Map<string, Array<{ payout_id: string | null; amount: number }>>();
  if (paidTripIds.length) {
    const rows = await ex.selectFrom("earnings_entries").select(["payout_id", "trip_id", "driver_id", "kind", "amount_minor", "at"]).where("kind", "=", "bonus").where("trip_id", "in", paidTripIds).execute();
    for (const b of rows) if (b.trip_id && ownBonus(b, trips.get(b.trip_id)!)) bonusesOf.set(b.trip_id, [...(bonusesOf.get(b.trip_id) ?? []), { payout_id: b.payout_id, amount: Number(b.amount_minor) }]);
  }
  for (const payout of payouts) {
    let driverGets = 0;
    let moveraGets = 0;
    const counted = new Set<string>();
    const mine = byPayout.get(payout.payout_id) ?? [];
    const tripsHere = new Set(mine.filter((e) => e.kind === "trip").map((e) => e.trip_id));
    for (const e of mine) {
      // J8 x M22 (owner s06:1277 "Driver gets" = his earnings for the period, all trips): money the driver paid Movera
      // ("Driver paid Movera", kind paid_to_movera) is not earnings and not Movera's commission: in neither number,
      // in the payout it closes or in the next one. The payout's own amount and lines still count it.
      if (e.kind === "paid_to_movera") continue;
      const amount = Number(e.amount_minor);
      driverGets += amount;
      // v0.18.110 BQ-V44 (priceDisplay.payoutSummary.campaignBonus, supervisor MF4): a bonus campaign is Movera's money
      // outside every trip's commission and the driver's own money, so it is taken off Movera gets in BOTH views — keyed on
      // kind bonus WITH bonus_id, never on "no trip" (the tripless paid_to_movera entry above stays out of both numbers).
      if (e.kind === "bonus" && e.bonus_id !== null) {
        moveraGets -= amount;
        continue;
      }
      const trip = e.trip_id ? trips.get(e.trip_id) : undefined;
      if (!trip) continue;
      if (e.kind === "trip" && !counted.has(`trip:${trip.trip_id}`)) {
        counted.add(`trip:${trip.trip_id}`);
        moveraGets += (tripProjection(trip, viewer)["moveraKeepsNow"] as Money | undefined)?.amountMinor ?? 0;
        // BQ-M28: its bonus entries booked in another payout (or none yet) are taken off there, never here.
        for (const b of bonusesOf.get(trip.trip_id) ?? []) if (b.payout_id !== payout.payout_id) moveraGets += b.amount;
      } else if (ownBonus(e, trip) && !tripsHere.has(trip.trip_id)) {
        // BQ-M28: a paid trip's bonus booked here while its trip entry is in another payout (or none yet): taken off here.
        moveraGets -= amount;
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

/** BQ-M26: both views of a payout's summary now, for payouts.paid_summary (worked out live, never read frozen). */
export async function frozenSummaries(ex: Executor, payouts: readonly PayoutKey[]): Promise<Map<string, FrozenSummary>> {
  const live = payouts.map((p) => ({ payout_id: p.payout_id, currency: p.currency }));
  const [admin, driver] = [await payoutSummaries(ex, live, "admin"), await payoutSummaries(ex, live, "driver")];
  const out = new Map<string, FrozenSummary>();
  for (const p of payouts) out.set(p.payout_id, { admin: admin.get(p.payout_id)!, driver: driver.get(p.payout_id)! });
  return out;
}

/** BQ-M26: freezes the summary of a payout being marked paid (same transaction as the status change). */
export async function freezePayoutSummary(ex: Executor, payout: PayoutKey): Promise<void> {
  const frozen = (await frozenSummaries(ex, [payout])).get(payout.payout_id)!;
  await ex.updateTable("payouts").set({ paid_summary: JSON.stringify(frozen) }).where("payout_id", "=", payout.payout_id).where("paid_summary", "is", null).execute();
}

export const FREEZE_BATCH = 200;

/**
 * BQ-M26 freeze at deploy (owner rule "a paid payout's numbers never change"; decision in Rules
 * audits/impact/m26-payout-frozen.md): every payout already paid without a frozen summary (paid before migration 0109) is
 * frozen once, at the values of this moment, in batches of FREEZE_BATCH. Runs at start (main.ts); safe on several server
 * copies and to run again (only rows still NULL are written). Returns how many payouts it froze.
 */
export async function freezePaidPayoutSummaries(ex: Executor, batch = FREEZE_BATCH): Promise<number> {
  let frozen = 0;
  let after = "";
  for (;;) {
    const rows = await ex.selectFrom("payouts").select(["payout_id", "currency"]).where("status", "=", "paid").where("paid_summary", "is", null).where("payout_id", ">", after).orderBy("payout_id").limit(batch).execute();
    if (rows.length === 0) return frozen;
    const summaries = await frozenSummaries(ex, rows);
    for (const row of rows) {
      const done = await ex.updateTable("payouts").set({ paid_summary: JSON.stringify(summaries.get(row.payout_id)!) }).where("payout_id", "=", row.payout_id).where("status", "=", "paid").where("paid_summary", "is", null).executeTakeFirst();
      frozen += Number(done.numUpdatedRows);
    }
    if (rows.length < batch) return frozen;
    after = rows.at(-1)!.payout_id;
  }
}
