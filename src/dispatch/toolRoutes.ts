import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db, Trx } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import * as tools from "./tools.js";

/** Contract v0.18.6 §32 (owner G4-F2..F6, contract.json#dispatchTools): the admin's Dispatch tools and GET /driver/events. */

export type ToolDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const COUNTRY = z.string().regex(/^[A-Z]{2}$/);
const Name = z.string().trim().min(1).max(40);
const Point = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const Area = z.array(Point).min(3).max(500);
const Version = z.number().int().min(1);
const Values = z.record(z.string(), z.unknown());
const Text = z.object({ sv: z.string().trim().min(1), fr: z.string().trim().min(1), en: z.string().trim().min(1) });
const Details = z.object({ title: Text, description: Text, pickupNote: Text.optional() });
const Location = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const Stamp = z.string().datetime();
const ZoneIds = z.union([z.literal("all"), z.array(ID).min(1)]);
const RuleFields = { name: Name, radarZoneIds: ZoneIds, seconds: z.number().int().min(5).max(120), maxDrivers: z.number().int().min(1).max(10), repeat: z.boolean() };
const EventFields = { name: z.string().trim().min(1).max(80), location: Location, polygon: Area.optional(), startsAt: Stamp, endsAt: Stamp, on: z.boolean().optional(), details: Details };

const BODIES = {
  presets: { create: z.object({ country: COUNTRY, name: Name, values: Values }), update: z.object({ expectedVersion: Version, name: Name.optional(), values: Values.optional() }) },
  groups: { create: z.object({ country: COUNTRY, name: Name, driverIds: z.array(ID).max(tools.GROUP_MAX_DRIVERS) }), update: z.object({ expectedVersion: Version, name: Name.optional(), driverIds: z.array(ID).max(tools.GROUP_MAX_DRIVERS).optional() }) },
  "radar-zones": { create: z.object({ zoneId: ID, name: Name, polygon: Area }), update: z.object({ expectedVersion: Version, name: Name.optional(), polygon: Area.optional() }) },
  "radar-rules": { create: z.object({ country: COUNTRY, ...RuleFields }), update: z.object({ expectedVersion: Version, ...Object.fromEntries(Object.entries(RuleFields).map(([k, v]) => [k, v.optional()])) }) },
  events: { create: z.object({ country: COUNTRY, ...EventFields }), update: z.object({ expectedVersion: Version, ...Object.fromEntries(Object.entries(EventFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])) }) },
} as const;

type Ops = {
  list: (db: Db, who: Principal, query: Record<string, string | undefined>) => Promise<unknown>;
  create: (trx: Trx, who: Principal, body: never, now: Date) => Promise<unknown>;
  update: (trx: Trx, who: Principal, id: string, body: never, now: Date) => Promise<unknown>;
  remove: (trx: Trx, who: Principal, id: string, expectedVersion: number, now: Date) => Promise<void>;
};
const OPS: Record<keyof typeof BODIES, Ops> = {
  presets: { list: (db, who, q) => tools.listPresets(db, who, q["country"]), create: tools.createPreset, update: tools.updatePreset, remove: tools.deletePreset },
  groups: { list: (db, who, q) => tools.listGroups(db, who, q["country"]), create: tools.createGroup, update: tools.updateGroup, remove: tools.deleteGroup },
  "radar-zones": { list: (db, who, q) => tools.listRadarZones(db, who, q["country"]), create: tools.createRadarZone, update: tools.updateRadarZone, remove: tools.deleteRadarZone },
  "radar-rules": { list: (db, who, q) => tools.listRules(db, who, q["country"]), create: tools.createRule, update: tools.updateRule, remove: tools.deleteRule },
  events: { list: (db, who, q) => tools.listEvents(db, who, { country: q["country"], from: q["from"], to: q["to"] }), create: tools.createEvent, update: tools.updateEvent, remove: tools.deleteEvent },
};

const PARAM: Record<keyof typeof BODIES, string> = { presets: "presetId", groups: "groupId", "radar-zones": "radarZoneId", "radar-rules": "ruleId", events: "eventId" };

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};
const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const ListQuery = z.object({ country: COUNTRY.optional(), from: Stamp.optional(), to: Stamp.optional() });

export async function dispatchToolRoutes(app: FastifyInstance, deps: ToolDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: Principal) => ({ actor: "admin" as const, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });

  for (const [base, schema] of Object.entries(BODIES) as Array<[keyof typeof BODIES, (typeof BODIES)[keyof typeof BODIES]]>) {
    const ops = OPS[base];
    const param = PARAM[base];
    const idOf = (request: FastifyRequest) => (parseBody(z.object({ [param]: ID }), request.params) as Record<string, string>)[param]!;
    app.get(`${API_PREFIX}/admin/dispatch/${base}`, async (request) => {
      const who = await authenticateAdmin(request, guard, "trips.read");
      return ops.list(deps.db, who, clean(parseBody(ListQuery, request.query)));
    });
    app.post(`${API_PREFIX}/admin/dispatch/${base}`, async (request, reply) => {
      const who = await authenticateAdmin(request, guard, "dispatch.edit");
      const body = parseBody(schema.create as z.ZodTypeAny, request.body);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 201, body: await ops.create(trx, who, clean(body as Record<string, unknown>) as never, now()) }));
      return reply.status(result.status).send(result.body);
    });
    app.put(`${API_PREFIX}/admin/dispatch/${base}/:${param}`, async (request, reply) => {
      const who = await authenticateAdmin(request, guard, "dispatch.edit");
      const id = idOf(request);
      const body = parseBody(schema.update as z.ZodTypeAny, request.body);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await ops.update(trx, who, id, clean(body as Record<string, unknown>) as never, now()) }));
      return reply.status(result.status).send(result.body);
    });
    app.delete(`${API_PREFIX}/admin/dispatch/${base}/:${param}`, async (request, reply) => {
      const who = await authenticateAdmin(request, guard, "dispatch.edit");
      const id = idOf(request);
      const { expectedVersion } = parseBody(z.object({ expectedVersion: z.coerce.number().int().min(1) }), request.query);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => {
        await ops.remove(trx, who, id, expectedVersion, now());
        return { status: 204, body: null };
      });
      return reply.status(result.status).send();
    });
  }

  app.get(`${API_PREFIX}/admin/dispatch/radar-zones/:radarZoneId/free`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const { radarZoneId: id } = parseBody(z.object({ radarZoneId: ID }), request.params);
    const { categoryId } = parseBody(z.object({ categoryId: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).optional() }), request.query);
    return tools.radarZoneFree(deps.db, who, id, categoryId, now());
  });

  app.get(`${API_PREFIX}/driver/events`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return tools.driverEvents(deps.db, who.subjectId, now());
  });
}
