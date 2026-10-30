import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { adminCoversZone, authenticate, authenticateAdmin } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { OFFER_EVENTS_CHANNEL } from "../db/tripLog.js";
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
    const items = [];
    for (const row of rows) {
      const trip = await deps.db.selectFrom("trips").selectAll().where("trip_id", "=", row.trip_id).executeTakeFirstOrThrow();
      items.push(offerView(row, trip));
    }
    return { items, nextCursor: null };
  });

  app.get(`${API_PREFIX}/driver/offers/stream`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { after: afterQuery } = parseBody(z.object({ after: z.coerce.number().int().min(0).optional() }), request.query);
    const lastEventId = request.headers["last-event-id"];
    const cursor = afterQuery ?? (typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : undefined);
    const after = cursor ?? 0;
    const read = async (from: number) =>
      deps.db.selectFrom("offer_events").selectAll().where("driver_id", "=", who.subjectId).where("sequence", ">", String(from)).orderBy("sequence").limit(200).execute();
    const envelope = (row: Awaited<ReturnType<typeof read>>[number]) => {
      // v0.8.0 (contract.json#autoOffline): the run's last miss carries driverOffline beside the offer.
      const { driverOffline, ...offer } = row.offer as Record<string, unknown>;
      return { eventId: row.event_id, sequence: Number(row.sequence), kind: row.kind, occurredAt: row.occurred_at.toISOString(), serverTime: now().toISOString(), offer, ...(driverOffline === true ? { driverOffline: true } : {}) };
    };
    if (!wantsEventStream(request)) {
      const rows = await read(after);
      return { items: rows.map(envelope), nextCursor: rows.length === 200 ? String(rows[rows.length - 1]!.sequence) : null };
    }
    if (deps.hub === undefined) throw new ApiError("unavailable", "Live offers are not available; poll /driver/offers.", { reason: "realtime_unavailable", retryAfterSeconds: 5 });
    // Driver 03c (live test 2026-10-30): a feed opened without a cursor (an app that just started) begins at the
    // driver's newest event and says so with an `id:`. Replaying the whole history sent hundreds of old events, among
    // them an old driverOffline that set the driver offline again right after Go online. The open offers come from
    // GET /driver/offers; `?after=0` still replays everything.
    const head =
      cursor === undefined
        ? Number((await deps.db.selectFrom("offer_events").select((eb) => eb.fn.max("sequence").as("head")).where("driver_id", "=", who.subjectId).executeTakeFirst())?.head ?? 0)
        : undefined;
    const stream = openEventStream(request, reply);
    if (head !== undefined && head > 0) stream.cursor(head);
    let last = head ?? after;
    let running = false;
    let again = false;
    const pump = async () => {
      if (running) return void (again = true);
      running = true;
      try {
        do {
          again = false;
          const rows = await read(last);
          for (const row of rows) {
            stream.send(Number(row.sequence), envelope(row));
            last = Number(row.sequence);
          }
          if (rows.length === 200) again = true;
        } while (again && !stream.closed());
      } catch (error) {
        request.log.warn({ err: error }, "offer stream read failed");
      } finally {
        running = false;
      }
    };
    const unsubscribe = deps.hub.subscribe(OFFER_EVENTS_CHANNEL, (payload) => {
      if (payload === null || payload["driverId"] === who.subjectId) void pump();
    });
    stream.onClose(unsubscribe);
    await pump();
    return reply;
  });

  app.post(`${API_PREFIX}/offers/:offerId/accept`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { offerId } = parseBody(z.object({ offerId: ID }), request.params);
    const body = parseBody(OfferBody, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await acceptOffer(trx, who.subjectId, offerId, body.expectedVersion, now()), "driver") }));
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
