import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { readIdempotencyKey, runIdempotent } from "../http/idempotency.js";
import type { Router } from "../maps/routing.js";
import { markRiderSeen } from "../riders/presence.js";
import { createQuotes, routeBeforeTransaction } from "./service.js";

/** v0.18.163 (contract.json#liveTraffic): `traffic` = Google live traffic (falls back to `router`), used when the zone's setting is on. */
export type QuoteDeps = { db: Db; jwtSecret: string; router: Router; traffic?: Router; clock?: () => Date };

export async function quoteRoutes(app: FastifyInstance, deps: QuoteDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  app.post(`${API_PREFIX}/quotes`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const header = request.headers["idempotency-key"];
    const key = Array.isArray(header) ? header[0] : header;
    // A missing or bad key is refused before any route call, as before.
    readIdempotencyKey(key);
    // The route first, with no database connection held; then the short transaction.
    const router = await routeBeforeTransaction(deps.router, request.body ?? {}, deps.db, deps.traffic);
    const result = await runIdempotent(
      deps.db,
      { actor: "rider", subjectId: who.subjectId, key, method: "POST", route: request.url.split("?")[0]!, body: request.body ?? null },
      async (trx) => ({ status: 201, body: await createQuotes(trx, { router }, who.subjectId, request.body ?? {}, deps.clock?.() ?? new Date(), { contractVersion: request.headers["x-contract-version"] }) }),
    );
    // v0.18.4 (G3-R4): asking a price makes the rider "online" in the pickup's zone.
    const pickup = (request.body as { pickup?: { lat?: unknown; lng?: unknown } } | undefined)?.pickup;
    if (result.status === 201 && typeof pickup?.lat === "number" && typeof pickup.lng === "number") await markRiderSeen(deps.db, who.subjectId, { lat: pickup.lat, lng: pickup.lng }, deps.clock?.() ?? new Date());
    return reply.status(result.status).send(result.body);
  });
}
