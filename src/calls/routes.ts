import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin } from "../auth/guard.js";
import { adminTrip } from "../admin/trips.js";
import type { Db } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { answerCall, endCall, relaySignal, tripCallLog, type CallWho } from "./service.js";

/** v0.18.38 §62 (contract.json#inAppCalls): the in-app call steps and the admin's call log. */
export type CallDeps = { db: Db; jwtSecret: string; clock?: () => Date };
const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export async function callRoutes(app: FastifyInstance, deps: CallDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const side = async (request: FastifyRequest) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const { callId } = parseBody(z.object({ callId: ID }), request.params);
    const key = request.headers["idempotency-key"];
    const idem = { actor: who.actor, subjectId: who.subjectId, key: Array.isArray(key) ? key[0] : key, method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null };
    return { who: { actor: who.actor as CallWho["actor"], subjectId: who.subjectId }, callId, idem };
  };

  app.post(`${API_PREFIX}/calls/:callId/answer`, async (request) => {
    const { who, callId, idem } = await side(request);
    return (await runIdempotent(deps.db, idem, async (trx) => ({ status: 200, body: await answerCall(trx, who, callId, now()) }))).body;
  });
  app.post(`${API_PREFIX}/calls/:callId/end`, async (request) => {
    const { who, callId, idem } = await side(request);
    return (await runIdempotent(deps.db, idem, async (trx) => ({ status: 200, body: await endCall(trx, who, callId, request.body, now()) }))).body;
  });
  app.post(`${API_PREFIX}/calls/:callId/signal`, async (request, reply) => {
    const { who, callId, idem } = await side(request);
    await runIdempotent(deps.db, idem, async (trx) => {
      await relaySignal(trx, who, callId, request.body, now());
      return { status: 202, body: null };
    });
    return reply.status(202).send();
  });
  app.get(`${API_PREFIX}/admin/trips/:tripId/calls`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const trip = await adminTrip(deps.db, who, tripId);
    return tripCallLog(deps.db, trip.trip_id);
  });
}
