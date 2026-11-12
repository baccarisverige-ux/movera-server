import { sql } from "kysely";
import { NOT_HELD } from "../reservations/view.js";
import { audit } from "../admin/audit.js";
import { liveDocument } from "../config/service.js";
import { geometry } from "../config/geometryCache.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { scheduleTimer, type TimerHandler } from "../jobs/timers.js";
import { markSetOffline } from "./offlineReason.js";
import { DRIVER_ASSIGNED } from "../rules/transitions.js";
import { inPolygon, type Polygon } from "../zones/geometry.js";

/**
 * Contract v0.18.4 §29 (contract.json#driverHome, owner decisions of driver group 3):
 * - G3-R1: an online driver (not on a trip) with no position for DriverAppConfig.offers.autoOffline.noFixMinutes
 *   (default 5) is set offline by a job every 30 s, told so (bell + push) and the admin audit gets a line.
 * - G3-R2: whether the driver's latest position is inside one of his own zones (no trips outside them).
 */

type Texts = Record<string, Record<string, string>>;
type Home = {
  setOffline: { jobEverySeconds: number; noticeKind: string; deepLink: string; auditAction: string; text: Texts };
  locationRequired: { reason: string; freshSeconds: number };
};
export const DRIVER_HOME = (contract as unknown as { driverHome: Home }).driverHome;
const DEFAULT_NO_FIX_MINUTES = (contract as unknown as { configDefaults: { noFixMinutesBeforeOffline: number } }).configDefaults.noFixMinutesBeforeOffline;

export const NO_FIX_OFFLINE = "no_fix_offline";
const lang = (language: string | null | undefined) => (language === "sv" || language === "fr" ? language : "en");

/** The zone's noFixMinutes (0 = never); the contract default when the document has none or a bad value. */
export async function noFixMinutes(ex: Executor, zoneId: string): Promise<number> {
  const doc = await liveDocument<{ offers?: { autoOffline?: { noFixMinutes?: unknown; on?: unknown } } }>(ex, "driver_app_config", zoneId);
  // v0.18.14 (g1-g3 M8): autoOffline.on false switches the no-position rule off too.
  if (doc?.document.offers?.autoOffline?.on === false) return 0;
  const value = doc?.document.offers?.autoOffline?.noFixMinutes;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_NO_FIX_MINUTES;
}

/** Books the first run (every instance calls this at start; one row wins). */
export async function ensureNoFixTimer(ex: Executor, now: Date): Promise<void> {
  await ex
    .insertInto("timers")
    .values({ kind: NO_FIX_OFFLINE, ref_id: "all", due_at: new Date(now.getTime() + DRIVER_HOME.setOffline.jobEverySeconds * 1000) })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
}

/**
 * S4 B1.23 (contract v0.18.70, owner Q83 "no mass offline after an outage"): a driver is not blamed for minutes no
 * server copy could hear him. One signal only, which phones cannot fake: a no-position run that comes more than
 * lateSeconds after its due time while no fix from any driver was stored since that due time (all copies or the
 * database were down). That run's time becomes `heardAgainAt`, kept in the job's one shared timer row (the same for every
 * server copy) and never moved back; each driver's silence counts from no earlier than it, so every silent driver is
 * offline by heardAgainAt + noFixMinutes (+ one run). A network cut with the server up is not covered (noFixMinutes as
 * before). The booked-ride offline check waits for the same grace (heardAgainAt below), never past the ride's dispatchAt.
 */
export const OUTAGE = { lateSeconds: 60 } as const;

const heardAgainOf = (payload: unknown): Date | null => {
  const at = (payload as { heardAgainAt?: unknown } | null)?.heardAgainAt;
  return typeof at === "string" && Number.isFinite(Date.parse(at)) ? new Date(at) : null;
};

/** The run at `now` of a timer due at `dueAt` ends an outage: more than lateSeconds late and no fix stored since dueAt. */
async function outageEnds(ex: Executor, now: Date, dueAt: Date): Promise<boolean> {
  if (now.getTime() - dueAt.getTime() <= OUTAGE.lateSeconds * 1000) return false;
  const stored = await ex.selectFrom("driver_locations").select("driver_id").where("received_at", ">=", dueAt).limit(1).executeTakeFirst();
  return stored === undefined;
}

/** The later of the kept heardAgainAt and this run's (when it ends an outage). */
async function nextHeardAgain(ex: Executor, now: Date, dueAt: Date, kept: Date | null): Promise<Date | null> {
  if (!(await outageEnds(ex, now, dueAt))) return kept;
  return kept !== null && kept > now ? kept : now;
}

/**
 * When the server could hear the drivers again after its last outage (null: none known), from the job's shared row.
 * A row overdue now with no fix stored since its due time means an outage is ending right now (the job has not caught
 * up yet). A parked row (due 'infinity', which pg returns as a number) gives no signal.
 */
export async function heardAgainAt(ex: Executor, now: Date): Promise<Date | null> {
  const row = await ex.selectFrom("timers").select(["due_at", "payload"]).where("kind", "=", NO_FIX_OFFLINE).where("ref_id", "=", "all").executeTakeFirst();
  if (row === undefined) return null;
  const due = row.due_at as unknown;
  if (!(due instanceof Date) || !Number.isFinite(due.getTime())) return null;
  return nextHeardAgain(ex, now, due, heardAgainOf(row.payload));
}

/** Per server copy: when this copy last checked a stored fix against the outage signal (empty at start). */
let lastFixCheckAt: number | null = null;
const FIX_CHECK_EVERY_MS = 10_000;

/**
 * Called before a fix is stored (POST /driver/location, going online with a location). The first fix stored after an
 * outage also marks it: when the no-position row is more than lateSeconds overdue and no fix was stored since its due
 * time, heardAgainAt = now (only later, never back), so the worker's first run after the outage still sees it even if
 * phones reach a copy before the worker runs. One statement, at most once per 10 s per copy; the time is set only after
 * a check that succeeded (a check that fails while the database is down never hides the first one after it).
 */
export async function noteFixAfterOutage(trx: Trx, now: Date): Promise<void> {
  const t = now.getTime();
  if (lastFixCheckAt !== null && t - lastFixCheckAt >= 0 && t - lastFixCheckAt < FIX_CHECK_EVERY_MS) return;
  const late = new Date(t - OUTAGE.lateSeconds * 1000);
  await sql`
    UPDATE timers SET payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{heardAgainAt}', to_jsonb(${now.toISOString()}::text))
     WHERE kind = ${NO_FIX_OFFLINE} AND ref_id = 'all' AND due_at < ${late} AND due_at > '-infinity'::timestamptz
       AND NOT EXISTS (SELECT 1 FROM driver_locations WHERE received_at >= timers.due_at)
       AND (payload->>'heardAgainAt' IS NULL OR (payload->>'heardAgainAt')::timestamptz < ${now})`.execute(trx);
  lastFixCheckAt = t;
}

/** The grace after an outage for this driver: noFixMinutes of the zone the no-position rule uses (his latest fix's zone, else his first home zone, else `fallbackZone`), the contract default when the rule is off there. */
export async function outageGraceMinutes(ex: Executor, driverId: string, fallbackZone: string | null): Promise<number> {
  const d = await ex.selectFrom("drivers").leftJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id").select(["drivers.zone_ids", "driver_locations.zone_id as fixZone"]).where("drivers.driver_id", "=", driverId).executeTakeFirst();
  const zoneId = d?.fixZone ?? d?.zone_ids[0] ?? fallbackZone;
  const minutes = zoneId ? await noFixMinutes(ex, zoneId) : DEFAULT_NO_FIX_MINUTES;
  return minutes > 0 ? minutes : DEFAULT_NO_FIX_MINUTES;
}

/** Every jobEverySeconds: set offline each online driver whose latest position is too old, then book the next run. */
export const noFixOfflineHandler: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  const heardAgain = await nextHeardAgain(trx, now, timer.dueAt, heardAgainOf(timer.payload));
  await setOfflineWithoutPosition(trx, now, heardAgain);
  await trx
    .insertInto("timers")
    .values({ kind: NO_FIX_OFFLINE, ref_id: "all", due_at: new Date(now.getTime() + DRIVER_HOME.setOffline.jobEverySeconds * 1000), payload: JSON.stringify(heardAgain ? { heardAgainAt: heardAgain.toISOString() } : {}) })
    .onConflict((conflict) => conflict.columns(["kind", "ref_id"]).doNothing())
    .execute();
};

/** `heardAgain` (B1.23): the silence of each driver counts from no earlier than this moment. */
export async function setOfflineWithoutPosition(trx: Trx, now: Date, heardAgain: Date | null = null): Promise<string[]> {
  // The shortest window any zone could have is the cheapest prefilter: nobody fresher than 1 minute is looked at.
  const rows = await trx
    .selectFrom("drivers")
    .leftJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .select(["drivers.driver_id", "drivers.zone_ids", "drivers.online_since", "drivers.language", "driver_locations.received_at", "driver_locations.zone_id as fixZone"])
    .where("drivers.online_status", "=", "online")
    .where((eb) => eb.or([eb("driver_locations.received_at", "is", null), eb("driver_locations.received_at", "<", new Date(now.getTime() - 60_000))]))
    .orderBy("drivers.driver_id")
    .execute();
  const done: string[] = [];
  for (const r of rows) {
    // v0.18.14 (g1-g3 M9): the zone he is in now (his latest position's) decides, else his first home zone.
    const zoneId = r.fixZone ?? r.zone_ids[0] ?? null;
    const minutes = zoneId ? await noFixMinutes(trx, zoneId) : DEFAULT_NO_FIX_MINUTES;
    if (minutes === 0) continue;
    const own = r.received_at ?? r.online_since;
    const last = heardAgain !== null && (own === null || own < heardAgain) ? heardAgain : own;
    if (last !== null && now.getTime() - last.getTime() < minutes * 60_000) continue;
    // Lock the driver; one busy with a command is looked at again on the next run.
    const locked = await trx.selectFrom("drivers").select(["online_status", "version"]).where("driver_id", "=", r.driver_id).forUpdate().skipLocked().executeTakeFirst();
    if (locked === undefined || locked.online_status !== "online") continue;
    const onTrip = await trx.selectFrom("trips").select("trip_id").where("driver_id", "=", r.driver_id).where("status", "in", [...DRIVER_ASSIGNED]).where(NOT_HELD).executeTakeFirst();
    if (onTrip) continue;
    await trx.updateTable("drivers").set({ online_status: "offline", online_since: null, version: locked.version + 1, updated_at: now }).where("driver_id", "=", r.driver_id).execute();
    // As going offline by hand: the open offers are withdrawn by a job that locks each trip in turn.
    await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: r.driver_id, dueAt: now, payload: {} });
    // v0.18.6 (owner "Send the real reason"): Driver.offlineReason no_position + the set_offline notice.
    await markSetOffline(trx, r.driver_id, "no_position", { minutes }, now);
    await audit(trx, { adminId: null, action: DRIVER_HOME.setOffline.auditAction, targetType: "driver", targetId: r.driver_id, zoneId, detail: { reason: "no_position", lastFixAt: r.received_at?.toISOString() ?? null, minutes }, at: now });
    done.push(r.driver_id);
  }
  return done;
}

/* ---------------------------------------------------------------- G3-R2: inside his own zones */

type ZoneShape = { zone_id: string; south: number; west: number; north: number; east: number; polygon: unknown };

function inside(point: { lat: number; lng: number }, z: ZoneShape): boolean {
  if (point.lat < z.south || point.lat > z.north || point.lng < z.west || point.lng > z.east) return false;
  return inPolygon(point.lat, point.lng, z.polygon as Polygon);
}

/** Is the point inside any of these zones (bounds first, the outline decides)? */
export async function insideZones(ex: Executor, point: { lat: number; lng: number }, zoneIds: string[]): Promise<boolean> {
  if (zoneIds.length === 0) return false;
  const cached = await geometry(ex);
  if (cached !== null) return zoneIds.some((id) => { const z = cached.byId.get(id); return z !== undefined && inside(point, z); });
  const zones = await ex.selectFrom("zones").select(["zone_id", "south", "west", "north", "east", "polygon"]).where("zone_id", "in", zoneIds).execute();
  return zones.some((z) => inside(point, z));
}

/** A checker over many drivers at once (dispatch): the zones are read once. */
export async function zoneChecker(ex: Executor, zoneIds: string[]): Promise<(point: { lat: number; lng: number }, own: string[]) => boolean> {
  const zones = zoneIds.length ? await ex.selectFrom("zones").select(["zone_id", "south", "west", "north", "east", "polygon"]).where("zone_id", "in", zoneIds).execute() : [];
  return (point, own) => zones.some((z) => own.includes(z.zone_id) && inside(point, z));
}

/** Driver.outsideArea / areaZones (driver view, location ack): missing while the server has no position. */
export async function areaView(ex: Executor, driver: { driver_id: string; zone_ids: string[]; language?: string | null }, stored?: { lat: number; lng: number }): Promise<Record<string, unknown>> {
  // `stored`: the caller already knows the stored position (POST /driver/location just wrote it), so it is not read again.
  const fix = stored ?? (await ex.selectFrom("driver_locations").select(["lat", "lng"]).where("driver_id", "=", driver.driver_id).executeTakeFirst());
  if (fix === undefined) return {};
  if (await insideZones(ex, fix, driver.zone_ids)) return { outsideArea: false };
  const language = lang(driver.language);
  const cached = await geometry(ex);
  const zones = !driver.zone_ids.length ? [] : cached !== null ? driver.zone_ids.flatMap((id) => cached.byId.get(id) ?? []) : await ex.selectFrom("zones").select(["zone_id", "name", "names"]).where("zone_id", "in", driver.zone_ids).execute();
  const named = driver.zone_ids.flatMap((id) => {
    const z = zones.find((x) => x.zone_id === id);
    if (!z) return [];
    const names = (z.names ?? {}) as Record<string, string>;
    return [{ zoneId: id, name: names[language] ?? z.name }];
  });
  return { outsideArea: true, areaZones: named };
}

/** Decision 2 / G3-R5: a position measured and received within freshSeconds. */
export async function hasFreshPosition(ex: Executor, driverId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - DRIVER_HOME.locationRequired.freshSeconds * 1000);
  const row = await ex
    .selectFrom("driver_locations")
    .select("driver_id")
    .where("driver_id", "=", driverId)
    .where("received_at", ">=", since)
    .where("measured_at", ">=", since)
    .executeTakeFirst();
  return row !== undefined;
}

/* ---------------------------------------------------------------- v0.18.37 §61: go offline after trips */

/**
 * Contract v0.18.37 §61 (contract.json#goOfflineAfterTrips, owner 2026-11-05 "go offline mean after all trips finish"):
 * Go offline during a trip schedules offline; the state lives in drivers.offline_after_trip (rule 33, several copies).
 */
type AfterTripRow = { driver_id: string; online_status: string; version: number; offline_after_trip?: boolean; offline_after_trip_at?: Date | null };

/** Driver.offlineAfterTrip / offlineAfterTripSince (driver and admin views). */
export function offlineAfterTripView(row: AfterTripRow): Record<string, unknown> {
  const on = row.offline_after_trip === true;
  return { offlineAfterTrip: on, ...(on && row.offline_after_trip_at ? { offlineAfterTripSince: row.offline_after_trip_at.toISOString() } : {}) };
}

/**
 * POST /driver/availability while on a trip (the caller holds the driver row lock): offline schedules it, online undoes
 * it; a repeat changes nothing. Returns true when handled here (the caller answers the Driver view).
 */
export async function availabilityOnTrip(trx: Trx, row: AfterTripRow, wanted: "online" | "offline", now: Date): Promise<boolean> {
  if (row.online_status !== "on_trip") return false;
  const flag = wanted === "offline";
  if ((row.offline_after_trip === true) === flag) return true;
  await trx.updateTable("drivers").set({ offline_after_trip: flag, offline_after_trip_at: flag ? now : null, version: row.version + 1, updated_at: now }).where("driver_id", "=", row.driver_id).execute();
  // From the tap no new offers: his open ones go at once (a job locks each trip in turn, as going offline does).
  if (flag) await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: row.driver_id, dueAt: now, payload: {} });
  return true;
}

/**
 * Called at the end of releaseDriver, in the trip-release transaction (rule 33: the driver row is locked FOR UPDATE).
 * Still on a trip (a queued live trip or a due held booked ride just started): he goes after that one, flag kept.
 * Free (online): offline now, reason after_trip. Already offline (a block won): only the flag is cleared.
 */
export async function settleOfflineAfterTrip(trx: Trx, driverId: string, now: Date): Promise<void> {
  const d = await trx.selectFrom("drivers").select(["online_status", "version", "offline_after_trip"]).where("driver_id", "=", driverId).forUpdate().executeTakeFirst();
  if (d === undefined || !d.offline_after_trip || d.online_status === "on_trip") return;
  const off = d.online_status === "online" || d.online_status === "going_online";
  await trx.updateTable("drivers")
    .set({ offline_after_trip: false, offline_after_trip_at: null, ...(off ? { online_status: "offline" as const, online_since: null } : {}), version: d.version + 1, updated_at: now })
    .where("driver_id", "=", driverId).execute();
  if (!off) return;
  await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: driverId, dueAt: now, payload: {} });
  await markSetOffline(trx, driverId, "after_trip", {}, now);
}

/* ---------------------------------------------------------------- v0.18.65 §86: stop next trips during a trip */

/**
 * POST /driver/next-trips (contract.json#nextTripsSwitch, owner phone test 2026-11-11): the trip sheet's radar. On a
 * trip, on false stops next-trip offers for this trip (his open ones go at once), on true starts them again; the same
 * state again changes nothing. Off a trip nothing changes. The driver row is locked (rule 33).
 */
export async function setNextTrips(trx: Trx, driverId: string, on: boolean, now: Date): Promise<void> {
  const d = await trx.selectFrom("drivers").select(["online_status", "version", "next_trips_off"]).where("driver_id", "=", driverId).forUpdate().executeTakeFirst();
  if (d === undefined || d.online_status !== "on_trip" || d.next_trips_off === !on) return;
  await trx.updateTable("drivers").set({ next_trips_off: !on, version: d.version + 1, updated_at: now }).where("driver_id", "=", driverId).execute();
  if (!on) await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: driverId, dueAt: now, payload: {} });
}

/** Each trip starts with next trips on: called when a trip of his ends (releaseDriver, the driver row is his). */
export async function clearNextTripsOff(trx: Trx, driverId: string, now: Date): Promise<void> {
  await trx.updateTable("drivers").set({ next_trips_off: false, version: sql`version + 1`, updated_at: now }).where("driver_id", "=", driverId).where("next_trips_off", "=", true).execute();
}
