import { sql } from "kysely";
import type { Principal } from "../auth/guard.js";
import { adminCoversZone } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { audit } from "./audit.js";
import { cursorOf, readCursor, zonesOf } from "./lists.js";
import { firstPageTotal, totalAfterPage, withTotal } from "./listTotal.js";
import { standardKey } from "../config/service.js";
import { freezePayoutSummary, payoutSummaries, type PayoutSummary } from "./payoutSummary.js";

/**
 * Payouts (contract v0.9.0 §16, contract.json#payouts, fixtures/payouts.json; owner decisions of 2026-10-27).
 * A payout takes the driver's earnings entries of a period that are in no payout yet and links them, so an entry is
 * paid once. amount = trips + waiting + pickup pay + bonus + tips + fees − cash collected, and may be negative.
 */

export type PayoutLineCode = "trips" | "waiting" | "pickup_pay" | "bonus" | "tips" | "cash_collected" | "fees";
export const PAYOUT_LINES = (contract as unknown as { payouts: { lines: PayoutLineCode[] } }).payouts.lines;

export type PayoutEntry = { kind: string; amountMinor: number; cashMinor: number; waitingMinor: number };

const WAITING_LINES = new Set(["waiting", "stop_waiting"]);

/** The waiting part of a trip's fare (its waiting and stop_waiting lines: 100 % the driver's). */
export function waitingOf(fareLines: unknown): number {
  if (!Array.isArray(fareLines)) return 0;
  let total = 0;
  for (const line of fareLines as { code?: string; amount?: { amountMinor?: number } }[]) {
    if (line && WAITING_LINES.has(line.code ?? "")) total += Number(line.amount?.amountMinor ?? 0);
  }
  return total;
}

/** The lines of a payout from its entries (the reference engine's payout(), reference_check.py). */
export function payoutLines(entries: readonly PayoutEntry[]): { lines: { code: PayoutLineCode; amountMinor: number; count?: number }[]; tripCount: number; amountMinor: number } {
  const sums = Object.fromEntries(PAYOUT_LINES.map((code) => [code, 0])) as Record<PayoutLineCode, number>;
  let trips = 0;
  for (const entry of entries) {
    switch (entry.kind) {
      case "trip":
        trips += 1;
        sums.waiting += entry.waitingMinor;
        sums.trips += entry.amountMinor - entry.waitingMinor;
        sums.cash_collected -= entry.cashMinor;
        break;
      case "adjustment":
        sums.trips += entry.amountMinor;
        break;
      case "pickup_pay":
        sums.pickup_pay += entry.amountMinor;
        break;
      case "bonus":
        sums.bonus += entry.amountMinor;
        break;
      case "tip":
        sums.tips += entry.amountMinor;
        // v0.18.10 (contract.json#finish.tips): a cash tip is already in the driver's hand.
        sums.cash_collected -= entry.cashMinor;
        break;
      case "fee_share":
        sums.fees += entry.amountMinor;
        break;
    }
  }
  const lines = PAYOUT_LINES.filter((code) => sums[code] !== 0 || code === "trips").map((code) => ({ code, amountMinor: sums[code], ...(code === "trips" ? { count: trips } : {}) }));
  return { lines, tripCount: trips, amountMinor: PAYOUT_LINES.reduce((sum, code) => sum + sums[code], 0) };
}

type PayoutRow = {
  payout_id: string;
  driver_id: string;
  zone_id: string | null;
  currency: string;
  amount_minor: string | number;
  lines: unknown;
  trip_count: number;
  source: "weekly" | "manual";
  status: "pending" | "pending_approval" | "paid";
  period_start: Date;
  period_end: Date;
  note: string | null;
  created_at: Date;
  paid_at: Date | null;
  paid_by: string | null;
  /** v0.18.95 BQ-M26 (0109): both views of Payout.summary, frozen when marked paid; null while unpaid. */
  paid_summary?: unknown;
  first_name?: string | null;
  last_name?: string | null;
};

/** The Payout an admin sees (with the lines), or the driver (totals only); v0.18.89 §90: both with summary (two amounts). */
export function payoutView(row: PayoutRow, viewer: "admin" | "driver", summary?: PayoutSummary) {
  const money = (minor: number | string) => ({ amountMinor: Number(minor), currency: row.currency });
  const lines = (row.lines as { code: string; amountMinor: number; count?: number }[]).map((line) => ({ code: line.code, amount: money(line.amountMinor), ...(line.count !== undefined ? { count: line.count } : {}) }));
  return {
    payoutId: row.payout_id,
    driverId: row.driver_id,
    amount: money(row.amount_minor),
    // v0.18.39 A2 (owner Q4): the driver app shows a run waiting for approval as pending.
    status: viewer === "driver" && row.status === "pending_approval" ? "pending" : row.status,
    periodStart: row.period_start.toISOString(),
    periodEnd: row.period_end.toISOString(),
    createdAt: row.created_at.toISOString(),
    ...(row.paid_at ? { paidAt: row.paid_at.toISOString() } : {}),
    source: row.source,
    tripCount: row.trip_count,
    // v0.18.89 §90 BQ-M22 (contract.json#priceDisplay.payoutSummary): Driver gets / Movera gets, amounts only.
    ...(summary ? { summary } : {}),
    ...(viewer === "admin"
      ? {
          lines,
          ...(row.first_name ? { driverName: [row.first_name, row.last_name].filter(Boolean).join(" ") } : {}),
          ...(row.zone_id ? { zoneId: row.zone_id } : {}),
          ...(row.paid_by ? { paidBy: row.paid_by } : {}),
          ...(row.note ? { note: row.note } : {}),
        }
      : {}),
  };
}

/**
 * Makes the payouts for a driver from the unpaid entries in [from, to): one per currency (v0.18.13, audit M1: kr and
 * € are never added). Returns the payouts made (none when there is nothing to pay). The entries are locked, so two
 * runs (the job and an admin, or two admins) never take the same entry.
 */
export async function makePayouts(trx: Trx, input: { driverId: string; from: Date; to: Date; source: "weekly" | "manual"; by: string | null; note?: string; entriesFrom?: Date; waitForApproval?: boolean }, now: Date): Promise<PayoutRow[]> {
  const entries = await trx
    .selectFrom("earnings_entries as e")
    .leftJoin("trips as t", "t.trip_id", "e.trip_id")
    .select(["e.entry_id", "e.kind", "e.currency", "e.amount_minor", "e.cash_minor", "t.fare_lines"])
    .where("e.driver_id", "=", input.driverId)
    .where("e.payout_id", "is", null)
    .where("e.at", ">=", input.entriesFrom ?? input.from)
    .where("e.at", "<", input.to)
    .orderBy("e.at")
    .forUpdate("e")
    .execute();
  if (entries.length === 0) return [];
  const driver = await trx.selectFrom("drivers").select(["zone_ids"]).where("driver_id", "=", input.driverId).executeTakeFirst();
  const byCurrency = new Map<string, typeof entries>();
  for (const e of entries) byCurrency.set(e.currency, [...(byCurrency.get(e.currency) ?? []), e]);
  const made: PayoutRow[] = [];
  let n = 0;
  for (const [currency, list] of byCurrency) {
    const calc = payoutLines(list.map((e) => ({ kind: e.kind, amountMinor: Number(e.amount_minor), cashMinor: Number(e.cash_minor ?? 0), waitingMinor: e.kind === "trip" ? waitingOf(e.fare_lines) : 0 })));
    const payoutId = newId("pyt", now.getTime() + n++);
    const row = await trx
      .insertInto("payouts")
      .values({
        payout_id: payoutId,
        driver_id: input.driverId,
        zone_id: driver?.zone_ids[0] ?? null,
        currency,
        amount_minor: calc.amountMinor,
        lines: JSON.stringify(calc.lines),
        trip_count: calc.tripCount,
        source: input.source,
        period_start: input.from,
        period_end: input.to,
        note: input.note ?? null,
        created_by: input.by,
        created_at: now,
        // v0.18.39 A2 (owner Q4, contract.json#payoutMode): a manual country's scheduled run waits for an admin.
        ...(input.waitForApproval ? { status: "pending_approval" as const } : {}),
      })
      .onConflict((c) => c.columns(["driver_id", "period_start", "currency"]).where("source", "=", "weekly").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) continue;
    await trx.updateTable("earnings_entries").set({ payout_id: payoutId }).where("entry_id", "in", list.map((e) => e.entry_id)).execute();
    made.push(row as PayoutRow);
  }
  return made;
}

/** payoutView for a page of payouts, each with its summary (one batched read for the page). */
export async function payoutViews(ex: Executor, rows: readonly PayoutRow[], viewer: "admin" | "driver") {
  const summaries = await payoutSummaries(ex, rows, viewer);
  return rows.map((row) => payoutView(row, viewer, summaries.get(row.payout_id)));
}

/** The first payout of makePayouts (kept for callers that make one period of one currency). */
export async function makePayout(trx: Trx, input: Parameters<typeof makePayouts>[1], now: Date): Promise<PayoutRow | null> {
  return (await makePayouts(trx, input, now))[0] ?? null;
}

/** Monday 00:00 of the week that holds `at`, in the time zone. */
export async function weekStart(ex: Executor, at: Date, timeZone: string): Promise<Date> {
  const row = await sql<{ start: Date }>`SELECT (date_trunc('week', ${at}::timestamptz AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone}) AS start`.execute(ex);
  return row.rows[0]!.start;
}

/* ---------------------------------------------------------------- the payout schedule (v0.18.13, owner G10-2) */

export type PayoutSchedule = { frequency: "weekly" | "every_2_weeks"; day: string; time: string };
type ScheduleSpec = { default: PayoutSchedule; countryTimeZones: Record<string, string>; anchorWeek: string };
const SCHEDULE = (contract as unknown as { payouts: { schedule: ScheduleSpec } }).payouts.schedule;
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** CountryRules.payoutSchedule of a country standard, with the default (weekly, Monday, 08:00). */
export function payoutScheduleOf(doc: { payoutSchedule?: Partial<PayoutSchedule> } | null | undefined): PayoutSchedule {
  const p = doc?.payoutSchedule ?? {};
  return {
    frequency: p.frequency === "weekly" || p.frequency === "every_2_weeks" ? p.frequency : SCHEDULE.default.frequency,
    day: typeof p.day === "string" && DAYS.includes(p.day) ? p.day : SCHEDULE.default.day,
    time: typeof p.time === "string" && TIME.test(p.time) ? p.time : SCHEDULE.default.time,
  };
}

/** The time zone of a payout: the driver's first zone, else his country's (never Sweden's for a French driver). */
export const countryTimeZone = (country: string | null | undefined): string | null => (country ? SCHEDULE.countryTimeZones[country] ?? null : null);

/**
 * The period [start, end) that holds `at` for a schedule, in the time zone: periods start on the schedule's day and
 * time; every_2_weeks periods start on even weeks counted from the anchor week (2026-01-05).
 */
export async function periodOf(ex: Executor, at: Date, timeZone: string, schedule: PayoutSchedule): Promise<{ start: Date; end: Date }> {
  const [hh, mm] = schedule.time.split(":").map(Number) as [number, number];
  const offset = `${DAYS.indexOf(schedule.day)} days ${hh} hours ${mm} minutes`;
  const weeks = schedule.frequency === "every_2_weeks" ? 2 : 1;
  const row = await sql<{ start: Date; end: Date }>`
    WITH b AS (
      SELECT date_trunc('week', (${at}::timestamptz AT TIME ZONE ${timeZone}) - ${offset}::interval) AS wk),
    p AS (
      SELECT CASE WHEN ${weeks}::int = 2 AND mod(((extract(epoch FROM (wk - ${SCHEDULE.anchorWeek}::timestamp)) / 604800)::bigint % 2 + 2), 2) = 1
                  THEN wk - interval '1 week' ELSE wk END + ${offset}::interval AS local_start FROM b)
    SELECT (local_start AT TIME ZONE ${timeZone}) AS start, ((local_start + make_interval(weeks => ${weeks}::int)) AT TIME ZONE ${timeZone}) AS end FROM p`.execute(ex);
  return { start: new Date(row.rows[0]!.start), end: new Date(row.rows[0]!.end) };
}

/**
 * The payout pass (S4 0.14a, owner W1 Q69: one payout job, the hourly payout timer of jobs/payouts.ts, one driver per
 * transaction there; the admin's payout time is kept within the hour): for every driver with unpaid entries in a
 * period that has ended (the country's schedule, the local time of his first zone or his country), the payouts of that
 * period, one per currency. Safe to run again: paid entries are never taken twice.
 */
export async function closePeriods(trx: Trx, now: Date): Promise<number> {
  return (await closePeriodsBatch(trx, now)).made;
}

/** Stress T-A follow-up: drivers per payout batch of the hourly job (one transaction never pays a whole backlog). */
export const PAYOUT_BATCH_DRIVERS = 200;

/** A driver with unpaid entries, as the payout pass reads him. */
export type PayoutDriverRow = { driver_id: string; time_zone: string | null; country: string | null; first_at: Date };
/** The countries' schedules and payout modes read during one pass (config_live once per country). */
export type PayoutScheduleCache = { schedules: Map<string, PayoutSchedule>; manual: Map<string, boolean> };
export const newPayoutScheduleCache = (): PayoutScheduleCache => ({ schedules: new Map(), manual: new Map() });

/**
 * The drivers with unpaid entries (not on hold), in driver_id order: at most `maxDrivers` after `after`, or only
 * `driverId` (0.14a: one driver's own payout step).
 */
export async function payoutDrivers(ex: Executor, options: { after?: string | null; maxDrivers?: number; driverId?: string } = {}): Promise<PayoutDriverRow[]> {
  const limit = options.maxDrivers;
  const rows = await sql<PayoutDriverRow>`
    SELECT e.driver_id, z.time_zone, coalesce(z.country, d.country) AS country, min(e.at) AS first_at
      FROM earnings_entries e
      JOIN drivers d ON d.driver_id = e.driver_id
      LEFT JOIN zones z ON z.zone_id = d.zone_ids[1]
     WHERE e.payout_id IS NULL
       AND d.payout_hold_at IS NULL -- v0.18.39 A2 (owner Q4): a held driver is paid after release
       ${options.after ? sql`AND e.driver_id > ${options.after}` : sql``}
       ${options.driverId !== undefined ? sql`AND e.driver_id = ${options.driverId}` : sql``}
     GROUP BY e.driver_id, z.time_zone, coalesce(z.country, d.country)
     ORDER BY 1
     ${limit !== undefined ? sql`LIMIT ${limit}` : sql``}`.execute(ex);
  return rows.rows;
}

/** The driver's time zone, schedule and manual mode, and his first unpaid period (from the oldest unpaid entry on). */
async function firstUnpaidPeriod(ex: Executor, row: PayoutDriverRow, cache: PayoutScheduleCache) {
  const timeZone = row.time_zone ?? countryTimeZone(row.country) ?? SCHEDULE.countryTimeZones["SE"]!;
  const key = row.country ?? "";
  if (!cache.schedules.has(key)) {
    const live = row.country ? await ex.selectFrom("config_live").select("document").where("doc", "=", "country_rules").where("zone_id", "=", standardKey(row.country)).executeTakeFirst() : undefined;
    cache.schedules.set(key, payoutScheduleOf(live?.document as { payoutSchedule?: Partial<PayoutSchedule> } | undefined));
    cache.manual.set(key, (live?.document as { payoutMode?: unknown } | undefined)?.payoutMode === "manual");
  }
  const schedule = cache.schedules.get(key)!;
  // Checker 4: an entry that came in late for a period already paid goes into the next open period (never stuck):
  // periods start after the driver's last weekly payout.
  const last = await ex.selectFrom("payouts").select((eb) => eb.fn.max("period_end").as("end")).where("driver_id", "=", row.driver_id).where("source", "=", "weekly").executeTakeFirst();
  const lastEnd = last?.end ? new Date(last.end as unknown as string) : null;
  const firstAt = new Date(row.first_at);
  const period = await periodOf(ex, lastEnd && lastEnd > firstAt ? lastEnd : firstAt, timeZone, schedule);
  const entriesFrom: Date | undefined = lastEnd && lastEnd > firstAt ? new Date(0) : undefined;
  return { timeZone, schedule, manual: cache.manual.get(key) === true, period, entriesFrom };
}

/** 0.14a: whether the driver has a period that ended by `now` (read only; the payout timer books his step then). */
export async function payoutDue(ex: Executor, row: PayoutDriverRow, now: Date, cache: PayoutScheduleCache): Promise<boolean> {
  return (await firstUnpaidPeriod(ex, row, cache)).period.end.getTime() <= now.getTime();
}

/** One driver's payouts: every ended period from the oldest unpaid entry on. Returns the payouts made. */
export async function closeDriverPeriods(trx: Trx, row: PayoutDriverRow, now: Date, cache: PayoutScheduleCache = newPayoutScheduleCache()): Promise<number> {
  const first = await firstUnpaidPeriod(trx, row, cache);
  let { period, entriesFrom } = first;
  let made = 0;
  while (period.end.getTime() <= now.getTime()) {
    made += (await makePayouts(trx, { driverId: row.driver_id, from: period.start, to: period.end, source: "weekly", by: null, ...(entriesFrom ? { entriesFrom } : {}), ...(first.manual ? { waitForApproval: true } : {}) }, now)).length;
    entriesFrom = undefined;
    period = await periodOf(trx, period.end, first.timeZone, first.schedule);
  }
  return made;
}

/**
 * closePeriods for at most `maxDrivers` drivers after `after` (driver_id order), in the caller's transaction. Returns
 * the payouts made and the last driver taken when more may follow (null = the list is done). The job does not use it
 * (0.14a: the payout timer gives each driver his own transaction); kept for one-transaction callers and tests.
 */
export async function closePeriodsBatch(trx: Trx, now: Date, options: { after?: string | null; maxDrivers?: number } = {}): Promise<{ made: number; next: string | null }> {
  const rows = await payoutDrivers(trx, options);
  const cache = newPayoutScheduleCache();
  let made = 0;
  for (const row of rows) made += await closeDriverPeriods(trx, row, now, cache);
  const limit = options.maxDrivers;
  const next = limit !== undefined && rows.length >= limit ? rows.at(-1)!.driver_id : null;
  return { made, next };
}

/** Kept name for the jobs (v0.9.0): the schedule now comes from the country (closePeriods). */
export const closeWeeks = closePeriods;

const SELECT_PAYOUT = ["payouts.payout_id", "payouts.driver_id", "payouts.zone_id", "payouts.currency", "payouts.amount_minor", "payouts.lines", "payouts.trip_count", "payouts.source", "payouts.status", "payouts.period_start", "payouts.period_end", "payouts.note", "payouts.created_at", "payouts.paid_at", "payouts.paid_by", "payouts.paid_summary", "drivers.first_name", "drivers.last_name"] as const;

export async function listPayouts(ex: Executor, who: Principal, input: { cursor?: string; limit: number; status?: string[]; driverId?: string; from?: string; to?: string; total?: boolean }) {
  let q = ex.selectFrom("payouts").innerJoin("drivers", "drivers.driver_id", "payouts.driver_id").select(SELECT_PAYOUT);
  const zones = zonesOf(who);
  if (zones) q = q.where("payouts.zone_id", "in", zones.length ? zones : ["-"]);
  const statuses = (input.status ?? []).filter((s) => s === "pending" || s === "pending_approval" || s === "paid") as ("pending" | "pending_approval" | "paid")[];
  // A status the server never gives (failed, held) matches nothing.
  if (input.status?.length) q = statuses.length ? q.where("payouts.status", "in", statuses) : q.where(sql<boolean>`false`);
  if (input.driverId) q = q.where("payouts.driver_id", "=", input.driverId);
  if (input.from) q = q.where("payouts.period_end", ">", new Date(input.from));
  if (input.to) q = q.where("payouts.period_start", "<", new Date(input.to));
  // L78-S (v0.18.78 adminListFilters.total).
  const filtered = q;
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(payouts.created_at, payouts.payout_id) < (${c.at}, ${c.id})`);
  }
  const reading = q.orderBy("payouts.created_at", "desc").orderBy("payouts.payout_id", "desc").limit(input.limit + 1).execute();
  // The page asked first; the count follows it (L78-S, listTotal.ts).
  const counting = firstPageTotal(ex, filtered, input);
  const rows = await reading;
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return withTotal({ items: await payoutViews(ex, page as PayoutRow[], "admin"), nextCursor: rows.length > input.limit && last ? cursorOf(last.created_at, last.payout_id) : null }, await totalAfterPage(counting));
}

/**
 * v0.18.94 job A5 / BQ-M13 (contract.json#payouts.schedule.nextPayout; owner G10-2 "Admin sets day and time" … "driver
 * app shows next payout", Rules decisions/driver-g10.md:6): when the driver's next payout is made — the end of his period
 * that holds `now` (his country's schedule, his first zone's time zone else his country's, as the payout job). Null while
 * his payouts are paused (no scheduled payout is made then) or he is unknown.
 */
export async function nextPayoutOf(ex: Executor, driverId: string, now: Date): Promise<{ nextPayoutAt: string; nextPayoutLocal: string; nextPayoutTimeZone: string } | null> {
  const row = await ex
    .selectFrom("drivers as d")
    .leftJoin("zones as z", (j) => j.on(sql<boolean>`z.zone_id = d.zone_ids[1]`))
    .select([sql<string | null>`z.time_zone`.as("time_zone"), sql<string | null>`coalesce(z.country, d.country)`.as("country"), "d.payout_hold_at"])
    .where("d.driver_id", "=", driverId)
    .executeTakeFirst();
  if (row === undefined || row.payout_hold_at !== null) return null;
  const timeZone = row.time_zone ?? countryTimeZone(row.country) ?? SCHEDULE.countryTimeZones["SE"]!;
  const live = row.country ? await ex.selectFrom("config_live").select("document").where("doc", "=", "country_rules").where("zone_id", "=", standardKey(row.country)).executeTakeFirst() : undefined;
  const { end } = await periodOf(ex, now, timeZone, payoutScheduleOf(live?.document as { payoutSchedule?: Partial<PayoutSchedule> } | undefined));
  const local = await sql<{ local: string }>`SELECT to_char(${end}::timestamptz AT TIME ZONE ${timeZone}, 'YYYY-MM-DD"T"HH24:MI') AS local`.execute(ex);
  return { nextPayoutAt: end.toISOString(), nextPayoutLocal: local.rows[0]!.local, nextPayoutTimeZone: timeZone };
}

/** GET /driver/payouts: the driver's own payouts, totals only; v0.18.94 (A5) with his next payout moment. */
export async function driverPayouts(ex: Executor, driverId: string, input: { cursor?: string; limit: number; from?: string; to?: string }, now: Date = new Date()) {
  let q = ex.selectFrom("payouts").selectAll().where("driver_id", "=", driverId);
  if (input.from) q = q.where("period_end", ">", new Date(input.from));
  if (input.to) q = q.where("period_start", "<", new Date(input.to));
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(created_at, payout_id) < (${c.at}, ${c.id})`);
  }
  const rows = await q.orderBy("created_at", "desc").orderBy("payout_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const next = await nextPayoutOf(ex, driverId, now);
  return { items: await payoutViews(ex, page as PayoutRow[], "driver"), nextCursor: rows.length > input.limit && last ? cursorOf(last.created_at, last.payout_id) : null, ...(next ?? {}) };
}

async function payoutForAdmin(ex: Executor, who: Principal, payoutId: string, lock = false): Promise<PayoutRow> {
  let q = ex.selectFrom("payouts").innerJoin("drivers", "drivers.driver_id", "payouts.driver_id").select(SELECT_PAYOUT).where("payouts.payout_id", "=", payoutId);
  if (lock) q = q.forUpdate("payouts");
  const row = await q.executeTakeFirst();
  if (row === undefined) throw notFound("No such payout.", "payout_not_found");
  if (row.zone_id && !adminCoversZone(who, row.zone_id)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
  return row as PayoutRow;
}

/** POST /admin/payouts: Create payout by hand for a driver and a date range (owner, 2026-10-27). */
export async function createPayout(trx: Trx, who: Principal, body: { driverId: string; from: string; to: string; note?: string }, now: Date) {
  const from = new Date(body.from);
  const to = new Date(body.to);
  if (!(from < to)) throw badRequest("from must be before to.", "invalid_range");
  if (to.getTime() > now.getTime()) throw badRequest("A payout can only cover time that has passed.", "range_in_future");
  const driver = await trx.selectFrom("drivers").select(["driver_id", "zone_ids"]).where("driver_id", "=", body.driverId).forUpdate().executeTakeFirst();
  if (driver === undefined) throw notFound("No such driver.", "driver_not_found");
  const zone = driver.zone_ids[0];
  if (zone && !adminCoversZone(who, zone)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
  // v0.18.13 (audit M1): one payout per currency; the answer is the first, every one is in the audit.
  const all = await makePayouts(trx, { driverId: body.driverId, from, to, source: "manual", by: who.subjectId, ...(body.note ? { note: body.note } : {}) }, now);
  const made = all[0];
  if (made === undefined) throw new ApiError("invalid_transition", "Nothing to pay in this period: every trip is already in a payout.", { reason: "nothing_to_pay" });
  for (const p of all) await audit(trx, { adminId: who.subjectId, action: "payout.create", targetType: "payout", targetId: p.payout_id, zoneId: p.zone_id, detail: { driverId: body.driverId, from: body.from, to: body.to, currency: p.currency, amountMinor: Number(p.amount_minor), ...(body.note ? { note: body.note } : {}) }, at: now });
  return (await payoutViews(trx, [await payoutForAdmin(trx, who, made.payout_id)], "admin"))[0]!;
}

/** POST /admin/payouts/{payoutId}/paid: Mark as paid. */
export async function markPayoutPaid(trx: Trx, who: Principal, payoutId: string, body: { note?: string }, now: Date) {
  const row = await payoutForAdmin(trx, who, payoutId, true);
  if (row.status === "paid") throw new ApiError("invalid_transition", "This payout is already paid.", { reason: "already_paid" });
  if (row.status === "pending_approval") throw new ApiError("conflict", "This payout's run is not approved yet.", { reason: "run_not_approved" });
  await trx.updateTable("payouts").set({ status: "paid", paid_at: now, paid_by: who.subjectId, ...(body.note ? { note: body.note } : {}) }).where("payout_id", "=", payoutId).execute();
  // v0.18.95 BQ-M26 (payoutSummary.frozenWhenPaid): the numbers at this moment are the payout's numbers from now on.
  await freezePayoutSummary(trx, row);
  await audit(trx, { adminId: who.subjectId, action: "payout.paid", targetType: "payout", targetId: payoutId, zoneId: row.zone_id, detail: body.note ? { note: body.note } : {}, at: now });
  return (await payoutViews(trx, [await payoutForAdmin(trx, who, payoutId)], "admin"))[0]!;
}

/**
 * v0.18.39 A2 (owner build-spec Q4, contract.json#payoutHold): POST /admin/drivers/{driverId}/payout-hold. Pauses or
 * releases one driver's scheduled payouts; on release the next run pays every ended period he missed.
 */
export async function holdDriverPayouts(trx: Trx, who: Principal, driverId: string, body: { held: boolean; reason: string }, now: Date) {
  const driver = await trx.selectFrom("drivers").select(["driver_id", "zone_ids", "payout_hold_at"]).where("driver_id", "=", driverId).forUpdate().executeTakeFirst();
  if (driver === undefined) throw notFound("No such driver.", "driver_not_found");
  const zone = driver.zone_ids[0];
  if (zone && !adminCoversZone(who, zone)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
  if (body.held === (driver.payout_hold_at !== null)) throw new ApiError("invalid_transition", body.held ? "This driver's payouts are already paused." : "This driver's payouts are not paused.", { reason: body.held ? "payout_already_held" : "payout_not_held" });
  await trx.updateTable("drivers").set(body.held ? { payout_hold_at: now, payout_hold_reason: body.reason, payout_hold_by: who.subjectId } : { payout_hold_at: null, payout_hold_reason: null, payout_hold_by: null }).where("driver_id", "=", driverId).execute();
  await audit(trx, { adminId: who.subjectId, action: body.held ? "payout.hold" : "payout.release", targetType: "driver", targetId: driverId, zoneId: zone ?? null, detail: { reason: body.reason }, at: now });
}

/**
 * v0.18.39 A2 (owner build-spec Q4, contract.json#payoutMode): POST /admin/payouts/runs/approve { country, periodEnd }.
 * Every pending_approval payout of that country and period inside the admin's zones becomes pending (to pay).
 * v0.18.102 BQ-V38 (contract.json#payoutMode.approveGuard; owner item 105 / Q-M8 "Refresh, approve again (Rec.)", Rules
 * decisions/session-2026-11-06.md:1119 "Movera never pays a total the admin did not see"): the admin sends what he saw
 * (expectedCount + expectedTotal per currency); under the row lock a run that no longer matches is refused with 409
 * conflict run_changed and the fresh PayoutRunCard, and nothing is approved.
 */
export type PayoutRunCard = { country: string; periodEnd: string; count: number; total: { amountMinor: number; currency: string }[] };

/** The same payouts and, per currency, the same total (no currency missing or extra). */
function sameRun(card: PayoutRunCard, expectedCount: number, expectedTotal: readonly { amountMinor: number; currency: string }[]): boolean {
  if (card.count !== expectedCount) return false;
  const seen = new Map<string, number>();
  for (const m of expectedTotal) seen.set(m.currency, (seen.get(m.currency) ?? 0) + m.amountMinor);
  if (seen.size !== card.total.length || seen.size !== expectedTotal.length) return false;
  return card.total.every((m) => seen.get(m.currency) === m.amountMinor);
}

export async function approvePayoutRun(trx: Trx, who: Principal, body: { country: string; periodEnd: string; reason: string; expectedCount?: number; expectedTotal?: { amountMinor: number; currency: string }[] }, now: Date) {
  // v0.18.39 fix job 0 (owner A2-3 "Yes, reason required"): never approved without a reason; it goes into the audit.
  if (!body.reason || !body.reason.trim()) throw new ApiError("invalid_request", "Write why you approve this run.", { reason: "reason_required" });
  // BQ-V38: never approved blind (an admin older than v0.18.102 sends no total).
  if (typeof body.expectedCount !== "number" || !Array.isArray(body.expectedTotal)) throw new ApiError("invalid_request", "Approve the run with the count and total you saw.", { reason: "expected_total_required" });
  const periodEnd = new Date(body.periodEnd);
  const rows = await trx
    .selectFrom("payouts as p")
    .innerJoin("drivers as d", "d.driver_id", "p.driver_id")
    .leftJoin("zones as z", "z.zone_id", "p.zone_id")
    .select(["p.payout_id", "p.zone_id", "p.currency", "p.amount_minor"])
    .where("p.status", "=", "pending_approval")
    .where("p.period_end", "=", periodEnd)
    .where(sql<boolean>`coalesce(z.country, d.country) = ${body.country}`)
    .forUpdate("p")
    .execute();
  const mine = rows.filter((r) => r.zone_id === null ? who.zones.includes("*") : adminCoversZone(who, r.zone_id));
  if (rows.length === 0) throw new ApiError("invalid_transition", "No payout of this run waits for approval.", { reason: "nothing_to_approve" });
  if (mine.length === 0) throw new ApiError("forbidden", "This run is outside your zones.", { reason: "zone_out_of_scope" });
  const totals = new Map<string, number>();
  for (const r of mine) totals.set(r.currency, (totals.get(r.currency) ?? 0) + Number(r.amount_minor));
  const total = [...totals].map(([currency, amountMinor]) => ({ amountMinor, currency }));
  // BQ-V38: the run as it is now (under the lock) must be the run the admin saw.
  const card: PayoutRunCard = { country: body.country, periodEnd: periodEnd.toISOString(), count: mine.length, total };
  if (!sameRun(card, body.expectedCount, body.expectedTotal)) throw new ApiError("conflict", "The run changed since you looked at it. Check the new numbers and approve again.", { reason: "run_changed", projection: card });
  await trx.updateTable("payouts").set({ status: "pending", approved_at: now, approved_by: who.subjectId }).where("payout_id", "in", mine.map((r) => r.payout_id)).execute();
  await audit(trx, { adminId: who.subjectId, action: "payout.run_approve", targetType: "payout_run", targetId: `${body.country}:${periodEnd.toISOString()}`, detail: { approved: mine.length, total, reason: body.reason.trim(), expectedCount: body.expectedCount, expectedTotal: body.expectedTotal }, at: now });
  return { country: body.country, periodEnd: periodEnd.toISOString(), approved: mine.length, total };
}
