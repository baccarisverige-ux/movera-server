import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findCauses } from "../../src/alerts/detector.js";
import { ensureMaintenanceTimers, maintenanceHandlers, nightlyHandler, NIGHTLY, SWEEP_IDEMPOTENCY_KEYS, sweepIdempotencyKeysHandler } from "../../src/jobs/maintenance.js";
import { MAX_ATTEMPTS, TimerWorker, rearmParkedRecurringTimers } from "../../src/jobs/timers.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";
import { HOUSEKEEPING_KINDS } from "../../src/jobs/housekeeping.js";

/**
 * S4 0.14a (owner W1 Q69 "Payouts on their own timer, one driver per step, one payout job (hourly kept)", 2026-11-11;
 * GLOBAL-SAFE-PLAN 0.14, money frame R29: SE and FR, and TN with 3 decimals, cash and card):
 *   - exactly one job pays (the payout timer), never the nightly summary nor the hourly clean-up sweep;
 *   - one transaction per driver: a driver whose payout fails does not stop the others, and an alert names him;
 *   - a crash in the middle of a run, then a re-run (also on two server copies at once), pays each driver once.
 */

let database: TestDatabase;
let n = 0;
const logs: Array<{ level: string; message: string; data: Record<string, unknown> }> = [];
const logger = {
  warn: (data: object, message: string) => void logs.push({ level: "warn", message, data: data as Record<string, unknown> }),
  error: (data: object, message: string) => void logs.push({ level: "error", message, data: data as Record<string, unknown> }),
};

beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => database.drop());
beforeEach(async () => {
  logs.length = 0;
  await sql`DROP TRIGGER IF EXISTS payout_fault ON payouts`.execute(database.db);
  await database.db.deleteFrom("earnings_entries").execute();
  await database.db.deleteFrom("payouts").execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("drivers").execute();
});

/** A trip entry: card (cash 0) or cash (the driver took `cash` in his hand). */
const trip = (driverId: string, at: string, currency: string, amount: number, cash = 0) =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_q${++n}`, driver_id: driverId, trip_id: null, kind: "trip", currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: cash, at: new Date(at) }).execute();
const driverIn = async (zoneIds: string[], country: string) => {
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ zone_ids: zoneIds, country }).where("driver_id", "=", id).execute();
  return id;
};
const payoutsOf = (driverId: string) =>
  database.db.selectFrom("payouts").select(["currency", "amount_minor", "period_start", "period_end"]).where("driver_id", "=", driverId).orderBy("currency").orderBy("period_start").execute()
    .then((rows) => rows.map((r) => [r.currency, Number(r.amount_minor), r.period_start.toISOString(), r.period_end.toISOString()]));
/** Injected fault: any payout insert for this driver fails (the message does not name him: the server must). */
const failPayoutsOf = async (driverId: string) => {
  await sql.raw(`CREATE OR REPLACE FUNCTION payout_fault_fn() RETURNS trigger AS $$ BEGIN IF NEW.driver_id = '${driverId}' THEN RAISE EXCEPTION 'injected payout fault'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`).execute(database.db);
  await sql`CREATE TRIGGER payout_fault BEFORE INSERT ON payouts FOR EACH ROW EXECUTE FUNCTION payout_fault_fn()`.execute(database.db);
};
const worker = (clock: { now: Date }) => new TimerWorker(database.db, { handlers: maintenanceHandlers, logger, clock: () => clock.now, pollMs: 20 });
/** Runs every due timer, moving the clock on so retries come due (never past `until`). */
async function runUntil(clock: { now: Date }, until: Date, w = worker(clock)) {
  for (;;) {
    await w.runDue(10_000);
    if (clock.now.getTime() >= until.getTime()) return;
    clock.now = new Date(Math.min(clock.now.getTime() + 60_000, until.getTime()));
  }
}

// Week Mon 2026-10-26 08:00 → Mon 2026-11-02 08:00 local (SE 07:00Z, FR 07:00Z, TN 07:00Z: Tunis is UTC+1 all year).
const PERIOD_END = "2026-11-02T07:00:00.000Z";
const PERIOD_START = "2026-10-26T07:00:00.000Z";

describe("0.14a one transaction per driver: a failing driver does not stop the others", () => {
  it("SE, FR and TN drivers are paid (cash and card) while one driver's payout keeps failing", async () => {
    const se = await driverIn(["Z001"], "SE");
    const fr = await driverIn(["FR-PC"], "FR");
    const tn = await driverIn(["TN-TC"], "TN");
    const bad = await driverIn(["Z001"], "SE");
    await trip(se, "2026-10-27T10:00:00Z", "SEK", 25_000, 0); // card
    await trip(se, "2026-10-28T10:00:00Z", "SEK", 12_000, 15_000); // cash: 150 kr in hand
    await trip(fr, "2026-10-27T10:00:00Z", "EUR", 2_150, 0);
    await trip(fr, "2026-10-29T10:00:00Z", "EUR", 1_800, 2_000);
    await trip(tn, "2026-10-27T10:00:00Z", "TND", 12_345, 0); // 12.345 DT
    await trip(tn, "2026-10-30T10:00:00Z", "TND", 8_750, 10_000); // cash 10.000 DT
    await trip(bad, "2026-10-27T10:00:00Z", "SEK", 9_000, 0);
    await failPayoutsOf(bad);
    const clock = { now: new Date("2026-11-02T07:30:00Z") };
    await ensureMaintenanceTimers(database.db, clock.now);
    await runUntil(clock, new Date("2026-11-02T07:45:00Z"));
    expect(await payoutsOf(se)).toEqual([["SEK", 25_000 + 12_000 - 15_000, PERIOD_START, PERIOD_END]]);
    expect(await payoutsOf(fr)).toEqual([["EUR", 2_150 + 1_800 - 2_000, PERIOD_START, PERIOD_END]]);
    expect(await payoutsOf(tn)).toEqual([["TND", 12_345 + 8_750 - 10_000, PERIOD_START, PERIOD_END]]);
    expect(await payoutsOf(bad)).toEqual([]);
    // The hourly clean-ups are not held back by a payout either: the sweep is booked an hour on, not retrying.
    const sweep = await database.db.selectFrom("timers").select(["attempts", "due_at"]).where("kind", "=", SWEEP_IDEMPOTENCY_KEYS).executeTakeFirstOrThrow();
    expect(sweep.attempts).toBe(0);
  });

  it("the failure is logged with the driver's id, and once parked the system alert names the driver", async () => {
    const good = await driverIn(["Z001"], "SE");
    const bad = await driverIn(["FR-PC"], "FR");
    await trip(good, "2026-10-27T10:00:00Z", "SEK", 4_000);
    await trip(bad, "2026-10-27T10:00:00Z", "EUR", 3_000, 500);
    await failPayoutsOf(bad);
    const clock = { now: new Date("2026-11-02T07:30:00Z") };
    await ensureMaintenanceTimers(database.db, clock.now);
    await runUntil(clock, new Date("2026-11-02T08:00:00Z"));
    expect((await payoutsOf(good)).length).toBe(1);
    const failures = logs.filter((l) => JSON.stringify(l.data).includes(bad));
    expect(failures.length).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
    expect(failures.at(-1)!.level).toBe("error");
    const health = (await findCauses(database.db, clock.now)).filter((c) => c.kind === "system_health");
    expect(health.length).toBeGreaterThan(0);
    for (const cause of health) expect(JSON.stringify(cause.detail ?? null)).toContain(bad);
    // Fixed (e.g. by a release), the next start runs it again and he is paid once.
    await sql`DROP TRIGGER payout_fault ON payouts`.execute(database.db);
    await rearmParkedRecurringTimers(database.db, ["payout_close", "payout_driver"], logger, clock.now);
    await runUntil(clock, new Date("2026-11-02T08:10:00Z"));
    expect(await payoutsOf(bad)).toEqual([["EUR", 2_500, PERIOD_START, PERIOD_END]]);
  });
});

describe("0.14a one payout job (Q69: hourly kept)", () => {
  it("nightly + hourly on the same clock: neither the nightly summary nor the clean-up sweep pays; the payout timer pays once (SE, FR)", async () => {
    const se = await driverIn(["Z001"], "SE");
    const fr = await driverIn(["FR-PC"], "FR");
    await trip(se, "2026-10-20T10:00:00Z", "SEK", 7_000, 7_000);
    await trip(fr, "2026-10-21T10:00:00Z", "EUR", 1_000);
    // 01:00 UTC on Monday: the nightly run and the hourly sweep are both due; the week of 10-19 ended on 10-26.
    const firedAt = new Date("2026-11-02T01:00:00Z");
    const timer = (kind: string) => ({ timerId: "t", kind, refId: "all", dueAt: firedAt, payload: {}, attempts: 0, firedAt });
    await database.db.transaction().execute((trx) => nightlyHandler(trx, timer(NIGHTLY)));
    expect(await database.db.selectFrom("payouts").selectAll().execute()).toEqual([]);
    await database.db.transaction().execute((trx) => sweepIdempotencyKeysHandler(trx, timer(SWEEP_IDEMPOTENCY_KEYS)));
    expect(await database.db.selectFrom("payouts").selectAll().execute()).toEqual([]);
    const clock = { now: firedAt };
    await ensureMaintenanceTimers(database.db, clock.now);
    await runUntil(clock, new Date("2026-11-02T01:05:00Z"));
    expect(await payoutsOf(se)).toEqual([["SEK", 0, "2026-10-19T06:00:00.000Z", "2026-10-26T07:00:00.000Z"]]);
    expect(await payoutsOf(fr)).toEqual([["EUR", 1_000, "2026-10-19T06:00:00.000Z", "2026-10-26T07:00:00.000Z"]]);
    const kinds = (await database.db.selectFrom("timers").select("kind").execute()).map((t) => t.kind).sort();
    expect(kinds).toEqual([NIGHTLY, "no_fix_offline", "payout_close", SWEEP_IDEMPOTENCY_KEYS, ...HOUSEKEEPING_KINDS].sort());
  });
});

describe("0.14a crash in the middle of a run, then a re-run (two server copies): each driver is paid once", () => {
  it("a driver whose second currency fails is rolled back alone; after the restart every payout exists once (SE kr+€, FR, TN)", async () => {
    const ids = { se: await driverIn(["Z001"], "SE"), fr: await driverIn(["FR-PC"], "FR"), tn: await driverIn(["TN-TC"], "TN") };
    const many: string[] = [];
    for (let i = 0; i < 30; i++) many.push(await driverIn([i % 2 ? "FR-PC" : "Z001"], i % 2 ? "FR" : "SE"));
    await trip(ids.se, "2026-10-27T10:00:00Z", "SEK", 10_000, 0);
    await trip(ids.se, "2026-10-28T10:00:00Z", "EUR", 2_000, 2_500);
    await trip(ids.fr, "2026-10-27T10:00:00Z", "EUR", 3_333, 3_333);
    await trip(ids.tn, "2026-10-28T10:00:00Z", "TND", 5_005, 0);
    for (const id of many) await trip(id, "2026-10-27T12:00:00Z", (await database.db.selectFrom("drivers").select("country").where("driver_id", "=", id).executeTakeFirstOrThrow()).country === "FR" ? "EUR" : "SEK", 1_000, 300);
    // The crash: the SE driver's € payout fails after his kr payout was written in the same step.
    await sql.raw(`CREATE OR REPLACE FUNCTION payout_fault_fn() RETURNS trigger AS $$ BEGIN IF NEW.driver_id = '${ids.se}' AND NEW.currency = 'EUR' THEN RAISE EXCEPTION 'injected crash'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`).execute(database.db);
    await sql`CREATE TRIGGER payout_fault BEFORE INSERT ON payouts FOR EACH ROW EXECUTE FUNCTION payout_fault_fn()`.execute(database.db);
    const clock = { now: new Date("2026-11-02T07:30:00Z") };
    await ensureMaintenanceTimers(database.db, clock.now);
    // First copy dies after a few timers.
    await worker(clock).runDue(5);
    expect(await payoutsOf(ids.se)).toEqual([]);
    // Restart: the fault is gone; two copies start (re-arm + booking) and work at the same time.
    await sql`DROP TRIGGER payout_fault ON payouts`.execute(database.db);
    clock.now = new Date("2026-11-02T07:40:00Z");
    for (let copy = 0; copy < 2; copy++) {
      await rearmParkedRecurringTimers(database.db, [SWEEP_IDEMPOTENCY_KEYS, NIGHTLY, "payout_close", "payout_driver"], logger, clock.now);
      await ensureMaintenanceTimers(database.db, clock.now);
    }
    await Promise.all([runUntil(clock, new Date("2026-11-02T07:50:00Z")), runUntil(clock, new Date("2026-11-02T07:50:00Z"))]);
    // And the next hour's run changes nothing.
    await runUntil(clock, new Date("2026-11-02T09:00:00Z"));
    expect(await payoutsOf(ids.se)).toEqual([["EUR", -500, PERIOD_START, PERIOD_END], ["SEK", 10_000, PERIOD_START, PERIOD_END]]);
    expect(await payoutsOf(ids.fr)).toEqual([["EUR", 0, PERIOD_START, PERIOD_END]]);
    expect(await payoutsOf(ids.tn)).toEqual([["TND", 5_005, PERIOD_START, PERIOD_END]]);
    for (const id of many) expect((await payoutsOf(id)).map((p) => p[1])).toEqual([700]);
    const total = await database.db.selectFrom("payouts").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
    expect(Number(total.n)).toBe(2 + 1 + 1 + 30);
    const unpaid = await database.db.selectFrom("earnings_entries").select("entry_id").where("payout_id", "is", null).execute();
    expect(unpaid).toEqual([]);
  });
});
