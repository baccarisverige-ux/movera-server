import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { runIdempotent } from "../http/idempotency.js";
import { API_PREFIX } from "../http/prefix.js";
import { parseBody } from "../http/validate.js";
import type { NotificationHub } from "../realtime/hub.js";
import { openEventStream, wantsEventStream } from "../realtime/sse.js";
import { adminIncident, adminIncidentCommand, eventOf, INCIDENT_EVENTS_CHANNEL, incidentEventsAfter, listIncidents, mayHear, raiseSos, type IncidentCommand } from "./incidents.js";

/** contract v0.7.0 §15: rider and driver SOS, admin incidents and the incident feed. */

export type SafetyDeps = { db: Db; jwtSecret: string; hub?: NotificationHub; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Position = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).optional(), at: z.string().datetime() });
const SosBody = z.object({ at: z.string().datetime(), position: Position.optional() });
const CommandBody = z.object({ expectedVersion: z.number().int().min(1), note: z.string().max(1000).optional() });
const many = <T extends z.ZodTypeAny>(item: T) => z.union([item, z.array(item)]).optional().transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));
const Status = z.enum(["open", "investigating", "resolved", "dismissed"]);
const ListQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: many(Status),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
  kind: z.string().max(64).optional(),
  tripId: ID.optional(),
  zoneId: ID.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
const StreamQuery = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};
const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export async function safetyRoutes(app: FastifyInstance, deps: SafetyDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal) => ({ actor: who.actor as "rider" | "driver" | "admin", subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });
  const tripParam = (request: FastifyRequest) => parseBody(z.object({ tripId: ID }), request.params).tripId;
  const incidentParam = (request: FastifyRequest) => parseBody(z.object({ incidentId: ID }), request.params).incidentId;

  for (const actor of ["rider", "driver"] as const) {
    app.post(`${API_PREFIX}/${actor}/trips/:tripId/sos`, async (request) => {
      const who = await authenticate(request, guard, [actor]);
      const tripId = tripParam(request);
      const body = parseBody(SosBody, request.body);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await raiseSos(trx, { actor, subjectId: who.subjectId }, tripId, clean(body), now()) }));
      return result.body;
    });
  }

  app.get(`${API_PREFIX}/admin/incidents`, async (request) => {
    const who = await authenticateAdmin(request, guard, "incidents.read");
    return listIncidents(deps.db, who, clean(parseBody(ListQuery, request.query)) as never);
  });

  app.get(`${API_PREFIX}/admin/incidents/stream`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "overview.read");
    const query = parseBody(StreamQuery, request.query);
    const lastEventId = request.headers["last-event-id"];
    const after = query.after ?? (typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : 0);
    if (!wantsEventStream(request)) {
      // The polling fallback: the same events as a JSON page.
      const rows = await incidentEventsAfter(deps.db, after, query.limit + 1);
      const page = rows.slice(0, query.limit);
      const serverTime = now();
      const items = page.filter((row) => mayHear(who, row.incident as Record<string, unknown>)).map((row) => eventOf(row, serverTime));
      const last = page[page.length - 1];
      return { items, nextCursor: rows.length > query.limit && last ? String(last.sequence) : null };
    }
    if (deps.hub === undefined) throw new ApiError("unavailable", "Live updates are not available; poll the incidents instead.", { reason: "realtime_unavailable", retryAfterSeconds: 10 });
    const stream = openEventStream(request, reply);
    let last = after;
    let running = false;
    let again = false;
    const pump = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const rows = await incidentEventsAfter(deps.db, last, 200);
          const serverTime = now();
          for (const row of rows) {
            if (stream.closed()) return;
            if (mayHear(who, row.incident as Record<string, unknown>)) stream.send(Number(row.sequence), eventOf(row, serverTime));
            last = Number(row.sequence);
          }
          if (rows.length === 200) again = true;
        } while (again && !stream.closed());
      } catch (error) {
        request.log.warn({ err: error }, "incident stream read failed");
      } finally {
        running = false;
      }
    };
    stream.onClose(deps.hub.subscribe(INCIDENT_EVENTS_CHANNEL, () => void pump()));
    await pump();
    return reply;
  });

  app.get(`${API_PREFIX}/admin/incidents/:incidentId`, async (request) => {
    const who = await authenticateAdmin(request, guard, "incidents.read");
    return adminIncident(deps.db, who, incidentParam(request));
  });

  for (const command of ["take", "resolve", "dismiss"] as const satisfies readonly IncidentCommand[]) {
    app.post(`${API_PREFIX}/admin/incidents/:incidentId/${command}`, async (request) => {
      const who = await authenticateAdmin(request, guard, "safety.edit");
      const incidentId = incidentParam(request);
      const body = parseBody(CommandBody, request.body);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await adminIncidentCommand(trx, who, incidentId, command, body, now()) }));
      return result.body;
    });
  }
}
