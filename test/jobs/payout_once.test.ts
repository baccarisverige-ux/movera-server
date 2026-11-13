import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePeriodsBatch, driverPayouts, PAYOUT_BATCH_DRIVERS } from "../../src/admin/payouts.js";
import { ensureMaintenanceTimers, maintenanceHandlers, nextNightly, nightlyHandler, NIGHTLY, SWEEP_IDEMPOTENCY_KEYS, sweepIdempotencyKeysHandler } from "../../src/jobs/maintenance.js";
import { TimerWorker, type TimerHandler } from "../../src/jobs/timers.js";
import { majorText } from "../../src/rules/money.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver } from "../support/seed.js";

/**
 * S5 J1 (S4 0.14a, owner W1 Q69; build plan handover/build-plans-2026-11-12/S5-money.md "J1"; GLOBAL-SAFE-PLAN 0.14
 * money frame R29): the extra tests the parked patch still lacked.
 *   1. A crash in the middle of a payout run (the database connection of the run is killed), then a re-run on two
 *      copies: the crash undoes only the driver it hit, and every weekly payout exists once (payouts_weekly_once).
 *   2. A Tunisian driver is paid once, in TND with 3 decimals (cash, card and a cash tip), by the payout timer only.
 *   3. The forward undo (docs/undo/0.14a_payout_timers.sql) after a code revert: the older release's nightly + hourly
 *      payout pass works again and pays nobody twice.
 * Only timer kinds as strings and the maintenance handlers are used outside test 3, so 1 and 2 run on the release
 * before 0.14a too (fail-before).
 */

let database: TestDatabase;
let n = 0;
const logger = { warn: () => undefined, error: () => undefined };

beforeAll(async () => {
  database = await freshDatabase();
  // The killed connection (test 1) also emits 'error' on its pg client; the server's guardProcess (db/ready.ts) logs
  // that and keeps running. Here a listener on each client does the same, so the test run sees no uncaught error.
  database.pool.on("connect", (client) => void client.on("error", () => undefined));
});
afterAll(async () => database.drop());
beforeEach(async () => {
  await sql`DROP TRIGGER IF EXISTS payout_crash ON payouts`.execute(database.db);
  await database.db.deleteFrom("earnings_entries").execute();
  await database.db.deleteFrom("payouts").execute();
  await database.db.deleteFrom("timers").execute();
  await database.db.deleteFrom("drivers").execute();
});

const entry = (driverId: string, at: string, currency: string, amount: number, cash = 0, kind: "trip" | "tip" = "trip") =>
  database.db.insertInto("earnings_entries").values({ entry_id: `ern_j1${++n}`, driver_id: driverId, trip_id: null, kind, currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: cash, at: new Date(at) }).execute();
const driverIn = async (zoneIds: string[], country: string) => {
  const id = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ zone_ids: zoneIds, country }).where("driver_id", "=", id).execute();
  return id;
};
const payoutsOf = (driverId: string) =>
  database.db.selectFrom("payouts").select(["currency", "amount_minor", "period_start"]).where("driver_id", "=", driverId).orderBy("currency").orderBy("period_start").execute()
    .then((rows) => rows.map((r) => [r.currency, Number(r.amount_minor), r.period_start.toISOString()]));
const allPayouts = () => database.db.selectFrom("payouts").select(["driver_id", "currency", "period_start", "source"]).execute();
/** Every weekly payout exists once per driver, period and currency (what payouts_weekly_once guards). */
async function expectWeeklyOnce() {
  const rows = await allPayouts();
  const keys = rows.filter((r) => r.source === "weekly").map((r) => `${r.driver_id}|${r.period_start.toISOString()}|${r.currency}`);
  expect(new Set(keys).size).toBe(keys.length);
}
async function runUntil(clock: { now: Date }, until: Date, w: TimerWorker) {
  for (;;) {
    await w.runDue(10_000);
    if (clock.now.getTime() >= until.getTime()) return;
    clock.now = new Date(Math.min(clock.now.getTime() + 60_000, until.getTime()));
  }
}
const worker = (clock: { now: Date }, handlers: Record<string, TimerHandler> = maintenanceHandlers) => new TimerWorker(database.db, { handlers, logger, clock: () => clock.now, pollMs: 20 });

// Week Mon 2026-10-26 08:00 → Mon 2026-11-02 08:00 local (SE, FR and TN are all UTC+1 that week).
const PERIOD_START = "2026-10-26T07:00:00.000Z";

describe("J1 crash in the middle of a payout run, then a re-run: each weekly payout once (payouts_weekly_once)", () => {
  it("the database connection of the run dies on the 3rd payout: only that driver waits; after the re-run (two copies) all are paid once (SE, FR, TN)", async () => {
    // The unique index the per-driver steps rely on (migration 0048) is there.
    const index = await sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes WHERE indexname = 'payouts_weekly_once'`.execute(database.db);
    expect(index.rows[0]?.indexdef).toMatch(/UNIQUE INDEX payouts_weekly_once ON public\.payouts USING btree \(driver_id, period_start, currency\) WHERE \(source = 'weekly'/);
    const ids: string[] = [];
    const countries = [["Z001", "SE", "SEK"], ["FR-PC", "FR", "EUR"], ["TN-TC", "TN", "TND"]] as const;
    for (let i = 0; i < 9; i++) {
      const [zone, country, currency] = countries[i % 3]!;
      const id = await driverIn([zone], country);
      ids.push(id);
      await entry(id, "2026-10-27T10:00:00Z", currency, 10_000 + i, i % 2 ? 4_000 : 0);
    }
    // The crash: the 3rd payout insert (whichever driver it is) kills its own database connection, once (a sequence
    // is not rolled back with the transaction).
    await sql`DROP SEQUENCE IF EXISTS payout_crash_seq`.execute(database.db);
    await sql`CREATE SEQUENCE payout_crash_seq`.execute(database.db);
    await sql.raw(`CREATE OR REPLACE FUNCTION payout_crash_fn() RETURNS trigger AS $$ BEGIN IF nextval('payout_crash_seq') = 3 THEN PERFORM pg_terminate_backend(pg_backend_pid()); PERFORM pg_sleep(5); END IF; RETURN NEW; END $$ LANGUAGE plpgsql`).execute(database.db);
    await sql`CREATE TRIGGER payout_crash BEFORE INSERT ON payouts FOR EACH ROW EXECUTE FUNCTION payout_crash_fn()`.execute(database.db);
    const clock = { now: new Date("2026-11-02T07:30:00Z") };
    await ensureMaintenanceTimers(database.db, clock.now);
    // One pass over everything due now (the clock does not move: no retry comes due).
    await worker(clock).runDue(10_000);
    // Only the run the crash hit is undone: the other 8 drivers keep their payout (before 0.14a: one transaction for
    // the whole batch, so nobody was paid until the retry).
    expect((await allPayouts()).length).toBe(8);
    await expectWeeklyOnce();
    // Re-run: two copies at once, then the next hour's run.
    await sql`DROP TRIGGER payout_crash ON payouts`.execute(database.db);
    await Promise.all([runUntil(clock, new Date("2026-11-02T07:50:00Z"), worker(clock)), runUntil(clock, new Date("2026-11-02T07:50:00Z"), worker(clock))]);
    await runUntil(clock, new Date("2026-11-02T09:00:00Z"), worker(clock));
    for (const [i, id] of ids.entries()) expect(await payoutsOf(id)).toEqual([[countries[i % 3]![2], 10_000 + i - (i % 2 ? 4_000 : 0), PERIOD_START]]);
    expect((await allPayouts()).length).toBe(9);
    await expectWeeklyOnce();
    expect(await database.db.selectFrom("earnings_entries").select("entry_id").where("payout_id", "is", null).execute()).toEqual([]);
  });
});

describe("J1 a Tunisian driver is paid in TND (3 decimals)", () => {
  it("nightly + hourly sweep pay nothing; the payout timer pays 11.095 DT once (card 12.345, cash trip 8.750 with 10.000 in hand, cash tip 1.500)", async () => {
    const tn = await driverIn(["TN-TC"], "TN");
    await entry(tn, "2026-10-27T10:00:00Z", "TND", 12_345, 0);
    await entry(tn, "2026-10-30T10:00:00Z", "TND", 8_750, 10_000);
    await entry(tn, "2026-10-30T10:05:00Z", "TND", 1_500, 1_500, "tip");
    const firedAt = new Date("2026-11-02T07:30:00Z");
    const timer = (kind: string) => ({ timerId: "t", kind, refId: "all", dueAt: firedAt, payload: {}, attempts: 0, firedAt });
    await database.db.transaction().execute((trx) => nightlyHandler(trx, timer(NIGHTLY)));
    await database.db.transaction().execute((trx) => sweepIdempotencyKeysHandler(trx, timer(SWEEP_IDEMPOTENCY_KEYS)));
    // Owner W1 Q69 "one payout job": neither the nightly summary nor the hourly sweep pays.
    expect(await payoutsOf(tn)).toEqual([]);
    const clock = { now: firedAt };
    await ensureMaintenanceTimers(database.db, clock.now);
    await runUntil(clock, new Date("2026-11-02T09:00:00Z"), worker(clock));
    const rows = await database.db.selectFrom("payouts").selectAll().where("driver_id", "=", tn).execute();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect([row.currency, Number(row.amount_minor), row.trip_count, row.period_start.toISOString()]).toEqual(["TND", 11_095, 2, PERIOD_START]);
    expect(row.lines).toEqual([
      { code: "trips", amountMinor: 21_095, count: 2 },
      { code: "tips", amountMinor: 1_500 },
      { code: "cash_collected", amountMinor: -11_500 },
    ]);
    const seen = await driverPayouts(database.db, tn, { limit: 10 });
    expect(seen.items.map((p) => p.amount)).toEqual([{ amountMinor: 11_095, currency: "TND" }]);
    expect(majorText({ amountMinor: 11_095, currency: "TND" })).toBe("11.095");
  });
});

/* ------------------------------------------------------------------------------------------------ forward undo */

/** The payout part of the release before 0.14a (movera-server b04438b, src/jobs/maintenance.ts), verbatim. */
const OLD_PAYOUT_BATCH_GAP_MS = 5_000;
const oldNightly: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  await closePeriodsBatch(trx, now, { maxDrivers: PAYOUT_BATCH_DRIVERS });
  await trx.insertInto("timers").values({ kind: NIGHTLY, ref_id: "all", due_at: nextNightly(now) }).onConflict((c) => c.columns(["kind", "ref_id"]).doNothing()).execute();
};
const oldSweep: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  const after = (timer.payload as { payoutAfter?: unknown } | null)?.payoutAfter;
  const batch = await closePeriodsBatch(trx, now, { after: typeof after === "string" ? after : null, maxDrivers: PAYOUT_BATCH_DRIVERS });
  await trx
    .insertInto("timers")
    .values({ kind: SWEEP_IDEMPOTENCY_KEYS, ref_id: "all", due_at: new Date(now.getTime() + (batch.next !== null ? OLD_PAYOUT_BATCH_GAP_MS : 60 * 60 * 1000)), payload: JSON.stringify(batch.next !== null ? { payoutAfter: batch.next } : {}) })
    .onConflict((c) => c.columns(["kind", "ref_id"]).doNothing())
    .execute();
};
/** The older release's handlers: the same clean-ups, its own sweep and nightly payout pass, no payout_close / payout_driver. */
const OLD_HANDLERS: Record<string, TimerHandler> = {
  ...Object.fromEntries(Object.entries(maintenanceHandlers).filter(([kind]) => kind !== "payout_close" && kind !== "payout_driver")),
  [SWEEP_IDEMPOTENCY_KEYS]: oldSweep,
  [NIGHTLY]: oldNightly,
};
const UNDO_SQL = readFileSync(join(import.meta.dirname, "../../docs/undo/0.14a_payout_timers.sql"), "utf8");

describe("J1 the forward undo (docs/undo/0.14a_payout_timers.sql) after a code revert", () => {
  it("deletes only the payout timer rows; the older release's nightly + hourly pass pays the rest again, nobody twice (SE, FR, TN)", async () => {
    const paidByNew = await driverIn(["Z001"], "SE");
    const waiting = await driverIn(["FR-PC"], "FR");
    const tn = await driverIn(["TN-TC"], "TN");
    await entry(paidByNew, "2026-10-27T10:00:00Z", "SEK", 9_000, 2_000);
    await entry(waiting, "2026-10-27T10:00:00Z", "EUR", 2_500);
    await entry(tn, "2026-10-28T10:00:00Z", "TND", 7_777, 1_000);
    // The 0.14a release ran one step: the SE driver is paid; the FR and TN steps are booked but not run yet.
    const clock = { now: new Date("2026-11-02T07:30:00Z") };
    await ensureMaintenanceTimers(database.db, clock.now);
    await worker(clock).runDue(1, { kinds: ["payout_close"] });
    await worker(clock).runDue(1, { kinds: ["payout_driver"] });
    const steps = await database.db.selectFrom("timers").select("ref_id").where("kind", "=", "payout_driver").execute();
    expect(steps).toHaveLength(2);
    const paidStep = [paidByNew, waiting, tn].find((id) => !steps.some((s) => s.ref_id === id))!;
    expect((await allPayouts()).map((p) => p.driver_id)).toEqual([paidStep]);
    const otherKinds = (await database.db.selectFrom("timers").select("kind").where("kind", "not in", ["payout_close", "payout_driver"]).execute()).map((t) => t.kind).sort();

    // Code revert: the older release's worker. Without the undo, the new rows fail there ("No handler").
    const old = new TimerWorker(database.db, { handlers: OLD_HANDLERS, logger, clock: () => clock.now, pollMs: 20 });
    expect(await old.runDue(1, { kinds: ["payout_driver"] })).toBe(1);
    expect((await database.db.selectFrom("timers").select(["attempts", "last_error"]).where("kind", "=", "payout_driver").orderBy("attempts", "desc").executeTakeFirstOrThrow())).toMatchObject({ attempts: 1, last_error: expect.stringContaining("No handler for timer kind payout_driver") });

    // The undo step (twice: safe to run again).
    await sql.raw(UNDO_SQL).execute(database.db);
    await sql.raw(UNDO_SQL).execute(database.db);
    expect(await database.db.selectFrom("timers").select("kind").where("kind", "in", ["payout_close", "payout_driver"]).execute()).toEqual([]);
    expect((await database.db.selectFrom("timers").select("kind").execute()).map((t) => t.kind).sort()).toEqual(otherKinds);

    // The older release's pass is back: its hourly sweep (row kept by 0.14a, due within the hour) and its nightly
    // run both pay, each driver once.
    await runUntil(clock, new Date("2026-11-03T02:00:00Z"), new TimerWorker(database.db, { handlers: OLD_HANDLERS, logger, clock: () => clock.now, pollMs: 20 }));
    expect((await database.db.selectFrom("timers").select("kind").where("kind", "=", NIGHTLY).executeTakeFirstOrThrow()).kind).toBe(NIGHTLY);
    expect(await payoutsOf(paidByNew)).toEqual([["SEK", 7_000, PERIOD_START]]);
    expect(await payoutsOf(waiting)).toEqual([["EUR", 2_500, PERIOD_START]]);
    expect(await payoutsOf(tn)).toEqual([["TND", 6_777, PERIOD_START]]);
    expect((await allPayouts()).length).toBe(3);
    await expectWeeklyOnce();
    expect(await database.db.selectFrom("earnings_entries").select("entry_id").where("payout_id", "is", null).execute()).toEqual([]);
  });
});
