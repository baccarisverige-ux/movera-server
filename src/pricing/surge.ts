import type { Executor, Trx } from "../db/db.js";
import { liveDocument } from "../config/service.js";
import { surgeAt, type SurgeSchedule } from "../rules/surge.js";
import type { PricingDocument } from "../rules/fare.js";

/**
 * Where a quote's surge comes from (contract v0.7.1, contract.json#pricing.surgeSource): the zone's surge schedule
 * (the admin's manual Start / Stop, §3.4), else the highest planned window in force (overlaps: the higher counts),
 * else smart surge when it is on (contract.json#smartSurge); else 1.0. priceFare keeps it within the admin's maximum.
 */

export type ScheduledWindow = { id: string; name?: string; multiplier: number; startsAt: string; endsAt: string };
export type SurgeProfile = { id: string; name: string; isDefault: boolean; days: number[]; windows: { from: string; to: string }[]; steps: { ratio: number; multiplier: number }[]; cap: number };
export type SmartSettings = {
  enabled: boolean;
  activeFrom?: string;
  activeTo?: string;
  checkEveryMin?: number;
  holdMin?: number;
  stopAfterMin?: number;
  cooldownMin?: number;
  profiles: SurgeProfile[];
};
export type DocSurge = { maxMultiplier?: number; smart?: SmartSettings; scheduled?: ScheduledWindow[]; notifyDrivers?: boolean };

export type SurgeNow = { multiplier: number; until?: string; source: "manual" | "scheduled" | "smart" | "off"; scheduleId?: string };

/** v0.7.1: the planned windows in force at `at`; when they overlap the higher multiplier counts. */
export function scheduledSurgeAt(scheduled: readonly ScheduledWindow[] | undefined, at: Date): { multiplier: number; until?: string } {
  const now = at.getTime();
  let best: ScheduledWindow | undefined;
  for (const window of scheduled ?? []) {
    const start = Date.parse(window.startsAt);
    const end = Date.parse(window.endsAt);
    if (!(Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end)) continue;
    if (best === undefined || window.multiplier > best.multiplier) best = window;
  }
  return best ? { multiplier: best.multiplier, until: best.endsAt } : { multiplier: 1 };
}

/** Planned windows that overlap another one (the admin is warned when saving). */
export function overlappingWindows(scheduled: readonly ScheduledWindow[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  scheduled.forEach((a, i) => {
    for (const b of scheduled.slice(i + 1)) {
      if (Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt)) out.push([a.id, b.id]);
    }
  });
  return out;
}

type ScheduleRow = { schedule_id: string; zone_id: string; category_ids: string[]; start_at: Date; end_at: Date; step_minutes: number; cap: string; points: unknown; status: string; version: number; created_by: string; created_at: Date };

export function scheduleView(row: ScheduleRow, now: Date) {
  const status = row.status === "cancelled" || row.status === "ended" ? row.status : now < row.start_at ? "scheduled" : now < row.end_at ? "active" : "ended";
  return {
    scheduleId: row.schedule_id,
    zoneId: row.zone_id,
    categoryIds: row.category_ids,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    stepMinutes: row.step_minutes,
    cap: Number(row.cap),
    points: row.points as SurgeSchedule["points"],
    status,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

/** The zone's newest schedule that is not stopped, or undefined. */
export async function currentSchedule(ex: Executor, zoneId: string): Promise<ScheduleRow | undefined> {
  return (await ex.selectFrom("surge_schedules").selectAll().where("zone_id", "=", zoneId).orderBy("created_at", "desc").orderBy("version", "desc").orderBy("schedule_id", "desc").limit(1).executeTakeFirst()) as ScheduleRow | undefined;
}

function manualAt(row: ScheduleRow | undefined, categoryId: string | undefined, at: Date): { multiplier: number; until: string; scheduleId: string } | null {
  if (row === undefined || row.status === "cancelled" || row.status === "ended") return null;
  if (categoryId !== undefined && row.category_ids.length > 0 && !row.category_ids.includes(categoryId)) return null;
  const value = surgeAt({ startAt: row.start_at.toISOString(), endAt: row.end_at.toISOString(), stepMinutes: row.step_minutes, cap: Number(row.cap), points: row.points as SurgeSchedule["points"] }, at);
  return value === null ? null : { multiplier: value, until: row.end_at.toISOString(), scheduleId: row.schedule_id };
}

/** The surge for one category of a zone now (before priceFare's clamp to the admin's maximum). */
export async function surgeFor(ex: Executor, zoneId: string, surge: DocSurge | undefined, categoryId: string | undefined, at: Date): Promise<SurgeNow> {
  const manual = manualAt(await currentSchedule(ex, zoneId), categoryId, at);
  if (manual) return { multiplier: manual.multiplier, until: manual.until, source: "manual", scheduleId: manual.scheduleId };
  const planned = scheduledSurgeAt(surge?.scheduled, at);
  if (planned.multiplier > 1) return { multiplier: planned.multiplier, ...(planned.until ? { until: planned.until } : {}), source: "scheduled" };
  if (surge?.smart?.enabled) {
    const state = await ex.selectFrom("smart_surge_state").select("multiplier").where("zone_id", "=", zoneId).executeTakeFirst();
    const value = state ? Number(state.multiplier) : 1;
    if (value > 1) return { multiplier: value, source: "smart" };
  }
  return { multiplier: 1, source: "off" };
}

// ---- smart surge (contract.json#smartSurge, fixtures/smart_surge.json)

const hm = (text: string) => {
  const [h, m] = text.split(":");
  return Number(h) * 60 + Number(m);
};

/** Zone-local weekday (0 = Monday) and minute of the day. */
export function localTime(at: Date, timeZone: string): { weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  return { weekday, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** The first non-default profile from the top that matches, else the default one. */
export function profileAt(smart: SmartSettings, weekday: number, minute: number): SurgeProfile | undefined {
  const yesterday = (weekday + 6) % 7;
  for (const profile of smart.profiles) {
    if (profile.isDefault) continue;
    for (const window of profile.windows) {
      const from = hm(window.from);
      const to = hm(window.to);
      const hit =
        (from === to && profile.days.includes(weekday)) ||
        (from < to && profile.days.includes(weekday) && minute >= from && minute < to) ||
        (from > to && ((profile.days.includes(weekday) && minute >= from) || (profile.days.includes(yesterday) && minute < to)));
      if (hit) return profile;
    }
  }
  return smart.profiles.find((profile) => profile.isDefault);
}

export function inActiveHours(smart: SmartSettings, minute: number): boolean {
  const from = hm(smart.activeFrom ?? "00:00");
  const to = hm(smart.activeTo ?? "00:00");
  return from === to || (from < to ? minute >= from && minute < to : minute >= from || minute < to);
}

/** The slider's top (contract.json#surge.capMax): no surge goes above it. */
export const SLIDER_TOP = 6;

/** contract.json#smartSurge.freshFixSeconds: a fix older than this does not count (Dispatch's rule). */
export const FRESH_FIX_SECONDS = 120;
/** contract.json#surgeLive.samples: samples are kept 8 days. */
const SAMPLE_DAYS = 8;

export function targetFor(profile: SurgeProfile, ratio: number, maxMultiplier: number = SLIDER_TOP): number {
  let multiplier = 1;
  for (const step of profile.steps) if (ratio >= step.ratio) multiplier = step.multiplier;
  return Math.min(multiplier, profile.cap, maxMultiplier);
}

export type SmartState = { multiplier: number; upSince: number | null; lowSince: number | null; lastChange: number | null };

/**
 * One check, times in minutes: up only after the target held for holdMin, down one step at a time, at least
 * cooldownMin between changes, and back to 1.0 when the target stayed 1.0 for stopAfterMin.
 */
export function smartStep(smart: SmartSettings, profile: SurgeProfile, maxMultiplier: number, state: SmartState, atMin: number, ratio: number): SmartState {
  const target = targetFor(profile, ratio, maxMultiplier);
  const cool = state.lastChange === null || atMin - state.lastChange >= (smart.cooldownMin ?? 1);
  const lowSince = target === 1 ? (state.lowSince ?? atMin) : null;
  let { multiplier, upSince, lastChange } = state;
  if (target > multiplier) {
    upSince = upSince ?? atMin;
    if (atMin - upSince >= (smart.holdMin ?? 1) && cool) {
      multiplier = target;
      lastChange = atMin;
      upSince = null;
    }
  } else {
    upSince = null;
    if (target < multiplier) {
      if (lowSince !== null && atMin - lowSince >= (smart.stopAfterMin ?? 1)) {
        multiplier = 1;
        lastChange = atMin;
      } else if (cool) {
        const levels = [...new Set(profile.steps.map((s) => Math.min(s.multiplier, profile.cap, maxMultiplier)))].filter((l) => l < multiplier);
        multiplier = Math.max(levels.length ? Math.max(...levels) : 1, target);
        lastChange = atMin;
      }
    }
  }
  return { multiplier, upSince, lowSince, lastChange };
}

/**
 * v0.7.2 (owner 2026-10-28, contract.json#smartSurge.ratio): free drivers are online (not on a trip) with a GPS fix
 * inside the zone that reached the server less than freshFixSeconds ago — the drivers Dispatch counts as free.
 */
export async function freeDriversIn(ex: Executor, zoneId: string, now: Date): Promise<number> {
  const row = await ex
    .selectFrom("drivers")
    .innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("drivers.online_status", "=", "online")
    .where("driver_locations.zone_id", "=", zoneId)
    .where("driver_locations.received_at", ">", new Date(now.getTime() - FRESH_FIX_SECONDS * 1000))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Ride requests created in the zone in the last `minutes`. */
export async function requestsIn(ex: Executor, zoneId: string, minutes: number, now: Date): Promise<number> {
  const since = new Date(now.getTime() - minutes * 60_000);
  const row = await ex.selectFrom("trips").select((eb) => eb.fn.countAll<string>().as("n")).where("zone_id", "=", zoneId).where("created_at", ">", since).where("created_at", "<=", now).executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Ride requests in the zone in the last `minutes` ÷ free drivers in the zone now (none counts as 1). */
export async function demandRatio(ex: Executor, zoneId: string, minutes: number, now: Date): Promise<number> {
  return (await requestsIn(ex, zoneId, minutes, now)) / Math.max(1, await freeDriversIn(ex, zoneId, now));
}

const toMin = (d: Date | null) => (d === null ? null : Math.floor(d.getTime() / 60_000));
const fromMin = (m: number | null) => (m === null ? null : new Date(m * 60_000));

/**
 * The smart surge check of every zone whose live pricing has it on, at most once per checkEveryMin. v0.7.2: then one
 * SurgeSample per open zone and minute (contract.json#surgeLive.samples), smart surge on or off; no driver notice.
 */
export async function runSmartSurge(trx: Trx, now: Date): Promise<Array<{ zoneId: string; multiplier: number }>> {
  const zones = await trx.selectFrom("zones").select(["zone_id", "time_zone"]).where("open", "=", true).orderBy("zone_id").execute();
  const changed: Array<{ zoneId: string; multiplier: number }> = [];
  for (const zone of zones) {
    const live = await liveDocument<PricingDocument & { surge: DocSurge }>(trx, "pricing", zone.zone_id);
    const surge = live?.document.surge;
    const smart = surge?.smart;
    const row = await trx.selectFrom("smart_surge_state").selectAll().where("zone_id", "=", zone.zone_id).forUpdate().executeTakeFirst();
    if (!smart?.enabled) {
      if (row && Number(row.multiplier) !== 1) await trx.updateTable("smart_surge_state").set({ multiplier: 1, up_since: null, low_since: null, last_change: now, checked_at: now }).where("zone_id", "=", zone.zone_id).execute();
      await recordSample(trx, zone.zone_id, surge, smart?.checkEveryMin ?? 1, now);
      continue;
    }
    const every = smart.checkEveryMin ?? 1;
    if (row?.checked_at && now.getTime() - row.checked_at.getTime() < every * 60_000) {
      await recordSample(trx, zone.zone_id, surge, every, now);
      continue;
    }
    const local = localTime(now, zone.time_zone);
    const profile = inActiveHours(smart, local.minute) ? profileAt(smart, local.weekday, local.minute) : undefined;
    const ratio = await demandRatio(trx, zone.zone_id, every, now);
    const before: SmartState = { multiplier: row ? Number(row.multiplier) : 1, upSince: toMin(row?.up_since ?? null), lowSince: toMin(row?.low_since ?? null), lastChange: toMin(row?.last_change ?? null) };
    const atMin = Math.floor(now.getTime() / 60_000);
    const next = profile ? smartStep(smart, profile, SLIDER_TOP, before, atMin, ratio) : { multiplier: 1, upSince: null, lowSince: null, lastChange: before.multiplier !== 1 ? atMin : before.lastChange };
    const values = {
      zone_id: zone.zone_id,
      multiplier: next.multiplier,
      up_since: fromMin(next.upSince),
      low_since: fromMin(next.lowSince),
      last_change: fromMin(next.lastChange),
      checked_at: now,
      ratio: Math.round(ratio * 1000) / 1000,
      profile_id: profile?.id ?? null,
    };
    await trx.insertInto("smart_surge_state").values(values).onConflict((c) => c.column("zone_id").doUpdateSet(values)).execute();
    if (next.multiplier !== before.multiplier) changed.push({ zoneId: zone.zone_id, multiplier: next.multiplier });
    await recordSample(trx, zone.zone_id, surge, every, now);
  }
  await trx.deleteFrom("surge_samples").where("at", "<", new Date(now.getTime() - SAMPLE_DAYS * 86_400_000)).execute();
  return changed;
}

/** One SurgeSample for the zone at this minute (a second check in the same minute replaces it). */
async function recordSample(trx: Trx, zoneId: string, surge: DocSurge | undefined, windowMin: number, now: Date): Promise<void> {
  const at = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const free = await freeDriversIn(trx, zoneId, now);
  const requests = await requestsIn(trx, zoneId, 1, now);
  const ratio = Math.round(((await requestsIn(trx, zoneId, windowMin, now)) / Math.max(1, free)) * 1000) / 1000;
  const current = await surgeFor(trx, zoneId, surge, undefined, now);
  const values = { zone_id: zoneId, at, requests, free_drivers: free, ratio, multiplier: Math.min(SLIDER_TOP, current.multiplier), source: current.source };
  await trx.insertInto("surge_samples").values(values).onConflict((c) => c.columns(["zone_id", "at"]).doUpdateSet(values)).execute();
}

// ---- the smart surge check on the timer worker, every minute

export const SMART_SURGE_CHECK = "smart_surge_check";

export const smartSurgeHandler = async (trx: Trx, timer: { firedAt: Date }) => {
  const now = timer.firedAt;
  await runSmartSurge(trx, now);
  await trx
    .insertInto("timers")
    .values({ kind: SMART_SURGE_CHECK, ref_id: "all", due_at: new Date(now.getTime() + 60_000) })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
};

export const pricingHandlers = { [SMART_SURGE_CHECK]: smartSurgeHandler };

/** Books the smart surge check if it is not booked yet (every instance calls this at start; one row wins). */
export async function ensurePricingTimers(ex: Executor, now: Date = new Date()): Promise<void> {
  await ex
    .insertInto("timers")
    .values({ kind: SMART_SURGE_CHECK, ref_id: "all", due_at: now })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
}
