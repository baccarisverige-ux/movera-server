import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin, adminCoversZone } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { addVehicle, getDriverProfile, liveDrivers, listVehicles, postLocations, setAvailability, tripTrace, updateDriverProfile } from "./service.js";

/** contract §2, §3.3, §12: driver profile, availability, location, vehicles; admin live drivers and trip trace. */

export type DriverDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const FixSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0), heading: z.number().min(0).lt(360).optional(), speedMps: z.number().min(0).optional(), moving: z.boolean().optional(), measuredAt: z.string().datetime() });
const AvailabilityBody = z.object({ expectedVersion: z.number().int().min(1), onlineStatus: z.enum(["online", "offline"]), location: FixSchema.optional() });

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export async function driverRoutes(app: FastifyInstance, deps: DriverDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, subjectId: string) => ({ actor: "driver" as const, subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });

  app.get(`${API_PREFIX}/driver/profile`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return getDriverProfile(deps.db, who.subjectId);
  });

  app.patch(`${API_PREFIX}/driver/profile`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await updateDriverProfile(trx, who.subjectId, request.body ?? {}, now()) }))).body;
  });

  app.post(`${API_PREFIX}/driver/availability`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const body = parseBody(AvailabilityBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await setAvailability(trx, who.subjectId, body, now()) }))).body;
  });

  app.post(`${API_PREFIX}/driver/location`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await postLocations(trx, who.subjectId, request.body ?? {}, now()) }))).body;
  });

  app.get(`${API_PREFIX}/driver/vehicles`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return listVehicles(deps.db, who.subjectId);
  });

  app.post(`${API_PREFIX}/driver/vehicles`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const result = await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 201, body: await addVehicle(trx, who.subjectId, request.body ?? {}, now()) }));
    return reply.status(result.status).send(result.body);
  });

  app.get(`${API_PREFIX}/admin/live/drivers`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const { zoneId } = parseBody(z.object({ zoneId: ID.optional() }), request.query);
    if (zoneId && !adminCoversZone(who, zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
    return liveDrivers(deps.db, zoneId, who.zones, now());
  });

  app.get(`${API_PREFIX}/admin/trips/:tripId/trace`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const trip = await deps.db.selectFrom("trips").select("zone_id").where("trip_id", "=", tripId).executeTakeFirst();
    if (trip && !adminCoversZone(who, trip.zone_id)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
    return tripTrace(deps.db, tripId);
  });
}
