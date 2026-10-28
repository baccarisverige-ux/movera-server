import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { adminCoversZone, authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db, Executor, Trx } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { audit } from "../admin/audit.js";
import { CONFIG_CHANNEL } from "../config/service.js";
import { boundsOf, polygonProblem, type Polygon } from "./geometry.js";

/**
 * Contract v0.11.0 §20 (contract.json#zones; owner 2026-10-28 and decision #9 "the server's list is the truth"):
 * the admin's Zones page lists, creates, outlines and opens or closes zones (zones.edit, one admin, audited, never
 * deleted); the apps read the open zones with their outline and names.
 */

export type ZoneDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const COUNTRY = z.string().regex(/^[A-Z]{2}$/);
const Name = z.string().trim().min(1).max(80);
const Names = z.object({ sv: Name, fr: Name, en: Name });
const Point = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const PolygonSchema = z.array(Point).min(3).max(500);
const Kind = z.enum(["operating", "airport"]);
const TimeZone = z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/);

const CreateBody = z.object({
  zoneId: ID,
  names: Names,
  country: COUNTRY,
  currency: z.enum(["SEK", "EUR", "TND"]),
  timeZone: TimeZone,
  kind: Kind.optional(),
  polygon: PolygonSchema,
  open: z.boolean().optional(),
});
const FIXED = ["country", "currency", "timeZone", "zoneId"] as const;
const UpdateBody = z.object({ expectedVersion: z.number().int().min(1), names: Names.optional(), kind: Kind.optional(), polygon: PolygonSchema.optional() }).passthrough();
const OpenBody = z.object({ expectedVersion: z.number().int().min(1), note: z.string().max(1000).optional() });
const CountryQuery = z.object({ country: COUNTRY.optional() });

type ZoneRow = {
  zone_id: string;
  names: unknown;
  country: string;
  currency: string;
  time_zone: string;
  kind: string;
  polygon: unknown;
  south: number;
  west: number;
  north: number;
  east: number;
  center_lat: number;
  center_lng: number;
  open: boolean;
  version: number;
  created_at: Date;
  updated_at: Date | null;
  updated_by: string | null;
};

export function zoneView(row: ZoneRow) {
  return {
    zoneId: row.zone_id,
    names: row.names as { sv: string; fr: string; en: string },
    country: row.country,
    currency: row.currency,
    timeZone: row.time_zone,
    kind: row.kind,
    polygon: row.polygon as Polygon,
    bounds: { south: row.south, west: row.west, north: row.north, east: row.east },
    center: { lat: row.center_lat, lng: row.center_lng },
    open: row.open,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    ...(row.updated_at ? { updatedAt: row.updated_at.toISOString() } : {}),
    ...(row.updated_by ? { updatedBy: row.updated_by } : {}),
  };
}

const COLUMNS = ["zone_id", "names", "country", "currency", "time_zone", "kind", "polygon", "south", "west", "north", "east", "center_lat", "center_lng", "open", "version", "created_at", "updated_at", "updated_by"] as const;

async function readZone(ex: Executor, zoneId: string, lock = false): Promise<ZoneRow> {
  let query = ex.selectFrom("zones").select(COLUMNS).where("zone_id", "=", zoneId);
  if (lock) query = query.forUpdate();
  const row = (await query.executeTakeFirst()) as ZoneRow | undefined;
  if (row === undefined) throw new ApiError("not_found", "No such zone.", { reason: "zone_not_found" });
  return row;
}

function checkPolygon(polygon: Polygon): void {
  const problem = polygonProblem(polygon);
  if (problem !== null) throw badRequest("The zone outline is not a simple shape.", problem);
}

/** The shape columns of an outline: bounds and the middle of bounds as center (contract.json#zones.polygon). */
function shape(polygon: Polygon) {
  const b = boundsOf(polygon);
  return { polygon: JSON.stringify(polygon), ...b, center_lat: (b.south + b.north) / 2, center_lng: (b.west + b.east) / 2 };
}

/** config_published { doc: zones } on commit (contract.json#zones.notify). */
async function notifyZone(trx: Trx, row: ZoneRow, at: Date): Promise<void> {
  await sql`SELECT pg_notify(${CONFIG_CHANNEL}, ${JSON.stringify({ doc: "zones", zoneId: row.zone_id, version: row.version, publishedAt: at.toISOString() })})`.execute(trx);
}

function checkScope(who: Principal, zoneId: string): void {
  if (!adminCoversZone(who, zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
}

/** A new zone: the whole scope, or a zone of the same country in scope (contract.json#zones.permissions). */
async function checkCountryScope(ex: Executor, who: Principal, country: string): Promise<void> {
  if (who.zones.includes("*")) return;
  const ids = (await ex.selectFrom("zones").select("zone_id").where("country", "=", country).execute()).map((r) => r.zone_id);
  if (!ids.some((id) => who.zones.includes(id))) throw new ApiError("forbidden", "This country is outside your scope.", { reason: "zone_out_of_scope" });
}

async function openZones(ex: Executor, country: string | undefined) {
  let query = ex.selectFrom("zones").select(COLUMNS).where("open", "=", true);
  if (country) query = query.where("country", "=", country);
  return ((await query.orderBy("zone_id").execute()) as ZoneRow[]).map(zoneView);
}

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export async function zoneRoutes(app: FastifyInstance, deps: ZoneDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal, body: unknown) => ({ actor: who.actor, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body });
  const zoneParam = (request: FastifyRequest) => parseBody(z.object({ zoneId: ID }), request.params).zoneId;

  app.get(`${API_PREFIX}/admin/zones`, async (request) => {
    const who = await authenticateAdmin(request, guard, "zones.read");
    const { country } = parseBody(CountryQuery, request.query);
    let query = deps.db.selectFrom("zones").select(COLUMNS);
    if (country) query = query.where("country", "=", country);
    const rows = (await query.orderBy("zone_id").execute()) as ZoneRow[];
    return { zones: rows.filter((r) => adminCoversZone(who, r.zone_id)).map(zoneView) };
  });

  app.post(`${API_PREFIX}/admin/zones`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "zones.edit");
    const body = parseBody(CreateBody, request.body);
    checkPolygon(body.polygon);
    const outcome = await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      await checkCountryScope(trx, who, body.country);
      const at = now();
      const taken = await trx.selectFrom("zones").select("zone_id").where("zone_id", "=", body.zoneId).executeTakeFirst();
      if (taken) throw new ApiError("conflict", "A zone with this id exists.", { reason: "zone_exists" });
      const other = await trx.selectFrom("zones").select(["currency", "time_zone"]).where("country", "=", body.country).executeTakeFirst();
      if (other && other.currency !== body.currency) throw badRequest(`The zones of ${body.country} are in ${other.currency}.`, "currency_not_country");
      await trx
        .insertInto("zones")
        .values({
          zone_id: body.zoneId,
          name: body.names.en,
          names: JSON.stringify(body.names),
          country: body.country,
          currency: body.currency,
          time_zone: body.timeZone,
          kind: body.kind ?? "operating",
          open: body.open ?? false,
          ...shape(body.polygon),
          created_at: at,
          updated_at: at,
          updated_by: who.subjectId,
        })
        .execute();
      const row = await readZone(trx, body.zoneId);
      await audit(trx, { adminId: who.subjectId, action: "zone.create", targetType: "zone", targetId: body.zoneId, zoneId: body.zoneId, detail: { names: body.names, country: body.country, kind: row.kind, open: row.open, points: body.polygon.length }, at });
      await notifyZone(trx, row, at);
      return { status: 201, body: zoneView(row) };
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  app.put(`${API_PREFIX}/admin/zones/:zoneId`, async (request) => {
    const who = await authenticateAdmin(request, guard, "zones.edit");
    const zoneId = zoneParam(request);
    const body = parseBody(UpdateBody, request.body);
    for (const field of FIXED) if (field in body) throw badRequest(`${field} cannot change.`, "zone_field_fixed");
    if (body.polygon) checkPolygon(body.polygon);
    checkScope(who, zoneId);
    const outcome = await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      const current = await readZone(trx, zoneId, true);
      if (current.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The zone changed since you last saw it.", { projection: zoneView(current) });
      const at = now();
      await trx
        .updateTable("zones")
        .set({
          ...(body.names ? { names: JSON.stringify(body.names), name: body.names.en } : {}),
          ...(body.kind ? { kind: body.kind } : {}),
          ...(body.polygon ? shape(body.polygon) : {}),
          version: current.version + 1,
          updated_at: at,
          updated_by: who.subjectId,
        })
        .where("zone_id", "=", zoneId)
        .execute();
      const row = await readZone(trx, zoneId);
      await audit(trx, { adminId: who.subjectId, action: "zone.update", targetType: "zone", targetId: zoneId, zoneId, detail: { version: row.version, ...(body.names ? { names: body.names } : {}), ...(body.kind ? { kind: body.kind } : {}), ...(body.polygon ? { points: body.polygon.length } : {}) }, at });
      await notifyZone(trx, row, at);
      return { status: 200, body: zoneView(row) };
    });
    return outcome.body;
  });

  for (const action of ["open", "close"] as const) {
    app.post(`${API_PREFIX}/admin/zones/:zoneId/${action}`, async (request) => {
      const who = await authenticateAdmin(request, guard, "zones.edit");
      const zoneId = zoneParam(request);
      const body = parseBody(OpenBody, request.body ?? {});
      checkScope(who, zoneId);
      const outcome = await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
        const current = await readZone(trx, zoneId, true);
        if (current.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The zone changed since you last saw it.", { projection: zoneView(current) });
        const at = now();
        await trx.updateTable("zones").set({ open: action === "open", version: current.version + 1, updated_at: at, updated_by: who.subjectId }).where("zone_id", "=", zoneId).execute();
        const row = await readZone(trx, zoneId);
        await audit(trx, { adminId: who.subjectId, action: `zone.${action}`, targetType: "zone", targetId: zoneId, zoneId, detail: { version: row.version, wasOpen: current.open, ...(body.note ? { note: body.note } : {}) }, at });
        await notifyZone(trx, row, at);
        return { status: 200, body: zoneView(row) };
      });
      return outcome.body;
    });
  }

  for (const actor of ["rider", "driver"] as const) {
    app.get(`${API_PREFIX}/${actor}/zones`, async (request) => {
      await authenticate(request, guard, [actor]);
      const { country } = parseBody(CountryQuery, request.query);
      return { zones: await openZones(deps.db, country) };
    });
  }
}
