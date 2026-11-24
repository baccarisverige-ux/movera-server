import { dontMatchSettings } from "../blockedPairs/service.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { tipAmountsFor, tipRulesOf, withPaymentOptions } from "../trips/finish.js";
import type { NotificationHub } from "../realtime/hub.js";
import { attachConfig, streamConfig } from "../realtime/streams.js";
import { openEventStream, wantsEventStream } from "../realtime/sse.js";
import { sql } from "kysely";
import { z } from "zod";
import { DRIVER_ASSIGNED } from "../rules/transitions.js";
import { NOT_HELD } from "../reservations/view.js";
import { withCatalog } from "../pricing/routes.js";
import { raiseMaxFactor, withRaiseLimit } from "./raiseLimit.js";
import { adminCoversZone, authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import type { ConfigDoc } from "../db/schema.js";
import { ApiError, badRequest } from "../http/errors.js";
import { emergencyNumbersFor } from "./emergencyNumbers.js";
import { withPickupSpots } from "./pickupSpots.js";
import { sosSmsDriverConfig } from "../safety/sosContactsSms.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { draftForPreview, previewRoutes } from "./preview.js";
import { scopeKey } from "./scope.js";
import { decideApproval, listApprovals } from "../admin/approvals.js";
import { withShareTrip } from "./shareTrip.js";
import { withOneStream } from "./oneStream.js";
import { withLiveLocation } from "../trips/liveLocation.js";
import { attachOfferFeed, offerHead } from "../dispatch/offerFeed.js";
import { COUNTRY_ONLY_DOCS, CONFIG_DOCS, EDIT_PERMISSION, PUBLISH_PERMISSION, getDraft, getZone, liveDocument, publishDraft, putDraft, useStandard, withLivePricing } from "./service.js";

/** contract §6: rider/driver config reads, admin drafts and publish, approvals (§3.1). */

/** paymentMethods (v0.18.10): what the server takes today (SERVER_PAYMENT_METHODS less PAYMENT_METHODS_PAUSED, v0.18.13), for the served paymentOptions. */
/** v0.18.101 §92: smsConnected = an SMS company is connected (DriverAppConfig.sosContactsSms.connected). */
export type ConfigDeps = { db: Db; jwtSecret: string; defaultZoneId: string; smsConnected?: boolean; paymentMethods?: readonly string[]; hub?: NotificationHub; clock?: () => Date };

const ZONE_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const DocParam = z.object({ doc: z.enum(CONFIG_DOCS as [ConfigDoc, ...ConfigDoc[]]) });
const COUNTRY = z.string().regex(/^[A-Z]{2}$/);
/** v0.8.0 (contract.json#configDocs.scope): exactly one of zoneId (the zone's own) or country (its standard). */
const Scope = { zoneId: ZONE_ID.optional(), country: COUNTRY.optional() };
const ScopeQuery = z.object(Scope);
const OptionalZoneQuery = z.object({ zoneId: ZONE_ID.optional() });
/** v0.18.25: ?draft=1 — honoured only for a preview token (contract.json#previewSession). */
const AppDocQuery = z.object({ zoneId: ZONE_ID.optional(), draft: z.enum(["0", "1"]).optional() });
// v0.18.123 (configDocs.keptKeys.removeKeys): optional dotted paths of kept keys to really remove.
const PutBody = z.object({ expectedVersion: z.number().int().min(1), ...Scope, document: z.unknown(), removeKeys: z.array(z.string().max(100)).max(20).optional() });
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

/**
 * G17 (live 2026-11-12): the zone a driver works in, for his config when the app names none: his active trip's zone,
 * else the zone of his latest position fix. One read: two indexed lookups (trips_one_active_per_driver, driver_locations primary key).
 */
async function driverWorkZone(db: Db, driverId: string): Promise<string | undefined> {
  const trip = db
    .selectFrom("trips")
    .select("trips.zone_id")
    .where("trips.driver_id", "=", driverId)
    .where("trips.status", "in", [...DRIVER_ASSIGNED])
    .where(NOT_HELD)
    .orderBy("trips.updated_at", "desc")
    .limit(1);
  const fix = db.selectFrom("driver_locations").select("driver_locations.zone_id").where("driver_locations.driver_id", "=", driverId);
  const row = await db.selectNoFrom(sql<string | null>`coalesce((${trip}), (${fix}))`.as("zone_id")).executeTakeFirst();
  return row?.zone_id ?? undefined;
}

/** The zone of an app's config read or stream: the asked one; a driver's work zone, else his first zone; else the default. */
async function appZone(db: Db, who: Principal, actor: "rider" | "driver", asked: string | undefined, defaultZoneId: string, previewZone: boolean): Promise<string> {
  if (asked !== undefined) return asked;
  if (actor === "driver" && who.preview !== true) return (await driverWorkZone(db, who.subjectId)) ?? who.zones[0] ?? defaultZoneId;
  return (actor === "driver" || (previewZone && who.preview === true) ? who.zones[0] : undefined) ?? defaultZoneId;
}

const keyOf = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export async function configRoutes(app: FastifyInstance, deps: ConfigDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  await previewRoutes(app, guard);

  // Apps: the live document of their zone, unchanged. A zone with nothing published is 404 config_not_published
  // and the app keeps its own seed.
  const serveAppDoc = (doc: ConfigDoc, actor: "rider" | "driver") => async (request: FastifyRequest) => {
    const who = await authenticate(request, guard, [actor]);
    const { zoneId: asked, draft } = parseBody(AppDocQuery, request.query);
    const zoneId = await appZone(deps.db, who, actor, asked, deps.defaultZoneId, true);
    const zone = await getZone(deps.db, zoneId);
    const live = who.preview === true && draft === "1" ? ((await draftForPreview(deps.db, doc, zoneId)) ?? (await liveDocument(deps.db, doc, zoneId))) : await liveDocument(deps.db, doc, zoneId);
    if (live === null) throw new ApiError("not_found", "No settings are published for this zone yet.", { reason: "config_not_published" });
    // v0.18.6 (owner G4-E4): the rider app always gets the raise limit the server checks (the zone's dispatch document).
    let document = doc === "rider_app_config" ? withRaiseLimit(live.document as Record<string, unknown>, await raiseMaxFactor(deps.db, zoneId)) : (live.document as Record<string, unknown>);
    // v0.18.7 (contract.json#pickupWaiting.servedConfig): the waiting / no-show terms and rider pickup fees of the zone's
    // LIVE pricing document, whatever the app document says (a driver in Paris reads French terms in euro), and the
    // rider app gets the zone's "cancel after arrival = no-show" switch from the driver document.
    document = await withLivePricing(deps.db, doc, zoneId, document);
    // v0.18.10 (contract.json#finish.paymentMethods.served): the admin's methods (never google_pay) and what the server takes.
    document = withPaymentOptions(document, deps.paymentMethods ?? ["cash"]);
    // Live G8 5a: tip rules saved without every field (no customMax) are served whole, with the defaults the server checks
    // (SE 200 kr / FR 20 €), so the rider app shows "Other amount" when the admin allows it.
    if (doc === "rider_app_config" && document["tipRules"] && typeof document["tipRules"] === "object") {
      // The same rules (and presets) as POST /trips/{id}/tip checks.
      document = { ...document, tipRules: tipRulesOf(document, zone.country, zone.currency, await tipAmountsFor(deps.db, zoneId, zone.currency)) };
    }
    // v0.18.43 §64 (fix job 10, contract.json#blockedPairs.settings): both apps get the zone's CountryRules.dontMatchAgain.
    document = { ...document, dontMatchAgain: await dontMatchSettings(deps.db, zoneId) };
    // v0.18.57 §79 (contract.json#emergencyNumbers.apps): both apps get the zone country's emergency numbers.
    document = { ...document, emergencyNumbers: await emergencyNumbersFor(deps.db, zone.country) };
    // v0.18.115 BQ-V21 (contract.json#pickupSpots): the rider app always gets booking.pickupSpots.on (missing = on).
    if (doc === "rider_app_config") document = withPickupSpots(document);
    // v0.18.116 §94 (contract.json#shareTrip.setting): the zone's Share trip switch, also as features.shareTrip.
    if (doc === "rider_app_config") document = withShareTrip(document);
    // v0.18.144 (contract.json#liveLocation.setting): liveLocation is always served with its three keys.
    if (doc === "rider_app_config") document = withLiveLocation(document);
    // v0.18.101 §92 (contract.json#sosContactsSms.driverConfig): the switch of the zone's country and whether SMS can go.
    // v0.18.122 L20 stream (contract.json#driverOneStream.server): the driver app always gets realtime.oneStream (missing = false).
    if (doc === "driver_app_config") document = withOneStream(document);
    if (doc === "driver_app_config") document = { ...document, sosContactsSms: await sosSmsDriverConfig(deps.db, zone.country, deps.smsConnected === true) };
    // v0.7.1 (contract.json#categoryCatalog): label, sub-line and seats from the admin catalog; archived car types left out.
    return withCatalog(deps.db, document);
  };
  app.get(`${API_PREFIX}/rider/config`, serveAppDoc("rider_app_config", "rider"));
  app.get(`${API_PREFIX}/driver/config`, serveAppDoc("driver_app_config", "driver"));

  // config_published streams (contract §4): the apps re-fetch the document when one arrives.
  const streamAppDoc = (doc: ConfigDoc, actor: "rider" | "driver") => async (request: FastifyRequest, reply: FastifyReply) => {
    const who = await authenticate(request, guard, [actor]);
    const { zoneId: asked } = parseBody(OptionalZoneQuery, request.query);
    // G17: the stream follows the zone it opened with; the app opens it again when its work zone changes.
    const zoneId = await appZone(deps.db, who, actor, asked, deps.defaultZoneId, false);
    await getZone(deps.db, zoneId);
    if (deps.hub === undefined) throw new ApiError("unavailable", "Live updates are not available.", { reason: "realtime_unavailable", retryAfterSeconds: 5 });
    const lastEventId = request.headers["last-event-id"];
    const seen = typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : (await liveDocument(deps.db, doc, zoneId))?.version ?? 0;
    await streamConfig(request, reply, { db: deps.db, hub: deps.hub, ...(deps.clock ? { clock: deps.clock } : {}) }, doc, zoneId, seen, actor === "rider" ? who.subjectId : undefined, actor === "driver" ? who.subjectId : undefined);
    return reply;
  };
  app.get(`${API_PREFIX}/rider/config/stream`, streamAppDoc("rider_app_config", "rider"));
  app.get(`${API_PREFIX}/driver/config/stream`, streamAppDoc("driver_app_config", "driver"));

  // v0.18.122 L20 stream (owner 2026-11-17 "Yes, with switch (Rec.)", contract.json#driverOneStream, Rules
  // audits/load/l20-1-design.md §3): the offer feed and the driver config stream on ONE connection. One openEventStream
  // (one open file, one live-streams count), the two existing pumps attached, each with its own hub options. id is
  // '<offer sequence>.<config version>'; Last-Event-ID / ?after= in that form resumes both halves. Served whatever the
  // zone's realtime.oneStream says (the switch only tells the app which to open). The two old routes are unchanged.
  app.get(`${API_PREFIX}/driver/stream`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    // SF-2 (Rules l20-one-stream-supervisor.md): no JSON answer on this route; without Accept: text/event-stream it
    // answers 400 and opens nothing (the old /driver/offers and /driver/config stay the JSON reads).
    if (!wantsEventStream(request)) throw badRequest("GET /driver/stream is an event stream only: send Accept: text/event-stream.", "event_stream_required");
    const { zoneId: asked, after } = parseBody(OptionalZoneQuery.extend({ after: z.string().optional() }), request.query);
    const lastEventId = request.headers["last-event-id"];
    const given = after ?? (typeof lastEventId === "string" && lastEventId !== "" ? lastEventId : undefined);
    const parts = given === undefined ? undefined : /^(\d+)(?:\.(\d+))?$/.exec(given);
    if (given !== undefined && parts == null) throw badRequest("The stream id must be '<offer sequence>.<config version>'.");
    const zoneId = await appZone(deps.db, who, "driver", asked, deps.defaultZoneId, false);
    await getZone(deps.db, zoneId);
    if (deps.hub === undefined) throw new ApiError("unavailable", "Live updates are not available.", { reason: "realtime_unavailable", retryAfterSeconds: 5 });
    // Without an id: each half as on its old stream (offers from offerHead, config from the live version: nothing sent).
    const head = parts ? undefined : await offerHead(deps.db, who.subjectId);
    let offerSeq = parts ? Number(parts[1]) : head!;
    let configVersion = parts ? Number(parts[2] ?? 0) : ((await liveDocument(deps.db, "driver_app_config", zoneId))?.version ?? 0);
    const hub = deps.hub;
    const feedDeps = { db: deps.db, hub, ...(deps.clock ? { clock: deps.clock } : {}) };
    const stream = openEventStream(request, reply);
    if (head !== undefined) stream.cursor(`${offerSeq}.${configVersion}`);
    // Offers first: an offer never waits behind the config catch-up.
    await attachOfferFeed(request, feedDeps, stream, who.subjectId, offerSeq, (sequence, data) => {
      offerSeq = sequence;
      stream.send(`${offerSeq}.${configVersion}`, data);
    });
    await attachConfig(request, stream, feedDeps, "driver_app_config", zoneId, configVersion, (version, data) => {
      configVersion = Math.max(configVersion, version);
      stream.send(`${offerSeq}.${configVersion}`, data);
    }, undefined, who.subjectId);
    return reply;
  });

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
      async (trx) => ({ status: 200, body: await putDraft(trx, { doc, zoneId, expectedVersion: body.expectedVersion, document: body.document, adminId: who.subjectId, role: who.role, ...(body.removeKeys ? { removeKeys: body.removeKeys } : {}) }, now()) }),
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
