import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvePayoutRun, closePeriods, driverPayouts, holdDriverPayouts, markPayoutPaid, payoutScheduleOf, periodOf } from "../../src/admin/payouts.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";

/**
 * Live clean-up 1 (contract v0.18.13, contract.json#payouts.schedule / payouts.currency; owner G10-2, audit M1/M2):
 * a payout is in one currency; the period follows the country's schedule (default weekly Monday 08:00 local); a
 * driver without a zone is paid in his country's time zone (a French driver never on Stockholm time).
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

const entry = (driverId: string, at: string, currency: string, amount: number) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_p${++n}`, driver_id: driverId, trip_id: null, kind: "adjustment", currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: null, at: new Date(at) }).execute();
const driverIn = async (zoneIds: string[], country: string | null) => {
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ zone_ids: zoneIds, country }).where("driver_id", "=", id).execute();
  return id;
};
const run = (now: string) => database.db.transaction().execute((trx) => closePeriods(trx, new Date(now)));
const payoutsOf = (driverId: string) =>
  database.db.selectFrom("payouts").select(["currency", "amount_minor", "period_start", "period_end"]).where("driver_id", "=", driverId).orderBy("currency").execute()
    .then((rows) => rows.map((r) => [r.currency, Number(r.amount_minor), r.period_start.toISOString(), r.period_end.toISOString()]));

describe("one payout per currency (audit M1)", () => {
  it("a driver with kr and € entries in one week gets two payouts, never a sum of both", async () => {
    const id = await driverIn(["Z001"], "SE");
    await entry(id, "2026-10-27T10:00:00Z", "SEK", 10_000);
    await entry(id, "2026-10-28T10:00:00Z", "EUR", 2_000);
    await entry(id, "2026-10-29T10:00:00Z", "SEK", 5_000);
    expect(await run("2026-11-02T08:00:00Z")).toBe(2);
    expect(await payoutsOf(id)).toEqual([
      ["EUR", 2_000, "2026-10-26T07:00:00.000Z", "2026-11-02T07:00:00.000Z"],
      ["SEK", 15_000, "2026-10-26T07:00:00.000Z", "2026-11-02T07:00:00.000Z"],
    ]);
    expect(await run("2026-11-02T09:00:00Z")).toBe(0);
  });
});

describe("payout schedule from the admin (owner G10-2)", () => {
  it("default weekly Monday 08:00 local: not paid at 07:59 Stockholm, paid from 08:00 (SE)", async () => {
    const id = await driverIn(["Z001"], "SE");
    await entry(id, "2026-10-27T10:00:00Z", "SEK", 10_000);
    expect(await run("2026-11-02T06:59:00Z")).toBe(0);
    expect(await run("2026-11-02T07:00:00Z")).toBe(1);
  });

  it("a French driver without a zone is paid on Paris time, not Stockholm's (FR)", async () => {
    const id = await driverIn([], "FR");
    await entry(id, "2026-10-27T10:00:00Z", "EUR", 3_000);
    expect(await run("2026-11-02T07:00:00Z")).toBe(1);
    expect(await payoutsOf(id)).toEqual([["EUR", 3_000, "2026-10-26T07:00:00.000Z", "2026-11-02T07:00:00.000Z"]]);
  });

  it("the country standard's schedule: every 2 weeks on Friday 16:30 (SE); bad values fall back to the default", async () => {
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-SE", version: 1, document: JSON.stringify({ country: "SE", payoutSchedule: { frequency: "every_2_weeks", day: "friday", time: "16:30" } }), published_at: new Date(), published_by: null }).execute();
    const id = await driverIn(["Z001"], "SE");
    await entry(id, "2026-10-27T10:00:00Z", "SEK", 4_000);
    // Periods start on even weeks from 2026-01-05 (the week of 10-12 is week 40): Fri 2026-10-16 16:30 CEST → Fri 2026-10-30 16:30 CET.
    expect(await run("2026-10-30T15:29:00Z")).toBe(0);
    expect(await run("2026-10-30T15:30:00Z")).toBe(1);
    expect(await payoutsOf(id)).toEqual([["SEK", 4_000, "2026-10-16T14:30:00.000Z", "2026-10-30T15:30:00.000Z"]]);
    expect(payoutScheduleOf({ payoutSchedule: { frequency: "daily" as never, day: "someday", time: "25:00" } })).toEqual({ frequency: "weekly", day: "monday", time: "08:00" });
    const p = await periodOf(database.db, new Date("2026-11-03T12:00:00Z"), "Europe/Paris", payoutScheduleOf(null));
    expect([p.start.toISOString(), p.end.toISOString()]).toEqual(["2026-11-02T07:00:00.000Z", "2026-11-09T07:00:00.000Z"]);
  });
});

describe("checker 4: a late entry for a week already paid goes to the next open week", () => {
  it("the entry is paid with the next week, never stuck (SE)", async () => {
    const id = await driverIn(["Z001"], "SE");
    await entry(id, "2026-10-27T10:00:00Z", "SEK", 10_000);
    expect(await run("2026-11-02T07:00:00Z")).toBe(1);
    // Booked late into the paid week (an admin adjustment dated in it).
    await entry(id, "2026-10-28T10:00:00Z", "SEK", 700);
    expect(await run("2026-11-09T07:00:00Z")).toBe(1);
    expect(await payoutsOf(id)).toEqual([
      ["SEK", 10_000, "2026-10-26T07:00:00.000Z", "2026-11-02T07:00:00.000Z"],
      ["SEK", 700, "2026-11-02T07:00:00.000Z", "2026-11-09T07:00:00.000Z"],
    ]);
    const left = await database.db.selectFrom("earnings_entries").select("entry_id").where("driver_id", "=", id).where("payout_id", "is", null).execute();
    expect(left).toEqual([]);
  });
});


describe("v0.18.16 A2 (owner Q4): pause one driver's payouts from his profile", () => {
  const finance = { actor: "admin" as const, subjectId: "adm_f", sessionId: "s", zones: ["*"] };
  const other = { actor: "admin" as const, subjectId: "adm_o", sessionId: "s", zones: ["FR-PC"] };
  const hold = (driverId: string, held: boolean, who = finance) => database.db.transaction().execute((trx) => holdDriverPayouts(trx, who, driverId, { held, reason: held ? "Bank check" : "Checked" }, new Date("2026-11-01T10:00:00Z")));
  it("held: no scheduled payout, others still paid; released: the missed weeks are paid at the next run (SE)", async () => {
    const held = await driverIn(["Z001"], "SE");
    const paid = await driverIn(["Z001"], "SE");
    await entry(held, "2026-10-20T10:00:00Z", "SEK", 7_000);
    await entry(held, "2026-10-27T10:00:00Z", "SEK", 3_000);
    await entry(paid, "2026-10-27T10:00:00Z", "SEK", 1_000);
    await expect(hold(held, true, other)).rejects.toMatchObject({ options: { reason: "zone_out_of_scope" } });
    await hold(held, true);
    await expect(hold(held, true)).rejects.toMatchObject({ options: { reason: "payout_already_held" } });
    expect(await run("2026-11-02T08:00:00Z")).toBe(1);
    expect(await payoutsOf(held)).toEqual([]);
    await hold(held, false);
    await expect(hold(held, false)).rejects.toMatchObject({ options: { reason: "payout_not_held" } });
    expect(await run("2026-11-02T09:00:00Z")).toBe(2);
    expect((await payoutsOf(held)).map((p) => p[1])).toEqual([7_000, 3_000]);
    const actions = await database.db.selectFrom("admin_audit").select("action").where("target_id", "=", held).orderBy("at").execute();
    expect(actions.map((a) => a.action)).toEqual(["payout.hold", "payout.release"]);
  });
});

describe("v0.18.16 A2 (owner Q4): payouts Automatic or Manual per country, a manual run is approved by one admin", () => {
  const finance = { actor: "admin" as const, subjectId: "adm_f", sessionId: "s", zones: ["*"] };
  const paris = { actor: "admin" as const, subjectId: "adm_p", sessionId: "s", zones: ["FR-PC"] };
  const at = new Date("2026-11-02T08:00:00Z");
  it("SE manual: the run waits, cannot be paid, one approval makes it pending; FR automatic is paid as before", async () => {
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-SE", version: 1, document: JSON.stringify({ country: "SE", payoutMode: "manual" }), published_at: new Date(), published_by: null }).execute();
    const se = await driverIn(["Z001"], "SE");
    const fr = await driverIn(["FR-PC"], "FR");
    await entry(se, "2026-10-27T10:00:00Z", "SEK", 10_000);
    await entry(fr, "2026-10-27T10:00:00Z", "EUR", 2_000);
    expect(await run("2026-11-02T08:00:00Z")).toBe(2);
    const rows = await database.db.selectFrom("payouts").select(["payout_id", "driver_id", "status", "period_end"]).execute();
    const sePayout = rows.find((r) => r.driver_id === se)!;
    expect(sePayout.status).toBe("pending_approval");
    expect(rows.find((r) => r.driver_id === fr)!.status).toBe("pending");
    // The driver sees it as on its way.
    expect((await driverPayouts(database.db, se, { limit: 10 })).items[0]).toMatchObject({ status: "pending" });
    await expect(database.db.transaction().execute((trx) => markPayoutPaid(trx, finance, sePayout.payout_id, {}, at))).rejects.toMatchObject({ options: { reason: "run_not_approved" } });
    const periodEnd = sePayout.period_end.toISOString();
    await expect(database.db.transaction().execute((trx) => approvePayoutRun(trx, paris, { country: "SE", periodEnd }, at))).rejects.toMatchObject({ options: { reason: "zone_out_of_scope" } });
    const done = await database.db.transaction().execute((trx) => approvePayoutRun(trx, finance, { country: "SE", periodEnd }, at));
    expect(done).toEqual({ country: "SE", periodEnd, approved: 1, total: [{ amountMinor: 10_000, currency: "SEK" }] });
    await expect(database.db.transaction().execute((trx) => approvePayoutRun(trx, finance, { country: "SE", periodEnd }, at))).rejects.toMatchObject({ options: { reason: "nothing_to_approve" } });
    expect((await database.db.selectFrom("payouts").select("status").where("payout_id", "=", sePayout.payout_id).executeTakeFirstOrThrow()).status).toBe("pending");
    await database.db.transaction().execute((trx) => markPayoutPaid(trx, finance, sePayout.payout_id, {}, at));
    const audit = await database.db.selectFrom("admin_audit").select(["action", "target_id"]).where("action", "=", "payout.run_approve").execute();
    expect(audit).toEqual([{ action: "payout.run_approve", target_id: `SE:${periodEnd}` }]);
  });

  it("FR manual and a Paris admin: the Paris admin approves the French run (FR)", async () => {
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-FR", version: 1, document: JSON.stringify({ country: "FR", payoutMode: "manual" }), published_at: new Date(), published_by: null }).execute();
    const fr = await driverIn(["FR-PC"], "FR");
    await entry(fr, "2026-10-27T10:00:00Z", "EUR", 3_000);
    expect(await run("2026-11-02T08:00:00Z")).toBe(1);
    const row = await database.db.selectFrom("payouts").select(["status", "period_end"]).where("driver_id", "=", fr).executeTakeFirstOrThrow();
    expect(row.status).toBe("pending_approval");
    const done = await database.db.transaction().execute((trx) => approvePayoutRun(trx, paris, { country: "FR", periodEnd: row.period_end.toISOString() }, at));
    expect(done.total).toEqual([{ amountMinor: 3_000, currency: "EUR" }]);
  });
});
