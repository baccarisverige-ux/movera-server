import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { parseQuery, ZoneFilterQuery } from "../admin/zoneFilter.js";
import { readOwnTrip } from "../trips/commands.js";
import { adminChats, adminMessagePerson } from "./admin.js";
import { chatOptions, chatSettingsFor } from "./settings.js";
import { translateMessage, type Translator } from "./translate.js";

/** v0.18.56 §78 (G9 part 2): chat options, translate, the admin chat list and admin Message. */

export type ChatDeps = { db: Db; jwtSecret: string; clock?: () => Date; translator?: Translator };
const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const ChatsQuery = { cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), ...ZoneFilterQuery };

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export async function chatRoutes(app: FastifyInstance, deps: ChatDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const tripParam = (request: FastifyRequest) => parseBody(z.object({ tripId: ID }), request.params).tripId;

  app.get(`${API_PREFIX}/trips/:tripId/messages/options`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const side = who.actor as "rider" | "driver";
    const trip = await readOwnTrip(deps.db, tripParam(request), { actor: side, subjectId: who.subjectId });
    return chatOptions(await chatSettingsFor(deps.db, trip.zone_id), side);
  });

  app.post(`${API_PREFIX}/trips/:tripId/messages/translate`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    return translateMessage(deps.db, deps.translator, { actor: who.actor as "rider" | "driver", subjectId: who.subjectId }, tripParam(request), request.body, now());
  });

  app.get(`${API_PREFIX}/admin/chats`, async (request) => {
    const who = await authenticateAdmin(request, guard, "support.reply");
    const q = parseQuery(ChatsQuery, request.query);
    return adminChats(deps.db, who, q);
  });

  for (const actor of ["driver", "rider"] as const) {
    const param = actor === "driver" ? "driverId" : "riderId";
    app.post(`${API_PREFIX}/admin/${actor}s/:${param}/message`, async (request, reply) => {
      const who = await authenticateAdmin(request, guard, "support.reply");
      const personId = parseBody(z.object({ [param]: ID }), request.params)[param] as string;
      const idem = { actor: "admin" as const, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null };
      const result = await runIdempotent(deps.db, idem, async (trx) => ({ status: 201, body: await adminMessagePerson(trx, who, actor, personId, request.body, now()) }));
      return reply.status(result.status).send(result.body);
    });
  }
}
