import { sql } from "kysely";
import type { Executor, Trx } from "../db/db.js";
import type { TripRow } from "../db/tripLog.js";
import { audit } from "../admin/audit.js";
import type { Principal } from "../auth/guard.js";
import { CONFIG_CHANNEL } from "../config/service.js";
import { contract } from "../contract/contract.js";
import { schemaProblem } from "../contract/schemas.js";
import { DISPATCH_FIX_MAX_AGE_SECONDS, STALE_AFTER_SECONDS } from "../drivers/service.js";
import { ApiError, badRequest, notFound } from "../http/errors.js";
import { newId } from "../ids.js";
import { cancelTimer, scheduleTimer, type TimerHandler } from "../jobs/timers.js";
import { applyCommand } from "../trips/commands.js";
import { DRIVER_ASSIGNED, TERMINAL } from "../rules/transitions.js";
import { inPolygon, polygonProblem, type Polygon } from "../zones/geometry.js";
import { dispatchKm } from "./engine.js";
import { lockTripNow, sendAdminOffers } from "./runtime.js";
import { RADAR_ZONE_REPEAT, sendView, type SendRow } from "./radarSends.js";

/**
 * Contract v0.18.6 §32 (owner decisions G4-F1..F6 of 2026-10-31, contract.json#dispatchTools): the admin's Dispatch
 * tools per country (SE, FR): saved presets (F2), driver groups (F3), radar zones and their rules with a repeating send
 * (F4) and events shown on the driver map (F6). F1: none of them waits for a second admin (one-admin rule).
 */

type Tools = { groups: { maxDrivers: number; sendMax: number }; events: { upcomingDays: number; signalDoc: string } };
const TOOLS = (contract as unknown as { dispatchTools: Tools }).dispatchTools;
export const GROUP_MAX_DRIVERS = TOOLS.groups.maxDrivers;
export const SEND_MAX = TOOLS.groups.sendMax;

type Lang = "sv" | "fr" | "en";
const COUNTRY_LANGUAGE: Record<string, Lang> = { SE: "sv", FR: "fr" };

/* ---------------------------------------------------------------- scope, names, versions */

/** An admin acts on a country's items with a zone of that country in scope (a Super admin: all). */
export async function checkCountry(ex: Executor, who: Principal, country: string): Promise<void> {
  if (who.zones.includes("*")) return;
  const zone = who.zones.length ? await ex.selectFrom("zones").select("zone_id").where("country", "=", country).where("zone_id", "in", who.zones).executeTakeFirst() : undefined;
  if (zone === undefined) throw new ApiError("forbidden", "This country is outside your zones.", { reason: "zone_out_of_scope" });
}

/** The countries an admin may list (every country with a zone in his scope). */
export async function countriesOf(ex: Executor, who: Principal, asked?: string): Promise<string[]> {
  if (asked !== undefined) {
    await checkCountry(ex, who, asked);
    return [asked];
  }
  let q = ex.selectFrom("zones").select("country").distinct();
  if (!who.zones.includes("*")) q = q.where("zone_id", "in", who.zones.length ? who.zones : ["-"]);
  return (await q.execute()).map((r) => r.country);
}

const nameTaken = () => new ApiError("conflict", "That name is already used in this country.", { reason: "name_taken" });
/** A unique-name violation of the (country, lower(name)) index becomes 409 name_taken. */
async function uniqueName<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw nameTaken();
    throw error;
  }
}
function checkVersion(row: { version: number }, expected: number, view: unknown): void {
  if (row.version !== expected) throw new ApiError("version_mismatch", "It changed since you last saw it.", { projection: view });
}
const stamps = (r: { version: number; created_by: string | null; created_at: Date; updated_by: string | null; updated_at: Date }) => ({
  version: r.version,
  ...(r.created_by ? { createdBy: r.created_by } : {}),
  createdAt: r.created_at.toISOString(),
  ...(r.updated_by ? { updatedBy: r.updated_by } : {}),
  updatedAt: r.updated_at.toISOString(),
});
const write = (who: Principal, action: string, targetId: string, detail: unknown, now: Date) => (ex: Executor) => audit(ex, { adminId: who.subjectId, action, targetType: "dispatch", targetId, zoneId: null, detail, at: now });

/* ---------------------------------------------------------------- F2 presets */

type PresetRow = { preset_id: string; country: string; name: string; values: unknown; version: number; created_by: string | null; created_at: Date; updated_by: string | null; updated_at: Date };
export const presetView = (r: PresetRow) => ({ presetId: r.preset_id, country: r.country, name: r.name, values: r.values, ...stamps(r) });
const PRESET_HEAD = ["version", "publishedAt", "zoneId", "country", "timeZone", "usesStandard"];

function checkPresetValues(country: string, values: Record<string, unknown>): Record<string, unknown> {
  const clean = Object.fromEntries(Object.entries(values).filter(([k]) => !PRESET_HEAD.includes(k)));
  const problem = schemaProblem("DispatchDocument", { ...clean, version: 1, publishedAt: "2026-01-01T00:00:00Z", zoneId: `standard-${country}`, country, timeZone: "Europe/Stockholm" });
  if (problem !== null) throw badRequest(`The preset is not a valid dispatch setting: ${problem}.`, "invalid_document");
  return clean;
}

export async function listPresets(ex: Executor, who: Principal, country?: string) {
  const countries = await countriesOf(ex, who, country);
  const rows = countries.length ? await ex.selectFrom("dispatch_presets").selectAll().where("country", "in", countries).orderBy("country").orderBy("name").execute() : [];
  return { items: (rows as PresetRow[]).map(presetView) };
}
export async function createPreset(trx: Trx, who: Principal, body: { country: string; name: string; values: Record<string, unknown> }, now: Date) {
  await checkCountry(trx, who, body.country);
  const values = checkPresetValues(body.country, body.values);
  const row = { preset_id: newId("dpr", now.getTime()), country: body.country, name: body.name.trim(), values: JSON.stringify(values), version: 1, created_by: who.subjectId, created_at: now, updated_by: who.subjectId, updated_at: now };
  await uniqueName(() => trx.insertInto("dispatch_presets").values(row).execute());
  await write(who, "dispatch.preset.create", row.preset_id, { country: row.country, name: row.name }, now)(trx);
  return presetView({ ...row, values });
}
async function lockPreset(trx: Trx, who: Principal, presetId: string): Promise<PresetRow> {
  const row = (await trx.selectFrom("dispatch_presets").selectAll().where("preset_id", "=", presetId).forUpdate().executeTakeFirst()) as PresetRow | undefined;
  if (row === undefined) throw notFound("No such preset.", "preset_not_found");
  await checkCountry(trx, who, row.country);
  return row;
}
export async function updatePreset(trx: Trx, who: Principal, presetId: string, body: { expectedVersion: number; name?: string; values?: Record<string, unknown> }, now: Date) {
  const row = await lockPreset(trx, who, presetId);
  checkVersion(row, body.expectedVersion, presetView(row));
  const values = body.values ? checkPresetValues(row.country, body.values) : row.values;
  const next = { name: body.name?.trim() ?? row.name, values: JSON.stringify(values), version: row.version + 1, updated_by: who.subjectId, updated_at: now };
  await uniqueName(() => trx.updateTable("dispatch_presets").set(next).where("preset_id", "=", presetId).execute());
  await write(who, "dispatch.preset.update", presetId, { country: row.country, name: next.name, valuesChanged: body.values !== undefined }, now)(trx);
  return presetView({ ...row, ...next, values });
}
export async function deletePreset(trx: Trx, who: Principal, presetId: string, expectedVersion: number, now: Date) {
  const row = await lockPreset(trx, who, presetId);
  checkVersion(row, expectedVersion, presetView(row));
  await trx.deleteFrom("dispatch_presets").where("preset_id", "=", presetId).execute();
  await write(who, "dispatch.preset.delete", presetId, { country: row.country, name: row.name }, now)(trx);
}

/* ---------------------------------------------------------------- F3 driver groups */

type GroupRow = { group_id: string; country: string; name: string; driver_ids: string[]; version: number; created_by: string | null; created_at: Date; updated_by: string | null; updated_at: Date };
export const groupView = (r: GroupRow) => ({ groupId: r.group_id, country: r.country, name: r.name, driverIds: r.driver_ids, ...stamps(r) });

/** Every driver must exist and be of the group's country (his own country, else the country of his first zone). */
async function checkDrivers(ex: Executor, country: string, driverIds: string[]): Promise<string[]> {
  const ids = [...new Set(driverIds)];
  if (ids.length > GROUP_MAX_DRIVERS) throw badRequest(`At most ${GROUP_MAX_DRIVERS} drivers in a group.`, "too_many_drivers");
  if (ids.length === 0) return ids;
  const rows = await ex.selectFrom("drivers").leftJoin("zones", (j) => j.on(sql<boolean>`zones.zone_id = drivers.zone_ids[1]`)).select(["drivers.driver_id", "drivers.country", "zones.country as zoneCountry"]).where("drivers.driver_id", "in", ids).execute();
  const wrong = ids.filter((id) => {
    const r = rows.find((x) => x.driver_id === id);
    return r === undefined || (r.country ?? r.zoneCountry) !== country;
  });
  if (wrong.length) throw new ApiError("invalid_request", "Every driver of a group must drive in its country.", { reason: "driver_not_in_country", details: wrong });
  return ids;
}

export async function listGroups(ex: Executor, who: Principal, country?: string) {
  const countries = await countriesOf(ex, who, country);
  const rows = countries.length ? await ex.selectFrom("driver_groups").selectAll().where("country", "in", countries).orderBy("country").orderBy("name").execute() : [];
  return { items: (rows as GroupRow[]).map(groupView) };
}
export async function createGroup(trx: Trx, who: Principal, body: { country: string; name: string; driverIds: string[] }, now: Date) {
  await checkCountry(trx, who, body.country);
  const driverIds = await checkDrivers(trx, body.country, body.driverIds);
  const row = { group_id: newId("dgr", now.getTime()), country: body.country, name: body.name.trim(), driver_ids: driverIds, version: 1, created_by: who.subjectId, created_at: now, updated_by: who.subjectId, updated_at: now };
  await uniqueName(() => trx.insertInto("driver_groups").values(row).execute());
  await write(who, "dispatch.group.create", row.group_id, { country: row.country, name: row.name, drivers: driverIds.length }, now)(trx);
  return groupView(row);
}
async function lockGroup(trx: Trx, who: Principal, groupId: string): Promise<GroupRow> {
  const row = (await trx.selectFrom("driver_groups").selectAll().where("group_id", "=", groupId).forUpdate().executeTakeFirst()) as GroupRow | undefined;
  if (row === undefined) throw notFound("No such group.", "group_not_found");
  await checkCountry(trx, who, row.country);
  return row;
}
export async function updateGroup(trx: Trx, who: Principal, groupId: string, body: { expectedVersion: number; name?: string; driverIds?: string[] }, now: Date) {
  const row = await lockGroup(trx, who, groupId);
  checkVersion(row, body.expectedVersion, groupView(row));
  const driverIds = body.driverIds ? await checkDrivers(trx, row.country, body.driverIds) : row.driver_ids;
  const next = { name: body.name?.trim() ?? row.name, driver_ids: driverIds, version: row.version + 1, updated_by: who.subjectId, updated_at: now };
  await uniqueName(() => trx.updateTable("driver_groups").set(next).where("group_id", "=", groupId).execute());
  await write(who, "dispatch.group.update", groupId, { country: row.country, name: next.name, drivers: driverIds.length }, now)(trx);
  return groupView({ ...row, ...next });
}
export async function deleteGroup(trx: Trx, who: Principal, groupId: string, expectedVersion: number, now: Date) {
  const row = await lockGroup(trx, who, groupId);
  checkVersion(row, expectedVersion, groupView(row));
  // Reservations will use groups with group 15 (then 409 group_in_use); nothing references a group yet.
  await trx.deleteFrom("driver_groups").where("group_id", "=", groupId).execute();
  await write(who, "dispatch.group.delete", groupId, { country: row.country, name: row.name }, now)(trx);
}

/* ---------------------------------------------------------------- free drivers (F3, F4) */

type Place = { lat: number; lng: number };

/**
 * The drivers who could take the trip now: account active, online (not on a trip), a position newer than 120 s, the
 * trip's category, no open offer of this trip; optionally only some ids and / or only inside a polygon. Nearest to the
 * pickup first, at most `limit`.
 */
export async function freeDriversFor(ex: Executor, trip: Pick<TripRow, "trip_id" | "pickup" | "category_id">, opts: { only?: string[]; polygon?: Polygon; limit: number; now: Date }): Promise<string[]> {
  if (opts.only !== undefined && opts.only.length === 0) return [];
  let q = ex
    .selectFrom("drivers")
    .innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .select(["drivers.driver_id", "driver_locations.lat", "driver_locations.lng"])
    .where("drivers.account_status", "=", "active")
    .where("drivers.online_status", "=", "online")
    .where("driver_locations.received_at", ">", new Date(opts.now.getTime() - STALE_AFTER_SECONDS * 1000))
    .where("driver_locations.measured_at", ">", new Date(opts.now.getTime() - DISPATCH_FIX_MAX_AGE_SECONDS * 1000))
    .where(sql<boolean>`${trip.category_id} = ANY(drivers.category_ids)`)
    .where((eb) => eb.not(eb.exists(eb.selectFrom("trips").select("trips.trip_id").whereRef("trips.driver_id", "=", "drivers.driver_id").where("trips.status", "in", [...DRIVER_ASSIGNED]))))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("offers").select("offers.offer_id").whereRef("offers.driver_id", "=", "drivers.driver_id").where("offers.trip_id", "=", trip.trip_id).where("offers.status", "=", "open"))));
  if (opts.only !== undefined) q = q.where("drivers.driver_id", "in", opts.only);
  const pickup = trip.pickup as Place;
  return (await q.execute())
    .filter((r) => opts.polygon === undefined || inPolygon(r.lat, r.lng, opts.polygon))
    .map((r) => ({ id: r.driver_id, km: dispatchKm({ lat: r.lat, lng: r.lng }, pickup) }))
    .sort((a, b) => a.km - b.km || (a.id < b.id ? -1 : 1))
    .slice(0, opts.limit)
    .map((r) => r.id);
}

/** Send to a group (F3): the group's free members, nearest first, at most 10; 409 no_free_driver only when none. */
export async function pickGroup(ex: Executor, who: Principal, trip: TripRow, groupId: string, now: Date): Promise<string[]> {
  const group = await ex.selectFrom("driver_groups").selectAll().where("group_id", "=", groupId).executeTakeFirst();
  if (group === undefined) throw notFound("No such group.", "group_not_found");
  await checkCountry(ex, who, group.country);
  const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", trip.zone_id).executeTakeFirst();
  if (zone?.country !== group.country) throw badRequest("This group is of another country.", "zone_not_in_country");
  const ids = await freeDriversFor(ex, trip, { only: group.driver_ids, limit: SEND_MAX, now });
  if (ids.length === 0) throw new ApiError("conflict", "Nobody of this group is free now.", { reason: "no_free_driver" });
  return ids;
}

/* ---------------------------------------------------------------- F4 radar zones and rules */

type RadarZoneRow = { radar_zone_id: string; country: string; zone_id: string; name: string; polygon: unknown; version: number; created_by: string | null; created_at: Date; updated_by: string | null; updated_at: Date };
export const radarZoneView = (r: RadarZoneRow) => ({ radarZoneId: r.radar_zone_id, country: r.country, zoneId: r.zone_id, name: r.name, polygon: r.polygon, ...stamps(r) });
type RuleRow = { rule_id: string; country: string; name: string; radar_zone_ids: unknown; seconds: number; max_drivers: number; repeat: boolean; version: number; created_by: string | null; created_at: Date; updated_by: string | null; updated_at: Date };
export const ruleView = (r: RuleRow) => ({ ruleId: r.rule_id, country: r.country, name: r.name, radarZoneIds: r.radar_zone_ids, seconds: r.seconds, maxDrivers: r.max_drivers, repeat: r.repeat, ...stamps(r) });

function checkShape(polygon: Polygon): void {
  const problem = polygonProblem(polygon);
  if (problem !== null) throw badRequest(`The area is not valid: ${problem}.`, "invalid_polygon");
}

export async function listRadarZones(ex: Executor, who: Principal, country?: string) {
  const countries = await countriesOf(ex, who, country);
  const rows = countries.length ? await ex.selectFrom("radar_zones").selectAll().where("country", "in", countries).orderBy("country").orderBy("name").execute() : [];
  return { items: (rows as RadarZoneRow[]).map(radarZoneView) };
}
export async function createRadarZone(trx: Trx, who: Principal, body: { zoneId: string; name: string; polygon: Polygon }, now: Date) {
  const zone = await trx.selectFrom("zones").select(["zone_id", "country"]).where("zone_id", "=", body.zoneId).executeTakeFirst();
  if (zone === undefined) throw notFound("No such zone.", "zone_not_found");
  await checkCountry(trx, who, zone.country);
  checkShape(body.polygon);
  const row = { radar_zone_id: newId("rzn", now.getTime()), country: zone.country, zone_id: zone.zone_id, name: body.name.trim(), polygon: JSON.stringify(body.polygon), version: 1, created_by: who.subjectId, created_at: now, updated_by: who.subjectId, updated_at: now };
  await uniqueName(() => trx.insertInto("radar_zones").values(row).execute());
  await write(who, "dispatch.radar_zone.create", row.radar_zone_id, { country: row.country, zoneId: row.zone_id, name: row.name }, now)(trx);
  return radarZoneView({ ...row, polygon: body.polygon });
}
async function lockRadarZone(trx: Trx, who: Principal, radarZoneId: string): Promise<RadarZoneRow> {
  const row = (await trx.selectFrom("radar_zones").selectAll().where("radar_zone_id", "=", radarZoneId).forUpdate().executeTakeFirst()) as RadarZoneRow | undefined;
  if (row === undefined) throw notFound("No such radar zone.", "radar_zone_not_found");
  await checkCountry(trx, who, row.country);
  return row;
}
export async function updateRadarZone(trx: Trx, who: Principal, radarZoneId: string, body: { expectedVersion: number; name?: string; polygon?: Polygon }, now: Date) {
  const row = await lockRadarZone(trx, who, radarZoneId);
  checkVersion(row, body.expectedVersion, radarZoneView(row));
  if (body.polygon) checkShape(body.polygon);
  const next = { name: body.name?.trim() ?? row.name, polygon: JSON.stringify(body.polygon ?? row.polygon), version: row.version + 1, updated_by: who.subjectId, updated_at: now };
  await uniqueName(() => trx.updateTable("radar_zones").set(next).where("radar_zone_id", "=", radarZoneId).execute());
  await write(who, "dispatch.radar_zone.update", radarZoneId, { country: row.country, name: next.name, areaChanged: body.polygon !== undefined }, now)(trx);
  return radarZoneView({ ...row, ...next, polygon: body.polygon ?? row.polygon });
}
export async function deleteRadarZone(trx: Trx, who: Principal, radarZoneId: string, expectedVersion: number, now: Date) {
  const row = await lockRadarZone(trx, who, radarZoneId);
  checkVersion(row, expectedVersion, radarZoneView(row));
  const used = await trx.selectFrom("radar_zone_rules").select("rule_id").where("country", "=", row.country).where(sql<boolean>`radar_zone_ids @> ${JSON.stringify([radarZoneId])}::jsonb`).execute();
  if (used.length) throw new ApiError("conflict", "A radar zone rule lists this radar zone.", { reason: "radar_zone_in_use", details: used.map((u) => u.rule_id) });
  await trx.deleteFrom("radar_zones").where("radar_zone_id", "=", radarZoneId).execute();
  await write(who, "dispatch.radar_zone.delete", radarZoneId, { country: row.country, name: row.name }, now)(trx);
}

async function checkRuleZones(ex: Executor, country: string, ids: "all" | string[]): Promise<"all" | string[]> {
  if (ids === "all") return ids;
  const unique = [...new Set(ids)];
  const rows = await ex.selectFrom("radar_zones").select("radar_zone_id").where("country", "=", country).where("radar_zone_id", "in", unique).execute();
  const missing = unique.filter((id) => !rows.some((r) => r.radar_zone_id === id));
  if (missing.length) throw new ApiError("invalid_request", "Every radar zone of a rule must be of its country.", { reason: "zone_not_in_country", details: missing });
  return unique;
}
type RuleBody = { name: string; radarZoneIds: "all" | string[]; seconds: number; maxDrivers: number; repeat: boolean };
export async function listRules(ex: Executor, who: Principal, country?: string) {
  const countries = await countriesOf(ex, who, country);
  const rows = countries.length ? await ex.selectFrom("radar_zone_rules").selectAll().where("country", "in", countries).orderBy("country").orderBy("name").execute() : [];
  return { items: (rows as RuleRow[]).map(ruleView) };
}
export async function createRule(trx: Trx, who: Principal, body: RuleBody & { country: string }, now: Date) {
  await checkCountry(trx, who, body.country);
  const zones = await checkRuleZones(trx, body.country, body.radarZoneIds);
  const row = { rule_id: newId("rzr", now.getTime()), country: body.country, name: body.name.trim(), radar_zone_ids: JSON.stringify(zones), seconds: body.seconds, max_drivers: body.maxDrivers, repeat: body.repeat, version: 1, created_by: who.subjectId, created_at: now, updated_by: who.subjectId, updated_at: now };
  await uniqueName(() => trx.insertInto("radar_zone_rules").values(row).execute());
  await write(who, "dispatch.radar_rule.create", row.rule_id, { country: row.country, name: row.name, radarZoneIds: zones, seconds: row.seconds, maxDrivers: row.max_drivers, repeat: row.repeat }, now)(trx);
  return ruleView({ ...row, radar_zone_ids: zones });
}
async function lockRule(trx: Trx, who: Principal, ruleId: string): Promise<RuleRow> {
  const row = (await trx.selectFrom("radar_zone_rules").selectAll().where("rule_id", "=", ruleId).forUpdate().executeTakeFirst()) as RuleRow | undefined;
  if (row === undefined) throw notFound("No such radar zone rule.", "radar_rule_not_found");
  await checkCountry(trx, who, row.country);
  return row;
}
export async function updateRule(trx: Trx, who: Principal, ruleId: string, body: Partial<RuleBody> & { expectedVersion: number }, now: Date) {
  const row = await lockRule(trx, who, ruleId);
  checkVersion(row, body.expectedVersion, ruleView(row));
  const zones = body.radarZoneIds !== undefined ? await checkRuleZones(trx, row.country, body.radarZoneIds) : (row.radar_zone_ids as "all" | string[]);
  const next = { name: body.name?.trim() ?? row.name, radar_zone_ids: JSON.stringify(zones), seconds: body.seconds ?? row.seconds, max_drivers: body.maxDrivers ?? row.max_drivers, repeat: body.repeat ?? row.repeat, version: row.version + 1, updated_by: who.subjectId, updated_at: now };
  await uniqueName(() => trx.updateTable("radar_zone_rules").set(next).where("rule_id", "=", ruleId).execute());
  await write(who, "dispatch.radar_rule.update", ruleId, { country: row.country, name: next.name, radarZoneIds: zones, seconds: next.seconds, maxDrivers: next.max_drivers, repeat: next.repeat }, now)(trx);
  return ruleView({ ...row, ...next, radar_zone_ids: zones });
}
export async function deleteRule(trx: Trx, who: Principal, ruleId: string, expectedVersion: number, now: Date) {
  const row = await lockRule(trx, who, ruleId);
  checkVersion(row, expectedVersion, ruleView(row));
  await trx.deleteFrom("radar_zone_rules").where("rule_id", "=", ruleId).execute();
  await write(who, "dispatch.radar_rule.delete", ruleId, { country: row.country, name: row.name }, now)(trx);
}

export async function radarZoneFree(ex: Executor, who: Principal, radarZoneId: string, categoryId: string | undefined, now: Date) {
  const zone = await ex.selectFrom("radar_zones").selectAll().where("radar_zone_id", "=", radarZoneId).executeTakeFirst();
  if (zone === undefined) throw notFound("No such radar zone.", "radar_zone_not_found");
  await checkCountry(ex, who, zone.country);
  let q = ex
    .selectFrom("drivers")
    .innerJoin("driver_locations", "driver_locations.driver_id", "drivers.driver_id")
    .select(["driver_locations.lat", "driver_locations.lng"])
    .where("drivers.account_status", "=", "active")
    .where("drivers.online_status", "=", "online")
    .where("driver_locations.received_at", ">", new Date(now.getTime() - STALE_AFTER_SECONDS * 1000))
    .where("driver_locations.measured_at", ">", new Date(now.getTime() - DISPATCH_FIX_MAX_AGE_SECONDS * 1000))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("trips").select("trips.trip_id").whereRef("trips.driver_id", "=", "drivers.driver_id").where("trips.status", "in", [...DRIVER_ASSIGNED]))));
  if (categoryId !== undefined) q = q.where(sql<boolean>`${categoryId} = ANY(drivers.category_ids)`);
  const free = (await q.execute()).filter((r) => inPolygon(r.lat, r.lng, zone.polygon as Polygon)).length;
  return { radarZoneId, free, at: now.toISOString() };
}

/* ---------------------------------------------------------------- F4 radar-zone send with repeat */

export { RADAR_ZONE_REPEAT } from "./radarSends.js";

/** The radar zone and rule of a send (the rule must cover the radar zone), with the free drivers inside now. */
export async function pickRadarZone(ex: Executor, who: Principal, trip: TripRow, radarZoneId: string, ruleId: string, now: Date) {
  const zone = await ex.selectFrom("radar_zones").selectAll().where("radar_zone_id", "=", radarZoneId).executeTakeFirst();
  if (zone === undefined) throw notFound("No such radar zone.", "radar_zone_not_found");
  const rule = await ex.selectFrom("radar_zone_rules").selectAll().where("rule_id", "=", ruleId).executeTakeFirst();
  if (rule === undefined) throw notFound("No such radar zone rule.", "radar_rule_not_found");
  await checkCountry(ex, who, zone.country);
  const tripZone = await ex.selectFrom("zones").select("country").where("zone_id", "=", trip.zone_id).executeTakeFirst();
  if (tripZone?.country !== zone.country) throw badRequest("This radar zone is of another country.", "zone_not_in_country");
  const covered = rule.radar_zone_ids === "all" ? rule.country === zone.country : (rule.radar_zone_ids as string[]).includes(radarZoneId);
  if (!covered) throw badRequest("This rule is not for that radar zone.", "rule_not_for_zone");
  const ids = await freeDriversFor(ex, trip, { polygon: zone.polygon as Polygon, limit: rule.max_drivers, now });
  if (ids.length === 0 && !rule.repeat) throw new ApiError("conflict", "Nobody is free inside this radar zone now.", { reason: "no_free_driver" });
  return { zone, rule, ids };
}

/** Starts (or replaces) the trip's radar-zone send; with repeat the next round is booked at expiry. */
export async function startRadarZoneSend(trx: Trx, who: Principal, trip: TripRow, picked: Awaited<ReturnType<typeof pickRadarZone>>, expiresAt: Date, now: Date) {
  const running = await trx.selectFrom("radar_zone_sends").select("send_id").where("trip_id", "=", trip.trip_id).where("active", "=", true).execute();
  for (const r of running) {
    await trx.updateTable("radar_zone_sends").set({ active: false, stopped_at: now, stopped_by: who.subjectId, stop_reason: "replaced" }).where("send_id", "=", r.send_id).execute();
    await cancelTimer(trx, RADAR_ZONE_REPEAT, r.send_id);
  }
  const row = { send_id: newId("rzs", now.getTime()), trip_id: trip.trip_id, radar_zone_id: picked.zone.radar_zone_id, rule_id: picked.rule.rule_id, seconds: picked.rule.seconds, max_drivers: picked.rule.max_drivers, repeat: picked.rule.repeat, active: picked.rule.repeat, rounds: 1, started_by: who.subjectId, started_at: now, stopped_at: null, stopped_by: null, stop_reason: null };
  await trx.insertInto("radar_zone_sends").values(row).execute();
  if (row.repeat) await scheduleTimer(trx, { kind: RADAR_ZONE_REPEAT, refId: row.send_id, dueAt: expiresAt, payload: { tripId: trip.trip_id } });
  return sendView(row);
}

async function endSend(trx: Trx, send: SendRow, reason: "admin" | "accepted" | "search_ended" | "trip_over", by: string | null, now: Date) {
  await trx.updateTable("radar_zone_sends").set({ active: false, stopped_at: now, stopped_by: by, stop_reason: reason }).where("send_id", "=", send.send_id).execute();
  await cancelTimer(trx, RADAR_ZONE_REPEAT, send.send_id);
  return sendView({ ...send, active: false, stopped_at: now, stopped_by: by, stop_reason: reason });
}

/** The repeat: to whoever is free inside the area now, until accepted, stopped, the search ends or the trip ends. */
export const radarZoneRepeatHandler: TimerHandler = async (trx, timer) => {
  const now = timer.firedAt;
  const send = (await trx.selectFrom("radar_zone_sends").selectAll().where("send_id", "=", timer.refId).forUpdate().executeTakeFirst()) as SendRow | undefined;
  if (send === undefined || !send.active) return;
  const trip = await lockTripNow(trx, send.trip_id);
  if (!trip) return;
  if ((TERMINAL as ReadonlySet<string>).has(trip.status)) return void (await endSend(trx, send, "trip_over", null, now));
  if (!["searching", "offered"].includes(trip.status)) return void (await endSend(trx, send, "accepted", null, now));
  const search = await trx.selectFrom("searches").select("end_at").where("trip_id", "=", trip.trip_id).executeTakeFirst();
  if (search && search.end_at.getTime() <= now.getTime()) return void (await endSend(trx, send, "search_ended", null, now));
  const zone = await trx.selectFrom("radar_zones").select("polygon").where("radar_zone_id", "=", send.radar_zone_id).executeTakeFirst();
  if (zone === undefined) return void (await endSend(trx, send, "trip_over", null, now));
  const ids = await freeDriversFor(trx, trip, { polygon: zone.polygon as Polygon, limit: send.max_drivers, now });
  let next = new Date(now.getTime() + send.seconds * 1000);
  if (ids.length > 0) {
    const assigned = await applyCommand(trx, trip, { command: "assign", actor: "admin", now });
    const sent = await sendAdminOffers(trx, assigned, ids, "radar", now, send.seconds);
    next = sent.expiresAt;
  }
  await trx.updateTable("radar_zone_sends").set({ rounds: send.rounds + 1 }).where("send_id", "=", send.send_id).execute();
  await scheduleTimer(trx, { kind: RADAR_ZONE_REPEAT, refId: send.send_id, dueAt: next, payload: { tripId: trip.trip_id } });
};

export async function stopRadarZoneSend(trx: Trx, who: Principal, trip: TripRow, note: string | undefined, now: Date) {
  const send = (await trx.selectFrom("radar_zone_sends").selectAll().where("trip_id", "=", trip.trip_id).where("active", "=", true).forUpdate().executeTakeFirst()) as SendRow | undefined;
  if (send === undefined) throw notFound("No radar-zone send is running for this trip.", "radar_zone_send_not_found");
  const view = await endSend(trx, send, "admin", who.subjectId, now);
  await audit(trx, { adminId: who.subjectId, action: "trip.radar_zone_stop", targetType: "trip", targetId: trip.trip_id, zoneId: trip.zone_id, detail: { sendId: send.send_id, rounds: send.rounds, note: note ?? null }, at: now });
  return view;
}

/* ---------------------------------------------------------------- F6 events */

type Localized = Record<Lang, string>;
type Details = { title: Localized; description: Localized; pickupNote?: Localized };
type EventRow = { event_id: string; country: string; name: string; lat: number; lng: number; polygon: unknown; starts_at: Date; ends_at: Date; is_on: boolean; details: unknown; version: number; created_by: string | null; created_at: Date; updated_by: string | null; updated_at: Date };
export const eventView = (r: EventRow) => ({
  eventId: r.event_id, country: r.country, name: r.name, location: { lat: r.lat, lng: r.lng }, ...(r.polygon ? { polygon: r.polygon } : {}),
  startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString(), on: r.is_on, details: r.details, ...stamps(r),
});
const LIMITS = { title: 80, description: 1000, pickupNote: 300 } as const;
function checkDetails(details: Details): void {
  for (const key of ["title", "description", "pickupNote"] as const) {
    const t = details[key];
    if (t === undefined) continue;
    for (const l of ["sv", "fr", "en"] as const) if (t[l].length > LIMITS[key]) throw badRequest(`${key} (${l}) is longer than ${LIMITS[key]} characters.`, "text_too_long");
  }
}
function checkTimes(startsAt: Date, endsAt: Date): void {
  if (!(endsAt.getTime() > startsAt.getTime())) throw badRequest("The event must end after it starts.", "ends_before_start");
}
/** config_published { doc: events } to every zone of the country: the driver apps read GET /driver/events again. */
async function signalEvents(ex: Executor, country: string, version: number, now: Date): Promise<void> {
  const zones = await ex.selectFrom("zones").select("zone_id").where("country", "=", country).execute();
  for (const z of zones) await sql`SELECT pg_notify(${CONFIG_CHANNEL}, ${JSON.stringify({ doc: TOOLS.events.signalDoc, zoneId: z.zone_id, version, publishedAt: now.toISOString() })})`.execute(ex);
}

type EventBody = { name: string; location: Place; polygon?: Polygon; startsAt: string; endsAt: string; on?: boolean; details: Details };
export async function listEvents(ex: Executor, who: Principal, input: { country?: string | undefined; from?: string | undefined; to?: string | undefined }) {
  const countries = await countriesOf(ex, who, input.country);
  if (!countries.length) return { items: [] };
  let q = ex.selectFrom("area_events").selectAll().where("country", "in", countries);
  if (input.from) q = q.where("ends_at", ">=", new Date(input.from));
  if (input.to) q = q.where("starts_at", "<=", new Date(input.to));
  return { items: ((await q.orderBy("starts_at").execute()) as EventRow[]).map(eventView) };
}
export async function createEvent(trx: Trx, who: Principal, body: EventBody & { country: string }, now: Date) {
  await checkCountry(trx, who, body.country);
  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  checkTimes(startsAt, endsAt);
  checkDetails(body.details);
  if (body.polygon) checkShape(body.polygon);
  const row = {
    event_id: newId("aev", now.getTime()), country: body.country, name: body.name.trim(), lat: body.location.lat, lng: body.location.lng, polygon: body.polygon ? JSON.stringify(body.polygon) : null,
    starts_at: startsAt, ends_at: endsAt, is_on: body.on ?? true, details: JSON.stringify(body.details), version: 1, created_by: who.subjectId, created_at: now, updated_by: who.subjectId, updated_at: now,
  };
  await trx.insertInto("area_events").values(row).execute();
  await write(who, "dispatch.event.create", row.event_id, { country: row.country, name: row.name, startsAt: body.startsAt, endsAt: body.endsAt, on: row.is_on }, now)(trx);
  await signalEvents(trx, row.country, row.version, now);
  return eventView({ ...row, polygon: body.polygon ?? null, details: body.details });
}
async function lockEvent(trx: Trx, who: Principal, eventId: string): Promise<EventRow> {
  const row = (await trx.selectFrom("area_events").selectAll().where("event_id", "=", eventId).forUpdate().executeTakeFirst()) as EventRow | undefined;
  if (row === undefined) throw notFound("No such event.", "event_not_found");
  await checkCountry(trx, who, row.country);
  return row;
}
export async function updateEvent(trx: Trx, who: Principal, eventId: string, body: Partial<EventBody> & { expectedVersion: number }, now: Date) {
  const row = await lockEvent(trx, who, eventId);
  checkVersion(row, body.expectedVersion, eventView(row));
  const startsAt = body.startsAt ? new Date(body.startsAt) : row.starts_at;
  const endsAt = body.endsAt ? new Date(body.endsAt) : row.ends_at;
  checkTimes(startsAt, endsAt);
  if (body.details) checkDetails(body.details);
  if (body.polygon) checkShape(body.polygon);
  const next = {
    name: body.name?.trim() ?? row.name, lat: body.location?.lat ?? row.lat, lng: body.location?.lng ?? row.lng, polygon: body.polygon !== undefined ? JSON.stringify(body.polygon) : row.polygon === null ? null : JSON.stringify(row.polygon),
    starts_at: startsAt, ends_at: endsAt, is_on: body.on ?? row.is_on, details: JSON.stringify(body.details ?? row.details), version: row.version + 1, updated_by: who.subjectId, updated_at: now,
  };
  await trx.updateTable("area_events").set(next).where("event_id", "=", eventId).execute();
  await write(who, "dispatch.event.update", eventId, { country: row.country, name: next.name, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), on: next.is_on }, now)(trx);
  await signalEvents(trx, row.country, next.version, now);
  return eventView({ ...row, ...next, polygon: body.polygon ?? row.polygon, details: body.details ?? row.details });
}
export async function deleteEvent(trx: Trx, who: Principal, eventId: string, expectedVersion: number, now: Date) {
  const row = await lockEvent(trx, who, eventId);
  checkVersion(row, expectedVersion, eventView(row));
  await trx.deleteFrom("area_events").where("event_id", "=", eventId).execute();
  await write(who, "dispatch.event.delete", eventId, { country: row.country, name: row.name }, now)(trx);
  await signalEvents(trx, row.country, row.version + 1, now);
}

/** GET /driver/events: running and upcoming (7 days) events of the driver's country, in his language. */
export async function driverEvents(ex: Executor, driverId: string, now: Date) {
  const driver = await ex.selectFrom("drivers").select(["country", "zone_ids", "language"]).where("driver_id", "=", driverId).executeTakeFirst();
  let country = driver?.country ?? null;
  if (country === null && driver?.zone_ids[0]) country = (await ex.selectFrom("zones").select("country").where("zone_id", "=", driver.zone_ids[0]).executeTakeFirst())?.country ?? null;
  if (country === null) return { items: [], at: now.toISOString() };
  const own = driver?.language === "sv" || driver?.language === "fr" || driver?.language === "en" ? (driver.language as Lang) : null;
  const order: Lang[] = [...new Set([own, "en", COUNTRY_LANGUAGE[country]].filter((l): l is Lang => l !== null && l !== undefined))];
  const rows = (await ex
    .selectFrom("area_events")
    .selectAll()
    .where("country", "=", country)
    .where("is_on", "=", true)
    .where("ends_at", ">", now)
    .where("starts_at", "<=", new Date(now.getTime() + TOOLS.events.upcomingDays * 86_400_000))
    .orderBy("starts_at")
    .execute()) as EventRow[];
  const pick = (t: Localized | undefined) => {
    for (const l of order) if (t?.[l]) return { text: t[l], language: l };
    return undefined;
  };
  return {
    items: rows.map((r) => {
      const d = r.details as Details;
      const title = pick(d.title)!;
      const pickup = pick(d.pickupNote);
      return {
        eventId: r.event_id, name: r.name, location: { lat: r.lat, lng: r.lng }, ...(r.polygon ? { polygon: r.polygon } : {}),
        startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString(), running: r.starts_at.getTime() <= now.getTime(),
        title: title.text, description: pick(d.description)?.text ?? "", ...(pickup ? { pickupNote: pickup.text } : {}), language: title.language,
      };
    }),
    at: now.toISOString(),
  };
}
