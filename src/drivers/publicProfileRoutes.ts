import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { runIdempotent } from "../http/idempotency.js";
import { API_PREFIX } from "../http/prefix.js";
import { parseBody } from "../http/validate.js";
import { etagOf, listDriverReviews, moderateDriverReview, ownPublicProfile, riderDriverProfile, updateOwnPublicProfile } from "./publicProfile.js";

/** v0.18.155 (contract.json#driverProfile.routes): the rider read, Min profil and the admin moderation list. */
const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};
const Patch = z.object({ languages: z.array(z.string()).max(32).optional(), showCity: z.boolean().optional(), showYears: z.boolean().optional() }).strict()
  .refine((b) => Object.keys(b).length > 0, "Give at least one field.");
const ListQuery = z.object({ status: z.enum(["pending", "approved", "hidden"]).optional(), zoneId: ID.optional(), cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();

export async function publicProfileRoutes(app: FastifyInstance, deps: { db: Db; jwtSecret: string; clock?: () => Date }): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal) => ({ actor: who.actor as "rider" | "driver" | "admin", subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });

  // LOAD RULE: read once when the sheet opens; private cache 5 min, ETag + 304.
  app.get(`${API_PREFIX}/rider/trips/:tripId/driver-profile`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const body = await riderDriverProfile(deps.db, who.subjectId, tripId, now());
    const etag = etagOf(body);
    reply.header("cache-control", "private, max-age=300").header("etag", etag);
    if (request.headers["if-none-match"] === etag) return reply.status(304).send();
    return body;
  });

  app.get(`${API_PREFIX}/driver/public-profile`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return ownPublicProfile(deps.db, who.subjectId, now());
  });
  app.patch(`${API_PREFIX}/driver/public-profile`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const body = parseBody(Patch, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await updateOwnPublicProfile(trx, who.subjectId, body, now()) }));
    return result.body;
  });

  app.get(`${API_PREFIX}/admin/driver-reviews`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.read");
    const q = parseBody(ListQuery, request.query);
    return listDriverReviews(deps.db, who, { limit: q.limit, ...(q.status ? { status: q.status } : {}), ...(q.zoneId ? { zoneId: q.zoneId } : {}), ...(q.cursor ? { cursor: q.cursor } : {}) });
  });
  for (const verb of ["approve", "hide"] as const) {
    app.post(`${API_PREFIX}/admin/driver-reviews/:reviewId/${verb}`, async (request) => {
      const who = await authenticateAdmin(request, guard, "settings.publish");
      const { reviewId } = parseBody(z.object({ reviewId: ID }), request.params);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await moderateDriverReview(trx, who, reviewId, verb === "approve", now()) }));
      return result.body;
    });
  }
}
