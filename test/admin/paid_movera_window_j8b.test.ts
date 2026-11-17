import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../src/auth/guard.js";
import { ApiError } from "../../src/http/errors.js";
import { driverPaidMovera } from "../../src/admin/driversOwing.js";
import { closePeriodsBatch, createPayout, holdDriverPayouts, listPayouts, markPayoutPaid } from "../../src/admin/payouts.js";
import { fleetEarnings } from "../../src/drivers/onboarding.js";
import { owedByDriver } from "../../src/drivers/owes.js";
import { payoutDriverHandler } from "../../src/jobs/payouts.js";
import type { Timer } from "../../src/jobs/timers.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";

/**
 * J8b (J8 supervisor round 3 SF1, Rules audits/impact/j8-supervisor-round3.md): "Driver paid Movera" recorded after the
 * week ended but before the payout row of that week is made (up to an hour; any time for a driver on payout hold) must
 * settle THAT week's debt. Before: the entry (dated now) went into the next payout: the old week's payout came out
 * −30 kr, the next one +30 kr "to pay", and owed read 30 kr again.
 * Owner rules: Q-M3 "Next payout" + Q-S5-7 "Carry over" (the money settles the carried rest first, oldest first),
 * contract debtModel.driverOwes.paidMovera; payoutHold ("while held no scheduled payout is made").
 */

let database: TestDatabase;
const SUPER: Principal = { actor: "admin", subjectId: "adm_j8b", sessionId: "s_j8b", zones: ["*"], role: "super", perms: [] } as unknown as Principal;
type Money = { amountMinor: number; currency: string };
const m = (amountMinor: number, currency: string): Money => ({ amountMinor, currency });
const SEK = (minor: number) => m(minor, "SEK");
const TND = (minor: number) => m(minor, "TND");

// Weekly, Monday 08:00 local. SE and TN are both UTC+1 in these weeks.
const W1_START = "2026-10-26T07:00:00.000Z";
const W1_END = "2026-11-02T07:00:00.000Z";
const W3_END = "2026-11-16T07:00:00.000Z";
const IN_W1 = new Date("2026-10-27T10:00:00Z");
const LATE_W1 = new Date("2026-11-02T06:59:59.900Z");
const WINDOW = new Date("2026-11-02T07:20:00Z");
const STEP_W1 = new Date("2026-11-02T08:00:00Z");
const IN_W2 = new Date("2026-11-04T10:00:00Z");
const STEP_W2 = new Date("2026-11-09T08:00:00Z");
const IN_W3 = new Date("2026-11-11T10:00:00Z");
const STEP_W3 = new Date("2026-11-16T08:00:00Z");

let n = 0;
async function driver(country: "SE" | "TN" | "FR" = "SE") {
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ zone_ids: [country === "SE" ? "Z001" : country === "TN" ? "TN-TC" : "FR-PC"], country }).where("driver_id", "=", id).execute();
  return id;
}
/** An entry: a cash trip (he collected `cash`, earns `amount`) or a card trip (cash 0). */
const entry = (driverId: string, at: Date, currency: string, amount: number, cash = 0, kind: "trip" | "adjustment" = "trip") =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_j8b_${++n}`, driver_id: driverId, trip_id: null, kind, currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: kind === "trip" ? cash : null, at }).execute();
const paid = (driverId: string, owed: Money, amount: Money, at: Date) =>
  database.db.transaction().execute((trx) => driverPaidMovera(trx, SUPER, driverId, { expectedOwed: owed, amount, reason: "Swish" }, at));
/** The driver's own payout step of the hourly job (jobs/payouts.ts PAYOUT_DRIVER). */
const step = (driverId: string, at: Date) =>
  database.db.transaction().execute((trx) => payoutDriverHandler(trx, { kind: "payout_driver", refId: driverId, payload: {}, attempts: 0, firedAt: at } as unknown as Timer));
const owed = async (driverId: string, currency: string) => (await owedByDriver(database.db, [driverId], currency)).get(driverId) ?? 0;
type Line = { code: string; amountMinor: number };
async function payouts(driverId: string) {
  const rows = await database.db.selectFrom("payouts").select(["payout_id", "currency", "amount_minor", "status", "period_start", "lines"]).where("driver_id", "=", driverId).orderBy("period_start").orderBy("currency").execute();
  return rows.map((r) => ({ id: r.payout_id, start: r.period_start.toISOString(), currency: r.currency, amount: Number(r.amount_minor), status: r.status, paidLine: (r.lines as Line[]).find((l) => l.code === "paid_to_movera")?.amountMinor ?? 0 }));
}
const paidEntries = async (driverId: string) =>
  (await database.db.selectFrom("earnings_entries").select(["amount_minor", "payout_id"]).where("driver_id", "=", driverId).where("kind", "=", "paid_to_movera").orderBy("entry_id").execute()).map((e) => ({ amount: Number(e.amount_minor), payoutId: e.payout_id }));
const sum = (list: { amount: number }[]) => list.reduce((s, x) => s + x.amount, 0);

beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

describe("J8b: Driver paid Movera between the week's end and its payout row settles that week (SF1 probe)", () => {
  it("SEK (the probe): he owes 30 kr from the ended week, the admin records 30 kr before the payout step: never −30 kr / +30 kr, owed stays 0", async () => {
    const d = await driver("SE");
    await entry(d, IN_W1, "SEK", 17_000, 20_000);
    expect(await owed(d, "SEK")).toBe(3_000);
    expect((await paid(d, SEK(3_000), SEK(3_000), WINDOW)).owed).toEqual(SEK(0));
    await step(d, STEP_W1);
    // Fail-before: the old week's payout was −3 000 (open) with no paid_to_movera line.
    expect(await payouts(d)).toEqual([expect.objectContaining({ start: W1_START, amount: 0, paidLine: 3_000, status: "pending" })]);
    expect(await owed(d, "SEK")).toBe(0);
    // Next week: a 100 kr card trip. Fail-before: the payout was 13 000 (his 30 kr paid back) and owed read 3 000 again.
    await entry(d, IN_W2, "SEK", 10_000);
    await step(d, STEP_W2);
    const all = await payouts(d);
    expect(all.map((p) => [p.start, p.amount, p.paidLine])).toEqual([[W1_START, 0, 3_000], [W1_END, 10_000, 0]]);
    expect(await owed(d, "SEK")).toBe(0);
    expect(await paidEntries(d)).toEqual([{ amount: 3_000, payoutId: all[0]!.id }]);
  });

  it("TND (3 decimals): 6.000 DT owed from the ended week + 1.500 DT this week, he pays 7.500 DT in the window: 6.000 settles the old week, 1.500 this week", async () => {
    const d = await driver("TN");
    await entry(d, IN_W1, "TND", 16_000, 22_000);
    await entry(d, new Date("2026-11-02T07:10:00Z"), "TND", 8_500, 10_000);
    expect(await owed(d, "TND")).toBe(7_500);
    expect((await paid(d, TND(7_500), TND(7_500), WINDOW)).owed).toEqual(TND(0));
    await step(d, STEP_W1);
    expect(await payouts(d)).toEqual([expect.objectContaining({ start: W1_START, currency: "TND", amount: 0, paidLine: 6_000 })]);
    expect(await owed(d, "TND")).toBe(0);
    await step(d, STEP_W2);
    const all = await payouts(d);
    // Fail-before: [W1 −6 000, W2 +6 000].
    expect(all.map((p) => [p.start, p.amount, p.paidLine])).toEqual([[W1_START, 0, 6_000], [W1_END, 0, 1_500]]);
    expect(await owed(d, "TND")).toBe(0);
    // The money he paid is there once, in whole millimes: 6.000 + 1.500 = 7.500 DT.
    const entries = await paidEntries(d);
    expect(sum(entries)).toBe(7_500);
    expect(entries.map((e) => [e.amount, e.payoutId]).sort()).toEqual([[1_500, all[1]!.id], [6_000, all[0]!.id]].sort());
  });

  it("SEK: a part payment in the window (10 of 30 kr): the old week's payout is −20 kr and owed stays 20 kr", async () => {
    const d = await driver("SE");
    await entry(d, IN_W1, "SEK", 17_000, 20_000);
    expect((await paid(d, SEK(3_000), SEK(1_000), WINDOW)).owed).toEqual(SEK(2_000));
    await step(d, STEP_W1);
    expect(await payouts(d)).toEqual([expect.objectContaining({ start: W1_START, amount: -2_000, paidLine: 1_000, status: "pending" })]);
    expect(await owed(d, "SEK")).toBe(2_000);
    // He pays the rest after the payout row exists: linked, the payout is closed as paid, nothing in a later payout.
    expect((await paid(d, SEK(2_000), SEK(2_000), IN_W2)).owed).toEqual(SEK(0));
    await step(d, STEP_W2);
    expect(await payouts(d)).toEqual([expect.objectContaining({ start: W1_START, amount: -2_000, status: "paid" })]);
    expect(await owed(d, "SEK")).toBe(0);
    expect(sum(await paidEntries(d))).toBe(3_000);
  });

  it("SEK: he pays more than the ended week's debt can take only up to what he owes; a later positive week is not touched", async () => {
    const d = await driver("SE");
    await entry(d, IN_W1, "SEK", 17_000, 20_000);
    await expect(paid(d, SEK(3_000), SEK(3_001), WINDOW)).rejects.toMatchObject({ options: { reason: "paid_above_owed" } });
    await paid(d, SEK(3_000), SEK(3_000), WINDOW);
    await entry(d, IN_W2, "SEK", 25_000);
    await step(d, STEP_W2);
    expect((await payouts(d)).map((p) => [p.start, p.amount, p.paidLine])).toEqual([[W1_START, 0, 3_000], [W1_END, 25_000, 0]]);
  });
});

describe("J8b: a driver on payout hold", () => {
  it("SEK: held over two weeks (−30 kr, −20 kr), he pays 50 kr in week 3; after the release each week is settled, nothing is paid back", async () => {
    const d = await driver("SE");
    await database.db.transaction().execute((trx) => holdDriverPayouts(trx, SUPER, d, { held: true, reason: "Bank check" }, new Date("2026-10-26T09:00:00Z")));
    await entry(d, IN_W1, "SEK", 17_000, 20_000);
    await entry(d, IN_W2, "SEK", 8_000, 10_000);
    await step(d, STEP_W2);
    // payoutHold: while held no scheduled payout is made.
    expect(await payouts(d)).toEqual([]);
    expect(await owed(d, "SEK")).toBe(5_000);
    expect((await paid(d, SEK(5_000), SEK(5_000), IN_W3)).owed).toEqual(SEK(0));
    expect(await payouts(d)).toEqual([]);
    await database.db.transaction().execute((trx) => holdDriverPayouts(trx, SUPER, d, { held: false, reason: "Checked" }, IN_W3));
    await step(d, new Date("2026-11-11T11:00:00Z"));
    // Fail-before: [W1 −3 000, W2 −2 000] and, after week 3, +5 000 "to pay" with owed 5 000.
    expect((await payouts(d)).map((p) => [p.start, p.amount, p.paidLine])).toEqual([[W1_START, 0, 3_000], [W1_END, 0, 2_000]]);
    expect(await owed(d, "SEK")).toBe(0);
    await step(d, STEP_W3);
    expect((await payouts(d)).length).toBe(2);
    expect(await owed(d, "SEK")).toBe(0);
    expect(sum(await paidEntries(d))).toBe(5_000);
    expect((await paidEntries(d)).every((e) => e.payoutId !== null)).toBe(true);
  });

  it("TND: held, he pays the first week's 6.000 DT in week 2 and then collects 2.000 DT more: after the release week 1 is 0 and week 2 is −2.000 DT", async () => {
    const d = await driver("TN");
    await database.db.transaction().execute((trx) => holdDriverPayouts(trx, SUPER, d, { held: true, reason: "Bank check" }, new Date("2026-10-26T09:00:00Z")));
    await entry(d, IN_W1, "TND", 16_000, 22_000);
    await paid(d, TND(6_000), TND(6_000), new Date("2026-11-03T09:00:00Z"));
    await entry(d, IN_W2, "TND", 8_000, 10_000);
    expect(await owed(d, "TND")).toBe(2_000);
    await database.db.transaction().execute((trx) => holdDriverPayouts(trx, SUPER, d, { held: false, reason: "Checked" }, IN_W3));
    await step(d, new Date("2026-11-11T11:00:00Z"));
    // Fail-before: [W1 −6 000, W2 +4 000].
    expect((await payouts(d)).map((p) => [p.start, p.amount, p.paidLine])).toEqual([[W1_START, 0, 6_000], [W1_END, -2_000, 0]]);
    expect(await owed(d, "TND")).toBe(2_000);
  });

  it("SEK: a payout made by hand for the ended week (Create payout) takes the money he paid after it too", async () => {
    const d = await driver("SE");
    await database.db.transaction().execute((trx) => holdDriverPayouts(trx, SUPER, d, { held: true, reason: "Bank check" }, new Date("2026-10-26T09:00:00Z")));
    await entry(d, IN_W1, "SEK", 17_000, 20_000);
    await paid(d, SEK(3_000), SEK(3_000), WINDOW);
    const made = await database.db.transaction().execute((trx) => createPayout(trx, SUPER, { driverId: d, from: W1_START, to: W1_END }, STEP_W1));
    expect(made.amount).toEqual(SEK(0));
    expect(await owed(d, "SEK")).toBe(0);
    expect(await paidEntries(d)).toEqual([{ amount: 3_000, payoutId: made.payoutId }]);
  });
});

describe("J8b: the cases that already worked stay as they were", () => {
  it("SEK normal: paid inside the same week: one payout of 0 kr with the paid_to_movera line", async () => {
    const d = await driver("SE");
    await entry(d, IN_W1, "SEK", 17_000, 20_000);
    await paid(d, SEK(3_000), SEK(3_000), new Date("2026-10-28T09:00:00Z"));
    await step(d, STEP_W1);
    expect((await payouts(d)).map((p) => [p.start, p.amount, p.paidLine])).toEqual([[W1_START, 0, 3_000]]);
    expect(await owed(d, "SEK")).toBe(0);
  });

  it("SEK normal: a part payment inside the week (10 of 30 kr): the payout is −20 kr and owed is 20 kr before and after the step", async () => {
    const d = await driver("SE");
    await entry(d, IN_W1, "SEK", 17_000, 20_000);
    await paid(d, SEK(3_000), SEK(1_000), new Date("2026-10-28T09:00:00Z"));
    expect(await owed(d, "SEK")).toBe(2_000);
    await step(d, STEP_W1);
    expect((await payouts(d)).map((p) => [p.start, p.amount, p.paidLine])).toEqual([[W1_START, -2_000, 1_000]]);
    // The money inside the payout's amount is counted once (not again as "linked").
    expect(await owed(d, "SEK")).toBe(2_000);
    // And the rest he pays later closes it: exactly 20 kr, not 10 kr.
    await expect(paid(d, SEK(2_000), SEK(2_001), IN_W2)).rejects.toMatchObject({ options: { reason: "paid_above_owed" } });
    await paid(d, SEK(2_000), SEK(2_000), IN_W2);
    expect((await payouts(d))[0]).toMatchObject({ status: "paid", amount: -2_000 });
    expect(await owed(d, "SEK")).toBe(0);
  });

  it("TND normal: the payout row exists (−6.000 DT): the money is linked to it and it is paid (J8 round 1 must-fix 2)", async () => {
    const d = await driver("TN");
    await entry(d, IN_W1, "TND", 16_000, 22_000);
    await step(d, STEP_W1);
    expect((await payouts(d)).map((p) => [p.amount, p.status])).toEqual([[-6_000, "pending"]]);
    await paid(d, TND(6_000), TND(6_000), IN_W2);
    const all = await payouts(d);
    expect(all.map((p) => [p.amount, p.status, p.paidLine])).toEqual([[-6_000, "paid", 0]]);
    await step(d, STEP_W2);
    expect((await payouts(d)).length).toBe(1);
    expect(await owed(d, "TND")).toBe(0);
  });

  it("SEK: a positive week takes no later paid_to_movera money (it stays in the week it was paid in)", async () => {
    const d = await driver("SE");
    await entry(d, IN_W1, "SEK", 10_000);
    await entry(d, new Date("2026-11-02T07:05:00Z"), "SEK", 17_000, 20_000);
    // Owed counts the unpaid entries together: 100 − 30 = +70 kr, nothing owed; no click is possible.
    expect(await owed(d, "SEK")).toBe(0);
    await step(d, STEP_W1);
    expect(await owed(d, "SEK")).toBe(3_000);
    await paid(d, SEK(3_000), SEK(3_000), IN_W2);
    await step(d, STEP_W2);
    expect((await payouts(d)).map((p) => [p.start, p.amount, p.paidLine])).toEqual([[W1_START, 10_000, 0], [W1_END, 0, 3_000]]);
  });
});

describe("J8b: two clicks and a click racing the payout step", () => {
  it("SEK: the second click in the window (same expectedOwed) is 409 owed_changed; one entry; after the step owed is 0", async () => {
    const d = await driver("SE");
    await entry(d, IN_W1, "SEK", 17_000, 20_000);
    const both = await Promise.allSettled([paid(d, SEK(3_000), SEK(3_000), WINDOW), paid(d, SEK(3_000), SEK(3_000), WINDOW)]);
    expect(both.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect((both.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ options: { reason: "owed_changed" } });
    await step(d, STEP_W1);
    await step(d, STEP_W1);
    expect((await payouts(d)).map((p) => [p.amount, p.paidLine])).toEqual([[0, 3_000]]);
    expect(sum(await paidEntries(d))).toBe(3_000);
    expect(await owed(d, "SEK")).toBe(0);
  });

  it("SEK: the click is not committed yet when the payout step starts: the step waits for it (driver lock) and then takes its money", async () => {
    const d = await driver("SE");
    await entry(d, IN_W1, "SEK", 17_000, 20_000);
    let commit!: () => void;
    const gate = new Promise<void>((resolve) => (commit = resolve));
    let written!: () => void;
    const wrote = new Promise<void>((resolve) => (written = resolve));
    // The click's clock is just before the week's end; it commits after the step (whose clock is after the end) began.
    const click = database.db.transaction().execute(async (trx) => {
      await driverPaidMovera(trx, SUPER, d, { expectedOwed: SEK(3_000), amount: SEK(3_000), reason: "Swish" }, LATE_W1);
      written();
      await gate;
    });
    await wrote;
    let stepDone = false;
    const running = step(d, STEP_W1).then(() => (stepDone = true));
    await new Promise((resolve) => setTimeout(resolve, 400));
    // The step waits on his row. Fail-before: it had already read his entries when it waited (on the payout insert),
    // so it made the week's payout −3 000 without the click's entry, and the next payout paid the 30 kr back.
    expect(stepDone).toBe(false);
    expect(await payouts(d)).toEqual([]);
    commit();
    await Promise.all([click, running]);
    expect((await payouts(d)).map((p) => [p.start, p.amount, p.paidLine])).toEqual([[W1_START, 0, 3_000]]);
    await entry(d, IN_W2, "SEK", 10_000);
    await step(d, STEP_W2);
    expect((await payouts(d)).map((p) => [p.amount, p.paidLine])).toEqual([[0, 3_000], [10_000, 0]]);
    expect(await owed(d, "SEK")).toBe(0);
  });

  it("SEK + TND, 12 rounds: the click and the payout step at the same moment (two connections): the money settles the old week either way", async () => {
    for (let round = 0; round < 12; round++) {
      const tn = round % 2 === 1;
      const cur = tn ? "TND" : "SEK";
      const d = await driver(tn ? "TN" : "SE");
      await entry(d, IN_W1, cur, 17_000, 20_000);
      // Odd thirds: the click's clock is just BEFORE the week's end while the step's is after it.
      const clickAt = round % 3 === 0 ? LATE_W1 : WINDOW;
      const results = await Promise.allSettled(round % 4 < 2 ? [paid(d, m(3_000, cur), m(3_000, cur), clickAt), step(d, STEP_W1)] : [step(d, STEP_W1), paid(d, m(3_000, cur), m(3_000, cur), clickAt)]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      await entry(d, IN_W2, cur, 10_000);
      await step(d, STEP_W2);
      const all = await payouts(d);
      // Week 1 is settled: 0 with the line (the click first) or −3 000 closed as paid (the step first). Never open below 0.
      expect(all.length).toBe(2);
      expect(all[0]!.amount === 0 ? all[0]!.paidLine : all[0]!.status).toBe(all[0]!.amount === 0 ? 3_000 : "paid");
      expect([0, -3_000]).toContain(all[0]!.amount);
      // Week 2 never pays his money back.
      expect([all[1]!.amount, all[1]!.paidLine]).toEqual([10_000, 0]);
      expect(await owed(d, cur)).toBe(0);
      const entries = await paidEntries(d);
      expect(entries).toEqual([{ amount: 3_000, payoutId: all[0]!.id }]);
    }
  });
});

describe("J8b: Driver gets / Movera gets and the fleet's earnings do not count the money (J8 rules kept)", () => {
  it("SEK + TND: the window payout's summary is his earnings only; the fleet owner sees his earnings only", async () => {
    for (const [country, cur] of [["SE", "SEK"], ["TN", "TND"]] as const) {
      const owner = await driver(country);
      const d = await driver(country);
      const fleetId = `flt_j8b_${++n}`;
      await database.db.insertInto("fleets").values({ fleet_id: fleetId, name: "J8b Taxi", org_number: "556677-8899", country, city_id: country === "SE" ? "stockholm_lan" : "tunis", zone_id: country === "SE" ? "Z001" : "TN-TC", owner_driver_id: owner, status: "approved" }).execute();
      await database.db.updateTable("drivers").set({ fleet_id: fleetId, fleet_linked_at: new Date(W1_START) }).where("driver_id", "in", [owner, d]).execute();
      await entry(d, IN_W1, cur, 17_000, 20_000);
      await entry(d, new Date("2026-11-02T07:10:00Z"), cur, 4_000, 5_000);
      const fleetView = () => fleetEarnings(database.db, owner, { from: W1_START, to: W3_END }, new Date(W3_END));
      const before = await fleetView();
      expect(before.total).toEqual(m(21_000, cur));
      await paid(d, m(4_000, cur), m(4_000, cur), WINDOW);
      await step(d, STEP_W1);
      await step(d, STEP_W2);
      const list = (await listPayouts(database.db, SUPER, { limit: 10, driverId: d })).items;
      const w1 = list.find((p) => p.periodStart === W1_START)!;
      const w2 = list.find((p) => p.periodStart === W1_END)!;
      expect([w1.amount, w2.amount]).toEqual([m(0, cur), m(0, cur)]);
      // His earnings for each period, never the 30 / 10 he paid Movera (trip_id null here, so Movera gets reads 0).
      expect(w1.summary).toEqual({ driverGets: m(17_000, cur), moveraGets: m(0, cur) });
      expect(w2.summary).toEqual({ driverGets: m(4_000, cur), moveraGets: m(0, cur) });
      expect(await fleetView()).toEqual(before);
    }
  });
});

describe("J8b round 2 (supervisor SF1-SF3, Rules audits/impact/j8b-supervisor.md)", () => {
  const W4_END = new Date("2026-11-23T07:00:00.000Z");
  const IN_W4 = new Date("2026-11-18T10:00:00Z");
  const hold = (d: string, held: boolean, at: Date) => database.db.transaction().execute((trx) => holdDriverPayouts(trx, SUPER, d, { held, reason: held ? "Bank check" : "Checked" }, at));
  const audits = async (d: string, action: string) =>
    (await database.db.selectFrom("admin_audit").select(["admin_id", "detail"]).where("target_id", "=", d).where("action", "=", action).orderBy("audit_id").execute()).map((r): Record<string, unknown> => ({ adminId: r.admin_id, ...(r.detail as Record<string, unknown>) }));

  it("TND: held 3 weeks + this week, 9.341 DT in one click: 6.001 + 1.333 + 0.007 + 2.000, and every split has an audit row that leads back to the payment (SF1, SF3)", async () => {
    const d = await driver("TN");
    await hold(d, true, new Date("2026-10-26T09:00:00Z"));
    await entry(d, IN_W1, "TND", 10_000, 16_001);
    await entry(d, IN_W2, "TND", 5_000, 6_333);
    await entry(d, IN_W3, "TND", 1_000, 1_007);
    await entry(d, IN_W4, "TND", 8_000, 10_000);
    expect(await owed(d, "TND")).toBe(9_341);
    expect((await paid(d, TND(9_341), TND(9_341), new Date("2026-11-18T12:00:00Z"))).owed).toEqual(TND(0));
    // The payment's audit row names its entry (one unlinked entry: no payout row exists while he is held).
    const [payment] = await audits(d, "driver.paid_movera");
    const first = (payment!["entries"] as { entryId: string; amountMinor: number; payoutId: string | null }[]);
    expect(first.map((e) => [e.amountMinor, e.payoutId])).toEqual([[9_341, null]]);
    await hold(d, false, new Date("2026-11-18T13:00:00Z"));
    await step(d, new Date("2026-11-18T14:00:00Z"));
    expect((await payouts(d)).map((p) => [p.start, p.amount, p.paidLine])).toEqual([[W1_START, 0, 6_001], [W1_END, 0, 1_333], ["2026-11-09T07:00:00.000Z", 0, 7]]);
    expect(await owed(d, "TND")).toBe(0);
    await step(d, new Date(W4_END.getTime() + 3_600_000));
    const all = await payouts(d);
    expect(all.map((p) => [p.amount, p.paidLine])).toEqual([[0, 6_001], [0, 1_333], [0, 7], [0, 2_000]]);
    expect(await owed(d, "TND")).toBe(0);
    const entries = await paidEntries(d);
    expect(entries.map((e) => e.amount).sort((a, b) => a - b)).toEqual([7, 1_333, 2_000, 6_001]);
    expect(sum(entries)).toBe(9_341);
    // SF1: three splits, each with its audit row: the same entry of the payment, before = left + taken, the new part, its payout.
    const splits = await audits(d, "driver.paid_movera_split");
    expect(splits.map((s) => [s["entryId"], s["amountBeforeMinor"], s["amountTakenMinor"], s["amountLeftMinor"], s["payoutId"], s["currency"], s["adminId"]])).toEqual([
      [first[0]!.entryId, 9_341, 6_001, 3_340, all[0]!.id, "TND", null],
      [first[0]!.entryId, 3_340, 1_333, 2_007, all[1]!.id, "TND", null],
      [first[0]!.entryId, 2_007, 7, 2_000, all[2]!.id, "TND", null],
    ]);
    // The total stays traceable: the parts taken + what is left of the entry = the payment in the audit.
    expect(splits.reduce((t, s) => t + (s["amountTakenMinor"] as number), 0) + (splits.at(-1)!["amountLeftMinor"] as number)).toBe((payment!["amount"] as Money).amountMinor);
    const rows = await database.db.selectFrom("earnings_entries").select(["entry_id", "amount_minor", "payout_id"]).where("driver_id", "=", d).where("kind", "=", "paid_to_movera").execute();
    for (const s of splits) expect(rows.find((r) => r.entry_id === s["partEntryId"])).toMatchObject({ amount_minor: String(s["amountTakenMinor"]), payout_id: s["payoutId"] });
    expect(rows.find((r) => r.entry_id === first[0]!.entryId)).toMatchObject({ amount_minor: "2000", payout_id: all[3]!.id });
  });

  it("SEK: no split, no split audit row (a whole entry is only linked)", async () => {
    const d = await driver("SE");
    await entry(d, IN_W1, "SEK", 17_000, 20_000);
    await paid(d, SEK(3_000), SEK(3_000), WINDOW);
    await step(d, STEP_W1);
    expect(await audits(d, "driver.paid_movera_split")).toEqual([]);
    expect((await audits(d, "driver.paid_movera")).length).toBe(1);
  });

  it("EUR, manual mode (pending_approval): a part payment in the window is pulled into the run's payout; the rest closes it as paid (SF3)", async () => {
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-FR", version: 1, document: JSON.stringify({ country: "FR", payoutMode: "manual" }), published_at: new Date(), published_by: null }).execute();
    const d = await driver("FR");
    const EUR = (minor: number) => m(minor, "EUR");
    await entry(d, IN_W1, "EUR", 1_400, 2_000);
    expect(await owed(d, "EUR")).toBe(600);
    expect((await paid(d, EUR(600), EUR(250), WINDOW)).owed).toEqual(EUR(350));
    await step(d, STEP_W1);
    // Fail-before: −600 with no line (the 2,50 € went into the next payout) and owed read wrong after it.
    expect(await payouts(d)).toEqual([expect.objectContaining({ start: W1_START, currency: "EUR", amount: -350, paidLine: 250, status: "pending_approval" })]);
    expect(await owed(d, "EUR")).toBe(350);
    await expect(paid(d, EUR(350), EUR(351), IN_W2)).rejects.toMatchObject({ options: { reason: "paid_above_owed" } });
    expect((await paid(d, EUR(350), EUR(350), IN_W2)).owed).toEqual(EUR(0));
    expect(await payouts(d)).toEqual([expect.objectContaining({ amount: -350, paidLine: 250, status: "paid" })]);
    await step(d, STEP_W2);
    expect((await payouts(d)).length).toBe(1);
    expect(await owed(d, "EUR")).toBe(0);
    expect(sum(await paidEntries(d))).toBe(600);
  });

  it("SEK + TND, 12 rounds: the click against Create payout, the step and a second copy of the step at once: one settled week, never paid back (SF3)", async () => {
    for (let round = 0; round < 12; round++) {
      const tn = round % 2 === 1;
      const cur = tn ? "TND" : "SEK";
      const d = await driver(tn ? "TN" : "SE");
      await entry(d, IN_W1, cur, 17_000, 20_000);
      const runs = [
        () => paid(d, m(3_000, cur), m(3_000, cur), round % 3 === 0 ? LATE_W1 : WINDOW),
        () => database.db.transaction().execute((trx) => createPayout(trx, SUPER, { driverId: d, from: W1_START, to: W1_END }, STEP_W1)),
        () => step(d, STEP_W1),
        () => database.db.transaction().execute((trx) => closePeriodsBatch(trx, STEP_W1, { after: d.slice(0, -1), maxDrivers: 1 })),
      ];
      for (let i = 0; i < round % runs.length; i++) runs.push(runs.shift()!);
      const results = await Promise.allSettled(runs.map((run) => run()));
      // Only business refusals (Create payout: nothing_to_pay when a step was first); never a deadlock or a database error.
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ApiError);
      expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.options.reason)).toEqual(expect.not.arrayContaining(["owed_changed", "paid_above_owed"]));
      await entry(d, IN_W2, cur, 10_000);
      await step(d, STEP_W2);
      const all = await payouts(d);
      expect(all.length).toBe(2);
      expect([0, -3_000]).toContain(all[0]!.amount);
      expect(all[0]!.amount === 0 ? all[0]!.paidLine : all[0]!.status).toBe(all[0]!.amount === 0 ? 3_000 : "paid");
      expect([all[1]!.amount, all[1]!.paidLine]).toEqual([10_000, 0]);
      expect(await owed(d, cur)).toBe(0);
      expect(await paidEntries(d)).toEqual([{ amount: 3_000, payoutId: all[0]!.id }]);
    }
  });

  it("SEK + TND, 12 rounds: Mark as paid and Driver paid Movera on the same payout at the same moment: no deadlock, paid once (SF2)", async () => {
    for (let round = 0; round < 12; round++) {
      const cur = round % 2 ? "TND" : "SEK";
      const d = await driver(round % 2 ? "TN" : "SE");
      await entry(d, IN_W1, cur, 17_000, 20_000);
      await step(d, STEP_W1);
      const [p] = await payouts(d);
      expect([p!.amount, p!.status]).toEqual([-3_000, "pending"]);
      const mark = () => database.db.transaction().execute((trx) => markPayoutPaid(trx, SUPER, p!.id, { note: "Bank" }, IN_W2));
      const click = () => paid(d, m(3_000, cur), m(3_000, cur), IN_W2);
      const results = await Promise.allSettled(round % 4 < 2 ? [mark(), click()] : [click(), mark()]);
      // Fail-before: Postgres "deadlock detected" (40P01) on one side. Now: one wins, the other gets its business refusal.
      const refused = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason);
      for (const reason of refused) expect(reason).toBeInstanceOf(ApiError);
      expect(refused.length).toBe(1);
      expect(["already_paid", "owed_changed"]).toContain(refused[0].options.reason);
      const after = (await payouts(d))[0]!;
      expect([after.amount, after.status]).toEqual([-3_000, "paid"]);
      const entries = await paidEntries(d);
      // The click won: 30 recorded once, linked. Mark as paid won: nothing recorded.
      expect(entries).toEqual(refused[0].options.reason === "already_paid" ? [{ amount: 3_000, payoutId: after.id }] : []);
      expect(await owed(d, cur)).toBe(0);
    }
  });
});
