import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { adminCoversZone, authenticate, authenticateAdmin } from "../auth/guard.js";
import type { Db, Executor } from "../db/db.js";
import { audit } from "../admin/audit.js";
import { driverView } from "../drivers/service.js";
import { ApiError } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { settingsFor } from "../reservations/service.js";
import { searchKey } from "./geometry.js";
import { areaAt, checkPreferredIds, PREFERRED, searchAreas } from "./service.js";

/** v0.18.172 driver preferred areas (contract.json#preferredAreas): driver search, area at a point, his list; admin list + switch. */

export type AreaDeps = { db: Db; jwtSecret: string; clock?: () => Date };
const AREA_ID = z.string().regex(/^[A-Z0-9-]{3,40}$/);
const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

async function driverOf(ex: Executor, driverId: string) {
  return ex.selectFrom("drivers").select(["zone_ids", "language"]).where("driver_id", "=", driverId).executeTakeFirstOrThrow();
}

/** The most areas he may keep: the lowest preferredAreasMax of his zones (default 10). */
async function maxFor(ex: Executor, zoneIds: string[]): Promise<number> {
  let max = 30;
  for (const zoneId of zoneIds) max = Math.min(max, (await settingsFor(ex, zoneId)).preferredAreasMax);
  return zoneIds.length === 0 ? 10 : max;
}

export async function areaRoutes(app: FastifyInstance, deps: AreaDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();

  app.get(`${API_PREFIX}/driver/areas/search`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const query = parseBody(z.object({ q: z.string().max(80).default(""), limit: z.coerce.number().int().min(1).max(PREFERRED.searchLimit).default(PREFERRED.searchLimit) }).passthrough(), request.query);
    const driver = await driverOf(deps.db, who.subjectId);
    return searchAreas(deps.db, driver.zone_ids, query.q, query.limit, driver.language);
  });

  // The point is read, used and dropped: in the BODY, never in the URL (GM 2026-11-28); never stored, never written to the
  // log at any level (GM edit 2), no Google call. A read: no Idempotency-Key needed.
  const Point = z.object({ lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }).strict();
  app.post(`${API_PREFIX}/driver/areas/at`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const parsed = Point.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError("invalid_request", "lat and lng must be numbers (-90..90, -180..180).", { reason: "invalid_point" });
    const driver = await driverOf(deps.db, who.subjectId);
    return areaAt(deps.db, driver.zone_ids, parsed.data.lat, parsed.data.lng, driver.language);
  });

  app.put(`${API_PREFIX}/driver/preferred-areas`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const body = parseBody(z.object({ areaIds: z.array(AREA_ID).max(100) }).strict(), request.body);
    const result = await runIdempotent(deps.db, { actor: "driver", subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null }, async (trx) => {
      const driver = await driverOf(trx, who.subjectId);
      const ids = await checkPreferredIds(trx, driver.zone_ids, body.areaIds, await maxFor(trx, driver.zone_ids));
      await trx.updateTable("drivers").set({ preferred_area_ids: ids, updated_at: now() }).where("driver_id", "=", who.subjectId).execute();
      const row = await trx.selectFrom("drivers").selectAll().where("driver_id", "=", who.subjectId).executeTakeFirstOrThrow();
      return { status: 200, body: await driverView(trx, row, "driver", now()) };
    });
    return result.body;
  });

  const adminView = (r: { area_id: string; name: string; name_override: string | null; kind: string; zone_id: string; country: string; parent_name: string | null; derived: boolean; source: string; licence: string; source_year: number; active: boolean; updated_at: Date }) => ({
    areaId: r.area_id, name: r.name_override ?? r.name, officialName: r.name, nameOverride: r.name_override, kind: r.kind, zoneId: r.zone_id, country: r.country,
    ...(r.parent_name ? { parentName: r.parent_name } : {}), derived: r.derived, source: r.source, licence: r.licence, sourceYear: r.source_year, active: r.active, updatedAt: r.updated_at.toISOString(),
  });
  const ADMIN_COLUMNS = ["area_id", "name", "name_override", "kind", "zone_id", "country", "parent_name", "derived", "source", "licence", "source_year", "active", "updated_at"] as const;
  const PAGE = 100;

  app.get(`${API_PREFIX}/admin/areas`, async (request) => {
    const who = await authenticateAdmin(request, guard, "zones.read");
    const query = parseBody(z.object({ zoneId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), q: z.string().max(80).optional(), cursor: z.string().regex(/^[A-Z0-9-]{3,40}$/).optional() }).passthrough(), request.query);
    if (query.zoneId !== undefined && !adminCoversZone(who, query.zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
    let q = deps.db.selectFrom("areas").select(ADMIN_COLUMNS);
    if (query.zoneId !== undefined) q = q.where("zone_id", "=", query.zoneId);
    else if (!who.zones.includes("*")) q = q.where("zone_id", "in", who.zones.length > 0 ? who.zones : ["-"]);
    const key = query.q ? searchKey(query.q) : "";
    if (key) q = q.where("search_key", "like", `%${key}%`);
    if (query.cursor) q = q.where("area_id", ">", query.cursor);
    const rows = await q.orderBy("area_id").limit(PAGE + 1).execute();
    const items = rows.slice(0, PAGE).map(adminView);
    return { items, nextCursor: rows.length > PAGE ? items[items.length - 1]!.areaId : null };
  });

  app.patch(`${API_PREFIX}/admin/areas/:areaId`, async (request) => {
    const who = await authenticateAdmin(request, guard, "zones.edit");
    const { areaId } = parseBody(z.object({ areaId: AREA_ID }), request.params);
    const body = parseBody(z.object({ active: z.boolean().optional(), nameOverride: z.string().trim().min(1).max(120).nullable().optional() }).strict(), request.body);
    const result = await runIdempotent(deps.db, { actor: "admin", subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null }, async (trx) => {
      const row = await trx.selectFrom("areas").select(ADMIN_COLUMNS).where("area_id", "=", areaId).forUpdate().executeTakeFirst();
      if (!row) throw new ApiError("not_found", "No such area.", { reason: "area_not_found" });
      if (!adminCoversZone(who, row.zone_id)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
      const at = now();
      await trx.updateTable("areas").set({
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.nameOverride !== undefined ? { name_override: body.nameOverride } : {}),
        updated_at: sql<Date>`greatest(${at}::timestamptz, updated_at + interval '1 millisecond')`,
      }).where("area_id", "=", areaId).execute();
      await audit(trx, { adminId: who.subjectId, action: "area.update", targetType: "area", targetId: areaId, zoneId: row.zone_id, detail: { ...(body.active !== undefined ? { active: body.active, wasActive: row.active } : {}), ...(body.nameOverride !== undefined ? { nameOverride: body.nameOverride } : {}) }, at });
      const updated = await trx.selectFrom("areas").select(ADMIN_COLUMNS).where("area_id", "=", areaId).executeTakeFirstOrThrow();
      return { status: 200, body: adminView(updated) };
    });
    return result.body;
  });
}
