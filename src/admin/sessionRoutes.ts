import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateAdmin, type Principal } from "../auth/guard.js";
import { activeSessions, adminSignOutSessions, assertSubjectInScope, type SessionSubject } from "../auth/adminSessions.js";
import type { Db } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";

/**
 * Contract v0.18.149 (owner decisions/driver-g12.md Q6, contract.json#adminSessions): GET /admin/{riders|drivers}/{id}/sessions
 * (riders.read / drivers.read) and POST /admin/{riders|drivers}/{id}/sessions/sign-out (riders.block / drivers.activate),
 * zone-scoped like the other admin people routes; the sign-out is idempotent and audited (auth/adminSessions.ts).
 */
export type SessionRoutesDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const SignOutBody = z.object({ sessionId: ID.optional(), all: z.literal(true).optional(), reason: z.string().max(2000).optional() }).strict();

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

const PEOPLE = [
  { actor: "rider", path: "riders", idName: "riderId", read: "riders.read", signOut: "riders.block" },
  { actor: "driver", path: "drivers", idName: "driverId", read: "drivers.read", signOut: "drivers.activate" },
] as const;

export async function adminSessionRoutes(app: FastifyInstance, deps: SessionRoutesDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal) => ({ actor: "admin" as const, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });

  for (const p of PEOPLE) {
    const subjectOf = (request: FastifyRequest): SessionSubject => ({ actor: p.actor, subjectId: (parseBody(z.object({ [p.idName]: ID }), request.params) as Record<string, string>)[p.idName]! });
    app.get(`${API_PREFIX}/admin/${p.path}/:${p.idName}/sessions`, async (request) => {
      const who = await authenticateAdmin(request, guard, p.read);
      const subject = subjectOf(request);
      await assertSubjectInScope(deps.db, who, subject);
      return { items: await activeSessions(deps.db, subject, now()) };
    });
    app.post(`${API_PREFIX}/admin/${p.path}/:${p.idName}/sessions/sign-out`, async (request) => {
      const who = await authenticateAdmin(request, guard, p.signOut);
      const subject = subjectOf(request);
      const body = parseBody(SignOutBody, request.body ?? {});
      return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await adminSignOutSessions(trx, who, subject, body, now()) }))).body;
    });
  }
}
