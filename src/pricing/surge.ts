import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import { liveDocument } from "../config/service.js";
import { notify } from "../notifications/service.js";
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
export type DocSurge = { maxMultiplier: number; smart?: SmartSettings; scheduled?: ScheduledWindow[]; notifyDrivers?: boolean };

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
  return (await ex.selectFrom("surge_schedules").selectAll().where("zone_id", "=", zoneId).orderBy("created_at", "desc").orderBy("schedule_id", "desc").limit(1).executeTakeFirst()) as ScheduleRow | undefined;
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

export function targetFor(profile: SurgeProfile, ratio: number, maxMultiplier: number): number {
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

/** Ride requests in the zone in the last `minutes` ÷ free online drivers in the zone (none counts as 1). */
export async function demandRatio(ex: Executor, zoneId: string, minutes: number, now: Date): Promise<number> {
  const since = new Date(now.getTime() - minutes * 60_000);
  const requests = await ex.selectFrom("trips").select((eb) => eb.fn.countAll<string>().as("n")).where("zone_id", "=", zoneId).where("created_at", ">", since).where("created_at", "<=", now).executeTakeFirstOrThrow();
  const free = await ex
    .selectFrom("drivers")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("online_status", "=", "online")
    .where(sql<boolean>`${zoneId} = ANY(zone_ids)`)
    .executeTakeFirstOrThrow();
  return Number(requests.n) / Math.max(1, Number(free.n));
}

const toMin = (d: Date | null) => (d === null ? null : Math.floor(d.getTime() / 60_000));
const fromMin = (m: number | null) => (m === null ? null : new Date(m * 60_000));

/**
 * The smart surge check of every zone whose live pricing has it on, at most once per checkEveryMin. A zone whose
 * smart surge rises above 1.0 tells its drivers when the admin asked for it (pricing.surge.notifyDrivers).
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
      continue;
    }
    const every = smart.checkEveryMin ?? 1;
    if (row?.checked_at && now.getTime() - row.checked_at.getTime() < every * 60_000) continue;
    const local = localTime(now, zone.time_zone);
    const profile = inActiveHours(smart, local.minute) ? profileAt(smart, local.weekday, local.minute) : undefined;
    const ratio = await demandRatio(trx, zone.zone_id, every, now);
    const before: SmartState = { multiplier: row ? Number(row.multiplier) : 1, upSince: toMin(row?.up_since ?? null), lowSince: toMin(row?.low_since ?? null), lastChange: toMin(row?.last_change ?? null) };
    const atMin = Math.floor(now.getTime() / 60_000);
    const next = profile ? smartStep(smart, profile, surge!.maxMultiplier, before, atMin, ratio) : { multiplier: 1, upSince: null, lowSince: null, lastChange: before.multiplier !== 1 ? atMin : before.lastChange };
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
    if (next.multiplier !== before.multiplier) {
      changed.push({ zoneId: zone.zone_id, multiplier: next.multiplier });
      if (before.multiplier === 1 && next.multiplier > 1 && surge?.notifyDrivers) await notifyDriversOfSurge(trx, zone.zone_id, next.multiplier, undefined, now);
    }
  }
  return changed;
}

// ---- surge notice to drivers (contract.json#surgeNotice)

const NOTICE: Record<string, { title: string; body: (m: string) => string }> = {
  sv: { title: "Högre priser nu", body: (m) => `Prishöjning ×${m} i ditt område. Fler resor väntar.` },
  fr: { title: "Prix majorés maintenant", body: (m) => `Majoration ×${m} dans votre zone. Plus de courses vous attendent.` },
  en: { title: "Higher prices now", body: (m) => `Surge ×${m} in your area. More rides are waiting.` },
};

/** In-app notice kind surge_started to every online driver of the zone; returns how many were told. */
export async function notifyDriversOfSurge(trx: Trx, zoneId: string, multiplier: number, until: string | undefined, now: Date): Promise<number> {
  const drivers = await trx
    .selectFrom("drivers")
    .select(["driver_id", "language"])
    .where("online_status", "in", ["online", "on_trip"])
    .where(sql<boolean>`${zoneId} = ANY(zone_ids)`)
    .orderBy("driver_id")
    .execute();
  const shown = multiplier.toFixed(1);
  for (const driver of drivers) {
    const words = NOTICE[driver.language ?? "sv"] ?? NOTICE["sv"]!;
    await notify(trx, { audience: "driver", subjectId: driver.driver_id, kind: "surge_started", title: words.title, body: words.body(shown), data: { zoneId, multiplier, ...(until ? { until } : {}) } }, now);
  }
  return drivers.length;
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
