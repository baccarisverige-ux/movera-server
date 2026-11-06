import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { adminCoversZone, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { audit } from "../admin/audit.js";
import { blockPair, listPairs, removePair } from "./service.js";

/** v0.18.40 §64 fix job 10 (contract.json#blockedPairs.admin / .undo): Admin › Trips › Block this pair; Support's undo. */
const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const BlockBody = z.object({ reason: z.string().trim().min(1).max(300).optional() }).strict();
const ListQuery = z.object({ riderId: ID.optional(), driverId: ID.optional() });

export type BlockedPairDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export async function blockedPairRoutes(app: FastifyInstance, deps: BlockedPairDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal, body: unknown) => ({ actor: who.actor, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body });

  app.post(`${API_PREFIX}/admin/trips/:tripId/block-pair`, async (request) => {
    const who = await authenticateAdmin(request, guard, "riders.block");
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    // Scope first: an admin outside the trip's zone learns nothing about the body (route matrix, e2e 12).
    const zone = await deps.db.selectFrom("trips").select("zone_id").where("trip_id", "=", tripId).executeTakeFirst();
    if (zone && !adminCoversZone(who, zone.zone_id)) throw new ApiError("forbidden", "This trip is outside your zones.", { reason: "zone_out_of_scope" });
    const body = parseBody(BlockBody, request.body ?? {});
    return (await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      const trip = await trx.selectFrom("trips").select(["trip_id", "rider_id", "driver_id", "zone_id"]).where("trip_id", "=", tripId).executeTakeFirst();
      if (!trip) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
      if (!trip.driver_id) throw new ApiError("invalid_transition", "This trip has no driver to block.", { reason: "no_driver" });
      const at = now();
      const pair = await blockPair(trx, { riderId: trip.rider_id, driverId: trip.driver_id, by: "admin", reason: body.reason ?? null, tripId, adminId: who.subjectId }, at);
      await audit(trx, { adminId: who.subjectId, action: "blocked_pair.add", targetType: "trip", targetId: tripId, zoneId: trip.zone_id, detail: { pairId: pair.pairId, riderId: pair.riderId, driverId: pair.driverId, reason: body.reason ?? null }, at });
      return { status: 200, body: pair };
    })).body;
  });

  app.delete(`${API_PREFIX}/admin/blocked-pairs/:pairId`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "riders.block");
    const { pairId } = parseBody(z.object({ pairId: ID }), request.params);
    await runIdempotent(deps.db, idem(request, who, {}), async (trx) => {
      const at = now();
      const pair = await removePair(trx, pairId, who.subjectId, at);
      if (!pair) throw new ApiError("not_found", "No such blocked pair.", { reason: "pair_not_found" });
      await audit(trx, { adminId: who.subjectId, action: "blocked_pair.remove", targetType: "rider", targetId: pair.riderId, detail: { pairId, driverId: pair.driverId }, at });
      return { status: 204, body: null };
    });
    return reply.status(204).send();
  });

  app.get(`${API_PREFIX}/admin/blocked-pairs`, async (request) => {
    await authenticateAdmin(request, guard, "riders.read");
    const q = parseBody(ListQuery, request.query);
    if (!q.riderId && !q.driverId) throw badRequest("Give riderId or driverId.", "person_missing");
    return listPairs(deps.db, q);
  });
}
