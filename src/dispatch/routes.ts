import type { FastifyInstance, FastifyRequest } from "fastify";
import { appClientOf } from "../config/appUpdate.js";
import { z } from "zod";
import { adminCoversZone, authenticate, authenticateAdmin } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { attachOfferFeed, offerHead, offerPage } from "./offerFeed.js";
import { ApiError, badRequest } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { getZone, liveDocument } from "../config/service.js";
import type { NotificationHub } from "../realtime/hub.js";
import { openEventStream, wantsEventStream } from "../realtime/sse.js";
import { tripProjection } from "../trips/projection.js";
import { riderCancel } from "../trips/service.js";
import { registerApprovalHandler } from "../admin/approvals.js";
import type { DispatchDoc } from "./engine.js";
import { zoneDriverFacts } from "./driverFacts.js";
import { acceptOffer, declineOffer, keepWaiting, offerView } from "./runtime.js";
import type { Trx } from "../db/db.js";

/** contract §3.6, §4: driver offers (list, stream, accept, decline), the rider's keep-waiting, dispatch control. */

export type DispatchDeps = { db: Db; jwtSecret: string; hub?: NotificationHub; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const OfferBody = z.object({ expectedVersion: z.number().int().min(1) });
const DeclineBody = z.object({ expectedVersion: z.number().int().min(1), reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional() });
const KeepWaitingBody = z.object({ answer: z.enum(["wait", "stop"]), expectedVersion: z.number().int().min(1).optional() });
const ControlBody = z.object({ expectedVersion: z.number().int().min(0), paused: z.boolean(), mode: z.enum(["radar", "exclusive"]).nullable(), note: z.string().max(1000).optional() });

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export const CONTROL_ACTION = "dispatch.control";

async function controlView(ex: Db | Trx, zoneId: string) {
  const row = await ex.selectFrom("dispatch_controls").selectAll().where("zone_id", "=", zoneId).executeTakeFirst();
  return row
    ? { zoneId, paused: row.paused, mode: row.mode, ...(row.by ? { by: row.by } : {}), at: row.at.toISOString(), version: row.version }
    : { zoneId, paused: false, mode: null, version: 0 };
}

async function setControl(trx: Trx, payload: Record<string, unknown>, by: string, now: Date) {
  const zoneId = payload["zoneId"] as string;
  const current = await trx.selectFrom("dispatch_controls").selectAll().where("zone_id", "=", zoneId).forUpdate().executeTakeFirst();
  const version = current?.version ?? 0;
  if (version !== payload["expectedVersion"]) throw new ApiError("version_mismatch", "The zone's dispatch switch changed.", { projection: await controlView(trx, zoneId) });
  const values = { zone_id: zoneId, paused: payload["paused"] as boolean, mode: payload["mode"] as "radar" | "exclusive" | null, by, at: now, version: version + 1 };
  await trx.insertInto("dispatch_controls").values(values).onConflict((c) => c.column("zone_id").doUpdateSet(values)).execute();
  return controlView(trx, zoneId);
}

registerApprovalHandler(CONTROL_ACTION, async (trx, payload, _approvedBy, requestedBy, now) => setControl(trx, payload, requestedBy, now));

export async function dispatchRoutes(app: FastifyInstance, deps: DispatchDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: { actor: "rider" | "driver" | "admin"; subjectId: string }) => ({ actor: who.actor, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });

  // GET /driver/offers: the driver's offers, newest first (open ones by default). With Accept: text/event-stream
  // GET /driver/offers/stream is the live feed with per-driver sequence (?after=, Last-Event-ID).
  app.get(`${API_PREFIX}/driver/offers`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { status, limit } = parseBody(z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), request.query);
    const rows = await deps.db.selectFrom("offers").selectAll().where("driver_id", "=", who.subjectId).where("status", "=", (status ?? "open") as "open").orderBy("sent_at", "desc").limit(limit).execute();
    // Job 1 (fix plan R23, stress L1): the offers' trips in ONE query, not one per offer.
    const tripIds = [...new Set(rows.map((r) => r.trip_id))];
    const trips = tripIds.length ? await deps.db.selectFrom("trips").selectAll().where("trip_id", "in", tripIds).execute() : [];
    const tripOf = new Map(trips.map((t) => [t.trip_id, t]));
    const items = rows.map((row) => offerView(row, tripOf.get(row.trip_id)!));
    return { items, nextCursor: null };
  });

  app.get(`${API_PREFIX}/driver/offers/stream`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { after: afterQuery } = parseBody(z.object({ after: z.coerce.number().int().min(0).optional() }), request.query);
    const lastEventId = request.headers["last-event-id"];
    const cursor = afterQuery ?? (typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : undefined);
    const after = cursor ?? 0;
    if (!wantsEventStream(request)) return offerPage(deps.db, who.subjectId, after, now());
    if (deps.hub === undefined) throw new ApiError("unavailable", "Live offers are not available; poll /driver/offers.", { reason: "realtime_unavailable", retryAfterSeconds: 5 });
    // Driver 03c: without a cursor the feed starts at offerHead (offerFeed.ts). An `id:` is always sent (`id: 0` with
    // no events) so the app always has a cursor for its next reconnect. `?after=0` / Last-Event-ID still replay from there.
    const head = cursor === undefined ? await offerHead(deps.db, who.subjectId) : undefined;
    const stream = openEventStream(request, reply);
    if (head !== undefined) stream.cursor(head);
    // v0.18.122 (L20 stream): the pump lives in offerFeed.ts so GET /driver/stream can attach the same one.
    await attachOfferFeed(request, { db: deps.db, hub: deps.hub, ...(deps.clock ? { clock: deps.clock } : {}) }, stream, who.subjectId, head ?? after, (sequence, data) => void stream.send(sequence, data));
    return reply;
  });

  // v0.18.6 (G4 decision 4, contract.json#driverOffers.acceptCheck): "did my accept go through?" after a lost answer.
  // The driver's own offer as it is now (any status); with the trip (driver view) when it is claimed, i.e. his.
  app.get(`${API_PREFIX}/driver/offers/:offerId`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { offerId } = parseBody(z.object({ offerId: ID }), request.params);
    const offer = await deps.db.selectFrom("offers").selectAll().where("offer_id", "=", offerId).executeTakeFirst();
    if (offer === undefined || offer.driver_id !== who.subjectId) throw new ApiError("not_found", "No such offer.", { reason: "offer_not_found" });
    const trip = await deps.db.selectFrom("trips").selectAll().where("trip_id", "=", offer.trip_id).executeTakeFirstOrThrow();
    // An open offer whose time is over reads as expired (as accept would answer), even before the round timer ran.
    const status = offer.status === "open" && offer.expires_at.getTime() <= now().getTime() ? "expired" : offer.status;
    const mine = status === "claimed" && trip.driver_id === who.subjectId;
    return { offer: offerView({ ...offer, status }, trip), ...(mine ? { trip: tripProjection(trip, "driver") } : {}) };
  });

  app.post(`${API_PREFIX}/offers/:offerId/accept`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { offerId } = parseBody(z.object({ offerId: ID }), request.params);
    const body = parseBody(OfferBody, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await acceptOffer(trx, who.subjectId, offerId, body.expectedVersion, now(), appClientOf(request)), "driver") }));
    return result.body;
  });

  app.post(`${API_PREFIX}/offers/:offerId/decline`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { offerId } = parseBody(z.object({ offerId: ID }), request.params);
    const body = parseBody(DeclineBody, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await declineOffer(trx, who.subjectId, offerId, body.expectedVersion, body.reasonCode, now()) }));
    return result.body;
  });

  app.post(`${API_PREFIX}/trips/:tripId/keep-waiting`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const body = parseBody(KeepWaitingBody, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => {
      const trip = await keepWaiting(trx, who.subjectId, tripId, body.answer, now(), (current) =>
        // Stop = the normal free rider cancel, reason wait_too_long (owner decision 24).
        riderCancel(trx, who.subjectId, tripId, { expectedVersion: current.version, reasonCode: "wait_too_long" }, now()),
        body.expectedVersion,
      );
      return { status: 200, body: tripProjection(trip, "rider") };
    });
    return result.body;
  });

  app.get(`${API_PREFIX}/admin/zones/:zoneId/dispatch-control`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const { zoneId } = parseBody(z.object({ zoneId: ID }), request.params);
    if (!adminCoversZone(who, zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
    await getZone(deps.db, zoneId);
    return controlView(deps.db, zoneId);
  });

  // v0.18.21 (contract.json#dispatchDriverFacts, owner 2026-11-04): the real facts of the zone's online drivers.
  app.get(`${API_PREFIX}/admin/zones/:zoneId/driver-facts`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const { zoneId } = parseBody(z.object({ zoneId: ID }), request.params);
    if (!adminCoversZone(who, zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
    await getZone(deps.db, zoneId);
    return zoneDriverFacts(deps.db, zoneId, now());
  });

  app.put(`${API_PREFIX}/admin/zones/:zoneId/dispatch-control`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "dispatch.edit");
    const { zoneId } = parseBody(z.object({ zoneId: ID }), request.params);
    if (!adminCoversZone(who, zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
    await getZone(deps.db, zoneId);
    const body = parseBody(ControlBody, request.body);
    if (body.mode !== null) {
      const doc = await liveDocument<DispatchDoc>(deps.db, "dispatch", zoneId);
      if (doc && !doc.document[body.mode].on) throw badRequest(`${body.mode} is switched off in this zone's rules.`, "mode_off");
    }
    const payload = { zoneId, expectedVersion: body.expectedVersion, paused: body.paused, mode: body.mode };
    const result = await runIdempotent<Record<string, unknown>>(deps.db, idem(request, who), async (trx) =>
      // Contract v0.7.2 (one admin is enough): pause, force a mode, resume and back to the rules apply at once.
      ({ status: 200, body: await setControl(trx, payload, who.subjectId, now()) }));
    return reply.status(result.status).send(result.body);
  });
}
