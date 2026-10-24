import type { FastifyInstance } from "fastify";
import { authenticate } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import type { Router } from "../maps/routing.js";
import { createQuotes } from "./service.js";

export type QuoteDeps = { db: Db; jwtSecret: string; router: Router; clock?: () => Date };

export async function quoteRoutes(app: FastifyInstance, deps: QuoteDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  app.post(`${API_PREFIX}/quotes`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const key = request.headers["idempotency-key"];
    const result = await runIdempotent(
      deps.db,
      { actor: "rider", subjectId: who.subjectId, key: Array.isArray(key) ? key[0] : key, method: "POST", route: request.url.split("?")[0]!, body: request.body ?? null },
      async (trx) => ({ status: 201, body: await createQuotes(trx, { router: deps.router }, who.subjectId, request.body ?? {}, deps.clock?.() ?? new Date()) }),
    );
    return reply.status(result.status).send(result.body);
  });
}
