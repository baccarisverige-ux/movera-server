import { sql } from "kysely";
import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";
import { standardKey } from "../config/service.js";
import { CARRY_ROW, CARRY_VALUE } from "../drivers/owes.js";

/**
 * v0.18.133 S5 J12-J15 (contract.json#payoutLines; owner 2026-11-19 "driver payout 3 lines", "carry line only when
 * needed", "carry counts toward owed limit"; Rules handover/build-plans-2026-11-12/S5-money.md J12-J15): a payout is
 * never paid below zero. A period below 0 pays 0 and the rest moves to the driver's next payout of that currency.
 * Old payouts below 0 are only read (drivers/owes.ts CARRY_ROW), never rewritten. Integers (minor units) only.
 */

const DEFAULT_ON = (contract as unknown as { configDefaults: { payoutLinesOn?: boolean } }).configDefaults.payoutLinesOn === true;

/** CountryRules.payoutLinesOn of the driver's country standard (his first zone's country, else his own); default off. */
export async function payoutLinesOn(ex: Executor, driverId: string): Promise<boolean> {
  const row = await ex
    .selectFrom("drivers as d")
    .leftJoin("zones as z", (j) => j.on(sql<boolean>`z.zone_id = d.zone_ids[1]`))
    .select(sql<string | null>`coalesce(z.country, d.country)`.as("country"))
    .where("d.driver_id", "=", driverId)
    .executeTakeFirst();
  if (!row?.country) return DEFAULT_ON;
  // Read as the payout job reads payoutMode (config_live directly, no cache): a money path follows the live switch.
  const live = await ex.selectFrom("config_live").select("document").where("doc", "=", "country_rules").where("zone_id", "=", standardKey(row.country)).executeTakeFirst();
  const doc = live?.document as { payoutLinesOn?: unknown } | undefined;
  return typeof doc?.payoutLinesOn === "boolean" ? doc.payoutLinesOn : DEFAULT_ON;
}

/**
 * What the driver's next payout of `currency` takes first (payoutLines.carry): `total` = the rest carried (>= 0), and
 * `fromLines` = the part left by a switched-on payout. Read under his driver lock (the caller's).
 */
export async function carryOf(ex: Executor, driverId: string, currency: string): Promise<{ total: number; fromLines: number; newestMadeAt: Date | null }> {
  const row = await ex
    .selectFrom("payouts as p")
    .select([
      sql<string>`coalesce(sum(${CARRY_VALUE}) FILTER (WHERE ${CARRY_ROW}), 0)`.as("net"),
      sql<string>`coalesce(sum(CASE WHEN p.carried_out_minor IS NOT NULL THEN p.carried_out_minor ELSE 0 END) FILTER (WHERE ${CARRY_ROW}), 0)`.as("lines"),
      sql<Date | null>`max(p.created_at)`.as("newest"),
    ])
    .where("p.driver_id", "=", driverId)
    .where("p.currency", "=", currency)
    .executeTakeFirst();
  const newest = row?.newest ?? null;
  return { total: Math.max(0, -Number(row?.net ?? 0)), fromLines: Number(row?.lines ?? 0), newestMadeAt: newest === null ? null : new Date(newest) };
}

/**
 * Review M2 (payoutLines.carry, "taken once"): the made-at of a lined payout. The carry points are ordered by the order
 * they were made (drivers/owes.ts NOT_SUPERSEDED: created_at, period_end, payout_id), and a lined payout takes every
 * carry row it read, so it must come after each of them: `now`, or 1 ms after his newest payout of that currency when
 * a clock behind it (a timer's firedAt) would put it before one.
 */
export function lineMadeAt(now: Date, newestMadeAt: Date | null): Date {
  return newestMadeAt !== null && newestMadeAt.getTime() >= now.getTime() ? new Date(newestMadeAt.getTime() + 1) : now;
}

type Entry = { kind: string; amountMinor: number; cashMinor: number };

/**
 * The parts of a payout (payoutLines.lines): each entry's amount less the cash he kept for it is earned when above 0,
 * else owed; owed starts at the carry and "Driver paid Movera" money lowers it (a rest past 0 counts as earned).
 * earned − owed = paidOut − carriedOut, always.
 */
export function splitPayout(entries: readonly Entry[], carriedIn: number): { earned: number; owed: number; paidOut: number; carriedOut: number } {
  let earned = 0;
  let owed = carriedIn;
  let paidMovera = 0;
  for (const e of entries) {
    if (e.kind === "paid_to_movera") {
      paidMovera += e.amountMinor;
      continue;
    }
    const net = e.amountMinor - (e.kind === "trip" || e.kind === "tip" ? e.cashMinor : 0);
    if (net >= 0) earned += net;
    else owed -= net;
  }
  owed -= paidMovera;
  if (owed < 0) {
    earned -= owed;
    owed = 0;
  }
  return { earned, owed, paidOut: Math.max(0, earned - owed), carriedOut: Math.max(0, owed - earned) };
}

export type RunCard = { country: string; periodStart: string; periodEnd: string; count: number; total: Money[]; earned: Money[]; owedToMovera: Money[]; paidOut: Money[]; carriedOut: Money[] };
type Money = { amountMinor: number; currency: string };

/**
 * GET /admin/payouts/runs?country (payoutLines.runs): every run waiting for approval in the country, inside the admin's
 * zones (null = all zones, lists.ts zonesOf), counted by the server over all its payouts (one grouped read, not a page).
 */
export async function payoutRuns(ex: Executor, country: string, zones: readonly string[] | null): Promise<{ items: RunCard[] }> {
  let q = ex
    .selectFrom("payouts as p")
    .innerJoin("drivers as d", "d.driver_id", "p.driver_id")
    .leftJoin("zones as z", "z.zone_id", "p.zone_id")
    .select([
      "p.period_end",
      "p.currency",
      sql<Date>`min(p.period_start)`.as("period_start"),
      sql<string>`count(*)`.as("count"),
      sql<string>`sum(p.amount_minor)`.as("total"),
      // A payout made before the lines (no parts) counts its amount as its own parts: earned when >= 0, else owed.
      sql<string>`sum(coalesce(p.earned_minor, greatest(p.amount_minor, 0)))`.as("earned"),
      sql<string>`sum(coalesce(p.owed_minor, greatest(-p.amount_minor, 0)))`.as("owed"),
      sql<string>`sum(greatest(p.amount_minor, 0))`.as("paid_out"),
      sql<string>`sum(coalesce(p.carried_out_minor, greatest(-p.amount_minor, 0)))`.as("carried_out"),
    ])
    .where("p.status", "=", "pending_approval")
    .where(sql<boolean>`coalesce(z.country, d.country) = ${country}`);
  // The same payouts approvePayoutRun takes: a zone of his (a payout with no zone only for an all-zones admin).
  if (zones !== null) q = q.where("p.zone_id", "in", zones.length ? zones : ["-"]);
  const rows = await q.groupBy(["p.period_end", "p.currency"]).orderBy("p.period_end").orderBy("p.currency").execute();
  const runs = new Map<string, RunCard>();
  for (const r of rows) {
    const end = new Date(r.period_end).toISOString();
    let card = runs.get(end);
    if (!card) runs.set(end, (card = { country, periodStart: new Date(r.period_start).toISOString(), periodEnd: end, count: 0, total: [], earned: [], owedToMovera: [], paidOut: [], carriedOut: [] }));
    const start = new Date(r.period_start).toISOString();
    if (start < card.periodStart) card.periodStart = start;
    card.count += Number(r.count);
    const m = (v: string) => ({ amountMinor: Number(v), currency: r.currency });
    card.total.push(m(r.total));
    card.earned.push(m(r.earned));
    card.owedToMovera.push(m(r.owed));
    card.paidOut.push(m(r.paid_out));
    card.carriedOut.push(m(r.carried_out));
  }
  return { items: [...runs.values()] };
}
