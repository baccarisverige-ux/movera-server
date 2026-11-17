import { sql } from "kysely";
import type { Executor } from "../../db/db.js";
import { badRequest } from "../../http/errors.js";
import { tripProjection } from "../projection.js";

/**
 * GET /driver/trips (contract v0.18.124 C10, contract.json#driverTripHistory; owner G11 Q10 "Load from server
 * (Recommended)", Rules decisions/driver-g11.md): the driver's own ended trips, newest first (createdAt, tripId), paged.
 * Each item is the driver's TripProjection plus earned = the trip's own earnings entries of the kinds GET /driver/earnings
 * puts in net (so the list, the totals and the admin agree) and cashCollected (cash of the trip and tip entries).
 * Rule 33: one bounded read per page, nothing kept in the server copy.
 */
export const DRIVER_HISTORY_STATUSES = ["completed", "cancelled_by_rider", "cancelled_by_driver", "cancelled_by_admin", "cancelled_by_system", "no_show"] as const;
const NET_KINDS = ["trip", "pickup_pay", "fee_share", "tip", "adjustment", "bonus"] as const;

export async function driverTrips(
  ex: Executor,
  driverId: string,
  input: { cursor?: string; limit: number; statuses?: string[]; from?: string; to?: string },
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const statuses = input.statuses?.length ? input.statuses : [...DRIVER_HISTORY_STATUSES];
  for (const s of statuses) if (!(DRIVER_HISTORY_STATUSES as readonly string[]).includes(s)) throw badRequest("Only ended trips are listed.", "invalid_status");
  let query = ex.selectFrom("trips").selectAll().where("driver_id", "=", driverId).where("status", "in", statuses as never);
  if (input.from) query = query.where("created_at", ">=", new Date(input.from));
  if (input.to) query = query.where("created_at", "<", new Date(input.to));
  if (input.cursor) {
    const [at, id] = Buffer.from(input.cursor, "base64url").toString("utf8").split("|");
    if (!at || !id || Number.isNaN(Date.parse(at))) throw badRequest("The cursor is not valid.", "invalid_cursor");
    query = query.where(sql<boolean>`(created_at, trip_id) < (${new Date(at)}, ${id})`);
  }
  const rows = await query.orderBy("created_at", "desc").orderBy("trip_id", "desc").limit(input.limit + 1).execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const ids = page.map((r) => r.trip_id);
  const sums = ids.length === 0 ? [] : await ex
    .selectFrom("earnings_entries")
    .select(["trip_id", "currency"])
    .select(sql<string>`coalesce(sum(amount_minor) FILTER (WHERE kind IN (${sql.join(NET_KINDS.map((k) => sql.lit(k)))})), 0)`.as("earned"))
    .select(sql<string>`coalesce(sum(cash_minor) FILTER (WHERE kind IN ('trip', 'tip')), 0)`.as("cash"))
    .where("driver_id", "=", driverId)
    .where("trip_id", "in", ids)
    .groupBy(["trip_id", "currency"])
    .execute();
  const items = page.map((row) => {
    // One trip earns in one currency (its zone's); the trip's own currency wins if entries ever differ.
    const mine = sums.filter((s) => s.trip_id === row.trip_id);
    const sum = mine.find((s) => s.currency === row.currency) ?? mine[0];
    const currency = sum?.currency ?? row.currency;
    const cash = Number(sum?.cash ?? 0);
    return {
      ...tripProjection(row, "driver"),
      earned: { amountMinor: Number(sum?.earned ?? 0), currency },
      ...(cash > 0 ? { cashCollected: { amountMinor: cash, currency } } : {}),
      ...(row.ended_at ? { endedAt: new Date(row.ended_at).toISOString() } : {}),
      ...(row.distance_meters !== null && row.distance_meters !== undefined ? { distanceMeters: Number(row.distance_meters) } : {}),
    };
  });
  return { items, nextCursor: rows.length > input.limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.trip_id}`).toString("base64url") : null };
}
