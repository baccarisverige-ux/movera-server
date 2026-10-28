import { sql } from "kysely";
import type { Principal } from "../auth/guard.js";
import { contract } from "../contract/contract.js";
import type { Executor } from "../db/db.js";
import { badRequest } from "../http/errors.js";

/**
 * Risk signals the server can count (contract v0.9.0 §16, contract.json#risk; owner, 2026-10-27): cancels (drivers
 * and riders, 30 days), failed payments (riders, 30 days) and low rating (drivers, last 50 visible ratings).
 */

type Signals = { cancels: { windowDays: number }; failed_payments: { windowDays: number }; low_rating: { lastRides: number } };
const RISK = (contract as unknown as { risk: { signals: Signals } }).risk.signals;
const DAY_MS = 86_400_000;

type Signal = { value: number; count: number; total?: number };
type Person = { who: "driver" | "rider"; id: string; name: string; zoneId?: string; signals: Partial<Record<"cancels" | "failed_payments" | "low_rating", Signal>> };

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

async function driverSignals(ex: Executor, zones: string[] | null, zoneId: string | undefined, now: Date): Promise<Person[]> {
  const since = new Date(now.getTime() - RISK.cancels.windowDays * DAY_MS);
  const rows = await sql<{ driver_id: string; first_name: string; last_name: string; zone_id: string | null; cancels: string; accepted: string; rated: string; average: string | null }>`
    SELECT d.driver_id, d.first_name, d.last_name, d.zone_ids[1] AS zone_id,
           (SELECT count(*) FROM driver_cancels c WHERE c.driver_id = d.driver_id AND c.at >= ${since}) AS cancels,
           (SELECT count(*) FROM offers o WHERE o.driver_id = d.driver_id AND o.status = 'claimed' AND o.answered_at >= ${since}) AS accepted,
           r.rated, r.average
      FROM drivers d
      LEFT JOIN LATERAL (
        SELECT count(*) AS rated, avg(stars) AS average FROM (
          SELECT g.stars FROM ratings g JOIN trips t ON t.trip_id = g.trip_id
           WHERE t.driver_id = d.driver_id AND g.rater = 'rider' AND NOT g.hidden
           ORDER BY g.at DESC LIMIT ${RISK.low_rating.lastRides}) last) r ON true`.execute(ex);
  const out: Person[] = [];
  for (const r of rows.rows) {
    if (zones && (r.zone_id === null || !zones.includes(r.zone_id))) continue;
    if (zoneId && r.zone_id !== zoneId) continue;
    const cancels = Number(r.cancels);
    const accepted = Number(r.accepted);
    const rated = Number(r.rated);
    const signals: Person["signals"] = {};
    // Every cancelled trip was accepted first, so the share is cancels ÷ accepted trips.
    const total = Math.max(accepted, cancels);
    if (cancels > 0) signals.cancels = { value: pct(cancels, total), count: cancels, total };
    if (rated > 0 && r.average !== null) signals.low_rating = { value: Math.round(Number(r.average) * 100) / 100, count: rated };
    if (Object.keys(signals).length) out.push({ who: "driver", id: r.driver_id, name: [r.first_name, r.last_name].filter(Boolean).join(" "), ...(r.zone_id ? { zoneId: r.zone_id } : {}), signals });
  }
  return out;
}

async function riderSignals(ex: Executor, zones: string[] | null, zoneId: string | undefined, now: Date): Promise<Person[]> {
  const since = new Date(now.getTime() - Math.max(RISK.cancels.windowDays, RISK.failed_payments.windowDays) * DAY_MS);
  const cancelSince = new Date(now.getTime() - RISK.cancels.windowDays * DAY_MS);
  const failSince = new Date(now.getTime() - RISK.failed_payments.windowDays * DAY_MS);
  const rows = await sql<{ rider_id: string; first_name: string; zone_id: string; booked: string; cancelled: string; failed: string }>`
    SELECT t.rider_id, r.first_name,
           (array_agg(t.zone_id ORDER BY t.created_at DESC))[1] AS zone_id,
           count(*) FILTER (WHERE t.created_at >= ${cancelSince}) AS booked,
           count(*) FILTER (WHERE t.created_at >= ${cancelSince} AND t.status = 'cancelled_by_rider') AS cancelled,
           count(*) FILTER (WHERE t.updated_at >= ${failSince} AND t.payment_status = 'failed') AS failed
      FROM trips t JOIN riders r ON r.rider_id = t.rider_id
     WHERE t.created_at >= ${since} OR t.updated_at >= ${since}
     GROUP BY t.rider_id, r.first_name`.execute(ex);
  const out: Person[] = [];
  for (const r of rows.rows) {
    if (zones && !zones.includes(r.zone_id)) continue;
    if (zoneId && r.zone_id !== zoneId) continue;
    const signals: Person["signals"] = {};
    const cancelled = Number(r.cancelled);
    const failed = Number(r.failed);
    if (cancelled > 0) signals.cancels = { value: pct(cancelled, Number(r.booked)), count: cancelled, total: Number(r.booked) };
    if (failed > 0) signals.failed_payments = { value: failed, count: failed };
    if (Object.keys(signals).length) out.push({ who: "rider", id: r.rider_id, name: r.first_name, zoneId: r.zone_id, signals });
  }
  return out;
}

/** GET /admin/risk/signals: people with at least one counted event; the cursor is the position in the list. */
export async function riskSignals(ex: Executor, who: Principal, input: { cursor?: string; limit: number; who?: "driver" | "rider"; zoneId?: string }, now: Date) {
  const zones = who.zones.includes("*") ? null : who.zones;
  const people = [
    ...(input.who !== "rider" ? await driverSignals(ex, zones, input.zoneId, now) : []),
    ...(input.who !== "driver" ? await riderSignals(ex, zones, input.zoneId, now) : []),
  ].sort((a, b) => a.who.localeCompare(b.who) || a.id.localeCompare(b.id));
  const start = input.cursor === undefined ? 0 : Number(input.cursor);
  if (!Number.isInteger(start) || start < 0) throw badRequest("The cursor is not valid.", "invalid_cursor");
  const page = people.slice(start, start + input.limit);
  return { items: page, nextCursor: start + input.limit < people.length ? String(start + input.limit) : null };
}
