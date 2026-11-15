import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import { parseQuery } from "../admin/zoneFilter.js";
import type { Db } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { commandCampaign, createCampaign, driverBonuses, getCampaign, listCampaigns, listProgress, markOpened, updateCampaign, type CreateBody } from "./campaigns.js";

/**
 * v0.18.110 BQ-V44 (contract.json#bonusCampaigns.endpoints, openapi part 1280): Admin › Drivers › Bonuses
 * (drivers.read to read, drivers.bonuses to write; zone scope; every write audited; one admin is enough) and the
 * driver's Campaigns screen (GET /driver/bonuses, POST /driver/bonuses/opened).
 */

export type BonusDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "a real date");
const Name = z.string().trim().min(1).max(80);
const Names = z.object({ sv: Name, fr: Name, en: Name }).strict();
// The shape only: the rules (target, amount, dates, area) answer with their own reasons (rules.ts validateCampaign).
const Point = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const CreateSchema = z.object({
  zoneId: ID,
  names: Names,
  measure: z.enum(["trips", "online_hours"]),
  target: z.number(),
  amount: z.object({ amountMinor: z.number().int(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
  startDate: DATE,
  endDate: DATE,
  polygon: z.array(Point).max(1000),
}).strict();
const UpdateSchema = z.object({ expectedVersion: z.number().int().min(1), names: Names.optional(), endDate: DATE.optional() }).passthrough();
const CommandSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();
const Params = z.object({ bonusId: ID });
const LIMIT = z.coerce.number().int().min(1).max(200).default(50);
const ListQuery = { zoneId: ID.optional(), state: z.enum(["scheduled", "active", "paused", "ended"]).optional(), cursor: z.string().max(512).optional(), limit: LIMIT };
const PageQuery = { cursor: z.string().max(512).optional(), limit: LIMIT };
const OpenedSchema = z.object({ bonusIds: z.array(ID).min(1).max(50).refine((ids) => new Set(ids).size === ids.length, "unique ids") }).strict();

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export async function bonusRoutes(app: FastifyInstance, deps: BonusDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal) => ({ actor: who.actor, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });

  app.get(`${API_PREFIX}/admin/bonuses`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.read");
    return listCampaigns(deps.db, who, parseQuery(ListQuery, request.query), now());
  });

  app.post(`${API_PREFIX}/admin/bonuses`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "drivers.bonuses");
    const body = parseBody(CreateSchema, request.body) as CreateBody;
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 201, body: await createCampaign(trx, who, body, now()) }));
    return reply.status(result.status).send(result.body);
  });

  app.get(`${API_PREFIX}/admin/bonuses/:bonusId`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.read");
    const { bonusId } = parseBody(Params, request.params);
    return getCampaign(deps.db, who, bonusId, now());
  });

  app.put(`${API_PREFIX}/admin/bonuses/:bonusId`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.bonuses");
    const { bonusId } = parseBody(Params, request.params);
    const body = parseBody(UpdateSchema, request.body) as Record<string, unknown>;
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await updateCampaign(trx, who, bonusId, body, now()) }))).body;
  });

  for (const command of ["pause", "resume", "end"] as const) {
    app.post(`${API_PREFIX}/admin/bonuses/:bonusId/${command}`, async (request) => {
      const who = await authenticateAdmin(request, guard, "drivers.bonuses");
      const { bonusId } = parseBody(Params, request.params);
      const { expectedVersion } = parseBody(CommandSchema, request.body);
      return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await commandCampaign(trx, who, bonusId, command, expectedVersion, now()) }))).body;
    });
  }

  app.get(`${API_PREFIX}/admin/bonuses/:bonusId/drivers`, async (request) => {
    const who = await authenticateAdmin(request, guard, "drivers.read");
    const { bonusId } = parseBody(Params, request.params);
    return listProgress(deps.db, who, bonusId, parseQuery(PageQuery, request.query));
  });

  app.get(`${API_PREFIX}/driver/bonuses`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return driverBonuses(deps.db, who.subjectId, now());
  });

  app.post(`${API_PREFIX}/driver/bonuses/opened`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { bonusIds } = parseBody(OpenedSchema, request.body);
    await runIdempotent(deps.db, idem(request, who), async (trx) => {
      await markOpened(trx, who.subjectId, bonusIds, now());
      return { status: 204, body: null };
    });
    return reply.status(204).send();
  });
}
