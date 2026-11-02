import { contract } from "../contract/contract.js";
import type { Principal } from "../auth/guard.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { audit } from "../admin/audit.js";
import { lockTrip } from "../db/tripLog.js";
import { openIncident, openOf } from "../safety/incidents.js";

/**
 * Support desk (contract v0.18.15 §37, contract.json#supportDesk; owner 2026-11-02 decisions/other-support-promos.md
 * QO-1 chat-style replies, QO-2 "<first name> · Movera Support", QO-4 the same 7 topics in both apps, QO-5 claim /
 * assign now; topics and time limits are an admin setting per country with defaults, owner rule 16).
 */

type TopicSetting = { code: string; on: boolean; firstReplyMin: number; solveHours: number };
export type SupportSettings = { country: string; claimDays: number; replyAfterSolved: "reopen" | "blocked"; topics: TopicSetting[]; updatedAt?: string; updatedBy?: string };

const DESK = (contract as unknown as {
  supportDesk: { settings: { countries: string[]; defaults: { claimDays: number; replyAfterSolved: "reopen" | "blocked"; topics: TopicSetting[] } }; caseIncidentKind: string };
}).supportDesk;
export const SUPPORT_COUNTRIES: readonly string[] = DESK.settings.countries;
const CATEGORIES: readonly string[] = (contract as unknown as { support: { categories: string[] } }).support.categories;

export function defaultSettings(country: string): SupportSettings {
  const d = DESK.settings.defaults;
  return { country, claimDays: d.claimDays, replyAfterSolved: d.replyAfterSolved, topics: d.topics.map((t) => ({ ...t })) };
}

/** A saved document over the defaults: every contract topic once, in the contract order. */
function merged(country: string, doc: unknown, updatedAt?: Date, updatedBy?: string | null): SupportSettings {
  const base = defaultSettings(country);
  const raw = (doc && typeof doc === "object" ? doc : {}) as Partial<SupportSettings>;
  const saved = new Map((Array.isArray(raw.topics) ? raw.topics : []).map((t) => [t.code, t]));
  return {
    country,
    claimDays: typeof raw.claimDays === "number" ? raw.claimDays : base.claimDays,
    replyAfterSolved: raw.replyAfterSolved === "blocked" ? "blocked" : base.replyAfterSolved,
    topics: base.topics.map((t) => ({ ...t, ...(saved.get(t.code) ?? {}), code: t.code })),
    ...(updatedAt ? { updatedAt: updatedAt.toISOString() } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  };
}

export async function settingsOf(ex: Executor, country: string | null): Promise<SupportSettings> {
  const c = country ?? "SE";
  const row = await ex.selectFrom("support_settings").selectAll().where("country", "=", c).executeTakeFirst();
  return row ? merged(c, row.doc, row.updated_at, row.updated_by) : defaultSettings(c);
}

export async function countryOfZone(ex: Executor, zoneId: string | null): Promise<string | null> {
  if (!zoneId) return null;
  const zone = await ex.selectFrom("zones").select("country").where("zone_id", "=", zoneId).executeTakeFirst();
  return zone?.country ?? null;
}

/** Super admin, or an admin with at least one zone in that country. */
async function coversCountry(ex: Executor, who: Principal, country: string): Promise<boolean> {
  if (who.zones.includes("*")) return true;
  if (who.zones.length === 0) return false;
  const hit = await ex.selectFrom("zones").select("zone_id").where("country", "=", country).where("zone_id", "in", who.zones).executeTakeFirst();
  return hit !== undefined;
}

export async function adminGetSettings(ex: Executor, country: string): Promise<SupportSettings> {
  return settingsOf(ex, country);
}

export async function adminPutSettings(trx: Trx, who: Principal, body: { country: string; claimDays: number; replyAfterSolved: "reopen" | "blocked"; topics: TopicSetting[] }, now: Date): Promise<SupportSettings> {
  if (!(await coversCountry(trx, who, body.country))) throw new ApiError("forbidden", "This country is outside your scope.", { reason: "zone_out_of_scope" });
  const codes = body.topics.map((t) => t.code);
  if (new Set(codes).size !== codes.length || codes.some((c) => !CATEGORIES.includes(c)) || codes.length !== CATEGORIES.length) {
    throw badRequest("Every topic once.", "invalid_body");
  }
  if (!body.topics.some((t) => t.on)) throw badRequest("At least one topic must be on.", "topics_required");
  const before = await settingsOf(trx, body.country);
  const doc = { claimDays: body.claimDays, replyAfterSolved: body.replyAfterSolved, topics: body.topics.map(({ code, on, firstReplyMin, solveHours }) => ({ code, on, firstReplyMin, solveHours })) };
  await trx
    .insertInto("support_settings")
    .values({ country: body.country, doc: JSON.stringify(doc), updated_at: now, updated_by: who.subjectId })
    .onConflict((oc) => oc.column("country").doUpdateSet({ doc: JSON.stringify(doc), updated_at: now, updated_by: who.subjectId }))
    .execute();
  await audit(trx, { adminId: who.subjectId, action: "support.settings", targetType: "support_settings", targetId: body.country, detail: { before: { claimDays: before.claimDays, replyAfterSolved: before.replyAfterSolved, topics: before.topics }, after: doc }, at: now });
  return settingsOf(trx, body.country);
}

/** QO-2: the first word of the admin's name; never an e-mail. */
export function firstNameOf(name: string | null | undefined): string | undefined {
  const clean = (name ?? "").trim();
  if (!clean || clean.includes("@")) return undefined;
  return clean.split(/\s+/)[0];
}

/** Admin view extras: who works on it, time limits of the ticket's country and topic. */
export type DeskRow = {
  ticket_id: string;
  zone_id: string | null;
  category: string;
  status: string;
  created_at: Date;
  assigned_admin_id?: string | null;
  claimed_until?: Date | null;
  solved_by?: string | null;
  solved_at?: Date | null;
  incident_id?: string | null;
  first_reply_at?: Date | null;
};

export async function deskExtras(ex: Executor, rows: readonly DeskRow[], now: Date): Promise<Map<string, Record<string, unknown>>> {
  const zoneIds = [...new Set(rows.map((r) => r.zone_id).filter((z): z is string => Boolean(z)))];
  const zones = zoneIds.length ? await ex.selectFrom("zones").select(["zone_id", "country"]).where("zone_id", "in", zoneIds).execute() : [];
  const countryOf = new Map(zones.map((z) => [z.zone_id, z.country as string | null]));
  const settings = new Map<string, SupportSettings>();
  for (const c of new Set(rows.map((r) => (r.zone_id ? countryOf.get(r.zone_id) : null) ?? "SE"))) settings.set(c, await settingsOf(ex, c));
  const adminIds = [...new Set(rows.map((r) => r.assigned_admin_id).filter((a): a is string => Boolean(a)))];
  const admins = adminIds.length ? await ex.selectFrom("admins").select(["admin_id", "name"]).where("admin_id", "in", adminIds).execute() : [];
  const nameOf = new Map(admins.map((a) => [a.admin_id, a.name]));
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const s = settings.get((r.zone_id ? countryOf.get(r.zone_id) : null) ?? "SE")!;
    const topic = s.topics.find((t) => t.code === r.category) ?? s.topics[s.topics.length - 1]!;
    const replyDue = new Date(r.created_at.getTime() + topic.firstReplyMin * 60_000);
    const solveDue = new Date(r.created_at.getTime() + topic.solveHours * 3_600_000);
    const done = r.status === "resolved" || r.status === "closed";
    const claimLive = r.assigned_admin_id && (!r.claimed_until || r.claimed_until > now);
    out.set(r.ticket_id, {
      ...(claimLive ? { assignedTo: { adminId: r.assigned_admin_id, ...(nameOf.get(r.assigned_admin_id!) ? { name: nameOf.get(r.assigned_admin_id!) } : {}) } } : {}),
      ...(claimLive && r.claimed_until ? { claimedUntil: r.claimed_until.toISOString() } : {}),
      ...(r.solved_by ? { solvedBy: r.solved_by } : {}),
      ...(r.solved_at ? { solvedAt: r.solved_at.toISOString() } : {}),
      ...(r.incident_id ? { incidentId: r.incident_id } : {}),
      ...(r.first_reply_at ? { firstReplyAt: r.first_reply_at.toISOString() } : {}),
      firstReplyDueAt: replyDue.toISOString(),
      solveDueAt: solveDue.toISOString(),
      late: {
        reply: (r.first_reply_at ? r.first_reply_at > replyDue : !done && now > replyDue),
        solve: (r.solved_at ? r.solved_at > solveDue : !done && now > solveDue),
      },
    });
  }
  return out;
}

/** GET /support/topics: the topics that are on for the person's country. */
export async function topicsFor(ex: Executor, who: { actor: "rider" | "driver"; subjectId: string }) {
  let zoneId: string | null = null;
  let country: string | null = null;
  if (who.actor === "driver") {
    const d = await ex.selectFrom("drivers").select(["zone_ids", "country"]).where("driver_id", "=", who.subjectId).executeTakeFirst();
    zoneId = d?.zone_ids[0] ?? null;
    country = d?.country ?? null;
  } else {
    const last = await ex.selectFrom("trips").select("zone_id").where("rider_id", "=", who.subjectId).orderBy("created_at", "desc").limit(1).executeTakeFirst();
    zoneId = last?.zone_id ?? null;
  }
  country = (await countryOfZone(ex, zoneId)) ?? country;
  const s = await settingsOf(ex, country);
  return { ...(country ? { country } : {}), topics: s.topics.filter((t) => t.on).map((t) => t.code) };
}

/** POST /support/tickets with a topic that is off for the zone's country. */
export async function assertTopicOn(ex: Executor, zoneId: string | null, category: string, fallbackCountry: string | null = null): Promise<void> {
  const s = await settingsOf(ex, (await countryOfZone(ex, zoneId)) ?? fallbackCountry);
  if (s.topics.find((t) => t.code === category)?.on === false) throw badRequest(`Topic ${category} is off.`, "topic_off");
}

/* ---------------------------------------------------------------- admin commands */

type Row = { ticket_id: string; zone_id: string | null; trip_id: string | null; status: "open" | "pending" | "resolved" | "closed"; category: string; assigned_admin_id: string | null; claimed_until: Date | null; incident_id: string | null };
const SOLVED = new Set(["resolved", "closed"]);

export async function claim(trx: Trx, who: Principal, row: Row, now: Date) {
  const other = row.assigned_admin_id && row.assigned_admin_id !== who.subjectId && (!row.claimed_until || row.claimed_until > now);
  if (other) throw new ApiError("conflict", "Another admin works on this ticket.", { reason: "ticket_claimed" });
  const s = await settingsOf(trx, await countryOfZone(trx, row.zone_id));
  const until = new Date(now.getTime() + s.claimDays * 86_400_000);
  await trx.updateTable("support_tickets").set({ assigned_admin_id: who.subjectId, claimed_until: until, updated_at: now }).where("ticket_id", "=", row.ticket_id).execute();
  await audit(trx, { adminId: who.subjectId, action: "ticket.claim", targetType: "ticket", targetId: row.ticket_id, zoneId: row.zone_id, detail: { until: until.toISOString() }, at: now });
}

export async function assign(trx: Trx, who: Principal, row: Row, body: { adminId: string | null; reason: string }, now: Date, permissionsOf: (role: string) => string[]) {
  if (body.adminId !== null) {
    const target = await trx.selectFrom("admins").select(["admin_id", "role", "zone_ids", "active"]).where("admin_id", "=", body.adminId).executeTakeFirst();
    const zones = target?.zone_ids ?? ["*"];
    const covers = row.zone_id === null ? zones.includes("*") : zones.includes("*") || zones.includes(row.zone_id);
    if (!target || !target.active || !permissionsOf(target.role).includes("support.reply") || !covers) {
      throw badRequest("That admin cannot work on this ticket.", "assignee_not_allowed");
    }
  }
  const s = await settingsOf(trx, await countryOfZone(trx, row.zone_id));
  const until = body.adminId ? new Date(now.getTime() + s.claimDays * 86_400_000) : null;
  await trx.updateTable("support_tickets").set({ assigned_admin_id: body.adminId, claimed_until: until, updated_at: now }).where("ticket_id", "=", row.ticket_id).execute();
  await audit(trx, { adminId: who.subjectId, action: "ticket.assign", targetType: "ticket", targetId: row.ticket_id, zoneId: row.zone_id, detail: { before: row.assigned_admin_id, after: body.adminId, reason: body.reason }, at: now });
}

export async function setTopic(trx: Trx, who: Principal, row: Row, category: string, now: Date) {
  if (!CATEGORIES.includes(category)) throw badRequest(`Unknown category ${category}.`, "invalid_body");
  await trx.updateTable("support_tickets").set({ category, updated_at: now }).where("ticket_id", "=", row.ticket_id).execute();
  await audit(trx, { adminId: who.subjectId, action: "ticket.topic", targetType: "ticket", targetId: row.ticket_id, zoneId: row.zone_id, detail: { before: row.category, after: category }, at: now });
}

export async function setWaiting(trx: Trx, who: Principal, row: Row, waiting: boolean, now: Date) {
  if (SOLVED.has(row.status)) throw new ApiError("invalid_transition", "This ticket is not open.", { reason: "ticket_not_open" });
  const status = waiting ? "pending" : "open";
  await trx.updateTable("support_tickets").set({ status, updated_at: now }).where("ticket_id", "=", row.ticket_id).execute();
  await audit(trx, { adminId: who.subjectId, action: "ticket.waiting", targetType: "ticket", targetId: row.ticket_id, zoneId: row.zone_id, detail: { before: row.status, after: status }, at: now });
}

export async function solve(trx: Trx, who: Principal, row: Row, note: string | undefined, now: Date) {
  if (row.status === "closed") throw new ApiError("invalid_transition", "This ticket is closed.", { reason: "ticket_closed" });
  await trx.updateTable("support_tickets").set({ status: "resolved", solved_by: who.subjectId, solved_at: now, updated_at: now }).where("ticket_id", "=", row.ticket_id).execute();
  // The note is private: only in the audit log, never on the ticket the person reads.
  await audit(trx, { adminId: who.subjectId, action: "ticket.solve", targetType: "ticket", targetId: row.ticket_id, zoneId: row.zone_id, detail: { before: row.status, ...(note ? { note } : {}) }, at: now });
}

export async function reopen(trx: Trx, who: Principal, row: Row, reason: string, now: Date) {
  if (!SOLVED.has(row.status)) throw new ApiError("invalid_transition", "This ticket is not solved.", { reason: "ticket_not_solved" });
  await trx.updateTable("support_tickets").set({ status: "open", solved_by: null, solved_at: null, updated_at: now }).where("ticket_id", "=", row.ticket_id).execute();
  await audit(trx, { adminId: who.subjectId, action: "ticket.reopen", targetType: "ticket", targetId: row.ticket_id, zoneId: row.zone_id, detail: { before: row.status, reason }, at: now });
}

export async function openCase(trx: Trx, who: Principal, row: Row, reason: string, now: Date) {
  if (!row.trip_id) throw new ApiError("invalid_transition", "This ticket has no trip.", { reason: "ticket_without_trip" });
  const trip = await lockTrip(trx, row.trip_id);
  const kind = DESK.caseIncidentKind;
  const incident = (await openOf(trx, trip.trip_id, kind)) ?? (await openIncident(trx, trip, { kind, raisedBy: "system", alarm: false }, now));
  await trx.updateTable("support_tickets").set({ incident_id: incident.incident_id, updated_at: now }).where("ticket_id", "=", row.ticket_id).execute();
  await audit(trx, { adminId: who.subjectId, action: "ticket.case", targetType: "ticket", targetId: row.ticket_id, zoneId: row.zone_id, detail: { incidentId: incident.incident_id, reason }, at: now });
}
