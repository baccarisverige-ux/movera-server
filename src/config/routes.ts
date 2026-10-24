import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { adminCoversZone, authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import type { ConfigDoc } from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { decideApproval, listApprovals, runOrRequest, type PendingApproval } from "../admin/approvals.js";
import {
  APPROVE_PERMISSION,
  CONFIG_DOCS,
  EDIT_PERMISSION,
  PUBLISH_ACTION,
  PUBLISH_PERMISSION,
  getDraft,
  getZone,
  liveDocument,
  putDraft,
  type Publication,
} from "./service.js";

/** contract §6: rider/driver config reads, admin drafts and publish, approvals (§3.1). */

export type ConfigDeps = { db: Db; jwtSecret: string; defaultZoneId: string; clock?: () => Date };

const ZONE_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const DocParam = z.object({ doc: z.enum(CONFIG_DOCS as [ConfigDoc, ...ConfigDoc[]]) });
const ZoneQuery = z.object({ zoneId: ZONE_ID });
const OptionalZoneQuery = z.object({ zoneId: ZONE_ID.optional() });
const PutBody = z.object({ expectedVersion: z.number().int().min(1), zoneId: ZONE_ID, document: z.unknown() });
const PublishBody = z.object({ expectedVersion: z.number().int().min(1), zoneId: ZONE_ID, note: z.string().max(1000).optional() });
const ApprovalParam = z.object({ approvalId: ZONE_ID });
const DecisionBody = z.object({ note: z.string().max(1000).optional() });
const ApprovalQuery = z.object({
  status: z.union([z.string(), z.array(z.string())]).optional(),
  targetType: z.string().max(32).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function checkZone(who: Principal, zoneId: string): void {
  if (!adminCoversZone(who, zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
}

const keyOf = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export async function configRoutes(app: FastifyInstance, deps: ConfigDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();

  // Apps: the live document of their zone, unchanged. A zone with nothing published is 404 config_not_published
  // and the app keeps its own seed.
  const serveAppDoc = (doc: ConfigDoc, actor: "rider" | "driver") => async (request: FastifyRequest) => {
    const who = await authenticate(request, guard, [actor]);
    const { zoneId: asked } = parseBody(OptionalZoneQuery, request.query);
    const zoneId = asked ?? (actor === "driver" ? who.zones[0] : undefined) ?? deps.defaultZoneId;
    await getZone(deps.db, zoneId);
    const live = await liveDocument(deps.db, doc, zoneId);
    if (live === null) throw new ApiError("not_found", "No settings are published for this zone yet.", { reason: "config_not_published" });
    return live.document;
  };
  app.get(`${API_PREFIX}/rider/config`, serveAppDoc("rider_app_config", "rider"));
  app.get(`${API_PREFIX}/driver/config`, serveAppDoc("driver_app_config", "driver"));

  app.get(`${API_PREFIX}/admin/config/:doc`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.read");
    const { doc } = parseBody(DocParam, request.params);
    const { zoneId } = parseBody(ZoneQuery, request.query);
    checkZone(who, zoneId);
    return getDraft(deps.db, doc, zoneId);
  });

  app.put(`${API_PREFIX}/admin/config/:doc`, async (request) => {
    const { doc } = parseBody(DocParam, request.params);
    const who = await authenticateAdmin(request, guard, EDIT_PERMISSION[doc]);
    const body = parseBody(PutBody, request.body);
    checkZone(who, body.zoneId);
    const result = await runIdempotent(
      deps.db,
      { actor: "admin", subjectId: who.subjectId, key: keyOf(request.headers["idempotency-key"]), method: "PUT", route: request.url.split("?")[0]!, body },
      async (trx) => ({ status: 200, body: await putDraft(trx, { doc, zoneId: body.zoneId, expectedVersion: body.expectedVersion, document: body.document, adminId: who.subjectId }, now()) }),
    );
    return result.body;
  });

  app.post(`${API_PREFIX}/admin/config/:doc/publish`, async (request, reply) => {
    const { doc } = parseBody(DocParam, request.params);
    const who = await authenticateAdmin(request, guard, PUBLISH_PERMISSION[doc]);
    const body = parseBody(PublishBody, request.body);
    checkZone(who, body.zoneId);
    await getZone(deps.db, body.zoneId);
    const idem = { actor: "admin" as const, subjectId: who.subjectId, key: keyOf(request.headers["idempotency-key"]), method: "POST", route: request.url.split("?")[0]!, body };
    const outcome = await runIdempotent<Publication | PendingApproval>(deps.db, idem, async (trx) => {
      const ran = await runOrRequest<Publication>(
        trx,
        who,
        {
          action: PUBLISH_ACTION,
          targetType: "config",
          targetId: doc,
          zoneId: body.zoneId,
          payload: { doc, zoneId: body.zoneId, expectedVersion: body.expectedVersion, ...(body.note ? { note: body.note } : {}) },
          approvePermission: APPROVE_PERMISSION[doc],
        },
        now(),
      );
      return ran.ran ? { status: 200, body: ran.result } : { status: 202, body: ran.pending };
    });
    return reply.status(outcome.status).send(outcome.body);
  });

  app.get(`${API_PREFIX}/admin/approvals`, async (request) => {
    await authenticateAdmin(request, guard, "approval.decide");
    const query = parseBody(ApprovalQuery, request.query);
    const statuses = query.status === undefined ? undefined : Array.isArray(query.status) ? query.status : [query.status];
    return listApprovals(deps.db, { ...(statuses ? { statuses } : {}), ...(query.targetType ? { targetType: query.targetType } : {}), ...(query.cursor ? { cursor: query.cursor } : {}), limit: query.limit }, now());
  });

  for (const decision of ["approve", "reject"] as const) {
    app.post(`${API_PREFIX}/admin/approvals/:approvalId/${decision}`, async (request) => {
      // The permission is per approval (approval.decide, or dispatch.approve for dispatch rules): checked inside.
      const who = await authenticateAdmin(request, guard);
      const { approvalId } = parseBody(ApprovalParam, request.params);
      const body = parseBody(DecisionBody, request.body);
      const outcome = await runIdempotent(
        deps.db,
        { actor: "admin", subjectId: who.subjectId, key: keyOf(request.headers["idempotency-key"]), method: "POST", route: request.url.split("?")[0]!, body },
        async (trx) => ({ status: 200, body: await decideApproval(trx, who, approvalId, decision, body.note, now()) }),
      );
      return outcome.body;
    });
  }
}
