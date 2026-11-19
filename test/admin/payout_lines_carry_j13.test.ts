import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePeriods, createPayout, payoutView } from "../../src/admin/payouts.js";
import { payoutRuns, splitPayout } from "../../src/admin/payoutCarry.js";
import { driverPaidMovera } from "../../src/admin/driversOwing.js";
import { owedByDriver, overOwesLimit } from "../../src/drivers/owes.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";

/**
 * S5 J13 (contract v0.18.133 contract.json#payoutLines; owner 2026-11-19 "driver payout 3 lines", "carry line only when
 * needed", "carry counts toward owed limit"; Rules handover/build-plans-2026-11-12/S5-money.md J12-J15): a payout is
 * never paid below zero, the rest moves to the next payout, old payouts below 0 are only read, the carry counts toward
 * the owes-limit (no cash trips above it, card trips still come), and a re-run never pays or carries twice.
 */

let database: TestDatabase;
let n = 0;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => database.drop());
beforeEach(async () => {
  await database.db.deleteFrom("earnings_entries").execute();
  await database.db.deleteFrom("payouts").execute();
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
});

const admin = { actor: "admin" as const, subjectId: "adm_j13", sessionId: "s", zones: ["*"] };
const rules = (country: string, doc: Record<string, unknown>) =>
  database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: `standard-${country}`, version: 1, document: JSON.stringify({ country, ...doc }), published_at: new Date(), published_by: null }).execute();
const setRules = async (country: string, doc: Record<string, unknown>) => {
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").where("zone_id", "=", `standard-${country}`).execute();
  await rules(country, doc);
};
const driverIn = async (zoneIds: string[], country: string) => {
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ zone_ids: zoneIds, country }).where("driver_id", "=", id).execute();
  return id;
};
/** A pay-in-car trip: the rider hands him `cash`, his share is `earned` (cash − earned is Movera's commission). */
const cashTrip = (driverId: string, when: string, currency: string, earned: number, cash: number) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_j13_${++n}`, driver_id: driverId, trip_id: null, kind: "trip", currency, amount_minor: earned, gross_minor: null, commission_minor: null, cash_minor: cash, at: new Date(when) }).execute();
/** Card trips / bonus Movera holds for him. */
const card = (driverId: string, when: string, currency: string, amount: number) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_j13_${++n}`, driver_id: driverId, trip_id: null, kind: "adjustment", currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: null, at: new Date(when) }).execute();
const run = (now: string) => database.db.transaction().execute((trx) => closePeriods(trx, new Date(now)));
const payoutsOf = (driverId: string) =>
  database.db.selectFrom("payouts").select(["payout_id", "amount_minor", "status", "earned_minor", "owed_minor", "carried_in_minor", "carried_out_minor", "period_end"]).where("driver_id", "=", driverId).orderBy("period_end").execute();
const parts = (p: { amount_minor: unknown; earned_minor: unknown; owed_minor: unknown; carried_in_minor: unknown; carried_out_minor: unknown }) =>
  [p.earned_minor, p.owed_minor, p.amount_minor, p.carried_in_minor, p.carried_out_minor].map((v) => (v === null ? null : Number(v)));
const owed = async (driverId: string, currency: string) => (await owedByDriver(database.db, [driverId], currency)).get(driverId);

// Weekly from Monday 08:00 local (the default schedule): runs after each Monday.
const W1 = "2026-10-27T10:00:00Z", RUN1 = "2026-11-02T08:00:00Z";
const W2 = "2026-11-03T10:00:00Z", RUN2 = "2026-11-09T08:00:00Z";
const W3 = "2026-11-10T10:00:00Z", RUN3 = "2026-11-16T08:00:00Z";

describe("J13: the parts of a payout (splitPayout)", () => {
  it("cash trip 95 kr, his share 70,27 kr → owed 24,73 kr; card 100 kr next week with that carry → paid out 75,27 kr", () => {
    expect(splitPayout([{ kind: "trip", amountMinor: 7027, cashMinor: 9500 }], 0)).toEqual({ earned: 0, owed: 2473, paidOut: 0, carriedOut: 2473 });
    expect(splitPayout([{ kind: "adjustment", amountMinor: 10_000, cashMinor: 0 }], 2473)).toEqual({ earned: 10_000, owed: 2473, paidOut: 7527, carriedOut: 0 });
    // "Driver paid Movera" lowers what he owes; a rest past 0 counts as earned.
    expect(splitPayout([{ kind: "paid_to_movera", amountMinor: 3000, cashMinor: 0 }], 2473)).toEqual({ earned: 527, owed: 0, paidOut: 527, carriedOut: 0 });
  });
});

describe("J13: switch off (default) = payouts exactly as before", () => {
  it("a cash-only week stays a payout below 0 with no parts; the driver view has no paidOut", async () => {
    const d = await driverIn(["Z001"], "SE");
    await cashTrip(d, W1, "SEK", 7027, 9500);
    expect(await run(RUN1)).toBe(1);
    const [p] = await payoutsOf(d);
    expect(parts(p!)).toEqual([null, null, -2473, null, null]);
    expect(await owed(d, "SEK")).toBe(2473);
    const row = await database.db.selectFrom("payouts").selectAll().where("driver_id", "=", d).executeTakeFirstOrThrow();
    expect(payoutView(row as never, "driver")).not.toHaveProperty("paidOut");
  });
});

describe("J13: switch on, carry chain over 3 weeks (SE)", () => {
  it("week 1 pays 0 and carries 24,73; week 2 takes it (75,27 paid); week 3 carries the new rest; re-runs never pay or carry twice", async () => {
    await rules("SE", { payoutLinesOn: true });
    const d = await driverIn(["Z001"], "SE");
    await cashTrip(d, W1, "SEK", 7027, 9500);
    expect(await run(RUN1)).toBe(1);
    expect(await run(RUN1)).toBe(0);
    let rows = await payoutsOf(d);
    expect(rows.map(parts)).toEqual([[0, 2473, 0, 0, 2473]]);
    expect(await owed(d, "SEK")).toBe(2473);

    await card(d, W2, "SEK", 10_000);
    expect(await run(RUN2)).toBe(1);
    expect(await run(RUN2)).toBe(0);
    rows = await payoutsOf(d);
    expect(rows.map(parts)).toEqual([[0, 2473, 0, 0, 2473], [10_000, 2473, 7527, 2473, 0]]);
    expect(await owed(d, "SEK")).toBe(0);

    await cashTrip(d, W3, "SEK", 7027, 9500);
    await card(d, W3, "SEK", 1000);
    expect(await run(RUN3)).toBe(1);
    expect(await run("2026-11-16T09:00:00Z")).toBe(0);
    rows = await payoutsOf(d);
    expect(rows.map(parts)[2]).toEqual([1000, 2473, 0, 0, 1473]);
    expect(await owed(d, "SEK")).toBe(1473);
    // Never a payout below zero; earned − owed = paidOut − carriedOut on every row.
    for (const r of rows) {
      const [e, o, paid, , out] = parts(r) as number[];
      expect(paid).toBeGreaterThanOrEqual(0);
      expect(e! - o!).toBe(paid! - out!);
    }
    // The driver sees the parts (server amounts).
    const row = await database.db.selectFrom("payouts").selectAll().where("payout_id", "=", rows[1]!.payout_id).executeTakeFirstOrThrow();
    expect(payoutView(row as never, "driver")).toMatchObject({ amount: { amountMinor: 7527, currency: "SEK" }, earned: { amountMinor: 10_000 }, owedToMovera: { amountMinor: 2473 }, paidOut: { amountMinor: 7527 }, carriedIn: { amountMinor: 2473 }, carriedOut: { amountMinor: 0 } });
  });

  it("a week with no entries makes no payout: the carry waits for the next payout", async () => {
    await rules("SE", { payoutLinesOn: true });
    const d = await driverIn(["Z001"], "SE");
    await cashTrip(d, W1, "SEK", 7027, 9500);
    await run(RUN1);
    expect(await run(RUN2)).toBe(0);
    await card(d, W3, "SEK", 5000);
    await run(RUN3);
    expect((await payoutsOf(d)).map(parts)).toEqual([[0, 2473, 0, 0, 2473], [5000, 2473, 2527, 2473, 0]]);
  });

  it("a Create payout by hand takes the carry too (one driver lock, the same calculation)", async () => {
    await rules("SE", { payoutLinesOn: true });
    const d = await driverIn(["Z001"], "SE");
    await cashTrip(d, W1, "SEK", 7027, 9500);
    await run(RUN1);
    await card(d, W2, "SEK", 3000);
    const made = await database.db.transaction().execute((trx) => createPayout(trx, admin, { driverId: d, from: "2026-11-02T07:00:00Z", to: "2026-11-05T00:00:00Z" }, new Date("2026-11-05T01:00:00Z")));
    expect(made).toMatchObject({ amount: { amountMinor: 527 }, paidOut: { amountMinor: 527 }, carriedIn: { amountMinor: 2473 }, carriedOut: { amountMinor: 0 } });
    expect(await owed(d, "SEK")).toBe(0);
  });

  it("'Driver paid Movera' while a rest is carried lowers what he owes; the next payout takes it once", async () => {
    await rules("SE", { payoutLinesOn: true });
    const d = await driverIn(["Z001"], "SE");
    await cashTrip(d, W1, "SEK", 7027, 9500);
    await run(RUN1);
    await database.db.transaction().execute((trx) => driverPaidMovera(trx, admin, d, { expectedOwed: { amountMinor: 2473, currency: "SEK" }, amount: { amountMinor: 2000, currency: "SEK" }, reason: "Swish" }, new Date("2026-11-04T10:00:00Z")));
    expect(await owed(d, "SEK")).toBe(473);
    await card(d, W2, "SEK", 1000);
    await run(RUN2);
    expect((await payoutsOf(d)).map(parts)[1]).toEqual([1000, 473, 527, 2473, 0]);
    expect(await owed(d, "SEK")).toBe(0);
  });
});

describe("J13 review M2: a carry is taken once, also by a hand payout for an older range", () => {
  // A newer switched-on payout N carries 24,73 kr; then a late entry dated in an older week is paid by Create payout.
  const lateOlderRange = async (handNow: string) => {
    await rules("SE", { payoutLinesOn: true });
    const d = await driverIn(["Z001"], "SE");
    await cashTrip(d, W2, "SEK", 7027, 9500);
    expect(await run(RUN2)).toBe(1);
    expect(await owed(d, "SEK")).toBe(2473);
    await card(d, W1, "SEK", 1000);
    const made = await database.db.transaction().execute((trx) => createPayout(trx, admin, { driverId: d, from: "2026-10-26T07:00:00Z", to: "2026-11-02T07:00:00Z" }, new Date(handNow)));
    expect(made).toMatchObject({ amount: { amountMinor: 0 }, earned: { amountMinor: 1000 }, owedToMovera: { amountMinor: 2473 }, carriedIn: { amountMinor: 2473 }, carriedOut: { amountMinor: 1473 } });
    // The 24,73 kr is taken once: he owes 14,73 kr, not 24,73 kr + 14,73 kr.
    expect(await owed(d, "SEK")).toBe(1473);
    await card(d, W3, "SEK", 10_000);
    expect(await run(RUN3)).toBe(1);
    const rows = await database.db.selectFrom("payouts").select(["amount_minor", "carried_in_minor", "carried_out_minor", "lines", "period_end"]).where("driver_id", "=", d).orderBy("created_at").execute();
    expect(rows.map((r) => [Number(r.amount_minor), Number(r.carried_in_minor), Number(r.carried_out_minor)])).toEqual([[0, 0, 2473], [0, 2473, 1473], [8527, 1473, 0]]);
    expect(await owed(d, "SEK")).toBe(0);
    // Review S2: the stored lines of every lined payout add up to its amount (carried_in / carried_out lines).
    for (const r of rows) expect((r.lines as { amountMinor: number }[]).reduce((sum, l) => sum + l.amountMinor, 0)).toBe(Number(r.amount_minor));
    expect(rows[1]!.lines).toEqual(expect.arrayContaining([{ code: "carried_in", amountMinor: -2473 }, { code: "carried_out", amountMinor: 1473 }]));
  };

  it("newer switched-on payout exists, admin pays an older range by hand: the rest is charged once", async () => {
    await lateOlderRange("2026-11-10T09:00:00Z");
  });

  it("the same when the hand payout's clock is behind the newer payout (it is stamped after it)", async () => {
    await lateOlderRange("2026-11-09T07:00:00Z");
  });
});

describe("J13: old payouts below 0 are only read", () => {
  it("made with the switch off, then switched on: the next payout takes the old rest once (less 'Driver paid Movera' linked to it); the old row is never rewritten and no longer counts", async () => {
    const d = await driverIn(["Z001"], "SE");
    await cashTrip(d, W1, "SEK", 7027, 9500);
    await run(RUN1);
    await database.db.transaction().execute((trx) => driverPaidMovera(trx, admin, d, { expectedOwed: { amountMinor: 2473, currency: "SEK" }, amount: { amountMinor: 1000, currency: "SEK" }, reason: "Swish" }, new Date("2026-11-04T10:00:00Z")));
    const [old] = await payoutsOf(d);
    expect(Number(old!.amount_minor)).toBe(-2473);
    expect(await owed(d, "SEK")).toBe(1473);
    await setRules("SE", { payoutLinesOn: true });
    await card(d, W2, "SEK", 10_000);
    await run(RUN2);
    const rows = await payoutsOf(d);
    expect(rows[0]).toEqual(old);
    expect(parts(rows[1]!)).toEqual([10_000, 1473, 8527, 1473, 0]);
    expect(await owed(d, "SEK")).toBe(0);
  });

  it("switched off again after a rest was carried: the rest is still taken (never lost)", async () => {
    await rules("SE", { payoutLinesOn: true });
    const d = await driverIn(["Z001"], "SE");
    await cashTrip(d, W1, "SEK", 7027, 9500);
    await run(RUN1);
    await setRules("SE", { payoutLinesOn: false });
    await card(d, W2, "SEK", 10_000);
    await run(RUN2);
    expect((await payoutsOf(d)).map(parts)[1]).toEqual([10_000, 2473, 7527, 2473, 0]);
  });
});

describe("J13: the carry counts toward the owes-limit (no cash trips above it, card trips still come)", () => {
  it("TN, 3 decimals: cash-only weeks grow the carried debt until the limit; then cash trips skip him, card trips do not", async () => {
    await rules("TN", { payoutLinesOn: true, driverOwesLimit: { enabled: true, max: { amountMinor: 5000, currency: "TND" } } });
    const tunis = await database.db.selectFrom("zones").select("zone_id").where("country", "=", "TN").executeTakeFirst();
    const d = await driverIn(tunis ? [tunis.zone_id] : [], "TN");
    const zone = tunis?.zone_id ?? "Z001";
    const cashBlocked = async () => (await overOwesLimit(database.db, { zone_id: zone, payment_method: "cash" }, [d])).has(d);
    const cardBlocked = async () => (await overOwesLimit(database.db, { zone_id: zone, payment_method: "card" }, [d])).has(d);
    for (const [w, r, want] of [[W1, RUN1, 2001], [W2, RUN2, 4002], [W3, RUN3, 6003]] as const) {
      await cashTrip(d, w, "TND", 6000, 8001);
      await run(r);
      expect(await owed(d, "TND")).toBe(want);
    }
    const rows = await payoutsOf(d);
    expect(rows.map((p) => Number(p.amount_minor))).toEqual([0, 0, 0]);
    expect(rows.map((p) => Number(p.carried_out_minor))).toEqual([2001, 4002, 6003]);
    expect(tunis).toBeDefined();
    expect(await cashBlocked()).toBe(true);
    expect(await cardBlocked()).toBe(false);
  });
});

describe("J14: GET /admin/payouts/runs counts every payout of a run (not the first page)", () => {
  it("150 waiting payouts → count 150 and the server's totals per line", async () => {
    await rules("SE", { payoutMode: "manual", payoutLinesOn: true });
    for (let i = 0; i < 150; i++) {
      const d = await driverIn(["Z001"], "SE");
      if (i % 2 === 0) await card(d, W1, "SEK", 1000);
      else await cashTrip(d, W1, "SEK", 7027, 9500);
    }
    expect(await run(RUN1)).toBe(150);
    const { items } = await payoutRuns(database.db, "SE", null);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ country: "SE", count: 150, total: [{ amountMinor: 75_000, currency: "SEK" }], earned: [{ amountMinor: 75_000, currency: "SEK" }], owedToMovera: [{ amountMinor: 75 * 2473, currency: "SEK" }], paidOut: [{ amountMinor: 75_000, currency: "SEK" }], carriedOut: [{ amountMinor: 75 * 2473, currency: "SEK" }] });
    // An admin of another zone sees none of it.
    expect((await payoutRuns(database.db, "SE", ["Z999"])).items).toEqual([]);
  });
});
