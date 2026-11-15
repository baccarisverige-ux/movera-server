import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvePayoutRun, closePeriods, closePeriodsBatch, driverPayouts, holdDriverPayouts, markPayoutPaid, payoutScheduleOf, periodOf } from "../../src/admin/payouts.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";
import { PAYOUT_BATCH_GAP_MS, SWEEP_IDEMPOTENCY_KEYS, sweepIdempotencyKeysHandler } from "../../src/jobs/maintenance.js";
import { PAYOUT_CLOSE, PAYOUT_DRIVER, payoutCloseHandler, payoutDriverHandler } from "../../src/jobs/payouts.js";

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
  database.db.selectFrom("payouts").select(["currency", "amount_minor", "period_start", "period_end"]).where("driver_id", "=", driverId).orderBy("currency").orderBy("period_start").execute()
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


describe("v0.18.39 fix job 0 (A2, owner Q4 + A2-3): pause one driver's payouts from his profile", () => {
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

describe("v0.18.39 fix job 0 (A2, owner Q4 + A2-3): payouts Automatic or Manual per country, a manual run is approved by one admin", () => {
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
    // BQ-V38 (v0.18.102): the approve carries the run the admin saw (1 payout, 100,00 kr).
    const seSeen = { expectedCount: 1, expectedTotal: [{ amountMinor: 10_000, currency: "SEK" }] };
    // Fix job 0 (owner A2-3 "Yes, reason required"): no reason, no approval.
    await expect(database.db.transaction().execute((trx) => approvePayoutRun(trx, finance, { country: "SE", periodEnd, reason: " ", ...seSeen }, at))).rejects.toMatchObject({ options: { reason: "reason_required" } });
    await expect(database.db.transaction().execute((trx) => approvePayoutRun(trx, paris, { country: "SE", periodEnd, reason: "Checked the bank file", ...seSeen }, at))).rejects.toMatchObject({ options: { reason: "zone_out_of_scope" } });
    const done = await database.db.transaction().execute((trx) => approvePayoutRun(trx, finance, { country: "SE", periodEnd, reason: "Checked the bank file", ...seSeen }, at));
    expect(done).toEqual({ country: "SE", periodEnd, approved: 1, total: [{ amountMinor: 10_000, currency: "SEK" }] });
    await expect(database.db.transaction().execute((trx) => approvePayoutRun(trx, finance, { country: "SE", periodEnd, reason: "Checked the bank file", ...seSeen }, at))).rejects.toMatchObject({ options: { reason: "nothing_to_approve" } });
    expect((await database.db.selectFrom("payouts").select("status").where("payout_id", "=", sePayout.payout_id).executeTakeFirstOrThrow()).status).toBe("pending");
    await database.db.transaction().execute((trx) => markPayoutPaid(trx, finance, sePayout.payout_id, {}, at));
    const audit = await database.db.selectFrom("admin_audit").select(["action", "target_id", "detail"]).where("action", "=", "payout.run_approve").execute();
    expect(audit).toMatchObject([{ action: "payout.run_approve", target_id: `SE:${periodEnd}`, detail: { reason: "Checked the bank file", ...seSeen } }]);
  });

  it("FR manual and a Paris admin: the Paris admin approves the French run (FR)", async () => {
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-FR", version: 1, document: JSON.stringify({ country: "FR", payoutMode: "manual" }), published_at: new Date(), published_by: null }).execute();
    const fr = await driverIn(["FR-PC"], "FR");
    await entry(fr, "2026-10-27T10:00:00Z", "EUR", 3_000);
    expect(await run("2026-11-02T08:00:00Z")).toBe(1);
    const row = await database.db.selectFrom("payouts").select(["status", "period_end"]).where("driver_id", "=", fr).executeTakeFirstOrThrow();
    expect(row.status).toBe("pending_approval");
    const done = await database.db.transaction().execute((trx) => approvePayoutRun(trx, paris, { country: "FR", periodEnd: row.period_end.toISOString(), reason: "Checked", expectedCount: 1, expectedTotal: [{ amountMinor: 3_000, currency: "EUR" }] }, at));
    expect(done.total).toEqual([{ amountMinor: 3_000, currency: "EUR" }]);
  });
});

describe("stress T-A follow-up: a payout backlog is paid in batches, never in one long transaction", () => {
  it("closePeriodsBatch takes at most maxDrivers drivers and goes on after the last one it took", async () => {
    const ids = [await driverIn(["Z001"], "SE"), await driverIn(["Z001"], "SE"), await driverIn(["Z001"], "SE")].sort();
    for (const id of ids) await entry(id, "2026-10-27T10:00:00Z", "SEK", 1_000);
    const now = new Date("2026-11-02T08:00:00Z");
    const first = await database.db.transaction().execute((trx) => closePeriodsBatch(trx, now, { maxDrivers: 2 }));
    expect(first).toEqual({ made: 2, next: ids[1] });
    expect((await payoutsOf(ids[2]!)).length).toBe(0);
    const second = await database.db.transaction().execute((trx) => closePeriodsBatch(trx, now, { after: first.next, maxDrivers: 2 }));
    expect(second).toEqual({ made: 1, next: null });
    for (const id of ids) expect((await payoutsOf(id)).length).toBe(1);
  });

  it("the payout timer books one step per due driver, comes back soon with a cursor while a backlog is left, and in an hour when done (S4 0.14a)", async () => {
    await database.db.deleteFrom("timers").where("kind", "in", [PAYOUT_CLOSE, PAYOUT_DRIVER, SWEEP_IDEMPOTENCY_KEYS]).execute();
    await database.db.updateTable("drivers").set({ payout_hold_at: new Date() }).execute(); // only this test's drivers
    const ids: string[] = [];
    for (let i = 0; i < 201; i++) ids.push(await driverIn(["Z001"], "SE"));
    for (const id of ids) await entry(id, "2026-10-27T10:00:00Z", "SEK", 500);
    const firedAt = new Date("2026-11-02T08:00:00Z");
    const fire = (payload: unknown) =>
      database.db.transaction().execute(async (trx) => {
        await trx.deleteFrom("timers").where("kind", "=", PAYOUT_CLOSE).execute();
        await payoutCloseHandler(trx, { timerId: "t", kind: PAYOUT_CLOSE, refId: "all", dueAt: firedAt, payload, attempts: 0, firedAt });
        return trx.selectFrom("timers").select(["due_at", "payload"]).where("kind", "=", PAYOUT_CLOSE).executeTakeFirstOrThrow();
      });
    const steps = () => database.db.selectFrom("timers").select("ref_id").where("kind", "=", PAYOUT_DRIVER).execute();
    const runSteps = async () => {
      for (const step of await steps()) {
        await database.db.transaction().execute(async (trx) => {
          await trx.deleteFrom("timers").where("kind", "=", PAYOUT_DRIVER).where("ref_id", "=", step.ref_id).execute();
          await payoutDriverHandler(trx, { timerId: "t", kind: PAYOUT_DRIVER, refId: step.ref_id, dueAt: firedAt, payload: {}, attempts: 0, firedAt });
        });
      }
    };
    const count = async () => Number((await database.db.selectFrom("payouts").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
    const next = await fire({});
    expect(next.due_at.getTime()).toBe(firedAt.getTime() + PAYOUT_BATCH_GAP_MS);
    expect(typeof (next.payload as { after?: unknown }).after).toBe("string");
    expect((await steps()).length).toBe(200);
    expect(await count()).toBe(0);
    await runSteps();
    expect(await count()).toBe(200);
    const done = await fire(next.payload);
    expect(done.due_at.getTime()).toBe(firedAt.getTime() + 60 * 60 * 1000);
    expect(done.payload).toEqual({});
    await runSteps();
    expect(await count()).toBe(201);
    // A sweep row booked by the older release (payload.payoutAfter) only cleans and comes back in an hour.
    await database.db.transaction().execute((trx) => sweepIdempotencyKeysHandler(trx, { timerId: "t", kind: SWEEP_IDEMPOTENCY_KEYS, refId: "all", dueAt: firedAt, payload: { payoutAfter: ids[0] }, attempts: 0, firedAt }));
    const sweep = await database.db.selectFrom("timers").select(["due_at", "payload"]).where("kind", "=", SWEEP_IDEMPOTENCY_KEYS).executeTakeFirstOrThrow();
    expect([sweep.due_at.getTime(), sweep.payload]).toEqual([firedAt.getTime() + 60 * 60 * 1000, {}]);
  });

  it("a driver whose period check throws (a broken time zone) still gets his own step; the others are booked (S4 0.14a)", async () => {
    await database.db.deleteFrom("timers").where("kind", "in", [PAYOUT_CLOSE, PAYOUT_DRIVER]).execute();
    await database.db.updateTable("drivers").set({ payout_hold_at: new Date() }).execute();
    const good = await driverIn(["Z001"], "SE");
    const broken = await driverIn([], "FR");
    const notYet = await driverIn(["FR-PC"], "FR");
    await entry(good, "2026-10-27T10:00:00Z", "SEK", 500);
    await entry(broken, "2026-10-27T10:00:00Z", "EUR", 500);
    await entry(notYet, "2026-11-02T10:00:00Z", "EUR", 500);
    const firedAt = new Date("2026-11-02T08:00:00Z");
    // His first zone has a time zone Postgres does not know: only his period check fails.
    await sql`INSERT INTO zones SELECT (jsonb_populate_record(NULL::zones, to_jsonb(z) || '{"zone_id": "BROKEN-TZ", "time_zone": "Mars/Olympus"}'::jsonb)).* FROM zones z WHERE zone_id = 'FR-PC'`.execute(database.db);
    await database.db.updateTable("drivers").set({ zone_ids: ["BROKEN-TZ"] }).where("driver_id", "=", broken).execute();
    try {
      await database.db.transaction().execute((trx) => payoutCloseHandler(trx, { timerId: "t", kind: PAYOUT_CLOSE, refId: "all", dueAt: firedAt, payload: {}, attempts: 0, firedAt }));
      const booked = (await database.db.selectFrom("timers").select("ref_id").where("kind", "=", PAYOUT_DRIVER).execute()).map((t) => t.ref_id).sort();
      expect(booked).toEqual([good, broken].sort());
      // His own step fails (and is retried, logged and alerted by the worker); it never pays anyone else's.
      await expect(database.db.transaction().execute((trx) => payoutDriverHandler(trx, { timerId: "t", kind: PAYOUT_DRIVER, refId: broken, dueAt: firedAt, payload: {}, attempts: 0, firedAt }))).rejects.toThrow(/time zone/);
    } finally {
      await database.db.updateTable("drivers").set({ zone_ids: [] }).where("driver_id", "=", broken).execute();
      await database.db.deleteFrom("zones").where("zone_id", "=", "BROKEN-TZ").execute();
    }
  });
});
