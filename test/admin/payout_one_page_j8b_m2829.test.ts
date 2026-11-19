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
 * J8b x BQ-M28 x BQ-M29 on ONE payout page (J8b money supervisor, Rules audits/impact/j8b-supervisor.md "Rebase 2011a0a
 * money re-read"): what J8b (src/admin/payouts.ts makePayouts / paidAfterPeriod, src/drivers/owes.ts PAID_AFTER_PAYOUT)
 * and M28/M29 (src/admin/payoutSummary.ts) do to the same two payouts of one driver:
 * - a "Driver paid Movera" entry SPLIT by the old week's payout (its part linked there, the rest in the next payout),
 * - a late bonus and a late pay change of the old week's paid trip, booked in the next payout (laterBonus / laterPayChange).
 * The split moves Payout.amount, its paid_to_movera line and owed only; Driver gets / Movera gets count the late bonus and
 * the pay change once and never the money he paid; a payout closed by the click and one closed by Mark as paid are frozen
 * with the numbers shown before. Sweden (SEK) and Tunisia (TND, 3 decimals).
 */

let database: TestDatabase;
let riderId: string;
const SUPER: Principal = { actor: "admin", subjectId: "adm_j8bm", sessionId: "s_j8bm", zones: ["*"], role: "super", perms: [] } as unknown as Principal;
const WEEK1 = { from: new Date("2026-11-02T00:00:00Z"), to: new Date("2026-11-09T00:00:00Z") };
const WEEK2 = { from: new Date("2026-11-09T00:00:00Z"), to: new Date("2026-11-16T00:00:00Z") };
const IN = new Date("2026-11-04T10:00:00Z");
const LATER = new Date("2026-11-10T12:00:00Z");
const B_IN = new Date("2026-11-11T10:00:00Z");
const PAID_AT = new Date("2026-11-12T09:00:00Z");
const ROW1_AT = new Date("2026-11-13T09:00:00Z");
const ROW2_AT = new Date("2026-11-16T01:00:00Z");
const CLOSE_AT = new Date("2026-11-17T09:00:00Z");
type Money = { amountMinor: number; currency: string };
type Line = { code: string; amountMinor: number };
const m = (amountMinor: number, currency: string): Money => ({ amountMinor, currency });

let n = 0;
/** A paid (completed, cash) trip with its trip entry, as finish.ts leaves it. */
async function paidTrip(driverId: string, t: { currency: string; fare: number; earnings: number; lines?: Array<{ code: string; amount: Money }> }, at: Date): Promise<TripRow> {
  const id = await insertTrip(database.db, riderId, { status: "completed", driverId });
  const lines = t.lines ?? [{ code: "base", amount: m(t.fare, t.currency) }];
  await database.db.updateTable("trips").set({
    currency: t.currency, fare_minor: t.fare, booked_fare_minor: t.fare, fare_lines: JSON.stringify(lines), driver_earnings_minor: t.earnings, pickup_pay_minor: 0, driver_bonus_minor: 0,
    commission_minor: commissionOf(t.fare, lines, t.earnings, 0, 0), driver_adjustments_minor: 0, lost_driver_paid_minor: 0, payment_method: "cash", ended_at: at,
    ended_by_command: "complete", payment_status: "captured", cash_collected_minor: t.fare,
  }).where("trip_id", "=", id).execute();
  await database.db.insertInto("earnings_entries").values({ entry_id: `ern_j8bm_${++n}`, driver_id: driverId, trip_id: id, kind: "trip", currency: t.currency, amount_minor: t.earnings, gross_minor: null, commission_minor: null, cash_minor: t.fare, at }).execute();
  return row(id);
}
const row = async (id: string) => (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", id).executeTakeFirstOrThrow()) as unknown as TripRow;
async function payChange(tripId: string, change: Money, at: Date) {
  const t = await row(tripId);
  await database.db.transaction().execute((trx) => adminDriverPay(trx, SUPER, tripId, { expectedVersion: t.version, change, reason: "J8b x M28/M29 one page test" }, at));
}
async function lateBonus(tripId: string, amount: Money, at: Date) {
  const t = await row(tripId);
  await database.db.transaction().execute((trx) => adminDriverBonus(trx, SUPER, tripId, { expectedVersion: t.version, amount }, at));
}
const pay = async (driverId: string, week: { from: Date; to: Date }, at: Date) =>
  (await database.db.transaction().execute((trx) => makePayouts(trx, { driverId, from: week.from, to: week.to, source: "manual", by: SUPER.subjectId }, at)))[0]!;
const click = (driverId: string, owed: Money, amount: Money, at: Date) =>
  database.db.transaction().execute((trx) => driverPaidMovera(trx, SUPER, driverId, { expectedOwed: owed, amount, reason: "Bank transfer" }, at));
/** Both payouts read on ONE page (one payoutSummaries call per view). */
async function page(driverId: string) {
  const mine = (await driverPayouts(database.db, driverId, { limit: 10 })).items;
  const admin = (await listPayouts(database.db, SUPER, { limit: 10, driverId })).items;
  return (payoutId: string) => ({ mine: mine.find((p) => p.payoutId === payoutId)!.summary!, admin: admin.find((p) => p.payoutId === payoutId)!.summary! });
}
const owedOf = async (driverId: string, currency: string) => (await owedByDriver(database.db, [driverId], currency)).get(driverId) ?? 0;
const keepsNow = async (tripId: string) => (tripProjection(await row(tripId), "admin")["moveraKeepsNow"] as Money).amountMinor;
const payoutRow = async (payoutId: string) => {
  const r = await database.db.selectFrom("payouts").select(["status", "amount_minor", "paid_summary", "lines"]).where("payout_id", "=", payoutId).executeTakeFirstOrThrow();
  return { status: r.status, amount: Number(r.amount_minor), frozen: r.paid_summary, paidLine: (r.lines as Line[]).find((l) => l.code === "paid_to_movera")?.amountMinor ?? 0 };
};
const paidEntries = async (driverId: string) =>
  (await database.db.selectFrom("earnings_entries").select(["entry_id", "amount_minor", "payout_id", "at"]).where("driver_id", "=", driverId).where("kind", "=", "paid_to_movera").orderBy("entry_id").execute()).map((e) => ({ id: e.entry_id, amount: Number(e.amount_minor), payoutId: e.payout_id, at: e.at.toISOString() }));
const audits = async (driverId: string, action: string) =>
  (await database.db.selectFrom("admin_audit").select(["admin_id", "detail"]).where("target_id", "=", driverId).where("action", "=", action).orderBy("audit_id").execute()).map((r): Record<string, unknown> => ({ adminId: r.admin_id, ...(r.detail as Record<string, unknown>) }));

beforeAll(async () => {
  database = await freshDatabase();
  riderId = await insertRider(database.db);
});
afterAll(async () => {
  await database.drop();
});

const CASES = [
  // 200 kr cash ride, driver 150 kr, Movera 50 kr. He pays 70 kr; the old week takes 50 kr of it (split 50 / 20).
  { name: "SEK", currency: "SEK", fare: 20_000, earnings: 15_000, movera: 5_000, bonusA: 500, change: 1_000, paid: 7_000 },
  // TND 3 decimals: 22.000 DT ride (20.000 + 2.000 app fee), driver 16.000 DT, Movera 6.000 DT. He pays 8.001 DT (split 6.000 / 2.001).
  { name: "TND", currency: "TND", fare: 22_000, earnings: 16_000, movera: 6_000, bonusA: 750, change: 1_500, paid: 8_001, lines: [{ code: "base", amount: m(20_000, "TND") }, { code: "app_fee", amount: m(2_000, "TND") }] },
] as const;

describe.each(CASES)("J8b x BQ-M28 x BQ-M29 ($name): a split Driver paid Movera entry, a late bonus and a late pay change on one payout page", (c) => {
  const lines = "lines" in c ? [...c.lines] : undefined;
  const trip = (d: string, at: Date) => paidTrip(d, { currency: c.currency, fare: c.fare, earnings: c.earnings, ...(lines ? { lines } : {}) }, at);
  const debt = c.fare - c.earnings; // what one cash trip leaves him owing
  const late = c.bonusA + c.change;
  const left = c.paid - debt; // the part of his payment the old week does not take
  // Payout 1 (trip A): the late bonus and the pay change are booked in payout 2, so they are added back here.
  const one = { driverGets: m(c.earnings, c.currency), moveraGets: m(c.movera, c.currency) };
  // Payout 2 (trip B + A's late bonus + A's pay change + the rest of his payment): the money he paid is in neither number.
  const two = { driverGets: m(c.earnings + late, c.currency), moveraGets: m(c.movera - late, c.currency) };

  it("the split moves Payout.amount, the paid_to_movera line and owed; Driver gets / Movera gets count the late entries once and never the money he paid; frozen = shown", async () => {
    const d = await insertDriver(database.db);
    // Week 1: cash trip A. No payout row is made for it yet (the hour after the week's end, or his payouts are paused).
    const a = await trip(d, IN);
    // Week 2: A's late bonus and pay change, cash trip B, then he pays Movera `paid` in one click (one unlinked entry).
    await lateBonus(a.trip_id, m(c.bonusA, c.currency), LATER);
    await payChange(a.trip_id, m(c.change, c.currency), LATER);
    const b = await trip(d, B_IN);
    expect(await owedOf(d, c.currency)).toBe(2 * debt - late);
    expect((await click(d, m(2 * debt - late, c.currency), m(c.paid, c.currency), PAID_AT)).owed).toEqual(m(2 * debt - late - c.paid, c.currency));
    const [payment] = await audits(d, "driver.paid_movera");
    const written = payment!["entries"] as { entryId: string; amountMinor: number; payoutId: string | null }[];
    expect(written.map((e) => [e.amountMinor, e.payoutId])).toEqual([[c.paid, null]]);

    // Payout 1 (week 1) is made now: −debt of its own, so it takes `debt` of the money he paid after the week (J8b split).
    const p1 = await pay(d, WEEK1, ROW1_AT);
    expect(await payoutRow(p1.payout_id)).toMatchObject({ status: "pending", amount: 0, paidLine: debt });
    expect(await owedOf(d, c.currency)).toBe(2 * debt - late - c.paid);
    // Payout 2 (week 2): trip B, A's late bonus, A's pay change and what is left of his payment.
    const p2 = await pay(d, WEEK2, ROW2_AT);
    expect(await payoutRow(p2.payout_id)).toMatchObject({ status: "pending", amount: -debt + late + left, paidLine: left });
    const kinds = (await database.db.selectFrom("earnings_entries").select(["kind", "payout_id"]).where("driver_id", "=", d).orderBy("kind").execute()).map((e) => [e.kind, e.payout_id === p1.payout_id ? 1 : e.payout_id === p2.payout_id ? 2 : 0]).sort();
    expect(kinds).toEqual([["adjustment", 2], ["bonus", 2], ["paid_to_movera", 1], ["paid_to_movera", 2], ["trip", 1], ["trip", 2]].sort());
    // Owed is unchanged by the two rows: payout 2's own paid_to_movera line is inside its amount, never counted twice.
    expect(await owedOf(d, c.currency)).toBe(debt - late - left);

    // The money he paid: one payment, two entries of the same time, the same total; the split's audit row leads back to it.
    const entries = await paidEntries(d);
    expect(entries.reduce((s, e) => s + e.amount, 0)).toBe(c.paid);
    expect(entries.map((e) => e.at)).toEqual([PAID_AT.toISOString(), PAID_AT.toISOString()]);
    expect(entries.find((e) => e.id === written[0]!.entryId)).toMatchObject({ amount: left, payoutId: p2.payout_id });
    const splits = await audits(d, "driver.paid_movera_split");
    expect(splits).toEqual([{ adminId: SUPER.subjectId, entryId: written[0]!.entryId, currency: c.currency, amountBeforeMinor: c.paid, amountTakenMinor: debt, amountLeftMinor: left, partEntryId: entries.find((e) => e.id !== written[0]!.entryId)!.id, payoutId: p1.payout_id, source: "manual" }]);
    expect(entries.find((e) => e.id === splits[0]!["partEntryId"])).toMatchObject({ amount: debt, payoutId: p1.payout_id });

    // ONE page, both views: the late bonus and the pay change lower Movera gets once (in payout 2), the split nowhere.
    const live = await page(d);
    expect(live(p1.payout_id)).toEqual({ mine: one, admin: one });
    expect(live(p2.payout_id)).toEqual({ mine: two, admin: two });
    expect(await keepsNow(a.trip_id)).toBe(c.movera - late);
    expect(one.moveraGets.amountMinor + two.moveraGets.amountMinor).toBe((await keepsNow(a.trip_id)) + (await keepsNow(b.trip_id)));
    // Payout.amount = Driver gets − the cash he collected + what he paid Movera, in each payout (paidToMovera).
    expect((await payoutRow(p1.payout_id)).amount).toBe(one.driverGets.amountMinor - c.fare + debt);
    expect((await payoutRow(p2.payout_id)).amount).toBe(two.driverGets.amountMinor - c.fare + left);

    // He pays the rest: payout 2 is closed by the click (J8 freeze), payout 1 by Mark as paid (M26 freeze): frozen = shown.
    const rest = debt - late - left;
    expect((await click(d, m(rest, c.currency), m(rest, c.currency), CLOSE_AT)).owed).toEqual(m(0, c.currency));
    await database.db.transaction().execute((trx) => markPayoutPaid(trx, SUPER, p1.payout_id, {}, CLOSE_AT));
    expect(await payoutRow(p2.payout_id)).toMatchObject({ status: "paid", amount: -rest, paidLine: left, frozen: { admin: two, driver: two } });
    expect(await payoutRow(p1.payout_id)).toMatchObject({ status: "paid", amount: 0, paidLine: debt, frozen: { admin: one, driver: one } });
    const after = await page(d);
    expect(after(p1.payout_id)).toEqual({ mine: one, admin: one });
    expect(after(p2.payout_id)).toEqual({ mine: two, admin: two });
    expect(await owedOf(d, c.currency)).toBe(0);
    expect((await paidEntries(d)).reduce((s, e) => s + e.amount, 0)).toBe(c.paid + rest);
  });
});
