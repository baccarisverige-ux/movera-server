import type { Executor, Trx } from "../db/db.js";
import { liveDocument } from "../config/service.js";
import { contract } from "../contract/contract.js";
import { newId } from "../ids.js";

/**
 * v0.18.43 §64 fix job 10 (contract.json#blockedPairs; owner G16 Q16-4, G15 2026-11-05 "Never told", "No, only Support").
 * A blocked pair (rider + driver) is never matched again. Nothing here is ever shown to the rider or the driver.
 * Rule 33: the pair lives only in blocked_pairs (partial unique index); every server copy reads the same rows.
 */
export type PairBy = "admin" | "rider" | "driver";
export type DontMatchAgain = { on: boolean; atStars: number };
type PairRow = { pair_id: string; rider_id: string; driver_id: string; blocked_by: PairBy; reason: string | null; trip_id: string | null; admin_id: string | null; at: Date };

const BP = contract as unknown as { configDefaults: { dontMatchAgain: DontMatchAgain }; blockedPairs: { settings: { ranges: { atStars: [number, number] } } } };
export const DONT_MATCH_DEFAULT = BP.configDefaults.dontMatchAgain;
const STARS = BP.blockedPairs.settings.ranges.atStars;

/** A stored CountryRules.dontMatchAgain (or nothing) with the defaults; a bad value reads as the default. */
export function dontMatchOf(raw: unknown): DontMatchAgain {
  const v = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const stars = v["atStars"];
  return {
    on: typeof v["on"] === "boolean" ? v["on"] : DONT_MATCH_DEFAULT.on,
    atStars: typeof stars === "number" && Number.isInteger(stars) && stars >= STARS[0] && stars <= STARS[1] ? stars : DONT_MATCH_DEFAULT.atStars,
  };
}

/** The zone's CountryRules.dontMatchAgain (its own, else its country's Standard), with defaults. */
export async function dontMatchSettings(ex: Executor, zoneId: string): Promise<DontMatchAgain> {
  const rules = await liveDocument<{ dontMatchAgain?: unknown }>(ex, "country_rules", zoneId);
  return dontMatchOf(rules?.document.dontMatchAgain);
}

/** Of `driverIds`, those blocked with this rider (one query for the whole round). */
export async function blockedDriversFor(ex: Executor, riderId: string, driverIds: string[]): Promise<Set<string>> {
  if (driverIds.length === 0) return new Set();
  const rows = await ex.selectFrom("blocked_pairs").select("driver_id").where("rider_id", "=", riderId).where("driver_id", "in", driverIds).where("removed_at", "is", null).execute();
  return new Set(rows.map((r) => r.driver_id));
}

export function pairView(r: PairRow) {
  return {
    pairId: r.pair_id, riderId: r.rider_id, driverId: r.driver_id, by: r.blocked_by,
    ...(r.reason ? { reason: r.reason } : {}), ...(r.trip_id ? { tripId: r.trip_id } : {}),
    at: r.at.toISOString(), ...(r.admin_id ? { adminId: r.admin_id } : {}),
  };
}

/** Writes the pair, or returns the active one (two copies at once → one row, ON CONFLICT DO NOTHING). */
export async function blockPair(trx: Trx, input: { riderId: string; driverId: string; by: PairBy; reason?: string | null; tripId?: string | null; adminId?: string | null }, now: Date) {
  await trx.insertInto("blocked_pairs").values({
    pair_id: newId("bpr", now.getTime()), rider_id: input.riderId, driver_id: input.driverId, blocked_by: input.by,
    reason: input.reason ?? null, trip_id: input.tripId ?? null, admin_id: input.adminId ?? null, at: now,
  }).onConflict((c) => c.columns(["rider_id", "driver_id"]).where("removed_at", "is", null).doNothing()).execute();
  const row = await trx.selectFrom("blocked_pairs").selectAll().where("rider_id", "=", input.riderId).where("driver_id", "=", input.driverId).where("removed_at", "is", null).executeTakeFirstOrThrow();
  return pairView(row);
}

/** Support's undo (the only undo). Returns the removed pair, or null when there is no active pair with that id. */
export async function removePair(trx: Trx, pairId: string, adminId: string, now: Date) {
  const row = await trx.updateTable("blocked_pairs").set({ removed_at: now, removed_by: adminId }).where("pair_id", "=", pairId).where("removed_at", "is", null).returningAll().executeTakeFirst();
  return row ? pairView(row) : null;
}

export async function listPairs(ex: Executor, filter: { riderId?: string | undefined; driverId?: string | undefined }) {
  let q = ex.selectFrom("blocked_pairs").selectAll().where("removed_at", "is", null);
  if (filter.riderId) q = q.where("rider_id", "=", filter.riderId);
  if (filter.driverId) q = q.where("driver_id", "=", filter.driverId);
  const rows = await q.orderBy("at", "desc").orderBy("pair_id", "desc").limit(200).execute();
  return { items: rows.map(pairView) };
}
