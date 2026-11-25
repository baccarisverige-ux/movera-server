import { contract } from "../contract/contract.js";
import { liveDocument } from "../config/service.js";
import type { Executor } from "../db/db.js";
import type { Router } from "./routing.js";

/**
 * v0.18.163 (contract.json#liveTraffic.setting): DispatchDocument.liveTraffic { on } of the zone (or the country
 * standard it follows); without the field, the default for the zone's country (on for SE and FR, off elsewhere).
 */
type Recall = { offRouteMeters: number; offRouteSeconds: number; behindMinutes: number };
const LT = (contract as unknown as { liveTraffic: { defaultOnCountries: string[]; recall: { defaults: Recall; ranges: Record<keyof Recall, [number, number]> } } }).liveTraffic;
/** v0.18.163 (contract.json#liveTraffic.recall, owner 2026-11-25): when the ETA asks Google again during a trip. */
export const RECALL_DEFAULTS: Readonly<Recall> = LT.recall.defaults;
export const LIVE_TRAFFIC_DEFAULT_ON: readonly string[] = LT.defaultOnCountries;

export function liveTrafficDefault(country: string | null | undefined): boolean {
  return country != null && LIVE_TRAFFIC_DEFAULT_ON.includes(country);
}

export type LiveTrafficSettings = { on: boolean } & Recall;

/** The zone's setting with the re-call thresholds; a missing or out-of-range value reads as its default. */
export async function liveTrafficSettings(ex: Executor, zoneId: string): Promise<LiveTrafficSettings> {
  const live = await liveDocument<{ liveTraffic?: Record<string, unknown> }>(ex, "dispatch", zoneId);
  const lt = live?.document.liveTraffic ?? {};
  const pick = (k: keyof Recall): number => {
    const v = lt[k];
    const [lo, hi] = LT.recall.ranges[k];
    return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : RECALL_DEFAULTS[k];
  };
  let on = lt["on"];
  if (typeof on !== "boolean") {
    const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", zoneId).executeTakeFirst();
    on = liveTrafficDefault(zone?.country ?? null);
  }
  return { on: on as boolean, offRouteMeters: pick("offRouteMeters"), offRouteSeconds: pick("offRouteSeconds"), behindMinutes: pick("behindMinutes") };
}

export async function liveTrafficOn(ex: Executor, zoneId: string): Promise<boolean> {
  return (await liveTrafficSettings(ex, zoneId)).on;
}

/** The two routers: `roads` (OSRM, else the estimate) and `traffic` (Google with live traffic, falling back to `roads`). */
export type TrafficRouters = { roads: Router; traffic?: Router };

/** The router for a trip time in this zone: live traffic when the server has it and the zone's setting is on. */
export async function tripTimeRouter(ex: Executor, zoneId: string, routers: TrafficRouters): Promise<Router> {
  if (routers.traffic === undefined) return routers.roads;
  try {
    return (await liveTrafficOn(ex, zoneId)) ? routers.traffic : routers.roads;
  } catch {
    return routers.roads;
  }
}
