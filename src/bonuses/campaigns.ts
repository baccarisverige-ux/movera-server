import { sql } from "kysely";
import { adminCoversZone, type Principal } from "../auth/guard.js";
import { audit } from "../admin/audit.js";
import { zoneToday } from "../admin/kpis.js";
import { liveDocument } from "../config/service.js";
import { contract } from "../contract/contract.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { newId } from "../ids.js";
import { boundsOf, type Polygon } from "../zones/geometry.js";
import { forgetBonusCampaigns } from "./counting.js";
import { BONUS, ENDED_SHOWN_DAYS, daysBetween, stateOf, validateCampaign, type Measure, type Money } from "./rules.js";

/**
 * v0.18.103 BQ-V44 (contract.json#bonusCampaigns.endpoints): the admin's campaigns (create, edit, pause, resume, end —
 * never deleted, Rule 21; every write audited; zone scope) and the driver's list. Every number is the server's.
 */

const C = contract as unknown as { configDefaults: { bonusCampaignMax: Record<string, Money> } };
export type Names = { sv: string; fr: string; en: string };
export type CreateBody = { zoneId: string; names: Names; measure: Measure; target: number; amount: Money; startDate: string; endDate: string; polygon: Polygon };

type Row = {
  bonus_id: string; zone_id: string; country: string; zone_currency: string; time_zone: string; names: Names; measure: Measure; target: number;
  amount_minor: string; currency: string; start_date: string; end_date: string; starts_at: Date; ends_at: Date; polygon: Polygon;
  south: number; west: number; north: number; east: number; status: "active" | "paused" | "ended"; pauses: Array<[string, string | null]>;
  ended_at: Date | null; version: number; created_by: string; created_at: Date; updated_at: Date;
};
const ROW = sql`c.bonus_id, c.zone_id, z.country, z.currency AS zone_currency, z.time_zone, c.names, c.measure, c.target, c.amount_minor, c.currency,
  to_char(c.start_date, 'YYYY-MM-DD') AS start_date, to_char(c.end_date, 'YYYY-MM-DD') AS end_date, c.starts_at, c.ends_at, c.polygon,
  c.south, c.west, c.north, c.east, c.status, c.pauses, c.ended_at, c.version, c.created_by, c.created_at, c.updated_at`;

const money = (amountMinor: number, currency: string) => ({ amountMinor, currency: currency.trim() });
const window = (r: Row) => ({ startsAt: r.starts_at, endsAt: r.ends_at, status: r.status });

async function readRow(ex: Executor, bonusId: string, lock = false): Promise<Row | undefined> {
  const rows = lock
    ? await sql<Row>`SELECT ${ROW} FROM bonus_campaigns c JOIN zones z ON z.zone_id = c.zone_id WHERE c.bonus_id = ${bonusId} FOR UPDATE OF c`.execute(ex)
    : await sql<Row>`SELECT ${ROW} FROM bonus_campaigns c JOIN zones z ON z.zone_id = c.zone_id WHERE c.bonus_id = ${bonusId}`.execute(ex);
  return rows.rows[0];
}

/** BonusCampaign (admin view): the campaign, its state now, and driversWithProgress / driversEarned / paidTotal. */
export async function campaignView(ex: Executor, r: Row, now: Date) {
  const counts = (await sql<{ progress: string; earned: string; paid: string }>`
    SELECT (SELECT count(*) FROM bonus_progress p WHERE p.bonus_id = ${r.bonus_id} AND (p.trips > 0 OR p.online_seconds >= 60 OR p.earned_at IS NOT NULL)) AS progress,
           (SELECT count(*) FROM bonus_progress p WHERE p.bonus_id = ${r.bonus_id} AND p.earned_at IS NOT NULL) AS earned,
           (SELECT coalesce(sum(amount_minor), 0) FROM earnings_entries e WHERE e.bonus_id = ${r.bonus_id}) AS paid`.execute(ex)).rows[0]!;
  return {
    bonusId: r.bonus_id,
    zoneId: r.zone_id,
    country: r.country,
    currency: r.currency.trim(),
    timeZone: r.time_zone,
    names: r.names,
    measure: r.measure,
    target: Number(r.target),
    amount: money(Number(r.amount_minor), r.currency),
    startDate: r.start_date,
    endDate: r.end_date,
    polygon: r.polygon,
    bounds: { south: Number(r.south), west: Number(r.west), north: Number(r.north), east: Number(r.east) },
    status: r.status,
    state: stateOf(window(r), now),
    version: Number(r.version),
    createdAt: r.created_at.toISOString(),
    createdBy: r.created_by,
    updatedAt: r.updated_at.toISOString(),
    ...(r.ended_at ? { endedAt: r.ended_at.toISOString() } : {}),
    driversWithProgress: Number(counts.progress),
    driversEarned: Number(counts.earned),
    paidTotal: money(Number(counts.paid), r.currency),
  };
}

/** CountryRules.bonusCampaignMax of the zone (its own, else its country's Standard), else configDefaults.bonusCampaignMax. */
export async function bonusMaxOf(ex: Executor, zoneId: string, country: string, currency: string): Promise<number> {
  const rules = await liveDocument<{ bonusCampaignMax?: Money }>(ex, "country_rules", zoneId);
  const own = rules?.document.bonusCampaignMax;
  if (own && own.currency === currency && Number.isInteger(own.amountMinor) && own.amountMinor > 0) return own.amountMinor;
  const fallback = C.configDefaults.bonusCampaignMax[country];
  return fallback && fallback.currency === currency ? fallback.amountMinor : 0;
}

const outOfScope = () => new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });

/** POST /admin/bonuses (drivers.bonuses; audit bonus.create). */
export async function createCampaign(trx: Trx, who: Principal, body: CreateBody, now: Date) {
  const zone = await trx.selectFrom("zones").select(["zone_id", "country", "currency", "time_zone", "polygon"]).where("zone_id", "=", body.zoneId).executeTakeFirst();
  if (!zone) throw new ApiError("not_found", "No such zone.", { reason: "zone_not_found" });
  if (!adminCoversZone(who, zone.zone_id)) throw outOfScope();
  const today = await zoneToday(trx, zone.time_zone, now);
  const max = await bonusMaxOf(trx, zone.zone_id, zone.country, zone.currency);
  const reason = validateCampaign({ currency: zone.currency, polygon: zone.polygon as Polygon }, today, body, max);
  if (reason !== "ok") throw badRequest(`The campaign is not valid: ${reason}.`, reason);
  const bonusId = newId("bon", now.getTime());
  const b = boundsOf(body.polygon);
  await sql`
    INSERT INTO bonus_campaigns (bonus_id, zone_id, names, measure, target, amount_minor, currency, start_date, end_date, starts_at, ends_at,
                                 polygon, south, west, north, east, status, pauses, version, created_by, created_at, updated_at)
    VALUES (${bonusId}, ${zone.zone_id}, ${JSON.stringify(body.names)}::jsonb, ${body.measure}, ${body.target}, ${body.amount.amountMinor}, ${zone.currency},
            ${body.startDate}::date, ${body.endDate}::date,
            (${body.startDate}::date::timestamp AT TIME ZONE ${zone.time_zone}), ((${body.endDate}::date + 1)::timestamp AT TIME ZONE ${zone.time_zone}),
            ${JSON.stringify(body.polygon)}::jsonb, ${b.south}, ${b.west}, ${b.north}, ${b.east}, 'active', '[]'::jsonb, 1, ${who.subjectId}, ${now}, ${now})`.execute(trx);
  forgetBonusCampaigns();
  await audit(trx, { adminId: who.subjectId, action: "bonus.create", targetType: "bonus", targetId: bonusId, zoneId: zone.zone_id, detail: { measure: body.measure, target: body.target, amount: body.amount, startDate: body.startDate, endDate: body.endDate, points: body.polygon.length }, at: now });
  return campaignView(trx, (await readRow(trx, bonusId))!, now);
}

/** The campaign, locked, in the admin's scope, at the version he saw, not ended (else 404 / 403 / 409). */
async function lockForChange(trx: Trx, who: Principal, bonusId: string, expectedVersion: number, now: Date): Promise<Row> {
  const row = await readRow(trx, bonusId, true);
  if (!row) throw new ApiError("not_found", "No such campaign.", { reason: "bonus_not_found" });
  if (!adminCoversZone(who, row.zone_id)) throw outOfScope();
  if (Number(row.version) !== expectedVersion) throw new ApiError("version_mismatch", "The campaign changed. Look again.", { projection: await campaignView(trx, row, now) });
  if (stateOf(window(row), now) === "ended") throw new ApiError("conflict", "The campaign has ended.", { reason: "bonus_ended", projection: await campaignView(trx, row, now) });
  return row;
}

const UPDATABLE = new Set(["expectedVersion", "names", "endDate"]);

/** PUT /admin/bonuses/{bonusId}: only the names and a LATER end date (still within maxDays) change (D8). */
export async function updateCampaign(trx: Trx, who: Principal, bonusId: string, body: Record<string, unknown>, now: Date) {
  const fixed = Object.keys(body).filter((k) => !UPDATABLE.has(k));
  const row = await lockForChange(trx, who, bonusId, Number(body["expectedVersion"]), now);
  if (fixed.length) throw badRequest(`Only the names and a later end date can change (${fixed.join(", ")} is fixed).`, "bonus_field_fixed");
  const names = body["names"] as Names | undefined;
  const endDate = body["endDate"] as string | undefined;
  if (endDate !== undefined && (endDate < row.end_date || daysBetween(row.start_date, endDate) > BONUS.limits.maxDays)) throw badRequest("The end date can only move later, within the longest campaign.", "bonus_dates_invalid");
  await sql`
    UPDATE bonus_campaigns SET names = ${JSON.stringify(names ?? row.names)}::jsonb,
           end_date = ${endDate ?? row.end_date}::date, ends_at = ((${endDate ?? row.end_date}::date + 1)::timestamp AT TIME ZONE ${row.time_zone}),
           version = version + 1, updated_at = ${now}
     WHERE bonus_id = ${bonusId}`.execute(trx);
  forgetBonusCampaigns();
  await audit(trx, { adminId: who.subjectId, action: "bonus.update", targetType: "bonus", targetId: bonusId, zoneId: row.zone_id, detail: { ...(names ? { names } : {}), ...(endDate ? { endDate: { from: row.end_date, to: endDate } } : {}) }, at: now });
  return campaignView(trx, (await readRow(trx, bonusId))!, now);
}

/** POST /admin/bonuses/{bonusId}/pause | resume | end. */
export async function commandCampaign(trx: Trx, who: Principal, bonusId: string, command: "pause" | "resume" | "end", expectedVersion: number, now: Date) {
  const row = await lockForChange(trx, who, bonusId, expectedVersion, now);
  const allowed = command === "pause" ? row.status === "active" : command === "resume" ? row.status === "paused" : true;
  if (!allowed) throw new ApiError("invalid_transition", `A ${row.status} campaign cannot ${command}.`, { reason: "invalid_transition", projection: await campaignView(trx, row, now) });
  const at = now.toISOString();
  // pauses: [[from, to], ...]; the open pause (to null) closes on resume and on end.
  const closed = row.pauses.map(([from, to]) => [from, to ?? at] as [string, string]);
  const pauses = command === "pause" ? [...row.pauses, [at, null]] : closed;
  await sql`
    UPDATE bonus_campaigns SET status = ${command === "pause" ? "paused" : command === "resume" ? "active" : "ended"}, pauses = ${JSON.stringify(pauses)}::jsonb,
           ended_at = ${command === "end" ? now : null}, version = version + 1, updated_at = ${now}
     WHERE bonus_id = ${bonusId}`.execute(trx);
  forgetBonusCampaigns();
  await audit(trx, { adminId: who.subjectId, action: `bonus.${command}`, targetType: "bonus", targetId: bonusId, zoneId: row.zone_id, detail: { from: row.status }, at: now });
  return campaignView(trx, (await readRow(trx, bonusId))!, now);
}

export async function getCampaign(ex: Executor, who: Principal, bonusId: string, now: Date) {
  const row = await readRow(ex, bonusId);
  if (!row) throw new ApiError("not_found", "No such campaign.", { reason: "bonus_not_found" });
  if (!adminCoversZone(who, row.zone_id)) throw outOfScope();
  return campaignView(ex, row, now);
}

const cursorOf = (a: string, b: string) => Buffer.from(`${a}|${b}`).toString("base64url");
function readCursor(cursor: string): [string, string] {
  const [a, b] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!a || !b) throw badRequest("The cursor is not valid.", "invalid_cursor");
  return [a, b];
}

const STATE_SQL = (state: string, now: Date) =>
  state === "ended" ? sql`(c.status = 'ended' OR c.ends_at <= ${now})`
    : state === "scheduled" ? sql`(c.status <> 'ended' AND c.starts_at > ${now})`
      : sql`(c.status = ${state} AND c.starts_at <= ${now} AND ${now} < c.ends_at)`;

/** GET /admin/bonuses: newest first, the zones in the admin's scope. */
export async function listCampaigns(ex: Executor, who: Principal, q: { zoneId?: string | undefined; state?: string | undefined; cursor?: string | undefined; limit: number }, now: Date) {
  if (q.zoneId && !adminCoversZone(who, q.zoneId)) throw outOfScope();
  const zones = who.zones.includes("*") ? null : who.zones;
  const after = q.cursor ? readCursor(q.cursor) : null;
  const rows = await sql<Row>`
    SELECT ${ROW} FROM bonus_campaigns c JOIN zones z ON z.zone_id = c.zone_id
     WHERE TRUE
       ${q.zoneId ? sql`AND c.zone_id = ${q.zoneId}` : sql``}
       ${zones ? sql`AND c.zone_id = ANY(${zones}::text[])` : sql``}
       ${q.state ? sql`AND ${STATE_SQL(q.state, now)}` : sql``}
       ${after ? sql`AND (c.created_at, c.bonus_id) < (${after[0]}::timestamptz, ${after[1]})` : sql``}
     ORDER BY c.created_at DESC, c.bonus_id DESC LIMIT ${q.limit + 1}`.execute(ex);
  const page = rows.rows.slice(0, q.limit);
  const items = [];
  for (const r of page) items.push(await campaignView(ex, r, now));
  const last = page.at(-1);
  return { items, nextCursor: rows.rows.length > q.limit && last ? cursorOf(last.created_at.toISOString(), last.bonus_id) : null };
}

/** progress { done, target }: trips, or whole minutes online with target hours × 60 (contract counting.onlineHours). */
const progressOf = (measure: Measure, target: number, trips: number, seconds: number) =>
  measure === "trips" ? { done: Math.min(trips, target), target } : { done: Math.floor(Math.min(seconds, target * 3600) / 60), target: target * 60 };

/** GET /admin/bonuses/{bonusId}/drivers: most progress first. */
export async function listProgress(ex: Executor, who: Principal, bonusId: string, q: { cursor?: string | undefined; limit: number }) {
  const row = await readRow(ex, bonusId);
  if (!row) throw new ApiError("not_found", "No such campaign.", { reason: "bonus_not_found" });
  if (!adminCoversZone(who, row.zone_id)) throw outOfScope();
  const score = row.measure === "trips" ? sql`p.trips` : sql`p.online_seconds`;
  const after = q.cursor ? readCursor(q.cursor) : null;
  const rows = await sql<{ driver_id: string; first_name: string; trips: number; online_seconds: number; earned_at: Date | null; entry_id: string | null; score: number }>`
    SELECT p.driver_id, d.first_name, p.trips, p.online_seconds, p.earned_at, p.entry_id, ${score} AS score
      FROM bonus_progress p JOIN drivers d ON d.driver_id = p.driver_id
     WHERE p.bonus_id = ${bonusId} ${after ? sql`AND (${score}, p.driver_id) < (${Number(after[0])}::int, ${after[1]})` : sql``}
     ORDER BY ${score} DESC, p.driver_id DESC LIMIT ${q.limit + 1}`.execute(ex);
  const page = rows.rows.slice(0, q.limit);
  const items = page.map((p) => ({
    driverId: p.driver_id,
    firstName: p.first_name,
    progress: progressOf(row.measure, Number(row.target), Number(p.trips), Number(p.online_seconds)),
    earned: p.earned_at !== null,
    ...(p.earned_at ? { earnedAt: p.earned_at.toISOString() } : {}),
    ...(p.entry_id ? { entryId: p.entry_id } : {}),
  }));
  const last = page.at(-1);
  return { items, nextCursor: rows.rows.length > q.limit && last ? cursorOf(String(last.score), last.driver_id) : null };
}

const ORDER = { active: 0, scheduled: 1, paused: 2, ended: 3 } as const;

/**
 * GET /driver/bonuses: the campaigns of his zones (MF5: the same drivers who count) that are scheduled, active or paused,
 * plus ended ones he has progress in, for 30 days after the end (D11); active first, then scheduled, then the rest.
 */
export async function driverBonuses(ex: Executor, driverId: string, now: Date) {
  const since = new Date(now.getTime() - ENDED_SHOWN_DAYS * 86_400_000);
  const rows = await sql<Row & { trips: number | null; online_seconds: number | null; earned_at: Date | null; opened_at: Date | null }>`
    SELECT ${ROW}, p.trips, p.online_seconds, p.earned_at, p.opened_at
      FROM drivers d
      JOIN bonus_campaigns c ON c.zone_id = ANY(d.zone_ids)
      JOIN zones z ON z.zone_id = c.zone_id
      LEFT JOIN bonus_progress p ON p.bonus_id = c.bonus_id AND p.driver_id = d.driver_id
     WHERE d.driver_id = ${driverId}
       AND ((c.status <> 'ended' AND c.ends_at > ${now})
         OR ((p.trips > 0 OR p.online_seconds >= 60 OR p.earned_at IS NOT NULL) AND least(coalesce(c.ended_at, c.ends_at), c.ends_at) > ${since}))
     ORDER BY c.start_date, c.bonus_id`.execute(ex);
  const items = rows.rows.map((r) => {
    const target = Number(r.target);
    return {
      bonusId: r.bonus_id,
      names: r.names,
      measure: r.measure,
      state: stateOf(window(r), now),
      startDate: r.start_date,
      endDate: r.end_date,
      timeZone: r.time_zone,
      polygon: r.polygon,
      bounds: { south: Number(r.south), west: Number(r.west), north: Number(r.north), east: Number(r.east) },
      amount: money(Number(r.amount_minor), r.currency),
      progress: progressOf(r.measure, target, Number(r.trips ?? 0), Number(r.online_seconds ?? 0)),
      earned: r.earned_at !== null,
      ...(r.earned_at ? { earnedAt: r.earned_at.toISOString() } : {}),
      isNew: r.opened_at === null,
    };
  });
  return { items: items.sort((a, b) => ORDER[a.state] - ORDER[b.state]) };
}

/** POST /driver/bonuses/opened: opened_at on the campaigns of his zones he names (others are left alone). */
export async function markOpened(trx: Trx, driverId: string, bonusIds: readonly string[], now: Date): Promise<void> {
  await sql`
    INSERT INTO bonus_progress (bonus_id, driver_id, opened_at, updated_at)
    SELECT c.bonus_id, d.driver_id, ${now}::timestamptz, ${now}::timestamptz
      FROM drivers d JOIN bonus_campaigns c ON c.zone_id = ANY(d.zone_ids)
     WHERE d.driver_id = ${driverId} AND c.bonus_id = ANY(${[...bonusIds]}::text[])
     ORDER BY c.bonus_id
    ON CONFLICT (bonus_id, driver_id) DO UPDATE SET opened_at = coalesce(bonus_progress.opened_at, EXCLUDED.opened_at)`.execute(trx);
}

