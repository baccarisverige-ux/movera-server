import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/guard.js";
import { driverPaidMovera } from "../../src/admin/driversOwing.js";
import { driverPayouts, listPayouts, makePayouts, markPayoutPaid } from "../../src/admin/payouts.js";
import { adminDriverBonus } from "../../src/admin/trips.js";
import type { TripRow } from "../../src/db/tripLog.js";
import { owedByDriver } from "../../src/drivers/owes.js";
import { commissionOf } from "../../src/rules/commission.js";
import { adminDriverPay } from "../../src/trips/finish.js";
import { tripProjection } from "../../src/trips/projection.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * BQ-M28 + BQ-M29 x BQ-V44 x J8 on ONE payout page (rebase supervisor 2026-11-16, Rules
 * audits/impact/m29-late-adjustment-supervisor.md "Rebase supervisor 2026-11-16" MF-R1): the four entry kinds that meet in
 * src/admin/payoutSummary.ts after the rebase, for one driver, in one payout:
 * - a bonus campaign entry (kind bonus WITH bonus_id, trip_id NULL; priceDisplay.payoutSummary.campaignBonus),
 * - a late bonus and a late pay change of a paid trip whose trip entry is in an older payout (laterBonus / laterPayChange),
 * - a "Driver paid Movera" entry (kind paid_to_movera, trip_id NULL; paidToMovera),
 * plus a trip with its own bonus in the same payout (counted once). Each is counted once, the campaign entry is never read
 * as a trip's own bonus, and the older payout closed by "Driver paid Movera" (J8 freeze in driversOwing) is frozen with the
 * same numbers as Mark as paid gives. Sweden (SEK) and Tunisia (TND).
 */

let database: TestDatabase;
let riderId: string;
const SUPER: Principal = { actor: "admin", subjectId: "adm_m2829", sessionId: "s_m2829", zones: ["*"], role: "super", perms: [] } as unknown as Principal;
const WEEK1 = { from: new Date("2026-11-02T00:00:00Z"), to: new Date("2026-11-09T00:00:00Z") };
const WEEK2 = { from: new Date("2026-11-09T00:00:00Z"), to: new Date("2026-11-16T00:00:00Z") };
const IN = new Date("2026-11-04T10:00:00Z");
const LATER = new Date("2026-11-10T12:00:00Z");
const B_IN = new Date("2026-11-11T10:00:00Z");
const B_LATE = new Date("2026-11-11T12:00:00Z");
const PAID_AT = new Date("2026-11-12T09:00:00Z");
type Money = { amountMinor: number; currency: string };
const m = (amountMinor: number, currency: string): Money => ({ amountMinor, currency });

let n = 0;
const entry = (v: { tripId: string | null; driverId: string; kind: "trip" | "bonus"; amount: number; currency: string; cash?: number; at: Date; bonusId?: string }) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_m2829_${++n}`, driver_id: v.driverId, trip_id: v.tripId, kind: v.kind, currency: v.currency, amount_minor: v.amount, gross_minor: null, commission_minor: null, cash_minor: v.cash ?? null, at: v.at, ...(v.bonusId ? { bonus_id: v.bonusId } : {}) }).execute();

/** A paid (completed, cash) trip with its trip entry, as finish.ts leaves it. */
async function paidTrip(driverId: string, t: { currency: string; fare: number; earnings: number; lines?: Array<{ code: string; amount: Money }> }, at: Date): Promise<TripRow> {
  const id = await insertTrip(database.db, riderId, { status: "completed", driverId });
  const lines = t.lines ?? [{ code: "base", amount: m(t.fare, t.currency) }];
  await database.db.updateTable("trips").set({
    currency: t.currency, fare_minor: t.fare, booked_fare_minor: t.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: t.earnings, pickup_pay_minor: 0, driver_bonus_minor: 0,
    commission_minor: commissionOf(t.fare, lines, t.earnings, 0, 0), driver_adjustments_minor: 0, lost_driver_paid_minor: 0, payment_method: "cash", ended_at: at,
    ended_by_command: "complete", payment_status: "captured", cash_collected_minor: t.fare,
  }).where("trip_id", "=", id).execute();
  await entry({ tripId: id, driverId, kind: "trip", amount: t.earnings, currency: t.currency, cash: t.fare, at });
  return row(id);
}
const row = async (id: string) => (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
/** A bonus campaign's award as bonuses/counting.ts writes it: kind bonus, trip_id NULL, bonus_id set. */
async function campaignEntry(driverId: string, amount: Money, at: Date) {
  const bonusId = `bns_m2829_${++n}`;
  const zone = await database.db.selectFrom("zones").select("zone_id").orderBy("zone_id").limit(1).executeTakeFirstOrThrow();
  await database.db.insertInto("bonus_campaigns").values({
    bonus_id: bonusId, zone_id: zone.zone_id, names: JSON.stringify({ sv: "Test", fr: "Test", en: "Test" }), measure: "trips", target: 1, amount_minor: amount.amountMinor, currency: amount.currency,
    start_date: "2026-11-01", end_date: "2026-11-30", starts_at: new Date("2026-11-01T00:00:00Z"), ends_at: new Date("2026-12-01T00:00:00Z"),
    polygon: JSON.stringify([[59, 18], [59, 19], [60, 18]]), south: 59, west: 18, north: 60, east: 19, created_by: SUPER.subjectId, created_at: at, updated_at: at,
  }).execute();
  await entry({ tripId: null, driverId, kind: "bonus", amount: amount.amountMinor, currency: amount.currency, at, bonusId });
}
async function payChange(tripId: string, change: Money, at: Date) {
  const t = await row(tripId);
  await database.db.transaction().execute((trx) => adminDriverPay(trx, SUPER, tripId, { expectedVersion: t.version, change, reason: "M28/M29 one page test" }, at));
}
async function lateBonus(tripId: string, amount: Money, at: Date) {
  const t = await row(tripId);
  await database.db.transaction().execute((trx) => adminDriverBonus(trx, SUPER, tripId, { expectedVersion: t.version, amount }, at));
}
const pay = async (driverId: string, week: { from: Date; to: Date }) =>
  (await database.db.transaction().execute((trx) => makePayouts(trx, { driverId, from: week.from, to: week.to, source: "manual", by: null }, new Date(week.to.getTime() + 3_600_000))))[0]!;
async function summary(driverId: string, payoutId: string) {
  const mine = (await driverPayouts(database.db, driverId, { limit: 10 })).items.find((p) => p.payoutId === payoutId)!;
  const admin = (await listPayouts(database.db, SUPER, { limit: 10, driverId })).items.find((p) => p.payoutId === payoutId)!;
  return { mine: mine.summary!, admin: admin.summary! };
}
const keepsNow = async (tripId: string) => (tripProjection(await row(tripId), "admin")["moveraKeepsNow"] as Money).amountMinor;
const payoutRow = (payoutId: string) => database.db.selectFrom("payouts").select(["status", "amount_minor", "paid_summary"]).where("payout_id", "=", payoutId).executeTakeFirstOrThrow();

beforeAll(async () => {
  database = await freshDatabase();
  riderId = await insertRider(database.db);
});
afterAll(async () => {
  await database.drop();
});

const CASES = [
  { name: "SEK", currency: "SEK", fare: 20_000, earnings: 15_000, movera: 5_000, bonusA: 500, change: 1_000, bonusB: 400, camp1: 300, camp2: 700, extra: 1_000 },
  // TND 3 decimals: 22.000 DT ride (20.000 + 2.000 app fee), driver 16.000 DT, Movera 6.000 DT.
  { name: "TND", currency: "TND", fare: 22_000, earnings: 16_000, movera: 6_000, bonusA: 750, change: 1_500, bonusB: 600, camp1: 450, camp2: 1_050, extra: 1_250, lines: [{ code: "base", amount: m(20_000, "TND") }, { code: "app_fee", amount: m(2_000, "TND") }] },
] as const;

describe.each(CASES)("BQ-M28 + BQ-M29 x V44 x J8 ($name): a campaign entry, a late bonus, a late pay change and Driver paid Movera in one payout", (c) => {
  const lines = "lines" in c ? [...c.lines] : undefined;
  const trip = (d: string, at: Date) => paidTrip(d, { currency: c.currency, fare: c.fare, earnings: c.earnings, ...(lines ? { lines } : {}) }, at);
  // Payout 1: trip A + campaign 1. Driver gets both; Movera gets what it keeps on A less the campaign (V44).
  const one = { driverGets: m(c.earnings + c.camp1, c.currency), moveraGets: m(c.movera - c.camp1, c.currency) };

  /** Week 1: trip A + campaign 1 in payout 1 (cash trip: the payout is below 0, carried). Then A's late bonus and pay change. */
  async function weekOne(d: string) {
    const a = await trip(d, IN);
    await campaignEntry(d, m(c.camp1, c.currency), IN);
    const p1 = await pay(d, WEEK1);
    expect(Number(p1.amount_minor)).toBe(c.earnings - c.fare + c.camp1);
    expect(await summary(d, p1.payout_id)).toEqual({ mine: one, admin: one });
    await lateBonus(a.trip_id, m(c.bonusA, c.currency), LATER);
    await payChange(a.trip_id, m(c.change, c.currency), LATER);
    // Written, not booked yet: payout 1 does not move (added back), and the campaign entry is never added back.
    expect(await summary(d, p1.payout_id)).toEqual({ mine: one, admin: one });
    return { a, p1 };
  }

  it("each entry counts once: payout 2 = trip B (own bonus once) - A's late bonus - A's pay change - the campaign; Driver paid Movera in neither number; payout 1 closed by Driver paid Movera is frozen without the late entries", async () => {
    const d = await insertDriver(database.db);
    const { a, p1 } = await weekOne(d);
    // Week 2: trip B with its own bonus (same payout as its trip entry) and campaign 2.
    const b = await trip(d, B_IN);
    await lateBonus(b.trip_id, m(c.bonusB, c.currency), B_LATE);
    await campaignEntry(d, m(c.camp2, c.currency), B_LATE);
    // He pays Movera payout 1's carried rest in full + `extra`: payout 1 is closed as paid (J8) and frozen at that moment
    // (the late bonus and pay change are written but booked nowhere), and `extra` is an unlinked entry for payout 2.
    const rest1 = c.fare - c.earnings - c.camp1;
    const owed = (await owedByDriver(database.db, [d], c.currency)).get(d) ?? 0;
    expect(owed).toBe(rest1 + (c.fare - c.earnings) - c.bonusA - c.change - c.bonusB - c.camp2);
    await database.db.transaction().execute((trx) => driverPaidMovera(trx, SUPER, d, { expectedOwed: m(owed, c.currency), amount: m(rest1 + c.extra, c.currency), reason: "Bank transfer" }, PAID_AT));
    const closed = await payoutRow(p1.payout_id);
    expect(closed.status).toBe("paid");
    expect(closed.paid_summary).toEqual({ admin: one, driver: one });

    const p2 = await pay(d, WEEK2);
    const kinds = (await database.db.selectFrom("earnings_entries").select(["kind", "trip_id", "bonus_id"]).where("payout_id", "=", p2.payout_id).execute())
      .map((e) => (e.kind === "bonus" ? (e.bonus_id ? "campaign" : e.trip_id === a.trip_id ? "lateBonusA" : "bonusB") : e.kind)).sort();
    expect(kinds).toEqual(["adjustment", "bonusB", "campaign", "lateBonusA", "paid_to_movera", "trip"]);
    // Payout.amount counts everything, also what he paid Movera (J8); the summary does not.
    expect(Number(p2.amount_minor)).toBe(c.earnings - c.fare + c.bonusB + c.bonusA + c.change + c.camp2 + c.extra);
    const two = await summary(d, p2.payout_id);
    expect(two.admin).toEqual({
      driverGets: m(c.earnings + c.bonusB + c.bonusA + c.change + c.camp2, c.currency),
      moveraGets: m(c.movera - c.bonusB - c.bonusA - c.change - c.camp2, c.currency),
    });
    expect(two.mine).toEqual(two.admin);
    // Payout 1 stays frozen; over both payouts Movera gets = what it keeps now on A and B less the two campaigns, once.
    expect(await summary(d, p1.payout_id)).toEqual({ mine: one, admin: one });
    expect(await keepsNow(a.trip_id)).toBe(c.movera - c.bonusA - c.change);
    expect(await keepsNow(b.trip_id)).toBe(c.movera - c.bonusB);
    expect(one.moveraGets.amountMinor + two.admin.moveraGets.amountMinor).toBe((await keepsNow(a.trip_id)) + (await keepsNow(b.trip_id)) - c.camp1 - c.camp2);
  });

  it("the J8 freeze (Driver paid Movera closes the payout) gives the same frozen numbers as Mark as paid", async () => {
    const [d1, d2] = [await insertDriver(database.db), await insertDriver(database.db)];
    const [w1, w2] = [await weekOne(d1), await weekOne(d2)];
    const rest1 = c.fare - c.earnings - c.camp1;
    const owed = (await owedByDriver(database.db, [d1], c.currency)).get(d1) ?? 0;
    expect(owed).toBe(rest1 - c.bonusA - c.change);
    // The carried rest of payout 1 is more than he owes now (the late bonus and pay change are his): he cannot close it
    // with Driver paid Movera until they are booked, so book them first (payout 2), then pay payout 1's rest.
    const p2 = await pay(d1, WEEK2);
    expect(Number(p2.amount_minor)).toBe(c.bonusA + c.change);
    await database.db.transaction().execute((trx) => driverPaidMovera(trx, SUPER, d1, { expectedOwed: m(rest1, c.currency), amount: m(rest1, c.currency), reason: "Bank transfer" }, PAID_AT));
    await pay(d2, WEEK2);
    await database.db.transaction().execute((trx) => markPayoutPaid(trx, SUPER, w2.p1.payout_id, {}, PAID_AT));
    const [j8, m26] = [await payoutRow(w1.p1.payout_id), await payoutRow(w2.p1.payout_id)];
    expect(j8.status).toBe("paid");
    expect(m26.status).toBe("paid");
    expect(j8.paid_summary).toEqual({ admin: one, driver: one });
    expect(j8.paid_summary).toEqual(m26.paid_summary);
    // The payout that pays the late bonus and the pay change takes them off once, in both views.
    const two = await summary(d1, p2.payout_id);
    expect(two.admin).toEqual({ driverGets: m(c.bonusA + c.change, c.currency), moveraGets: m(-c.bonusA - c.change, c.currency) });
    expect(two.mine).toEqual(two.admin);
  });
});
