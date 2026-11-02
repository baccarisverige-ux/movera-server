import { sql } from "kysely";
import type { Principal } from "../auth/guard.js";
import { adminCoversZone } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { audit } from "./audit.js";
import { cursorOf, readCursor, zonesOf } from "./lists.js";

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
 * Makes one payout for a driver from the unpaid entries in [from, to). Returns null when there is none.
 * The entries are locked, so two runs (the job and an admin, or two admins) never take the same entry.
 */
export async function makePayout(trx: Trx, input: { driverId: string; from: Date; to: Date; source: "weekly" | "manual"; by: string | null; note?: string }, now: Date): Promise<PayoutRow | null> {
  const entries = await trx
    .selectFrom("earnings_entries as e")
    .leftJoin("trips as t", "t.trip_id", "e.trip_id")
    .select(["e.entry_id", "e.kind", "e.currency", "e.amount_minor", "e.cash_minor", "t.fare_lines"])
    .where("e.driver_id", "=", input.driverId)
    .where("e.payout_id", "is", null)
    .where("e.at", ">=", input.from)
    .where("e.at", "<", input.to)
    .orderBy("e.at")
    .forUpdate("e")
    .execute();
  if (entries.length === 0) return null;
  const calc = payoutLines(entries.map((e) => ({ kind: e.kind, amountMinor: Number(e.amount_minor), cashMinor: Number(e.cash_minor ?? 0), waitingMinor: e.kind === "trip" ? waitingOf(e.fare_lines) : 0 })));
  const driver = await trx.selectFrom("drivers").select(["zone_ids"]).where("driver_id", "=", input.driverId).executeTakeFirst();
  const payoutId = newId("pyt", now.getTime());
  const row = await trx
    .insertInto("payouts")
    .values({
      payout_id: payoutId,
      driver_id: input.driverId,
      zone_id: driver?.zone_ids[0] ?? null,
      currency: entries[0]!.currency,
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
    .onConflict((c) => c.columns(["driver_id", "period_start"]).where("source", "=", "weekly").doNothing())
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) return null;
  await trx.updateTable("earnings_entries").set({ payout_id: payoutId }).where("entry_id", "in", entries.map((e) => e.entry_id)).execute();
  return row as PayoutRow;
}

/** Monday 00:00 of the week that holds `at`, in the time zone. */
export async function weekStart(ex: Executor, at: Date, timeZone: string): Promise<Date> {
  const row = await sql<{ start: Date }>`SELECT (date_trunc('week', ${at}::timestamptz AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone}) AS start`.execute(ex);
  return row.rows[0]!.start;
}

/**
 * The weekly job: for every driver with unpaid entries in a week that has ended (Monday to Monday in the driver's
 * first zone's time), one payout. Safe to run again: a week already paid has no entries left.
 */
export async function closeWeeks(trx: Trx, now: Date): Promise<number> {
  const rows = await sql<{ driver_id: string; time_zone: string; week: Date }>`
    SELECT DISTINCT e.driver_id, coalesce(z.time_zone, 'Europe/Stockholm') AS time_zone,
           (date_trunc('week', e.at AT TIME ZONE coalesce(z.time_zone, 'Europe/Stockholm')) AT TIME ZONE coalesce(z.time_zone, 'Europe/Stockholm')) AS week
      FROM earnings_entries e
      JOIN drivers d ON d.driver_id = e.driver_id
      LEFT JOIN zones z ON z.zone_id = d.zone_ids[1]
     WHERE e.payout_id IS NULL
     ORDER BY 1, 3`.execute(trx);
  let made = 0;
  for (const row of rows.rows) {
    const end = new Date((await sql<{ end: Date }>`SELECT ((${row.week}::timestamptz AT TIME ZONE ${row.time_zone} + interval '1 week') AT TIME ZONE ${row.time_zone}) AS end`.execute(trx)).rows[0]!.end);
    if (end.getTime() > now.getTime()) continue;
    if (await makePayout(trx, { driverId: row.driver_id, from: row.week, to: end, source: "weekly", by: null }, now)) made += 1;
  }
  return made;
}

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
  const made = await makePayout(trx, { driverId: body.driverId, from, to, source: "manual", by: who.subjectId, ...(body.note ? { note: body.note } : {}) }, now);
  if (made === null) throw new ApiError("invalid_transition", "Nothing to pay in this period: every trip is already in a payout.", { reason: "nothing_to_pay" });
  await audit(trx, { adminId: who.subjectId, action: "payout.create", targetType: "payout", targetId: made.payout_id, zoneId: made.zone_id, detail: { driverId: body.driverId, from: body.from, to: body.to, amountMinor: Number(made.amount_minor), ...(body.note ? { note: body.note } : {}) }, at: now });
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
