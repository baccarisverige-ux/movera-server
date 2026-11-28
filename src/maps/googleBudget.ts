import { sql } from "kysely";
import type { Executor } from "../db/db.js";

/**
 * v0.18.171 (contract.json#googleRoadLines.dailyBudget / dayBoundary; owner 2026-11-27: 2,000 Google Routes calls a day,
 * 1,400 for prices and 600 for road lines): ONE daily budget for all countries together, because Google's quota is per
 * project. The day is the America/Los_Angeles calendar day (Google's per-day quota resets at midnight Pacific time).
 * The per-country rows of google_route_calls_daily are for reporting only; every limit is checked on the day's SUM.
 *  - Quotes may use the whole daily limit.
 *  - Road lines stop first: re-routes and ETA re-calls at 80% of the road-line share, the drive to the pickup at 100%.
 * The numbers are in the DB (every server copy sees the same); a race between copies can overshoot by a call or two.
 */
export const GOOGLE_BUDGET_DEFAULTS = { dailyLimit: 2000, quotesPerDay: 1400 } as const;
export const DAILY_LIMIT_RANGE = [100, 100_000] as const;
/** Re-routes and ETA re-calls stop at this part of the road-line share (the drive to the pickup goes on to 100%). */
export const REROUTE_SHARE = 0.8;
export const GOOGLE_DAY_TIME_ZONE = "America/Los_Angeles";

export type GoogleCallKind = "quote" | "road_line";
/** Who asks Google: a price (quote), or a road line (`pickup` = the first drive to the pickup, `reroute` = the rest). */
export type GoogleCallBudget = { kind: GoogleCallKind; country?: string; stage?: "pickup" | "reroute" };
export type GoogleBudget = { dailyLimit: number; quotesPerDay: number };
export type GoogleUse = { day: string; quotes: number; roadLines: number };

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: GOOGLE_DAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** YYYY-MM-DD of the America/Los_Angeles day `now` falls on. */
export function googleDay(now: Date): string {
  return DAY_FORMAT.format(now);
}

export async function readGoogleBudget(ex: Executor): Promise<GoogleBudget> {
  const row = await ex.selectFrom("google_routes_budget").select(["daily_limit", "quotes_per_day"]).executeTakeFirst();
  return row ? { dailyLimit: row.daily_limit, quotesPerDay: row.quotes_per_day } : { ...GOOGLE_BUDGET_DEFAULTS };
}

export async function googleUse(ex: Executor, now: Date): Promise<GoogleUse> {
  const day = googleDay(now);
  const rows = await ex.selectFrom("google_route_calls_daily").select(["kind", sql<string>`sum(calls)`.as("n")]).where("day", "=", day).groupBy("kind").execute();
  const of = (k: GoogleCallKind) => Number(rows.find((r) => r.kind === k)?.n ?? 0);
  return { day, quotes: of("quote"), roadLines: of("road_line") };
}

/** May one more Google call of this kind go out today? (no count) */
export function budgetAllows(budget: GoogleBudget, use: GoogleUse, ask: GoogleCallBudget): boolean {
  if (use.quotes + use.roadLines >= budget.dailyLimit) return false;
  if (ask.kind === "quote") return true;
  const share = Math.max(0, budget.dailyLimit - budget.quotesPerDay);
  const cap = ask.stage === "pickup" ? share : Math.floor(share * REROUTE_SHARE);
  return use.roadLines < cap;
}

export async function googleBudgetOpen(ex: Executor, ask: GoogleCallBudget, now: Date): Promise<boolean> {
  return budgetAllows(await readGoogleBudget(ex), await googleUse(ex, now), ask);
}

/** One more call today: one upsert. */
export async function countGoogleCall(ex: Executor, ask: GoogleCallBudget, now: Date): Promise<void> {
  await ex
    .insertInto("google_route_calls_daily")
    .values({ day: googleDay(now), country: ask.country ?? "XX", kind: ask.kind, calls: 1 })
    .onConflict((oc) => oc.columns(["day", "country", "kind"]).doUpdateSet({ calls: sql`google_route_calls_daily.calls + 1` }))
    .execute();
}

/** The router's daily guard (googleRoutes.ts): checks the budget, and counts the call when it may go out. */
export type DailyGuard = { take(ask: GoogleCallBudget): Promise<boolean> };

export function dbDailyGuard(ex: Executor, now: () => Date = () => new Date()): DailyGuard {
  return {
    async take(ask) {
      const at = now();
      if (!(await googleBudgetOpen(ex, ask, at))) return false;
      await countGoogleCall(ex, ask, at);
      return true;
    },
  };
}
