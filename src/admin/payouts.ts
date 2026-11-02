import { sql } from "kysely";
import type { Principal } from "../auth/guard.js";
import { adminCoversZone } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { audit } from "./audit.js";
import { cursorOf, readCursor, zonesOf } from "./lists.js";
import { standardKey } from "../config/service.js";

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
  status: "pending" | "paid";
  period_start: Date;
  period_end: Date;
  note: string | null;
  created_at: Date;
  paid_at: Date | null;
  paid_by: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

/** The Payout an admin sees (with the lines), or the driver (totals only: the driver app shows only the total). */
export function payoutView(row: PayoutRow, viewer: "admin" | "driver") {
  const money = (minor: number | string) => ({ amountMinor: Number(minor), currency: row.currency });
  const lines = (row.lines as { code: string; amountMinor: number; count?: number }[]).map((line) => ({ code: line.code, amount: money(line.amountMinor), ...(line.count !== undefined ? { count: line.count } : {}) }));
  return {
    payoutId: row.payout_id,
    driverId: row.driver_id,
    amount: money(row.amount_minor),
    status: row.status,
    periodStart: row.period_start.toISOString(),
    periodEnd: row.period_end.toISOString(),
    createdAt: row.created_at.toISOString(),
    ...(row.paid_at ? { paidAt: row.paid_at.toISOString() } : {}),
    source: row.source,
    tripCount: row.trip_count,
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
export async function makePayouts(trx: Trx, input: { driverId: string; from: Date; to: Date; source: "weekly" | "manual"; by: string | null; note?: string; entriesFrom?: Date }, now: Date): Promise<PayoutRow[]> {
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
 * The payout job (each night and every hour, so the admin's payout time is kept within the hour): for every driver
 * with unpaid entries in a period that has ended (the country's schedule, the local time of his first zone or his
 * country), the payouts of that period, one per currency. Safe to run again: paid entries are never taken twice.
 */
export async function closePeriods(trx: Trx, now: Date): Promise<number> {
  const rows = await sql<{ driver_id: string; time_zone: string | null; country: string | null; first_at: Date }>`
    SELECT e.driver_id, z.time_zone, coalesce(z.country, d.country) AS country, min(e.at) AS first_at
      FROM earnings_entries e
      JOIN drivers d ON d.driver_id = e.driver_id
      LEFT JOIN zones z ON z.zone_id = d.zone_ids[1]
     WHERE e.payout_id IS NULL
       AND d.payout_hold_at IS NULL -- v0.18.16 A2 (owner Q4): a held driver is paid after release
     GROUP BY e.driver_id, z.time_zone, coalesce(z.country, d.country)
     ORDER BY 1`.execute(trx);
  const schedules = new Map<string, PayoutSchedule>();
  let made = 0;
  for (const row of rows.rows) {
    const timeZone = row.time_zone ?? countryTimeZone(row.country) ?? SCHEDULE.countryTimeZones["SE"]!;
    const key = row.country ?? "";
    if (!schedules.has(key)) {
      const live = row.country ? await trx.selectFrom("config_live").select("document").where("doc", "=", "country_rules").where("zone_id", "=", standardKey(row.country)).executeTakeFirst() : undefined;
      schedules.set(key, payoutScheduleOf(live?.document as { payoutSchedule?: Partial<PayoutSchedule> } | undefined));
    }
    const schedule = schedules.get(key)!;
    // Every ended period from the oldest unpaid entry on. Checker 4: an entry that came in late for a period already
    // paid goes into the next open period (never stuck): periods start after the driver's last weekly payout.
    const last = await trx.selectFrom("payouts").select((eb) => eb.fn.max("period_end").as("end")).where("driver_id", "=", row.driver_id).where("source", "=", "weekly").executeTakeFirst();
    const lastEnd = last?.end ? new Date(last.end as unknown as string) : null;
    const firstAt = new Date(row.first_at);
    let period = await periodOf(trx, lastEnd && lastEnd > firstAt ? lastEnd : firstAt, timeZone, schedule);
    let entriesFrom: Date | undefined = lastEnd && lastEnd > firstAt ? new Date(0) : undefined;
    while (period.end.getTime() <= now.getTime()) {
      made += (await makePayouts(trx, { driverId: row.driver_id, from: period.start, to: period.end, source: "weekly", by: null, ...(entriesFrom ? { entriesFrom } : {}) }, now)).length;
      entriesFrom = undefined;
      period = await periodOf(trx, period.end, timeZone, schedule);
    }
  }
  return made;
}

/** Kept name for the jobs (v0.9.0): the schedule now comes from the country (closePeriods). */
export const closeWeeks = closePeriods;

const SELECT_PAYOUT = ["payouts.payout_id", "payouts.driver_id", "payouts.zone_id", "payouts.currency", "payouts.amount_minor", "payouts.lines", "payouts.trip_count", "payouts.source", "payouts.status", "payouts.period_start", "payouts.period_end", "payouts.note", "payouts.created_at", "payouts.paid_at", "payouts.paid_by", "drivers.first_name", "drivers.last_name"] as const;

export async function listPayouts(ex: Executor, who: Principal, input: { cursor?: string; limit: number; status?: string[]; driverId?: string; from?: string; to?: string }) {
  let q = ex.selectFrom("payouts").innerJoin("drivers", "drivers.driver_id", "payouts.driver_id").select(SELECT_PAYOUT);
  const zones = zonesOf(who);
  if (zones) q = q.where("payouts.zone_id", "in", zones.length ? zones : ["-"]);
  const statuses = (input.status ?? []).filter((s) => s === "pending" || s === "paid") as ("pending" | "paid")[];
  // A status the server never gives (pending_approval, failed, held) matches nothing.
  if (input.status?.length) q = statuses.length ? q.where("payouts.status", "in", statuses) : q.where(sql<boolean>`false`);
  if (input.driverId) q = q.where("payouts.driver_id", "=", input.driverId);
  if (input.from) q = q.where("payouts.period_end", ">", new Date(input.from));
  if (input.to) q = q.where("payouts.period_start", "<", new Date(input.to));
  if (input.cursor) {
    const c = readCursor(input.cursor);
    q = q.where(sql<boolean>`(payouts.created_at, payouts.payout_id) < (${c.at}, ${c.id})`);
  }
  const rows = await q.orderBy("payouts.created_at", "desc").orderBy("payouts.payout_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return { items: page.map((r) => payoutView(r as PayoutRow, "admin")), nextCursor: rows.length > input.limit && last ? cursorOf(last.created_at, last.payout_id) : null };
}

/** GET /driver/payouts: the driver's own payouts, totals only. */
export async function driverPayouts(ex: Executor, driverId: string, input: { cursor?: string; limit: number; from?: string; to?: string }) {
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
  return { items: page.map((r) => payoutView(r as PayoutRow, "driver")), nextCursor: rows.length > input.limit && last ? cursorOf(last.created_at, last.payout_id) : null };
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
  return payoutView(await payoutForAdmin(trx, who, made.payout_id), "admin");
}

/** POST /admin/payouts/{payoutId}/paid: Mark as paid. */
export async function markPayoutPaid(trx: Trx, who: Principal, payoutId: string, body: { note?: string }, now: Date) {
  const row = await payoutForAdmin(trx, who, payoutId, true);
  if (row.status === "paid") throw new ApiError("invalid_transition", "This payout is already paid.", { reason: "already_paid" });
  await trx.updateTable("payouts").set({ status: "paid", paid_at: now, paid_by: who.subjectId, ...(body.note ? { note: body.note } : {}) }).where("payout_id", "=", payoutId).execute();
  await audit(trx, { adminId: who.subjectId, action: "payout.paid", targetType: "payout", targetId: payoutId, zoneId: row.zone_id, detail: body.note ? { note: body.note } : {}, at: now });
  return payoutView(await payoutForAdmin(trx, who, payoutId), "admin");
}

/**
 * v0.18.16 A2 (owner build-spec Q4, contract.json#payoutHold): POST /admin/drivers/{driverId}/payout-hold. Pauses or
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
