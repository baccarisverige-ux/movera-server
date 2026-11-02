import { driverPerformance } from "../drivers/performance.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sql } from "kysely";
import { authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db, Executor } from "../db/db.js";
import { ApiError, notFound } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { adminDocumentFile, assertReason, checkDocument, driverInScope, reviewDocument } from "../documents/service.js";
import { EXTRA_CATEGORIES, onboardingSettings } from "../drivers/onboardingSettings.js";
import { markSetOffline } from "../drivers/offlineReason.js";
import type { DocumentKey } from "../documents/files.js";
import { adminGetFleet, adminRemoveFleetDriver, listFleets, renewFleetCode, reviewFleet } from "../drivers/onboarding.js";
import { adminDecideInvitation, type InviteDeps } from "../drivers/invitations.js";
import { driverView, loadDriver, rulesBrokenBy, vehicleFullView, type VehicleRow } from "../drivers/service.js";
import { vehicleCountry } from "../drivers/readiness.js";
import { noticeVehicleReview } from "../drivers/reviewNotices.js";
import { sendFile } from "../drivers/routes.js";
import { scheduleTimer } from "../jobs/timers.js";
import { audit } from "./audit.js";
import { adminLinkVehicleDriver, adminReviewBank, adminSetDriverCategories, adminUpdateVehicle } from "./vehicleActions.js";

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
const VehicleReviewBody = z.object({ ...Version, decision: z.enum(["approved", "rejected", "blocked"]), note: z.string().max(1000).optional(), categoryIds: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/)).max(20).optional() });
const DocumentReviewBody = z.object({ decision: z.enum(["approved", "rejected"]), expiresAt: z.string().datetime().optional(), issuedAt: z.string().datetime().optional(), note: z.string().max(1000).optional() });

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
    // v0.18.4 (G3-D2): the same numbers the driver sees.
    return { ...(await driverView(deps.db, row, "admin", now())), performance: await driverPerformance(deps.db, row.driver_id, now()) };
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
  // v0.18.0 (contract.json#driverOnboarding.adminActions): the group 2 admin items on live; zone before body.
  const action = (fn: (trx: import("../db/db.js").Trx, who: Principal, id: string, body: unknown, at: Date) => Promise<unknown>, permission: string, idName: "vehicleId" | "driverId") => async (request: FastifyRequest) => {
    const who = await authenticateAdmin(request, guard, permission);
    const id = param(request, idName);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await fn(trx, who, id, request.body ?? {}, now()) }))).body;
  };
  app.patch(`${API_PREFIX}/admin/vehicles/:vehicleId`, action(adminUpdateVehicle, "vehicles.edit", "vehicleId"));
  app.post(`${API_PREFIX}/admin/vehicles/:vehicleId/driver`, action(adminLinkVehicleDriver, "vehicles.edit", "vehicleId"));
  app.put(`${API_PREFIX}/admin/drivers/:driverId/categories`, action(adminSetDriverCategories, "vehicles.edit", "driverId"));
  app.post(`${API_PREFIX}/admin/drivers/:driverId/bank/review`, action(adminReviewBank, "documents.approve", "driverId"));

  // v0.18.0 (owner items 8 and 13): the info session (or an admin's own admin_check type) marked held.
  app.post(`${API_PREFIX}/admin/drivers/:driverId/documents/:type/check`, async (request) => {
    const who = await authenticateAdmin(request, guard, "documents.approve");
    const driverId = param(request, "driverId");
    const type = param(request, "type");
    // The zone first: an admin outside the driver's zones is refused whatever the body says.
    await driverInScope(deps.db, who, driverId);
    const body = parseBody(z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(1000).optional() }), request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await checkDocument(trx, who, driverId, type, body, now()) }))).body;
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
async function reviewVehicle(trx: Db extends never ? never : import("../db/db.js").Trx, who: Principal, vehicleId: string, body: { expectedVersion: number; decision: "approved" | "rejected" | "blocked"; note?: string | undefined; categoryIds?: string[] | undefined }, now: Date) {
  const row = (await trx.selectFrom("vehicles").selectAll().where("vehicle_id", "=", vehicleId).forUpdate().executeTakeFirst()) as VehicleRow | undefined;
  if (row === undefined) throw notFound("No such vehicle.", "vehicle_not_found");
  const zone = await zoneOfVehicle(trx, row);
  if (!who.zones.includes("*") && (zone === null || !who.zones.includes(zone))) throw new ApiError("forbidden", "This car is outside your zones.", { reason: "zone_out_of_scope" });
  if (row.version !== body.expectedVersion) throw new ApiError("version_mismatch", "The car changed since you last saw it.", { projection: await vehicleFullView(trx, row) });
  // v0.18.5 (G2-D5.7): a rejection or a block says why.
  assertReason(body.decision, body.note);
  // v0.18.3 (R2, vehicleRules.approval): a car that breaks its country's car rules cannot be approved.
  // v0.18.5 (G2-D5.3, vehicleRules.categoriesByAdmin): the admin gives the categories when approving (else the car's own,
  // set by PATCH); at least one ride category, each one the car fits.
  const categoryIds = body.decision === "approved" ? [...new Set(body.categoryIds ?? row.category_ids)] : row.category_ids;
  if (body.decision === "approved") {
    if (!categoryIds.some((c) => !EXTRA_CATEGORIES.includes(c))) throw new ApiError("invalid_request", "Give the car at least one ride category.", { reason: "categories_required" });
    const country = await vehicleCountry(trx, row);
    // Checker finding 4: an id that is no category of the car's country (nor an extra) is refused, never stored.
    const known = new Set([...(await onboardingSettings(trx, country)).vehicles.categories.map((r) => r.category), ...EXTRA_CATEGORIES]);
    const unknown = categoryIds.filter((c) => !known.has(c)).map((c) => `${c}:unknown_category`);
    const problems = [...unknown, ...(await rulesBrokenBy(trx, { ...row, category_ids: categoryIds.filter((c) => known.has(c)) }, country))];
    if (problems.length > 0) throw new ApiError("invalid_transition", "The car breaks the car rules of its country.", { reason: "vehicle_rules_not_met", details: problems });
  }
  await trx.updateTable("vehicles").set({ status: body.decision, category_ids: categoryIds, version: row.version + 1, updated_at: now }).where("vehicle_id", "=", vehicleId).execute();
  // Deep fix 2026-11-02 (g1-g3 M5): a ride type the car no longer has leaves the chosen types of every driver who has
  // this car as his car (extras stay as they are).
  if (body.decision === "approved") {
    const removed = row.category_ids.filter((c) => !categoryIds.includes(c));
    if (removed.length > 0) {
      const users = await trx.selectFrom("drivers").select(["driver_id", "category_ids", "version"]).where("vehicle_id", "=", vehicleId).execute();
      for (const d of users) {
        const kept = d.category_ids.filter((c) => !removed.includes(c));
        if (kept.length !== d.category_ids.length) await trx.updateTable("drivers").set({ category_ids: kept, version: d.version + 1, updated_at: now }).where("driver_id", "=", d.driver_id).execute();
      }
    }
  }
  if (body.decision !== "approved") {
    const drivers = await trx.selectFrom("drivers").select(["driver_id", "online_status", "version"]).where("vehicle_id", "=", vehicleId).where("online_status", "in", ["online", "going_online"]).execute();
    for (const d of drivers) {
      await trx.updateTable("drivers").set({ online_status: "offline", online_since: null, version: d.version + 1, updated_at: now }).where("driver_id", "=", d.driver_id).execute();
      // v0.18.6 (owner "Send the real reason"): vehicle_blocked with the admin's note.
      await markSetOffline(trx, d.driver_id, "vehicle_blocked", { note: body.note ?? null }, now);
      await scheduleTimer(trx, { kind: "withdraw_driver_offers", refId: d.driver_id, dueAt: now, payload: {} });
    }
  }
  // v0.18.3 (R6): the bell notice to the car's fleet owner.
  await noticeVehicleReview(trx, row, body.decision, body.note ?? null, now);
  await audit(trx, { adminId: who.subjectId, action: "vehicle.review", targetType: "vehicle", targetId: vehicleId, zoneId: zone, detail: { from: row.status, to: body.decision, note: body.note ?? null, ...(body.decision === "approved" ? { categoryIds } : {}) }, at: now });
  const fresh = await trx.selectFrom("vehicles").selectAll().where("vehicle_id", "=", vehicleId).executeTakeFirstOrThrow();
  return vehicleFullView(trx, fresh as unknown as VehicleRow);
}
