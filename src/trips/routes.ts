import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { tripEventsAfter } from "../db/tripLog.js";
import { ApiError, badRequest } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { nearbyVehicles } from "../riders/nearby.js";
import { getRiderProfile, requestDeletion, updateRiderProfile } from "../riders/service.js";
import { tripProjection } from "./projection.js";
import { eventEnvelope } from "../realtime/events.js";
import type { NotificationHub } from "../realtime/hub.js";
import { wantsEventStream } from "../realtime/sse.js";
import { streamTrip } from "../realtime/streams.js";
import { DriverCancelBody, driverCancel } from "./rideRoutes.js";
import { activeTrip, createTrip, getTrip, riderCancel, riderTrips, setCancelReason } from "./service.js";

/** contract §3, §7: trips for the rider (with the deprecated /rides aliases), the rider profile, payment methods. */

const NearbyQuery = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) });

export type TripDeps = { db: Db; jwtSecret: string; paymentMethods: readonly string[]; currency: string; hub?: NotificationHub; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const CancelBody = z.object({ expectedVersion: z.number().int().min(1), reasonCode: z.string().min(1), note: z.string().max(1000).optional() });
const ReasonBody = z.object({ reasonCode: z.string().min(1), note: z.string().max(1000).optional() });
const ListQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.union([z.string(), z.array(z.string())]).optional(),
  kind: z.enum(["live", "scheduled"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) });
const DefaultMethodBody = z.object({ method: z.string(), paymentMethodId: z.string().optional() });

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export async function tripRoutes(app: FastifyInstance, deps: TripDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: { actor: "rider" | "driver" | "admin"; subjectId: string }, method = request.method) => ({
    actor: who.actor,
    subjectId: who.subjectId,
    key: keyOf(request),
    method,
    // The alias and the real path are one route: a retry on either replays the same answer.
    route: request.url.split("?")[0]!.replace(`${API_PREFIX}/rides/`, `${API_PREFIX}/trips/`),
    body: request.body ?? null,
  });

  app.post(`${API_PREFIX}/trips`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => {
      const trip = await createTrip(trx, who.subjectId, request.body ?? {}, { paymentMethods: deps.paymentMethods, now: now() });
      return { status: 201, body: tripProjection(trip, "rider") };
    });
    return reply.status(result.status).send(result.body);
  });

  for (const base of ["trips", "rides"] as const) {
    const param = base === "trips" ? "tripId" : "rideId";
    app.get(`${API_PREFIX}/${base}/:${param}`, async (request) => {
      const who = await authenticate(request, guard, base === "rides" ? ["rider"] : ["rider", "driver", "admin"]);
      const id = parseBody(z.object({ [param]: ID }), request.params)[param] as string;
      return getTrip(deps.db, id, { actor: who.actor as "rider" | "driver" | "admin", subjectId: who.subjectId });
    });

    app.post(`${API_PREFIX}/${base}/:${param}/cancel`, async (request) => {
      const who = await authenticate(request, guard, base === "rides" ? ["rider"] : ["rider", "driver"]);
      const id = parseBody(z.object({ [param]: ID }), request.params)[param] as string;
      if (who.actor === "driver") {
        const body = parseBody(DriverCancelBody, request.body);
        return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await driverCancel(trx, who.subjectId, id, body, now()), "driver") }))).body;
      }
      const body = parseBody(CancelBody, request.body);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await riderCancel(trx, who.subjectId, id, body, now()), "rider") }));
      return result.body;
    });
  }

  app.post(`${API_PREFIX}/trips/:tripId/cancel-reason`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const body = parseBody(ReasonBody, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await setCancelReason(trx, who.subjectId, tripId, body), "rider") }));
    return result.body;
  });

  app.get(`${API_PREFIX}/trips/:tripId/events`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider", "driver", "admin"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const query = parseBody(EventsQuery, request.query);
    const lastEventId = request.headers["last-event-id"];
    const after = query.after ?? (typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : 0);
    const viewer = who.actor as "rider" | "driver" | "admin";
    await getTrip(deps.db, tripId, { actor: viewer, subjectId: who.subjectId });
    if (wantsEventStream(request)) {
      if (deps.hub === undefined) throw new ApiError("unavailable", "Live updates are not available; poll the trip instead.", { reason: "realtime_unavailable", retryAfterSeconds: 5 });
      await streamTrip(request, reply, { db: deps.db, hub: deps.hub, ...(deps.clock ? { clock: deps.clock } : {}) }, tripId, who, after);
      return reply;
    }
    const rows = await tripEventsAfter(deps.db, tripId, after, query.limit + 1);
    const serverTime = now();
    const items = rows.slice(0, query.limit).map((row) => eventEnvelope(row, viewer, serverTime));
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > query.limit && last ? String(last["sequence"]) : null };
  });

  app.get(`${API_PREFIX}/rider/trips/active`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const trip = await activeTrip(deps.db, who.subjectId);
    return trip === undefined ? reply.status(204).send() : tripProjection(trip, "rider");
  });

  app.get(`${API_PREFIX}/rider/trips`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const query = parseBody(ListQuery, request.query);
    const statuses = query.status === undefined ? undefined : Array.isArray(query.status) ? query.status : [query.status];
    return riderTrips(deps.db, who.subjectId, { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}), ...(statuses ? { statuses } : {}), ...(query.kind ? { kind: query.kind } : {}), ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}) });
  });

  app.get(`${API_PREFIX}/rider/profile`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    return getRiderProfile(deps.db, who.subjectId, deps.currency);
  });

  // contract v0.5.2 §13: the free cars around the rider's map, with nothing that tells who drives.
  app.get(`${API_PREFIX}/rider/nearby-vehicles`, async (request) => {
    await authenticate(request, guard, ["rider"]);
    const point = parseBody(NearbyQuery, request.query);
    return nearbyVehicles(deps.db, point, deps.jwtSecret, now());
  });

  app.patch(`${API_PREFIX}/rider/profile`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await updateRiderProfile(trx, who.subjectId, request.body ?? {}, deps.currency, now()) }));
    return result.body;
  });

  // Payment methods (test week: cash only, owner decision). Cash is always there and is the default.
  const methodsPage = () => ({ items: deps.paymentMethods.filter((m) => m === "cash").map((m) => ({ paymentMethodId: m, method: m, isDefault: true })), nextCursor: null });
  app.get(`${API_PREFIX}/payment-methods`, async (request) => {
    await authenticate(request, guard, ["rider"]);
    return methodsPage();
  });
  app.post(`${API_PREFIX}/payment-methods`, async (request) => {
    await authenticate(request, guard, ["rider"]);
    throw badRequest("Only cash is available for now.", "payment_method_not_available");
  });
  app.post(`${API_PREFIX}/payment-methods/default`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const body = parseBody(DefaultMethodBody, request.body);
    if (!deps.paymentMethods.includes(body.method)) throw badRequest("Only cash is available for now.", "payment_method_not_available");
    const result = await runIdempotent(deps.db, idem(request, who), async () => ({ status: 200, body: methodsPage() }));
    return result.body;
  });

  app.post(`${API_PREFIX}/account/deletion`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 202, body: await requestDeletion(trx, who.subjectId, now()) }));
    return reply.status(result.status).send(result.body);
  });
}
