import type { Executor } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { callSettingsFor, type CallSettings } from "./settings.js";

/**
 * v0.18.113 BQ-S13 (contract.json#inAppCalls.callOpenUntil; owner 2026-11-01 "Keep call open for 1 hour but not chat",
 * Rules decisions/driver-g9.md:38): the end of the call window after a completed drop-off — trips.ended_at + the zone's
 * CountryRules.calls.callWindowAfterTripMin. The server's own check (callWindowOpen) uses this same instant.
 */
export function callWindowEnd(trip: Pick<TripRow, "status" | "ended_at">, settings: Pick<CallSettings, "callWindowAfterTripMin">): Date | null {
  if (trip.status !== "completed" || trip.ended_at === null) return null;
  return new Date(trip.ended_at.getTime() + settings.callWindowAfterTripMin * 60_000);
}

/** TripProjection.callOpenUntil on a read: only a completed trip while its zone's calls are on; settings read now. */
export async function withCallOpenUntil(
  ex: Executor,
  trip: TripRow,
  projection: Record<string, unknown>,
  cache: Map<string, Promise<CallSettings>> = new Map(),
): Promise<Record<string, unknown>> {
  if (trip.status !== "completed" || trip.ended_at === null || trip.driver_id === null) return projection;
  const key = trip.zone_id ?? "";
  let settings = cache.get(key);
  if (settings === undefined) {
    settings = callSettingsFor(ex, trip.zone_id);
    cache.set(key, settings);
  }
  const s = await settings;
  const end = s.on ? callWindowEnd(trip, s) : null;
  return end === null ? projection : { ...projection, callOpenUntil: end.toISOString() };
}
