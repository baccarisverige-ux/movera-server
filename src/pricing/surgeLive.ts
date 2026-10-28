import type { Executor } from "../db/db.js";
import { liveDocument } from "../config/service.js";
import type { PricingDocument } from "../rules/fare.js";
import { SLIDER_TOP, surgeFor, type DocSurge } from "./surge.js";

/**
 * Contract v0.7.2 (owner 2026-10-28): the real numbers behind the admin's Surge tab (contract.json#surgeLive) and
 * the driver's coloured surge zones (contract.json#driverSurgeMap). Everything comes from surge_samples, quotes,
 * trips and the zone's surge schedules; nothing is invented.
 */

type Source = "manual" | "scheduled" | "smart" | "off";
const MIN_MS = 60_000;
const round1 = (value: number) => Math.round(value * 10) / 10;

async function zoneSurge(ex: Executor, zoneId: string): Promise<DocSurge | undefined> {
  return (await liveDocument<PricingDocument & { surge?: DocSurge }>(ex, "pricing", zoneId))?.document.surge;
}

/** The surge a quote made now would get in the zone (before a category filter), at most ×6. */
async function surgeNowOf(ex: Executor, zoneId: string, now: Date) {
  const current = await surgeFor(ex, zoneId, await zoneSurge(ex, zoneId), undefined, now);
  return { ...current, multiplier: Math.min(SLIDER_TOP, current.multiplier) };
}

/** GET /admin/surge/now: one ZoneSurgeNow per zone, with the newest sample's demand. */
export async function surgeNow(ex: Executor, zoneIds: readonly string[], now: Date) {
  const zones = [];
  for (const zoneId of zoneIds) {
    const current = await surgeNowOf(ex, zoneId, now);
    const sample = await ex.selectFrom("surge_samples").selectAll().where("zone_id", "=", zoneId).orderBy("at", "desc").limit(1).executeTakeFirst();
    const state = current.source === "smart" ? await ex.selectFrom("smart_surge_state").select("profile_id").where("zone_id", "=", zoneId).executeTakeFirst() : undefined;
    zones.push({
      zoneId,
      multiplier: current.multiplier,
      source: current.source,
      ...(current.until ? { until: current.until } : {}),
      ...(current.scheduleId ? { scheduleId: current.scheduleId } : {}),
      ...(state?.profile_id ? { profileId: state.profile_id } : {}),
      requests: sample?.requests ?? 0,
      freeDrivers: sample?.free_drivers ?? 0,
      ratio: sample ? round1(Number(sample.ratio)) : 0,
      ...(sample ? { checkedAt: sample.at.toISOString() } : {}),
    });
  }
  return { at: now.toISOString(), zones };
}

type Sample = { at: Date; requests: number; free: number; ratio: number; multiplier: number; source: Source };

async function samplesOf(ex: Executor, zoneId: string, from: Date, to: Date): Promise<Sample[]> {
  const rows = await ex.selectFrom("surge_samples").selectAll().where("zone_id", "=", zoneId).where("at", ">=", from).where("at", "<=", to).orderBy("at").execute();
  return rows.map((r) => ({ at: r.at, requests: r.requests, free: r.free_drivers, ratio: Number(r.ratio), multiplier: Number(r.multiplier), source: r.source }));
}

/** Quotes of the zone with a surge above 1.0 in [from, to), and how many of them no trip was made from. */
export async function priceCheck(ex: Executor, zoneId: string, from: Date, to: Date) {
  const rows = await ex
    .selectFrom("quotes")
    .select(["quote_id", "used_at"])
    .where("zone_id", "=", zoneId)
    .where("created_at", ">=", from)
    .where("created_at", "<", to)
    .where("surge_multiplier", ">", "1")
    .execute();
  const saw = rows.length;
  const left = rows.filter((r) => r.used_at === null).length;
  return { windowMin: Math.round((to.getTime() - from.getTime()) / MIN_MS), saw, left, leftPct: saw === 0 ? 0 : Math.round((100 * left) / saw) };
}

async function tripsBetween(ex: Executor, zoneId: string, from: Date, to: Date): Promise<number> {
  const row = await ex.selectFrom("trips").select((eb) => eb.fn.countAll<string>().as("n")).where("zone_id", "=", zoneId).where("created_at", ">=", from).where("created_at", "<", to).executeTakeFirstOrThrow();
  return Number(row.n);
}

const averageFree = (samples: readonly Sample[]) => (samples.length === 0 ? 0 : samples.reduce((sum, s) => sum + s.free, 0) / samples.length);

/** The effect of a start or a rise: the 30 minutes after against the 30 minutes before; null while not over. */
async function effectOf(ex: Executor, zoneId: string, at: Date, all: readonly Sample[], now: Date) {
  const half = 30 * MIN_MS;
  const after = new Date(at.getTime() + half);
  if (after > now) return null;
  const before = new Date(at.getTime() - half);
  const inRange = (from: Date, to: Date) => all.filter((s) => s.at >= from && s.at < to);
  const ridesBefore = await tripsBetween(ex, zoneId, before, at);
  const ridesAfter = await tripsBetween(ex, zoneId, at, after);
  return {
    drivers: Math.round(averageFree(inRange(at, after)) - averageFree(inRange(before, at))),
    ridesPct: Math.round((100 * (ridesAfter - ridesBefore)) / Math.max(1, ridesBefore)),
    leftPct: (await priceCheck(ex, zoneId, at, after)).leftPct,
  };
}

type TimelineKind = "manual_start" | "manual_stop" | "scheduled_start" | "scheduled_end" | "smart_change" | "smart_end";

/** The surge timeline of the zone, newest first: every change of multiplier or source in the samples. */
async function timelineOf(ex: Executor, zoneId: string, from: Date, now: Date) {
  // The samples from 30 minutes before the window, so a change at its start has its "before".
  const all = await samplesOf(ex, zoneId, new Date(from.getTime() - 30 * MIN_MS), now);
  const schedules = await ex.selectFrom("surge_schedules").select(["start_at", "ended_at", "end_at", "created_by"]).where("zone_id", "=", zoneId).where("created_at", ">=", new Date(from.getTime() - 24 * 60 * MIN_MS)).execute();
  const manualBy = (at: Date) => schedules.find((s) => s.start_at.getTime() <= at.getTime() + MIN_MS && at.getTime() <= (s.ended_at ?? s.end_at).getTime() + MIN_MS)?.created_by;
  const items: Array<{ at: string; kind: TimelineKind; multiplier: number; previous?: number; by?: string; effect?: { drivers: number; ridesPct: number; leftPct: number } }> = [];
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1]!;
    const cur = all[i]!;
    if (cur.at < from || (prev.multiplier === cur.multiplier && prev.source === cur.source)) continue;
    let kind: TimelineKind;
    if (cur.source === "manual" && prev.source !== "manual") kind = "manual_start";
    else if (prev.source === "manual" && cur.source !== "manual") kind = "manual_stop";
    else if (cur.source === "scheduled" && prev.source !== "scheduled") kind = "scheduled_start";
    else if (prev.source === "scheduled" && cur.source !== "scheduled") kind = "scheduled_end";
    else if (cur.source === "smart") kind = "smart_change";
    else if (prev.source === "smart") kind = "smart_end";
    else if (cur.source === "manual") kind = "manual_start";
    else continue;
    const by = kind === "manual_start" || kind === "manual_stop" ? manualBy(cur.at) : kind.startsWith("smart") ? "smart" : "scheduled";
    const rise = cur.multiplier > prev.multiplier;
    const effect = rise ? await effectOf(ex, zoneId, cur.at, all, now) : null;
    items.push({ at: cur.at.toISOString(), kind, multiplier: cur.multiplier, ...(prev.multiplier !== cur.multiplier ? { previous: prev.multiplier } : {}), ...(by ? { by } : {}), ...(effect ? { effect } : {}) });
  }
  return items.reverse().slice(0, 50);
}

/** GET /admin/zones/{zoneId}/surge/history: the demand chart, the rider price check and the surge timeline. */
export async function surgeHistory(ex: Executor, zoneId: string, hours: number, bucketMin: number, now: Date) {
  const from = new Date(now.getTime() - hours * 60 * MIN_MS);
  const samples = await samplesOf(ex, zoneId, from, now);
  const buckets = new Map<number, Sample[]>();
  for (const sample of samples) {
    const key = Math.floor(sample.at.getTime() / (bucketMin * MIN_MS)) * bucketMin * MIN_MS;
    buckets.set(key, [...(buckets.get(key) ?? []), sample]);
  }
  const points = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([at, list]) => ({
      at: new Date(at).toISOString(),
      requests: list.reduce((sum, s) => sum + s.requests, 0),
      freeDrivers: Math.round(averageFree(list)),
      ratio: round1(list.reduce((sum, s) => sum + s.ratio, 0) / list.length),
      multiplier: Math.max(...list.map((s) => s.multiplier)),
    }));
  return {
    zoneId,
    from: from.toISOString(),
    to: now.toISOString(),
    bucketMin,
    points,
    priceCheck: await priceCheck(ex, zoneId, new Date(now.getTime() - 60 * MIN_MS), new Date(now.getTime() + 1)),
    timeline: await timelineOf(ex, zoneId, from, now),
  };
}

/** contract.json#driverSurgeMap.levels: null = no colour. */
export function surgeLevel(multiplier: number): "low" | "medium" | "high" | null {
  if (multiplier <= 1) return null;
  if (multiplier < 1.5) return "low";
  if (multiplier <= 2.5) return "medium";
  return "high";
}

/** The driver's country: their own, else that of their zones, else that of the zone their latest fix is in. */
async function driverCountry(ex: Executor, driverId: string): Promise<string | null> {
  const driver = await ex.selectFrom("drivers").select(["country", "zone_ids"]).where("driver_id", "=", driverId).executeTakeFirst();
  if (driver?.country) return driver.country;
  const zoneId = driver?.zone_ids?.[0] ?? (await ex.selectFrom("driver_locations").select("zone_id").where("driver_id", "=", driverId).executeTakeFirst())?.zone_id;
  if (!zoneId) return null;
  return (await ex.selectFrom("zones").select("country").where("zone_id", "=", zoneId).executeTakeFirst())?.country ?? null;
}

/** GET /driver/surge-map: the zones of the driver's country with a surge now, as a level and a rectangle. */
export async function driverSurgeMap(ex: Executor, driverId: string, now: Date) {
  const country = await driverCountry(ex, driverId);
  const zones = country
    ? await ex.selectFrom("zones").select(["zone_id", "south", "west", "north", "east"]).where("country", "=", country).where("open", "=", true).where("kind", "=", "operating").orderBy("zone_id").execute()
    : [];
  const out = [];
  for (const zone of zones) {
    const level = surgeLevel((await surgeNowOf(ex, zone.zone_id, now)).multiplier);
    if (level) out.push({ zoneId: zone.zone_id, level, bounds: { south: zone.south, west: zone.west, north: zone.north, east: zone.east } });
  }
  return { at: now.toISOString(), zones: out };
}
