import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { adminCoversZone, authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db, Executor, Trx } from "../db/db.js";
import type { ConfigDoc } from "../db/schema.js";
import { ApiError, badRequest } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { registerApprovalHandler, runOrRequest, type PendingApproval } from "../admin/approvals.js";
import { audit } from "../admin/audit.js";
import { newId } from "../ids.js";
import { contract } from "../contract/contract.js";
import { CONFIG_DOCS, PUBLISH_ACTION, PUBLISH_PERMISSION, APPROVE_PERMISSION, configHistory, getZone, liveDocument, rewriteLive, type Publication } from "../config/service.js";
import { validateSchedule } from "../rules/surge.js";
import { SLIDER_TOP, currentSchedule, scheduleView, type DocSurge } from "./surge.js";
import { driverSurgeMap, surgeHistory, surgeNow } from "./surgeLive.js";

/**
 * Contract v0.7.1 (owner Pricing decisions 2026-10-27): the manual surge Start / Stop (§3.4), the pricing history and Restore (contract.json#pricingHistory), and the car
 * type catalog (contract.json#categoryCatalog). v0.7.2 (owner 2026-10-28): the real surge data of the Surge tab
 * (contract.json#surgeLive) and the driver's surge map (contract.json#driverSurgeMap); no surge notice to drivers.
 */

export type PricingDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const ZONE = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const CATEGORY = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);
const Timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/);
const ScheduleBody = z.object({
  expectedVersion: z.number().int().min(0),
  categoryIds: z.array(CATEGORY).max(32).optional(),
  startAt: Timestamp,
  endAt: Timestamp,
  stepMinutes: z.number().int().min(1).optional(),
  points: z.array(z.object({ atMin: z.number().int().min(0), multiplier: z.number().min(1) })).min(2).max(200),
  note: z.string().max(1000).optional(),
});
const EndBody = z.object({ expectedVersion: z.number().int().min(1), zoneId: ZONE.optional(), note: z.string().max(1000).optional() });
const HistoryQuery = z.object({ zoneId: ZONE, cursor: z.string().max(32).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const RestoreBody = z.object({ expectedVersion: z.number().int().min(1), zoneId: ZONE, version: z.number().int().min(1), note: z.string().max(1000).optional() });
const Line = z.object({ sv: z.string().max(80), fr: z.string().max(80), en: z.string().max(80) });
const CategoryBody = z.object({ id: CATEGORY.optional(), label: z.string().trim().min(1).max(40), line: Line, seats: z.number().int().min(1).max(8), sort: z.number().int().min(0).optional() });
const ArchiveBody = z.object({ reason: z.string().trim().min(1).max(500) });

const RESTORE_DAYS: number = (contract as unknown as { categoryCatalog: { restoreDays: number } }).categoryCatalog.restoreDays;
const DAY_MS = 86_400_000;
const TERMINAL: readonly string[] = (contract as unknown as { tripStatus: { terminal: string[] } }).tripStatus.terminal;

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

function checkZone(who: Principal, zoneId: string): void {
  if (!adminCoversZone(who, zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
}

/* ---------------------------------------------------------------- manual surge */

const SURGE_ACTION = "surge.schedule";

async function zoneSurge(ex: Executor, zoneId: string): Promise<DocSurge | undefined> {
  return (await liveDocument<{ surge?: DocSurge }>(ex, "pricing", zoneId))?.document.surge;
}

type SchedulePayload = z.infer<typeof ScheduleBody> & { zoneId: string };

async function putSchedule(trx: Trx, payload: SchedulePayload, by: string, now: Date) {
  const zone = await getZone(trx, payload.zoneId);
  const surge = await zoneSurge(trx, zone.zoneId);
  if (surge === undefined) throw new ApiError("unavailable", "Prices are not set for this zone yet.", { reason: "pricing_not_published", retryAfterSeconds: 60 });
  const current = await currentSchedule(trx, zone.zoneId);
  const live = current && scheduleView(current, now).status !== "ended" && scheduleView(current, now).status !== "cancelled" ? current : undefined;
  if ((live?.version ?? 0) !== payload.expectedVersion) throw new ApiError("version_mismatch", "The surge changed since you last saw it.", { ...(live ? { projection: scheduleView(live, now) } : {}) });
  // The value the admin chose on the slider is the surge's maximum (owner 2026-10-27, no extra box), at most ×6.
  const cap = Math.max(1, ...payload.points.map((p) => p.multiplier));
  if (cap > SLIDER_TOP) throw badRequest(`The surge is not valid: at most ×${SLIDER_TOP}.`, "invalid_surge");
  const schedule = { startAt: payload.startAt, endAt: payload.endAt, stepMinutes: payload.stepMinutes ?? 5, cap, points: payload.points };
  const problems = validateSchedule(schedule);
  if (problems.length > 0) throw badRequest(`The surge is not valid: ${problems.join("; ")}.`, "invalid_surge");
  if (live) await trx.updateTable("surge_schedules").set({ status: "cancelled", ended_at: now }).where("schedule_id", "=", live.schedule_id).execute();
  const scheduleId = newId("sur", now.getTime());
  await trx
    .insertInto("surge_schedules")
    .values({
      schedule_id: scheduleId,
      zone_id: zone.zoneId,
      category_ids: payload.categoryIds ?? [],
      start_at: new Date(payload.startAt),
      end_at: new Date(payload.endAt),
      step_minutes: schedule.stepMinutes,
      cap,
      points: JSON.stringify(payload.points),
      status: "scheduled",
      version: (live?.version ?? 0) + 1,
      created_by: by,
      created_at: now,
    })
    .execute();
  const row = (await trx.selectFrom("surge_schedules").selectAll().where("schedule_id", "=", scheduleId).executeTakeFirstOrThrow()) as Parameters<typeof scheduleView>[0];
  return scheduleView(row, now);
}

registerApprovalHandler(SURGE_ACTION, async (trx, payload, _approvedBy, requestedBy, now) => putSchedule(trx, payload as SchedulePayload, requestedBy, now));

/* ---------------------------------------------------------------- car type catalog */

type CategoryRow = { category_id: string; label: string; line: Record<string, string>; seats: number; built_in: boolean; sort: number; archived_at: Date | null; archived_by: string | null; archive_reason: string | null };

export function categoryView(row: CategoryRow) {
  return {
    id: row.category_id,
    label: row.label,
    line: { sv: row.line["sv"] ?? "", fr: row.line["fr"] ?? "", en: row.line["en"] ?? "" },
    seats: row.seats,
    builtIn: row.built_in,
    sort: row.sort,
    ...(row.archived_at
      ? {
          archivedAt: row.archived_at.toISOString(),
          ...(row.archived_by ? { archivedBy: row.archived_by } : {}),
          ...(row.archive_reason ? { archiveReason: row.archive_reason } : {}),
          restoreUntil: new Date(row.archived_at.getTime() + RESTORE_DAYS * DAY_MS).toISOString(),
        }
      : {}),
  };
}

/** Active car types, then the archived ones still restorable; one archived longer ago is gone. */
export async function listCategories(ex: Executor, now: Date) {
  const rows = (await ex.selectFrom("categories").selectAll().orderBy("sort").orderBy("category_id").execute()) as unknown as CategoryRow[];
  const shown = rows.filter((r) => r.archived_at === null || now.getTime() - r.archived_at.getTime() < RESTORE_DAYS * DAY_MS);
  return { categories: [...shown.filter((r) => !r.archived_at), ...shown.filter((r) => r.archived_at)].map(categoryView), restoreDays: RESTORE_DAYS };
}

const slug = (label: string) =>
  label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([^a-z])/, "c_$1")
    .slice(0, 32);

async function lockCategory(trx: Trx, id: string): Promise<CategoryRow> {
  const row = (await trx.selectFrom("categories").selectAll().where("category_id", "=", id).forUpdate().executeTakeFirst()) as unknown as CategoryRow | undefined;
  if (row === undefined) throw new ApiError("not_found", "No such car type.", { reason: "category_not_found" });
  return row;
}

/** Switches a category off in every zone's live pricing (a new version where it was on). */
async function switchOffEverywhere(trx: Trx, categoryId: string, by: string, now: Date): Promise<string[]> {
  const zones = await trx.selectFrom("config_live").select("zone_id").where("doc", "=", "pricing").orderBy("zone_id").execute();
  const changed: string[] = [];
  for (const { zone_id } of zones) {
    const version = await rewriteLive(
      trx,
      "pricing",
      zone_id,
      (document) => {
        const categories = document["categories"] as Record<string, { enabled?: boolean }> | undefined;
        const category = categories?.[categoryId];
        if (!category || category.enabled === false) return null;
        category.enabled = false;
        return document;
      },
      `car type ${categoryId} archived: switched off`,
      by,
      now,
    );
    if (version !== null) changed.push(zone_id);
  }
  return changed;
}

/** The catalog the apps get: label, sub-line and seats from the admin catalog; archived car types left out. */
export async function withCatalog(ex: Executor, document: Record<string, unknown>): Promise<Record<string, unknown>> {
  const catalog = document["catalog"] as { categories?: Array<Record<string, unknown>> } | undefined;
  if (!catalog || !Array.isArray(catalog.categories)) return document;
  const rows = (await ex.selectFrom("categories").selectAll().execute()) as unknown as CategoryRow[];
  const byId = new Map(rows.map((r) => [r.category_id, r]));
  const categories = catalog.categories
    .filter((c) => !byId.get(String(c["id"]))?.archived_at)
    .map((c) => {
      const row = byId.get(String(c["id"]));
      return row ? { ...c, label: row.label, seats: row.seats, line: categoryView(row).line } : c;
    });
  return { ...document, catalog: { ...catalog, categories } };
}

export async function pricingRoutes(app: FastifyInstance, deps: PricingDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal, body: unknown) => ({ actor: "admin" as const, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body });
  const zoneParam = (request: FastifyRequest) => parseBody(z.object({ zoneId: ZONE }), request.params).zoneId;

  app.get(`${API_PREFIX}/admin/zones/:zoneId/surge`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "settings.read");
    const zoneId = zoneParam(request);
    checkZone(who, zoneId);
    await getZone(deps.db, zoneId);
    const row = await currentSchedule(deps.db, zoneId);
    const view = row ? scheduleView(row, now()) : undefined;
    if (!view || view.status === "ended" || view.status === "cancelled") return reply.status(204).send();
    return view;
  });

  // Manual surge Start (owner 2026-10-27): a flat or curved surge with its end time, within the admin's maximum.
  app.put(`${API_PREFIX}/admin/zones/:zoneId/surge`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "settings.publish");
    const zoneId = zoneParam(request);
    checkZone(who, zoneId);
    const body = parseBody(ScheduleBody, request.body);
    const outcome = await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      const ran = await runOrRequest(trx, who, { action: SURGE_ACTION, targetType: "config", targetId: `surge:${zoneId}`, zoneId, payload: { ...body, zoneId }, approvePermission: "approval.decide" }, now());
      return ran.ran ? { status: 200, body: ran.result } : { status: 202, body: ran.pending };
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  // Manual surge Stop: back to ×1.0 (or to the planned / smart surge) at once, for every admin.
  app.post(`${API_PREFIX}/admin/zones/:zoneId/surge/end`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.publish");
    const zoneId = zoneParam(request);
    checkZone(who, zoneId);
    const body = parseBody(EndBody, request.body);
    const outcome = await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      const row = await currentSchedule(trx, zoneId);
      const view = row ? scheduleView(row, now()) : undefined;
      if (!row || !view || view.status === "ended" || view.status === "cancelled") throw new ApiError("invalid_transition", "There is no surge to stop.", { reason: "no_surge" });
      if (row.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The surge changed since you last saw it.", { projection: view });
      await trx.updateTable("surge_schedules").set({ status: "ended", ended_at: now(), end_at: now() < row.end_at ? now() : row.end_at }).where("schedule_id", "=", row.schedule_id).execute();
      await audit(trx, { adminId: who.subjectId, action: "surge.end", targetType: "config", targetId: `surge:${zoneId}`, zoneId, detail: { scheduleId: row.schedule_id, ...(body.note ? { note: body.note } : {}) }, at: now() });
      return { status: 200, body: scheduleView((await currentSchedule(trx, zoneId))!, now()) };
    });
    return outcome.body;
  });

  // v0.7.2 (contract.json#surgeLive.now): the surge now in each zone of the admin's scope, with its demand.
  app.get(`${API_PREFIX}/admin/surge/now`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.read");
    const query = parseBody(z.object({ zoneIds: z.string().max(2000).optional() }), request.query);
    const asked = query.zoneIds ? query.zoneIds.split(",").map((id) => id.trim()).filter(Boolean) : undefined;
    if (asked?.some((id) => !ZONE.safeParse(id).success)) throw badRequest("zoneIds: not valid zone ids.", "invalid_zone_ids");
    const open = await deps.db.selectFrom("zones").select("zone_id").where("open", "=", true).orderBy("zone_id").execute();
    const zoneIds = open.map((zone) => zone.zone_id).filter((id) => (asked ? asked.includes(id) : true) && adminCoversZone(who, id));
    return surgeNow(deps.db, zoneIds, now());
  });

  // v0.7.2 (contract.json#surgeLive.history): the demand chart, the rider price check and the surge timeline.
  app.get(`${API_PREFIX}/admin/zones/:zoneId/surge/history`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.read");
    const zoneId = zoneParam(request);
    checkZone(who, zoneId);
    await getZone(deps.db, zoneId);
    const query = parseBody(z.object({ hours: z.coerce.number().int().min(1).max(24).default(6), bucketMin: z.coerce.number().int().refine((v) => [5, 10, 15, 30, 60].includes(v)).default(10) }), request.query);
    return surgeHistory(deps.db, zoneId, query.hours, query.bucketMin, now());
  });

  // v0.7.2 (contract.json#driverSurgeMap): coloured zones for the driver's Home map; never the multiplier.
  app.get(`${API_PREFIX}/driver/surge-map`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return driverSurgeMap(deps.db, who.subjectId, now());
  });

  // Pricing › History (and every other config document).
  app.get(`${API_PREFIX}/admin/config/:doc/history`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.read");
    const { doc } = parseBody(z.object({ doc: z.enum(CONFIG_DOCS as [ConfigDoc, ...ConfigDoc[]]) }), request.params);
    const query = parseBody(HistoryQuery, request.query);
    checkZone(who, query.zoneId);
    return configHistory(deps.db, doc, query.zoneId, { cursor: query.cursor, limit: query.limit });
  });

  // Restore / Undo last publish: the old version is published again, with every effect of a publish.
  app.post(`${API_PREFIX}/admin/config/:doc/restore`, async (request, reply) => {
    const { doc } = parseBody(z.object({ doc: z.enum(CONFIG_DOCS as [ConfigDoc, ...ConfigDoc[]]) }), request.params);
    const who = await authenticateAdmin(request, guard, PUBLISH_PERMISSION[doc]);
    const body = parseBody(RestoreBody, request.body);
    checkZone(who, body.zoneId);
    const outcome = await runIdempotent<Publication | PendingApproval>(deps.db, idem(request, who, body), async (trx) => {
      await getZone(trx, body.zoneId);
      const ran = await runOrRequest<Publication>(
        trx,
        who,
        { action: PUBLISH_ACTION, targetType: "config", targetId: doc, zoneId: body.zoneId, payload: { doc, zoneId: body.zoneId, expectedVersion: body.expectedVersion, restoreVersion: body.version, ...(body.note ? { note: body.note } : {}) }, approvePermission: APPROVE_PERMISSION[doc] },
        now(),
      );
      return ran.ran ? { status: 200, body: ran.result } : { status: 202, body: ran.pending };
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  // Manage categories.
  app.get(`${API_PREFIX}/admin/categories`, async (request) => {
    await authenticateAdmin(request, guard, "settings.read");
    return listCategories(deps.db, now());
  });

  app.post(`${API_PREFIX}/admin/categories`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "settings.publish");
    const body = parseBody(CategoryBody, request.body);
    const outcome = await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      const id = body.id ?? slug(body.label);
      if (!/^[a-z][a-z0-9_]{1,31}$/.test(id)) throw badRequest("Give the car type a name with letters.", "invalid_category_id");
      const clash = await trx.selectFrom("categories").select(["category_id", "label"]).where((eb) => eb.or([eb("category_id", "=", id), eb(eb.fn("lower", ["label"]), "=", body.label.toLowerCase())])).executeTakeFirst();
      if (clash) throw new ApiError("conflict", `${clash.label} already exists.`, { reason: "category_exists" });
      const sort = body.sort ?? Number((await trx.selectFrom("categories").select((eb) => eb.fn.max("sort").as("m")).executeTakeFirst())?.m ?? -1) + 1;
      await trx.insertInto("categories").values({ category_id: id, label: body.label, line: JSON.stringify(body.line), seats: body.seats, built_in: false, sort, archived_at: null, archived_by: null, archive_reason: null, updated_at: now() }).execute();
      await audit(trx, { adminId: who.subjectId, action: "category.create", targetType: "category", targetId: id, detail: { label: body.label, seats: body.seats, line: body.line }, at: now() });
      return { status: 201, body: categoryView((await lockCategory(trx, id)) as CategoryRow) };
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  app.put(`${API_PREFIX}/admin/categories/:categoryId`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.publish");
    const { categoryId } = parseBody(z.object({ categoryId: CATEGORY }), request.params);
    const body = parseBody(CategoryBody, request.body);
    const outcome = await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      const before = await lockCategory(trx, categoryId);
      await trx.updateTable("categories").set({ label: body.label, line: JSON.stringify(body.line), seats: body.seats, ...(body.sort !== undefined ? { sort: body.sort } : {}), updated_at: now() }).where("category_id", "=", categoryId).execute();
      await audit(trx, { adminId: who.subjectId, action: "category.edit", targetType: "category", targetId: categoryId, detail: { before: categoryView(before), label: body.label, seats: body.seats, line: body.line }, at: now() });
      return { status: 200, body: categoryView(await lockCategory(trx, categoryId)) };
    });
    return outcome.body;
  });

  // Delete = archive for 30 days; refused while trips of the car type are booked (owner 2026-10-27).
  app.post(`${API_PREFIX}/admin/categories/:categoryId/archive`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.publish");
    const { categoryId } = parseBody(z.object({ categoryId: CATEGORY }), request.params);
    const body = parseBody(ArchiveBody, request.body);
    const outcome = await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      const row = await lockCategory(trx, categoryId);
      if (row.archived_at) throw new ApiError("invalid_transition", "This car type is already deleted.", { reason: "category_archived" });
      const booked = await trx.selectFrom("trips").select((eb) => eb.fn.countAll<string>().as("n")).where("category_id", "=", categoryId).where("status", "not in", TERMINAL as string[]).executeTakeFirstOrThrow();
      if (Number(booked.n) > 0) throw new ApiError("invalid_transition", `${row.label} has ${booked.n} booked trip(s); delete it when they are done.`, { reason: "category_in_use" });
      await trx.updateTable("categories").set({ archived_at: now(), archived_by: who.subjectId, archive_reason: body.reason, updated_at: now() }).where("category_id", "=", categoryId).execute();
      const zones = await switchOffEverywhere(trx, categoryId, who.subjectId, now());
      await audit(trx, { adminId: who.subjectId, action: "category.archive", targetType: "category", targetId: categoryId, detail: { reason: body.reason, switchedOffIn: zones }, at: now() });
      return { status: 200, body: categoryView(await lockCategory(trx, categoryId)) };
    });
    return outcome.body;
  });

  // Restore within 30 days: back in the catalog with its old prices, off in every zone.
  app.post(`${API_PREFIX}/admin/categories/:categoryId/restore`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.publish");
    const { categoryId } = parseBody(z.object({ categoryId: CATEGORY }), request.params);
    const outcome = await runIdempotent(deps.db, idem(request, who, request.body ?? null), async (trx) => {
      const row = await lockCategory(trx, categoryId);
      if (!row.archived_at) throw new ApiError("invalid_transition", "This car type is not deleted.", { reason: "category_not_archived" });
      if (now().getTime() - row.archived_at.getTime() >= RESTORE_DAYS * DAY_MS) throw new ApiError("invalid_transition", `It was deleted more than ${RESTORE_DAYS} days ago.`, { reason: "restore_expired" });
      await trx.updateTable("categories").set({ archived_at: null, archived_by: null, archive_reason: null, updated_at: now() }).where("category_id", "=", categoryId).execute();
      await switchOffEverywhere(trx, categoryId, who.subjectId, now());
      await audit(trx, { adminId: who.subjectId, action: "category.restore", targetType: "category", targetId: categoryId, detail: {}, at: now() });
      return { status: 200, body: categoryView(await lockCategory(trx, categoryId)) };
    });
    return outcome.body;
  });
}
