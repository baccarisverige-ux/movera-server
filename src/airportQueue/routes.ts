import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { adminCoversZone, authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { audit } from "../admin/audit.js";
import { contract } from "../contract/contract.js";
import { boundsOf, polygonProblem, type Polygon } from "../zones/geometry.js";
import { areaIdOf, areaView, emptyArea, queueFeed, queueStatus, type AreaRow } from "./service.js";

/** v0.18.39 §63 fix job 9 (contract.json#airportQueue): the driver's place, the admin's queue area and Dashboard feed. */

type Ranges = { leaveGraceMin: [number, number]; offerSeconds: [number, number]; maxQueueOffers: [number, number] };
type Defaults = { leaveGraceMin: number; offerSeconds: number; maxQueueOffers: number; keepPlaceAfterDecline: boolean };
const AQ = (contract as unknown as { airportQueue: { ranges: Ranges; defaults: Defaults } }).airportQueue;
const int = (r: [number, number]) => z.number().int().min(r[0]).max(r[1]);
const Point = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const Body = z.object({
  polygon: z.array(Point).min(3).max(500),
  on: z.boolean(),
  leaveGraceMin: int(AQ.ranges.leaveGraceMin).optional(),
  offerSeconds: int(AQ.ranges.offerSeconds).optional(),
  maxQueueOffers: int(AQ.ranges.maxQueueOffers).optional(),
  keepPlaceAfterDecline: z.boolean().optional(),
}).strict();
const ZoneParam = z.object({ zoneId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

export type AirportQueueDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export async function airportQueueRoutes(app: FastifyInstance, deps: AirportQueueDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal, body: unknown) => ({ actor: who.actor, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body });
  const scope = (who: Principal, zoneId: string) => {
    if (!adminCoversZone(who, zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
  };

  app.get(`${API_PREFIX}/driver/airport-queue`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return queueStatus(deps.db, who.subjectId, now());
  });

  app.get(`${API_PREFIX}/admin/zones/:zoneId/queue-area`, async (request) => {
    const who = await authenticateAdmin(request, guard, "zones.read");
    const { zoneId } = parseBody(ZoneParam, request.params);
    scope(who, zoneId);
    const row = (await deps.db.selectFrom("airport_queue_areas").selectAll().where("airport_zone_id", "=", zoneId).executeTakeFirst()) as AreaRow | undefined;
    if (!row) throw new ApiError("not_found", "This airport has no queue area yet.", { reason: "queue_area_not_found" });
    return areaView(row);
  });

  app.put(`${API_PREFIX}/admin/zones/:zoneId/queue-area`, async (request) => {
    const who = await authenticateAdmin(request, guard, "zones.edit");
    const { zoneId } = parseBody(ZoneParam, request.params);
    // Scope first: an admin outside this zone learns nothing about the body (route matrix, e2e 12).
    scope(who, zoneId);
    const body = parseBody(Body, request.body);
    const problem = polygonProblem(body.polygon as Polygon);
    if (problem !== null) throw badRequest("The queue area is not a simple shape.", problem);
    const outcome = await runIdempotent(deps.db, idem(request, who, body), async (trx) => {
      const zone = await trx.selectFrom("zones").select(["zone_id", "kind"]).where("zone_id", "=", zoneId).forUpdate().executeTakeFirst();
      if (!zone) throw new ApiError("not_found", "No such zone.", { reason: "zone_not_found" });
      if (zone.kind !== "airport") throw badRequest("Only an airport zone has a queue area.", "not_airport_zone");
      const at = now();
      const values = {
        polygon: JSON.stringify(body.polygon),
        ...boundsOf(body.polygon as Polygon),
        is_on: body.on,
        // A save is the whole area: a number left out takes its default (contract.json#airportQueue.defaults).
        leave_grace_min: body.leaveGraceMin ?? AQ.defaults.leaveGraceMin,
        offer_seconds: body.offerSeconds ?? AQ.defaults.offerSeconds,
        max_queue_offers: body.maxQueueOffers ?? AQ.defaults.maxQueueOffers,
        keep_place_after_decline: body.keepPlaceAfterDecline ?? AQ.defaults.keepPlaceAfterDecline,
        updated_at: at,
        updated_by: who.subjectId,
      };
      const row = (await trx.insertInto("airport_queue_areas").values({ area_id: areaIdOf(zoneId), airport_zone_id: zoneId, ...values })
        .onConflict((c) => c.column("airport_zone_id").doUpdateSet(values)).returningAll().executeTakeFirstOrThrow()) as AreaRow;
      if (!row.is_on) await emptyArea(trx, row.area_id, at);
      await audit(trx, { adminId: who.subjectId, action: "zone.queue_area", targetType: "zone", targetId: zoneId, zoneId, detail: { on: row.is_on, points: body.polygon.length, leaveGraceMin: row.leave_grace_min, offerSeconds: row.offer_seconds, maxQueueOffers: row.max_queue_offers, keepPlaceAfterDecline: row.keep_place_after_decline }, at });
      return { status: 200, body: areaView(row) };
    });
    return outcome.body;
  });

  app.get(`${API_PREFIX}/admin/airport-queues`, async (request) => {
    const who = await authenticateAdmin(request, guard, "zones.read");
    return queueFeed(deps.db, (zoneId) => adminCoversZone(who, zoneId), now());
  });
}
