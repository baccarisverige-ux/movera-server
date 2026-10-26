import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sql } from "kysely";
import { authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db, Executor } from "../db/db.js";
import { ApiError, notFound } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { adminDocumentFile, reviewDocument } from "../documents/service.js";
import type { DocumentKey } from "../documents/files.js";
import { adminGetFleet, adminRemoveFleetDriver, listFleets, renewFleetCode, reviewFleet } from "../drivers/onboarding.js";
import { adminDecideInvitation, type InviteDeps } from "../drivers/invitations.js";
import { driverView, loadDriver, vehicleFullView, type VehicleRow } from "../drivers/service.js";
import { sendFile } from "../drivers/routes.js";
import { scheduleTimer } from "../jobs/timers.js";
import { audit } from "./audit.js";

/** contract v0.5.3 §14 (admin side): fleets, driver detail, vehicles list and review, document review and file. */

export type PeopleDeps = { db: Db; jwtSecret: string; documentKey: DocumentKey; invites: InviteDeps; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Version = { expectedVersion: z.number().int().min(1) };
const many = z.union([z.string(), z.array(z.string())]).optional().transform((v): string[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));
const Page = { cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) };
const FleetsQuery = z.object({ ...Page, status: many, country: z.string().length(2).optional(), zoneId: ID.optional(), q: z.string().max(100).optional() });
const VehiclesQuery = z.object({ ...Page, status: many, driverId: ID.optional(), fleetId: ID.optional(), zoneId: ID.optional(), q: z.string().max(100).optional() });
const FleetReviewBody = z.object({ ...Version, decision: z.enum(["approved", "rejected", "blocked"]), note: z.string().max(1000).optional() });
const VersionBody = z.object(Version);
const VehicleReviewBody = z.object({ ...Version, decision: z.enum(["approved", "rejected", "blocked"]), note: z.string().max(1000).optional() });
const DocumentReviewBody = z.object({ decision: z.enum(["approved", "rejected"]), expiresAt: z.string().datetime().optional(), note: z.string().max(1000).optional() });

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};
const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export async function adminPeopleRoutes(app: FastifyInstance, deps: PeopleDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal) => ({ actor: "admin" as const, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });
  const param = <K extends string>(request: FastifyRequest, name: K) => (parseBody(z.object({ [name]: ID } as Record<K, typeof ID>), request.params) as Record<string, string>)[name]!;

  /* ---- fleets */
  app.get(`${API_PREFIX}/admin/fleets`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.read");
    return listFleets(deps.db, who, clean(parseBody(FleetsQuery, request.query)));
  });
  app.get(`${API_PREFIX}/admin/fleets/:fleetId`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.read");
    return adminGetFleet(deps.db, who, param(request, "fleetId"), now());
  });
  app.post(`${API_PREFIX}/admin/fleets/:fleetId/review`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.activate");
    const fleetId = param(request, "fleetId");
    const body = parseBody(FleetReviewBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await reviewFleet(trx, who, fleetId, body, now()) }))).body;
  });
  app.post(`${API_PREFIX}/admin/fleets/:fleetId/code`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.activate");
    const fleetId = param(request, "fleetId");
    const body = parseBody(VersionBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await renewFleetCode(trx, who, fleetId, body, now()) }))).body;
  });
  app.post(`${API_PREFIX}/admin/fleets/:fleetId/drivers/:driverId/remove`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "drivers.activate");
    const { fleetId, driverId } = parseBody(z.object({ fleetId: ID, driverId: ID }), request.params);
    await runIdempotent(deps.db, idem(request, who), async (trx) => {
      await adminRemoveFleetDriver(trx, who, fleetId, driverId, now());
      return { status: 204, body: null };
    });
    return reply.status(204).send();
  });

  // v0.5.3: an admin may accept or cancel a pending invitation or request.
  for (const action of ["accept", "cancel"] as const) {
    app.post(`${API_PREFIX}/admin/fleets/:fleetId/invitations/:invitationId/${action}`, async (request) => {
      const who = await authenticateAdmin(request, guard, "drivers.activate");
      const { fleetId, invitationId } = parseBody(z.object({ fleetId: ID, invitationId: ID }), request.params);
      return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await adminDecideInvitation(trx, deps.invites, who, fleetId, invitationId, action, now()) }))).body;
    });
  }

  /* ---- drivers */
  app.get(`${API_PREFIX}/admin/drivers/:driverId`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.read");
    const row = await loadDriver(deps.db, param(request, "driverId"));
    if (!who.zones.includes("*") && !row.zone_ids.some((z) => who.zones.includes(z))) throw new ApiError("forbidden", "This driver is outside your zones.", { reason: "zone_out_of_scope" });
    return driverView(deps.db, row, "admin");
  });

  /* ---- vehicles */
  app.get(`${API_PREFIX}/admin/vehicles`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.read");
    return listVehicles(deps.db, who, clean(parseBody(VehiclesQuery, request.query)));
  });
  app.post(`${API_PREFIX}/admin/vehicles/:vehicleId/review`, async (request) => {
    const who = await authenticateAdmin(request, guard, "vehicles.edit");
    const vehicleId = param(request, "vehicleId");
    const body = parseBody(VehicleReviewBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await reviewVehicle(trx, who, vehicleId, body, now()) }))).body;
  });

  /* ---- documents */
  app.post(`${API_PREFIX}/admin/documents/:documentId/review`, async (request) => {
    const who = await authenticateAdmin(request, guard, "documents.approve");
    const documentId = param(request, "documentId");
    const body = parseBody(DocumentReviewBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await reviewDocument(trx, who, documentId, body, now()) }))).body;
  });
  app.get(`${API_PREFIX}/admin/documents/:documentId/file`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "documents.approve");
    const documentId = param(request, "documentId");
    const file = await deps.db.transaction().execute((trx) => adminDocumentFile(trx, deps.documentKey, who, documentId, now()));
    return sendFile(reply, file);
  });
}

/** The zone a car is judged by: its fleet's, or (pre-v0.5.3) its owner's first zone. */
async function zoneOfVehicle(ex: Executor, v: VehicleRow): Promise<string | null> {
  if (v.fleet_id) return (await ex.selectFrom("fleets").select("zone_id").where("fleet_id", "=", v.fleet_id).executeTakeFirst())?.zone_id ?? null;
  if (v.driver_id) return (await ex.selectFrom("drivers").select("zone_ids").where("driver_id", "=", v.driver_id).executeTakeFirst())?.zone_ids[0] ?? null;
  return null;
}

async function listVehicles(ex: Executor, who: Principal, input: { cursor?: string | undefined; limit: number; status?: string[] | undefined; driverId?: string | undefined; fleetId?: string | undefined; zoneId?: string | undefined; q?: string | undefined }) {
  let q = ex.selectFrom("vehicles").selectAll();
  if (input.status?.length) q = q.where("status", "in", input.status as never);
  if (input.driverId) q = q.where("driver_id", "=", input.driverId);
  if (input.fleetId) q = q.where("fleet_id", "=", input.fleetId);
  if (input.q) {
    const text = `%${input.q.trim().replace(/[%_\\]/g, "").toUpperCase()}%`;
    q = q.where((eb) => eb.or([eb("plate", "like", text), eb("make", "ilike", text), eb("model", "ilike", text), eb("vehicle_id", "=", input.q!.trim())]));
  }
  if (input.cursor) {
    const [at, id] = Buffer.from(input.cursor, "base64url").toString("utf8").split("|");
    q = q.where(sql<boolean>`(created_at, vehicle_id) < (${new Date(at!)}, ${id!})`);
  }
  const rows = await q.orderBy("created_at", "desc").orderBy("vehicle_id", "desc").limit(input.limit * 3 + 1).execute();
  // Zone scope is per car (its fleet's or owner's zone), so it is filtered after the read.
  const items = [];
  let lastKept: { created_at: Date; vehicle_id: string } | undefined;
  let seen = 0;
  for (const r of rows) {
    const zone = await zoneOfVehicle(ex, r as unknown as VehicleRow);
    const covered = who.zones.includes("*") || (zone !== null && who.zones.includes(zone));
    if (!covered || (input.zoneId && zone !== input.zoneId)) continue;
    seen += 1;
    if (seen > input.limit) break;
    items.push(await vehicleFullView(ex, r as unknown as VehicleRow));
    lastKept = r;
  }
  return { items, nextCursor: seen > input.limit && lastKept ? Buffer.from(`${lastKept.created_at.toISOString()}|${lastKept.vehicle_id}`).toString("base64url") : null };
}

/** POST /admin/vehicles/{id}/review: a car that is no longer approved takes its driver offline (not on a trip). */
async function reviewVehicle(trx: Db extends never ? never : import("../db/db.js").Trx, who: Principal, vehicleId: string, body: { expectedVersion: number; decision: "approved" | "rejected" | "blocked"; note?: string | undefined }, now: Date) {
  const row = (await trx.selectFrom("vehicles").selectAll().where("vehicle_id", "=", vehicleId).forUpdate().executeTakeFirst()) as VehicleRow | undefined;
  if (row === undefined) throw notFound("No such vehicle.", "vehicle_not_found");
  const zone = await zoneOfVehicle(trx, row);
  if (!who.zones.includes("*") && (zone === null || !who.zones.includes(zone))) throw new ApiError("forbidden", "This car is outside your zones.", { reason: "zone_out_of_scope" });
  if (row.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The car changed since you last saw it.", { projection: await vehicleFullView(trx, row) });
  await trx.updateTable("vehicles").set({ status: body.decision, version: row.version + 1, updated_at: now }).where("vehicle_id", "=", vehicleId).execute();
  if (body.decision !== "approved") {
    const drivers = await trx.selectFrom("drivers").select(["driver_id", "online_status", "version"]).where("vehicle_id", "=", vehicleId).where("online_status", "in", ["online", "going_online"]).execute();
    for (const d of drivers) {
      await trx.updateTable("drivers").set({ online_status: "offline", online_since: null, version: d.version + 1, updated_at: now }).where("driver_id", "=", d.driver_id).execute();
      await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: d.driver_id, dueAt: now, payload: {} });
    }
  }
  await audit(trx, { adminId: who.subjectId, action: "vehicle.review", targetType: "vehicle", targetId: vehicleId, zoneId: zone, detail: { from: row.status, to: body.decision, note: body.note ?? null }, at: now });
  const fresh = await trx.selectFrom("vehicles").selectAll().where("vehicle_id", "=", vehicleId).executeTakeFirstOrThrow();
  return vehicleFullView(trx, fresh as unknown as VehicleRow);
}
