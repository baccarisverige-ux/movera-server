import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { withPaymentOptions } from "../trips/finish.js";
import type { NotificationHub } from "../realtime/hub.js";
import { streamConfig } from "../realtime/streams.js";
import { z } from "zod";
import { withCatalog } from "../pricing/routes.js";
import { raiseMaxFactor, withRaiseLimit } from "./raiseLimit.js";
import { adminCoversZone, authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import type { ConfigDoc } from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { decideApproval, listApprovals } from "../admin/approvals.js";
import { COUNTRY_ONLY_DOCS, CONFIG_DOCS, EDIT_PERMISSION, PUBLISH_PERMISSION, getDraft, getZone, liveDocument, publishDraft, putDraft, standardKey, useStandard, withLivePricing } from "./service.js";

/** contract §6: rider/driver config reads, admin drafts and publish, approvals (§3.1). */

/** paymentMethods (v0.18.10): what the server takes today (env PAYMENT_METHODS), for the served paymentOptions. */
export type ConfigDeps = { db: Db; jwtSecret: string; defaultZoneId: string; paymentMethods?: readonly string[]; hub?: NotificationHub; clock?: () => Date };

const ZONE_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const DocParam = z.object({ doc: z.enum(CONFIG_DOCS as [ConfigDoc, ...ConfigDoc[]]) });
const COUNTRY = z.string().regex(/^[A-Z]{2}$/);
/** v0.8.0 (contract.json#configDocs.scope): exactly one of zoneId (the zone's own) or country (its standard). */
const Scope = { zoneId: ZONE_ID.optional(), country: COUNTRY.optional() };
const ScopeQuery = z.object(Scope);
const OptionalZoneQuery = z.object({ zoneId: ZONE_ID.optional() });
const PutBody = z.object({ expectedVersion: z.number().int().min(1), ...Scope, document: z.unknown() });
const PublishBody = z.object({ expectedVersion: z.number().int().min(1), ...Scope, note: z.string().max(1000).optional() });
const UseStandardBody = z.object({ expectedVersion: z.number().int().min(1), zoneId: ZONE_ID });
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

/** The scope key of a request: the zone id, or standard-<CC> for a country; a country needs one zone of it (owner 2026-10-27). */
async function scopeKey(db: Db, who: Principal, scope: { zoneId?: string | undefined; country?: string | undefined }, doc?: ConfigDoc): Promise<string> {
  if ((scope.zoneId === undefined) === (scope.country === undefined)) throw new ApiError("invalid_request", "Name exactly one of zoneId or country.", { reason: "scope_required" });
  // v0.18.0 (contract.json#configDocs.countryOnly): the onboarding settings exist per country only.
  if (doc !== undefined && COUNTRY_ONLY_DOCS.includes(doc) && scope.zoneId !== undefined) throw new ApiError("invalid_request", "These settings are per country; name the country.", { reason: "scope_country_only" });
  if (scope.zoneId !== undefined) {
    checkZone(who, scope.zoneId);
    return scope.zoneId;
  }
  const zones = await db.selectFrom("zones").select("zone_id").where("country", "=", scope.country!).execute();
  if (zones.length > 0 && !zones.some((zone) => adminCoversZone(who, zone.zone_id))) throw new ApiError("forbidden", "This country is outside your scope.", { reason: "zone_out_of_scope" });
  return standardKey(scope.country!);
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
    // v0.18.6 (owner G4-E4): the rider app always gets the raise limit the server checks (the zone's dispatch document).
    let document = doc === "rider_app_config" ? withRaiseLimit(live.document as Record<string, unknown>, await raiseMaxFactor(deps.db, zoneId)) : (live.document as Record<string, unknown>);
    // v0.18.7 (contract.json#pickupWaiting.servedConfig): the waiting / no-show terms and rider pickup fees of the zone's
    // LIVE pricing document, whatever the app document says (a driver in Paris reads French terms in euro), and the
    // rider app gets the zone's "cancel after arrival = no-show" switch from the driver document.
    document = await withLivePricing(deps.db, doc, zoneId, document);
    // v0.18.10 (contract.json#finish.paymentMethods.served): the admin's methods (never google_pay) and what the server takes.
    document = withPaymentOptions(document, deps.paymentMethods ?? ["cash"]);
    // v0.7.1 (contract.json#categoryCatalog): label, sub-line and seats from the admin catalog; archived car types left out.
    return withCatalog(deps.db, document);
  };
  app.get(`${API_PREFIX}/rider/config`, serveAppDoc("rider_app_config", "rider"));
  app.get(`${API_PREFIX}/driver/config`, serveAppDoc("driver_app_config", "driver"));

  // config_published streams (contract §4): the apps re-fetch the document when one arrives.
  const streamAppDoc = (doc: ConfigDoc, actor: "rider" | "driver") => async (request: FastifyRequest, reply: FastifyReply) => {
    const who = await authenticate(request, guard, [actor]);
    const { zoneId: asked } = parseBody(OptionalZoneQuery, request.query);
    const zoneId = asked ?? (actor === "driver" ? who.zones[0] : undefined) ?? deps.defaultZoneId;
    await getZone(deps.db, zoneId);
    if (deps.hub === undefined) throw new ApiError("unavailable", "Live updates are not available.", { reason: "realtime_unavailable", retryAfterSeconds: 5 });
    const lastEventId = request.headers["last-event-id"];
    const seen = typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : (await liveDocument(deps.db, doc, zoneId))?.version ?? 0;
    await streamConfig(request, reply, { db: deps.db, hub: deps.hub, ...(deps.clock ? { clock: deps.clock } : {}) }, doc, zoneId, seen);
    return reply;
  };
  app.get(`${API_PREFIX}/rider/config/stream`, streamAppDoc("rider_app_config", "rider"));
  app.get(`${API_PREFIX}/driver/config/stream`, streamAppDoc("driver_app_config", "driver"));

  app.get(`${API_PREFIX}/admin/config/:doc`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.read");
    const { doc } = parseBody(DocParam, request.params);
    const zoneId = await scopeKey(deps.db, who, parseBody(ScopeQuery, request.query), doc);
    return getDraft(deps.db, doc, zoneId);
  });

  app.put(`${API_PREFIX}/admin/config/:doc`, async (request) => {
    const { doc } = parseBody(DocParam, request.params);
    const who = await authenticateAdmin(request, guard, EDIT_PERMISSION[doc]);
    const body = parseBody(PutBody, request.body);
    const zoneId = await scopeKey(deps.db, who, body, doc);
    const result = await runIdempotent(
      deps.db,
      { actor: "admin", subjectId: who.subjectId, key: keyOf(request.headers["idempotency-key"]), method: "PUT", route: request.url.split("?")[0]!, body },
      async (trx) => ({ status: 200, body: await putDraft(trx, { doc, zoneId, expectedVersion: body.expectedVersion, document: body.document, adminId: who.subjectId }, now()) }),
    );
    return result.body;
  });

  // v0.8.0 (contract.json#configDocs.publishApproval, owner 2026-10-27): no second admin; 200 at once.
  app.post(`${API_PREFIX}/admin/config/:doc/publish`, async (request) => {
    const { doc } = parseBody(DocParam, request.params);
    const who = await authenticateAdmin(request, guard, PUBLISH_PERMISSION[doc]);
    const body = parseBody(PublishBody, request.body);
    const zoneId = await scopeKey(deps.db, who, body, doc);
    const idem = { actor: "admin" as const, subjectId: who.subjectId, key: keyOf(request.headers["idempotency-key"]), method: "POST", route: request.url.split("?")[0]!, body };
    const outcome = await runIdempotent(deps.db, idem, async (trx) => ({
      status: 200,
      body: await publishDraft(trx, { doc, zoneId, expectedVersion: body.expectedVersion, ...(body.note ? { note: body.note } : {}), publishedBy: who.subjectId, approvedBy: null }, now()),
    }));
    return outcome.body;
  });

  // v0.8.0 (contract.json#configDocs.useStandard): Go back to Standard, after the admin confirmed.
  app.post(`${API_PREFIX}/admin/config/:doc/use-standard`, async (request) => {
    const { doc } = parseBody(DocParam, request.params);
    const who = await authenticateAdmin(request, guard, PUBLISH_PERMISSION[doc]);
    const body = parseBody(UseStandardBody, request.body);
    checkZone(who, body.zoneId);
    if (COUNTRY_ONLY_DOCS.includes(doc)) throw new ApiError("invalid_request", "These settings are per country; name the country.", { reason: "scope_country_only" });
    const idem = { actor: "admin" as const, subjectId: who.subjectId, key: keyOf(request.headers["idempotency-key"]), method: "POST", route: request.url.split("?")[0]!, body };
    const outcome = await runIdempotent(deps.db, idem, async (trx) => ({ status: 200, body: await useStandard(trx, { doc, zoneId: body.zoneId, expectedVersion: body.expectedVersion, adminId: who.subjectId }, now()) }));
    return outcome.body;
  });

  app.get(`${API_PREFIX}/admin/approvals`, async (request) => {
    const who = await authenticateAdmin(request, guard, "approval.decide");
    const query = parseBody(ApprovalQuery, request.query);
    const statuses = query.status === undefined ? undefined : Array.isArray(query.status) ? query.status : [query.status];
    return listApprovals(deps.db, who, { ...(statuses ? { statuses } : {}), ...(query.targetType ? { targetType: query.targetType } : {}), ...(query.cursor ? { cursor: query.cursor } : {}), limit: query.limit }, now());
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
