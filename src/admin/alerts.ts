import { contract } from "../contract/contract.js";
import type { Principal } from "../auth/guard.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { audit } from "./audit.js";

/**
 * Alerts full flow (contract v0.18.15 §38, contract.json#alertDesk; owner 2026-11-02 Q5 "FULL FLOW": take — the
 * others see who has it, pass on, snooze, mute types, quiet hours, done). The admin panel finds the alerts from the
 * live data; the server keeps who works on each one, the history, mutes, quiet hours, settings and rules.
 */

const INCIDENT_KINDS: readonly string[] = (contract as unknown as { alertDesk: { incidentKinds: string[] } }).alertDesk.incidentKinds;
const KEEP_DONE_DAYS = 30;
const MAX_DOC_BYTES = 256 * 1024;

type Event = { at: string; by: string; kind: "take" | "done" | "snooze" | "pass" | "reopen"; text: string; to?: string };
type RecordRow = { alert_id: string; kind: string; level: "critical" | "important" | "info"; title: string; zone_id: string | null; since: Date; status: "taken" | "done" | "snoozed"; owner: string | null; snooze_until: Date | null; events: unknown; updated_at: Date };
export type AlertInput = { kind: string; level: "critical" | "important" | "info"; title: string; zoneId?: string | undefined; since: string };

async function people(ex: Executor, who: Principal) {
  const rows = await ex.selectFrom("admins").select(["admin_id", "name", "zone_ids"]).where("active", "=", true).orderBy("name").execute();
  const all = who.zones.includes("*");
  return rows
    .filter((r) => all || r.zone_ids === null || r.zone_ids.includes("*") || r.zone_ids.some((z) => who.zones.includes(z)))
    .map((r) => ({ adminId: r.admin_id, name: r.name }));
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
    events: events.map((e) => ({ ...e, ...(names.get(e.by) ? { byName: names.get(e.by) } : {}) })),
  };
}

async function namesOf(ex: Executor): Promise<Map<string, string>> {
  const rows = await ex.selectFrom("admins").select(["admin_id", "name"]).execute();
  return new Map(rows.map((r) => [r.admin_id, r.name]));
}

export async function alertBook(ex: Executor, who: Principal, now: Date) {
  const book = await ex.selectFrom("admin_alert_book").selectAll().where("id", "=", 1).executeTakeFirstOrThrow();
  const since = new Date(now.getTime() - KEEP_DONE_DAYS * 86_400_000);
  const rows = (await ex.selectFrom("admin_alert_records").selectAll().where((eb) => eb.or([eb("status", "!=", "done"), eb("updated_at", ">=", since)])).orderBy("updated_at", "desc").limit(500).execute()) as RecordRow[];
  const quiet = await ex.selectFrom("admin_alert_quiet").selectAll().where("admin_id", "=", who.subjectId).executeTakeFirst();
  const names = await namesOf(ex);
  const mutes = Object.fromEntries(Object.entries((book.mutes ?? {}) as Record<string, { until: string; by: string }>).filter(([, m]) => Date.parse(m.until) > now.getTime()));
  return {
    rev: book.rev,
    settings: book.settings ?? {},
    rules: book.rules ?? [],
    records: rows.map((r) => recordView(r, names)),
    mutes,
    quiet: quiet ? { on: quiet.quiet_on, from: quiet.from_hm, to: quiet.to_hm } : { on: false, from: "22:00", to: "07:00" },
    people: await people(ex, who),
  };
}

export async function alertHistory(ex: Executor, input: { from?: string | undefined; to?: string | undefined }) {
  let q = ex.selectFrom("admin_alert_records").selectAll();
  if (input.from) q = q.where("since", ">=", new Date(input.from));
  if (input.to) q = q.where("since", "<", new Date(input.to));
  const rows = (await q.orderBy("since", "desc").limit(5000).execute()) as RecordRow[];
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
  const at = now.toISOString();
  const me = who.subjectId;
  const row = (await trx.selectFrom("admin_alert_records").selectAll().where("alert_id", "=", alertId).forUpdate().executeTakeFirst()) as RecordRow | undefined;
  const live = row && row.status !== "done";
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
      const allowed = (await people(trx, who)).some((p) => p.adminId === command.to);
      if (!allowed) throw badRequest("That admin cannot get this alert.", "assignee_not_allowed");
      next = { status: "taken", owner: command.to, snooze_until: null };
      events.push({ at, by: me, kind: "pass", text: `Passed to ${command.to}`, to: command.to });
      break;
    }
  }
  const values = { kind: input.kind, level: input.level, title: input.title, zone_id: input.zoneId ?? null, since: live ? row.since : new Date(input.since), ...next, events: JSON.stringify(events), updated_at: now };
  await trx
    .insertInto("admin_alert_records")
    .values({ alert_id: alertId, ...values })
    .onConflict((oc) => oc.column("alert_id").doUpdateSet(values))
    .execute();
  await audit(trx, { adminId: me, action: `alert.${command.verb}`, targetType: "alert", targetId: alertId, zoneId: input.zoneId ?? null, detail: { kind: input.kind, ...(command.verb === "pass" ? { to: command.to } : {}), ...(command.verb === "snooze" ? { minutes: command.minutes } : {}) }, at: now });
  return alertBook(trx, who, now);
}

async function lockBook(trx: Trx) {
  return trx.selectFrom("admin_alert_book").selectAll().where("id", "=", 1).forUpdate().executeTakeFirstOrThrow();
}

export async function setMute(trx: Trx, who: Principal, kind: string, minutes: number | null, now: Date) {
  const book = await lockBook(trx);
  const mutes = { ...((book.mutes ?? {}) as Record<string, { until: string; by: string }>) };
  if (minutes === null) delete mutes[kind];
  else mutes[kind] = { until: new Date(now.getTime() + minutes * 60_000).toISOString(), by: who.subjectId };
  await trx.updateTable("admin_alert_book").set({ mutes: JSON.stringify(mutes), updated_at: now }).where("id", "=", 1).execute();
  await audit(trx, { adminId: who.subjectId, action: minutes === null ? "alert.unmute" : "alert.mute", targetType: "alert_kind", targetId: kind, detail: minutes === null ? {} : { minutes }, at: now });
  return alertBook(trx, who, now);
}

export async function setQuiet(trx: Trx, who: Principal, body: { on: boolean; from: string; to: string }, now: Date) {
  const values = { quiet_on: body.on, from_hm: body.from, to_hm: body.to, updated_at: now };
  await trx.insertInto("admin_alert_quiet").values({ admin_id: who.subjectId, ...values }).onConflict((oc) => oc.column("admin_id").doUpdateSet(values)).execute();
  await audit(trx, { adminId: who.subjectId, action: "alert.quiet", targetType: "admin", targetId: who.subjectId, detail: body, at: now });
  return alertBook(trx, who, now);
}

export async function saveDoc(trx: Trx, who: Principal, which: "settings" | "rules", expectedRev: number, doc: unknown, now: Date) {
  if (JSON.stringify(doc).length > MAX_DOC_BYTES) throw badRequest("Too large.", "invalid_body");
  const book = await lockBook(trx);
  if (book.rev !== expectedRev) throw new ApiError("version_mismatch", "Someone saved the alert settings first. Load them again.");
  await trx.updateTable("admin_alert_book").set(which === "settings" ? { settings: JSON.stringify(doc), rev: book.rev + 1, updated_at: now } : { rules: JSON.stringify(doc), rev: book.rev + 1, updated_at: now }).where("id", "=", 1).execute();
  await audit(trx, { adminId: who.subjectId, action: `alert.${which}`, targetType: "alert_book", targetId: which, detail: { rev: book.rev + 1 }, at: now });
  return alertBook(trx, who, now);
}
