import { contract } from "../contract/contract.js";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { audit } from "./audit.js";
import { isAdminRole, permissionsOf } from "./permissions.js";

/**
 * Alerts full flow (contract v0.18.15 §38, contract.json#alertDesk; owner 2026-11-02 Q5 "FULL FLOW": take — the
 * others see who has it, pass on, snooze, mute types, quiet hours, done). The admin panel finds the alerts from the
 * live data; the server keeps who works on each one, the history, and per country the mutes, settings and rules.
 * Every admin sees and acts only on alerts of their zones and of the groups their permissions cover.
 */

type Group = "safety" | "dispatch" | "drivers" | "money" | "riders" | "system" | "rules";
const DESK = (contract as unknown as {
  alertDesk: { incidentKinds: string[]; kindGroups: Record<string, Group>; permissions: { see: Record<Group, string>; act: Record<Group, string> } };
}).alertDesk;
const INCIDENT_KINDS: readonly string[] = DESK.incidentKinds;
const KEEP_DONE_DAYS = 30;
const MAX_DOC_BYTES = 256 * 1024;

type Event = { at: string; by: string; kind: "take" | "done" | "snooze" | "pass" | "reopen"; text: string; to?: string };
type RecordRow = { alert_id: string; kind: string; level: "critical" | "important" | "info"; title: string; zone_id: string | null; since: Date; status: "new" | "taken" | "done" | "snoozed"; owner: string | null; snooze_until: Date | null; events: unknown; updated_at: Date };
export type AlertInput = { kind: string; level: "critical" | "important" | "info"; title: string; zoneId?: string | undefined; since: string };

const groupOf = (kind: string): Group | undefined => DESK.kindGroups[kind];
const has = (who: Principal, permission: string) => (who.perms ?? []).includes(permission);
export const maySee = (who: Principal, kind: string) => {
  const group = groupOf(kind);
  return group !== undefined && has(who, DESK.permissions.see[group]);
};
const mayAct = (perms: readonly string[], kind: string) => {
  const group = groupOf(kind);
  return group !== undefined && (perms.includes(DESK.permissions.act[group]) || perms.includes("alerts.manage"));
};
/** An alert without zone: Super admins only (as support tickets). */
const coversZone = (who: Principal, zoneId: string | null) => (zoneId === null ? who.zones.includes("*") : adminCoversZone(who, zoneId));

async function zonesOfCountry(ex: Executor, country: string): Promise<string[]> {
  return (await ex.selectFrom("zones").select("zone_id").where("country", "=", country).execute()).map((z) => z.zone_id);
}

/** Super admin, or an admin with at least one zone in that country. */
export async function assertCountry(ex: Executor, who: Principal, country: string): Promise<string[]> {
  const zones = await zonesOfCountry(ex, country);
  if (!who.zones.includes("*") && !zones.some((z) => who.zones.includes(z))) throw new ApiError("forbidden", "This country is outside your scope.", { reason: "zone_out_of_scope" });
  return zones;
}

/** Active admins with a zone in the country (Super admins included), each with what they may do. */
async function colleagues(ex: Executor, countryZones: readonly string[]) {
  const rows = await ex.selectFrom("admins").select(["admin_id", "name", "role", "zone_ids"]).where("active", "=", true).orderBy("name").execute();
  return rows
    .filter((r) => r.zone_ids === null || r.zone_ids.includes("*") || r.zone_ids.some((z) => countryZones.includes(z)))
    .map((r) => ({ adminId: r.admin_id, name: r.name, zones: r.zone_ids ?? ["*"], perms: isAdminRole(r.role) ? permissionsOf(r.role) : [] }));
}

function recordView(r: RecordRow, names: Map<string, string>) {
  const events = (Array.isArray(r.events) ? r.events : []) as Event[];
  return {
    alertId: r.alert_id,
    kind: r.kind,
    level: r.level,
    title: r.title,
    ...(r.zone_id ? { zoneId: r.zone_id } : {}),
    since: r.since.toISOString(),
    status: r.status,
    ...(r.owner ? { owner: r.owner, ...(names.get(r.owner) ? { ownerName: names.get(r.owner) } : {}) } : {}),
    ...(r.snooze_until ? { snoozeUntil: r.snooze_until.toISOString() } : {}),
    events: events.map((e) => ({ ...e, ...(names.get(e.by) ? { byName: names.get(e.by) } : {}), ...(e.to && names.get(e.to) ? { toName: names.get(e.to) } : {}) })),
  };
}

async function namesOf(ex: Executor): Promise<Map<string, string>> {
  const rows = await ex.selectFrom("admins").select(["admin_id", "name"]).execute();
  return new Map(rows.map((r) => [r.admin_id, r.name]));
}

/** The records an admin may see in a country: their zones there, the groups they may read; no-zone ones for Super. */
async function visibleRecords(ex: Executor, who: Principal, countryZones: readonly string[], q: { since?: Date; from?: Date; to?: Date; limit: number }) {
  const zones = who.zones.includes("*") ? [...countryZones] : countryZones.filter((z) => who.zones.includes(z));
  let query = ex.selectFrom("admin_alert_records").selectAll().where("status", "!=", "new");
  query = query.where((eb) => (who.zones.includes("*") ? eb.or([eb("zone_id", "in", zones.length ? zones : ["-"]), eb("zone_id", "is", null)]) : eb("zone_id", "in", zones.length ? zones : ["-"])));
  if (q.since) {
    const since = q.since;
    query = query.where((eb) => eb.or([eb("status", "!=", "done"), eb("updated_at", ">=", since)]));
  }
  if (q.from) query = query.where("since", ">=", q.from);
  if (q.to) query = query.where("since", "<", q.to);
  const rows = (await query.orderBy("updated_at", "desc").limit(q.limit).execute()) as RecordRow[];
  return rows.filter((r) => maySee(who, r.kind));
}

async function bookRow(ex: Executor, country: string, lock = false) {
  if (lock) await (ex as Trx).insertInto("admin_alert_book").values({ country }).onConflict((oc) => oc.column("country").doNothing()).execute();
  let q = ex.selectFrom("admin_alert_book").selectAll().where("country", "=", country);
  if (lock) q = q.forUpdate();
  return (await q.executeTakeFirst()) ?? { country, rev: 1, settings: {}, rules: [], mutes: {}, updated_at: new Date(0) };
}

export async function alertBook(ex: Executor, who: Principal, country: string, now: Date) {
  const countryZones = await assertCountry(ex, who, country);
  const book = await bookRow(ex, country);
  const rows = await visibleRecords(ex, who, countryZones, { since: new Date(now.getTime() - KEEP_DONE_DAYS * 86_400_000), limit: 500 });
  const quiet = await ex.selectFrom("admin_alert_quiet").selectAll().where("admin_id", "=", who.subjectId).executeTakeFirst();
  const names = await namesOf(ex);
  const mutes = Object.fromEntries(Object.entries((book.mutes ?? {}) as Record<string, { until: string; by: string }>).filter(([, m]) => Date.parse(m.until) > now.getTime()));
  return {
    country,
    rev: book.rev,
    settings: book.settings ?? {},
    rules: book.rules ?? [],
    records: rows.map((r) => recordView(r, names)),
    mutes,
    quiet: quiet ? { on: quiet.quiet_on, from: quiet.from_hm, to: quiet.to_hm } : { on: false, from: "22:00", to: "07:00" },
    people: (await colleagues(ex, countryZones)).map((p) => ({ adminId: p.adminId, name: p.name })),
  };
}

export async function alertHistory(ex: Executor, who: Principal, input: { country: string; from?: string | undefined; to?: string | undefined }) {
  const countryZones = await assertCountry(ex, who, input.country);
  const rows = await visibleRecords(ex, who, countryZones, { ...(input.from ? { from: new Date(input.from) } : {}), ...(input.to ? { to: new Date(input.to) } : {}), limit: 5000 });
  const names = await namesOf(ex);
  return { items: rows.map((r) => recordView(r, names)) };
}

export type AlertCommand =
  | { verb: "take" }
  | { verb: "done"; note?: string | undefined }
  | { verb: "snooze"; minutes: number }
  | { verb: "pass"; to: string };

export async function alertCommand(trx: Trx, who: Principal, alertId: string, input: AlertInput, command: AlertCommand, now: Date) {
  if (INCIDENT_KINDS.includes(input.kind)) throw new ApiError("invalid_transition", "Take, pass and solve this alert in Incidents.", { reason: "alert_in_incidents" });
  if (!groupOf(input.kind)) throw badRequest(`Unknown alert kind ${input.kind}.`, "unknown_alert_kind");
  // The row exists before anyone acts, so two admins acting at once queue on its lock (checker HIGH).
  await trx
    .insertInto("admin_alert_records")
    .values({ alert_id: alertId, kind: input.kind, level: input.level, title: input.title, zone_id: input.zoneId ?? null, since: new Date(input.since), status: "new", owner: null, events: "[]", updated_at: now })
    .onConflict((oc) => oc.column("alert_id").doNothing())
    .execute();
  const row = (await trx.selectFrom("admin_alert_records").selectAll().where("alert_id", "=", alertId).forUpdate().executeTakeFirstOrThrow()) as RecordRow;
  // The zone and kind the server stored first are the alert's; what a later call sends is not trusted.
  const kind = row.kind;
  if (!coversZone(who, row.zone_id)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
  if (!mayAct(who.perms ?? [], kind)) throw new ApiError("forbidden", "You may not act on this kind of alert.", { reason: "permission_missing" });
  const at = now.toISOString();
  const me = who.subjectId;
  const live = row.status === "taken" || row.status === "snoozed";
  const owner = live ? row.owner : null;
  // Someone else works on it: only they act, or they pass it on.
  if (owner && owner !== me) throw new ApiError("conflict", "Another admin works on this alert.", { reason: "alert_taken" });
  const events = live ? ((Array.isArray(row.events) ? row.events : []) as Event[]) : [];
  let next: { status: RecordRow["status"]; owner: string | null; snooze_until: Date | null };
  switch (command.verb) {
    case "take":
      next = { status: "taken", owner: me, snooze_until: null };
      events.push({ at, by: me, kind: "take", text: "Working on it" });
      break;
    case "done":
      if (!owner) events.push({ at, by: me, kind: "take", text: "Working on it" });
      next = { status: "done", owner: me, snooze_until: null };
      events.push({ at, by: me, kind: "done", text: command.note?.trim() || "Solved" });
      break;
    case "snooze":
      next = { status: "snoozed", owner, snooze_until: new Date(now.getTime() + command.minutes * 60_000) };
      events.push({ at, by: me, kind: "snooze", text: `Remind in ${command.minutes} min` });
      break;
    case "pass": {
      if (command.to === me) throw badRequest("Pick another admin.", "assignee_not_allowed");
      const country = row.zone_id ? (await trx.selectFrom("zones").select("country").where("zone_id", "=", row.zone_id).executeTakeFirst())?.country : null;
      const pool = country ? await colleagues(trx, await zonesOfCountry(trx, country)) : (await colleagues(trx, [])).filter((p) => p.zones.includes("*"));
      const target = pool.find((p) => p.adminId === command.to);
      const covers = target && (target.zones.includes("*") || (row.zone_id !== null && target.zones.includes(row.zone_id)));
      if (!target || !covers || !mayAct(target.perms, kind)) throw badRequest("That admin cannot get this alert.", "assignee_not_allowed");
      next = { status: "taken", owner: command.to, snooze_until: null };
      events.push({ at, by: me, kind: "pass", text: `Passed to ${target.name}`, to: command.to });
      break;
    }
  }
  await trx
    .updateTable("admin_alert_records")
    .set({ level: input.level, title: input.title, ...(live ? {} : { since: new Date(input.since) }), ...next, events: JSON.stringify(events), updated_at: now })
    .where("alert_id", "=", alertId)
    .execute();
  await audit(trx, { adminId: me, action: `alert.${command.verb}`, targetType: "alert", targetId: alertId, zoneId: row.zone_id, detail: { kind, ...(command.verb === "pass" ? { to: command.to } : {}), ...(command.verb === "snooze" ? { minutes: command.minutes } : {}) }, at: now });
  const country = row.zone_id ? (await trx.selectFrom("zones").select("country").where("zone_id", "=", row.zone_id).executeTakeFirst())?.country ?? "SE" : "SE";
  return alertBook(trx, who, country, now);
}

export async function setMute(trx: Trx, who: Principal, country: string, kind: string, minutes: number | null, now: Date) {
  await assertCountry(trx, who, country);
  const book = await bookRow(trx, country, true);
  const mutes = { ...((book.mutes ?? {}) as Record<string, { until: string; by: string }>) };
  if (minutes === null) delete mutes[kind];
  else mutes[kind] = { until: new Date(now.getTime() + minutes * 60_000).toISOString(), by: who.subjectId };
  await trx.updateTable("admin_alert_book").set({ mutes: JSON.stringify(mutes), updated_at: now }).where("country", "=", country).execute();
  await audit(trx, { adminId: who.subjectId, action: minutes === null ? "alert.unmute" : "alert.mute", targetType: "alert_kind", targetId: kind, detail: { country, ...(minutes === null ? {} : { minutes }) }, at: now });
  return alertBook(trx, who, country, now);
}

export async function setQuiet(trx: Trx, who: Principal, country: string, body: { on: boolean; from: string; to: string }, now: Date) {
  const values = { quiet_on: body.on, from_hm: body.from, to_hm: body.to, updated_at: now };
  await trx.insertInto("admin_alert_quiet").values({ admin_id: who.subjectId, ...values }).onConflict((oc) => oc.column("admin_id").doUpdateSet(values)).execute();
  await audit(trx, { adminId: who.subjectId, action: "alert.quiet", targetType: "admin", targetId: who.subjectId, detail: body, at: now });
  return alertBook(trx, who, country, now);
}

export async function saveDoc(trx: Trx, who: Principal, country: string, which: "settings" | "rules", expectedRev: number, doc: unknown, now: Date) {
  if (JSON.stringify(doc).length > MAX_DOC_BYTES) throw badRequest("Too large.", "invalid_body");
  await assertCountry(trx, who, country);
  const book = await bookRow(trx, country, true);
  if (book.rev !== expectedRev) throw new ApiError("version_mismatch", "Someone saved the alert settings first. Load them again.");
  const set = which === "settings" ? { settings: JSON.stringify(doc), rev: book.rev + 1, updated_at: now } : { rules: JSON.stringify(doc), rev: book.rev + 1, updated_at: now };
  await trx.updateTable("admin_alert_book").set(set).where("country", "=", country).execute();
  await audit(trx, { adminId: who.subjectId, action: `alert.${which}`, targetType: "alert_book", targetId: `${country}:${which}`, detail: { rev: book.rev + 1 }, at: now });
  return alertBook(trx, who, country, now);
}
