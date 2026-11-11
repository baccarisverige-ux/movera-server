import { markRiderSeen } from "../riders/presence.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, type Principal } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { tripEventsAfter } from "../db/tripLog.js";
import { ApiError, badRequest } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { nearbyVehicles } from "../riders/nearby.js";
import { getRiderProfile, requestDeletion, updateRiderProfile } from "../riders/service.js";
import { tripProjection } from "./projection.js";
import { answerRouteChange, quoteRouteChange, requestRouteChange } from "./routeChange.js";
import { tripPath } from "./path.js";
import { EstimateRouter, type Router } from "../maps/routing.js";
import { assertAdminTripScope, listMessages, sendMessage } from "./messages.js";
import { callTripPeer } from "./call.js";
import { disabledTelephony, type TelephonyProvider } from "../telephony/provider.js";
import { eventEnvelope } from "../realtime/events.js";
import { TERMINAL, type TripStatus } from "../rules/transitions.js";
import type { NotificationHub } from "../realtime/hub.js";
import { wantsEventStream } from "../realtime/sse.js";
import { streamTrip } from "../realtime/streams.js";
import { DriverCancelBody, driverCancel } from "./rideRoutes.js";
import { activeTrip, createTrip, getTrip, movePickup, raisePrice, riderCancel, riderTrips, setCancelReason, riderOnTheWay, withDriverPosition } from "./service.js";

/** contract §3, §7: trips for the rider (with the deprecated /rides aliases), the rider profile, payment methods. */

const NearbyQuery = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) });

const RouteChangeBody = z.object({ expectedVersion: z.number().int().min(1), routeQuoteId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
const RouteChangeAnswer = z.object({ expectedVersion: z.number().int().min(1), changeId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

export type TripDeps = { db: Db; router?: Router; jwtSecret: string; paymentMethods: readonly string[]; currency: string; hub?: NotificationHub; clock?: () => Date; telephony?: TelephonyProvider };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const CancelBody = z.object({ expectedVersion: z.number().int().min(1), reasonCode: z.string().min(1), note: z.string().max(1000).optional() });
const ReasonBody = z.object({ reasonCode: z.string().min(1), note: z.string().max(1000).optional() });
const ListQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.union([z.string(), z.array(z.string())]).optional(),
  kind: z.enum(["live", "scheduled"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) });
const MessagesQuery = z.object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const DefaultMethodBody = z.object({ method: z.string(), paymentMethodId: z.string().optional() });

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

/** The chat's caller: an admin brings their zones and permissions (support.reply, contract v0.13.0 §22). */
const chatWho = (who: Principal) => ({ actor: who.actor as "rider" | "driver" | "admin", subjectId: who.subjectId, zones: who.zones, ...(who.perms ? { perms: who.perms } : {}) });

export async function tripRoutes(app: FastifyInstance, deps: TripDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: { actor: "rider" | "driver" | "admin"; subjectId: string }, method = request.method) => ({
    actor: who.actor,
    subjectId: who.subjectId,
    key: keyOf(request),
    method,
    // The alias and the real path are one route: a retry on either replays the same answer.
    route: request.url.split("?")[0]!.replace(`${API_PREFIX}/rides/`, `${API_PREFIX}/trips/`),
    body: request.body ?? null,
  });

  app.post(`${API_PREFIX}/trips`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => {
      const trip = await createTrip(trx, who.subjectId, request.body ?? {}, { paymentMethods: deps.paymentMethods, now: now() });
      return { status: 201, body: tripProjection(trip, "rider") };
    });
    return reply.status(result.status).send(result.body);
  });

  for (const base of ["trips", "rides"] as const) {
    const param = base === "trips" ? "tripId" : "rideId";
    app.get(`${API_PREFIX}/${base}/:${param}`, async (request) => {
      const who = await authenticate(request, guard, base === "rides" ? ["rider"] : ["rider", "driver", "admin"]);
      const id = parseBody(z.object({ [param]: ID }), request.params)[param] as string;
      return getTrip(deps.db, id, chatWho(who), now());
    });

    app.post(`${API_PREFIX}/${base}/:${param}/cancel`, async (request) => {
      const who = await authenticate(request, guard, base === "rides" ? ["rider"] : ["rider", "driver"]);
      const id = parseBody(z.object({ [param]: ID }), request.params)[param] as string;
      if (who.actor === "driver") {
        const body = parseBody(DriverCancelBody, request.body);
        return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await driverCancel(trx, who.subjectId, id, body, now()), "driver") }))).body;
      }
      const body = parseBody(CancelBody, request.body);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await riderCancel(trx, who.subjectId, id, body, now()), "rider") }));
      return result.body;
    });
  }

  // contract v0.17.0 §25: the route of an ended trip, for its rider or driver (read-only).
  const roads = deps.router ?? new EstimateRouter();
  app.get(`${API_PREFIX}/trips/:tripId/path`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    return tripPath(deps.db, roads, tripId, { actor: who.actor as "rider" | "driver", subjectId: who.subjectId });
  });

  // v0.18.7 (contract.json#pickupWaiting.pickupMove): the rider moves the pickup, at most booking.maxPickupMoveMeters.
  app.patch(`${API_PREFIX}/trips/:tripId`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const id = parseBody(z.object({ tripId: ID }), request.params).tripId;
    const raw = (request.body ?? {}) as Record<string, unknown>;
    // v0.18.9 (contract.json#onTrip.routeChange): with routeQuoteId the rider confirms a route change.
    const run = (trx: Parameters<typeof movePickup>[0]) =>
      typeof raw["routeQuoteId"] === "string" && raw["pickup"] === undefined
        ? requestRouteChange(trx, who.subjectId, id, parseBody(RouteChangeBody, raw), now())
        : movePickup(trx, who.subjectId, id, raw, now());
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await run(trx), "rider", { now: now() }) }));
    return result.body;
  });

  // v0.18.9 (contract.json#onTrip.routeChange): the price of a new route, then the driver's answer (or the rider's withdraw).
  app.post(`${API_PREFIX}/trips/:tripId/route-quote`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const id = parseBody(z.object({ tripId: ID }), request.params).tripId;
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 201, body: await quoteRouteChange(trx, roads, who.subjectId, id, request.body ?? {}, now()) }));
    return reply.status(result.status).send(result.body);
  });
  for (const [verb, actor] of [["accept", "driver"], ["refuse", "driver"], ["withdraw", "rider"]] as const) {
    app.post(`${API_PREFIX}/trips/:tripId/route-change/${verb}`, async (request) => {
      const who = await authenticate(request, guard, [actor]);
      const id = parseBody(z.object({ tripId: ID }), request.params).tripId;
      const body = parseBody(RouteChangeAnswer, request.body);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await answerRouteChange(trx, { actor, subjectId: who.subjectId }, id, verb, body, now()), actor, { now: now() }) }));
      return result.body;
    });
  }

  app.post(`${API_PREFIX}/trips/:tripId/cancel-reason`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const body = parseBody(ReasonBody, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await setCancelReason(trx, who.subjectId, tripId, body), "rider") }));
    return result.body;
  });

  app.post(`${API_PREFIX}/trips/:tripId/raise-price`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await raisePrice(trx, who.subjectId, tripId, (request.body ?? {}) as never, now()), "rider") }))).body;
  });

  app.post(`${API_PREFIX}/trips/:tripId/on-the-way`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await riderOnTheWay(trx, who.subjectId, tripId, now()), "rider") }));
    return result.body;
  });

  app.get(`${API_PREFIX}/trips/:tripId/events`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider", "driver", "admin"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const query = parseBody(EventsQuery, request.query);
    const lastEventId = request.headers["last-event-id"];
    const after = query.after ?? (typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number(lastEventId) : 0);
    const viewer = who.actor as "rider" | "driver" | "admin";
    const seen = await getTrip(deps.db, tripId, chatWho(who));
    // v0.18.5 (G9, chat.appStorage.afterTrip): after the trip the apps get no chat text.
    const hideMessage = viewer !== "admin" && TERMINAL.has(seen["status"] as TripStatus);
    if (wantsEventStream(request)) {
      if (deps.hub === undefined) throw new ApiError("unavailable", "Live updates are not available; poll the trip instead.", { reason: "realtime_unavailable", retryAfterSeconds: 5 });
      await streamTrip(request, reply, { db: deps.db, hub: deps.hub, ...(deps.clock ? { clock: deps.clock } : {}) }, tripId, who, after);
      return reply;
    }
    const rows = await tripEventsAfter(deps.db, tripId, after, query.limit + 1);
    const serverTime = now();
    const items = rows.slice(0, query.limit).map((row) => eventEnvelope(row, viewer, serverTime, { hideMessage }));
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > query.limit && last ? String(last["sequence"]) : null };
  });

  // The trip chat (contract Message): both sides of the trip and admins (as support). Not a trip change: no
  // expectedVersion, no version bump; the message goes out as a `message` event on the trip's stream.
  app.get(`${API_PREFIX}/trips/:tripId/messages`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver", "admin"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const query = parseBody(MessagesQuery, request.query);
    return listMessages(deps.db, chatWho(who), tripId, { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) });
  });

  app.post(`${API_PREFIX}/trips/:tripId/messages`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider", "driver", "admin"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 201, body: await sendMessage(trx, chatWho(who), tripId, request.body ?? {}, now()) }));
    return reply.status(result.status).send(result.body);
  });

  // v0.18.38 §62: an in-app call (default) or, with mode phone and a provider, a masked number (contract v0.13.0 §22).
  app.post(`${API_PREFIX}/trips/:tripId/call`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const telephony = deps.telephony ?? disabledTelephony;
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await callTripPeer(trx, { actor: who.actor as "rider" | "driver", subjectId: who.subjectId }, tripId, telephony, now()) }));
    return result.body;
  });

  app.get(`${API_PREFIX}/rider/trips/active`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const trip = await activeTrip(deps.db, who.subjectId);
    return trip === undefined ? reply.status(204).send() : withDriverPosition(deps.db, trip, tripProjection(trip, "rider"));
  });

  app.get(`${API_PREFIX}/rider/trips`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const query = parseBody(ListQuery, request.query);
    const statuses = query.status === undefined ? undefined : Array.isArray(query.status) ? query.status : [query.status];
    return riderTrips(deps.db, who.subjectId, { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}), ...(statuses ? { statuses } : {}), ...(query.kind ? { kind: query.kind } : {}), ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}) });
  });

  app.get(`${API_PREFIX}/rider/profile`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    return getRiderProfile(deps.db, who.subjectId, deps.currency);
  });

  // contract v0.5.2 §13: the free cars around the rider's map, with nothing that tells who drives.
  app.get(`${API_PREFIX}/rider/nearby-vehicles`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const point = parseBody(NearbyQuery, request.query);
    // v0.18.4 (G3-R4): the open map makes the rider "online" in its zone for the admin's Dashboard.
    await markRiderSeen(deps.db, who.subjectId, point, now());
    return nearbyVehicles(deps.db, point, deps.jwtSecret, now());
  });

  app.patch(`${API_PREFIX}/rider/profile`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await updateRiderProfile(trx, who.subjectId, request.body ?? {}, deps.currency, now()) }));
    return result.body;
  });

  // Payment methods (test week: cash only, owner decision). Cash is always there and is the default.
  const methodsPage = () => ({ items: deps.paymentMethods.filter((m) => m === "cash").map((m) => ({ paymentMethodId: m, method: m, isDefault: true })), nextCursor: null });
  app.get(`${API_PREFIX}/payment-methods`, async (request) => {
    await authenticate(request, guard, ["rider"]);
    return methodsPage();
  });
  app.post(`${API_PREFIX}/payment-methods`, async (request) => {
    await authenticate(request, guard, ["rider"]);
    throw badRequest("Only cash is available for now.", "payment_method_not_available");
  });
  // Openapi lists card methods, payment intents and wallet top-up; the test week takes cash only, so these answer the
  // same typed 400 as POST /payment-methods instead of a plain 404 (audit B9). No money is moved.
  const cashOnly = async (request: FastifyRequest): Promise<never> => {
    await authenticate(request, guard, ["rider"]);
    throw badRequest("Only cash is available for now.", "payment_method_not_available");
  };
  app.delete(`${API_PREFIX}/payment-methods/:paymentMethodId`, cashOnly);
  app.post(`${API_PREFIX}/payments`, cashOnly);
  app.post(`${API_PREFIX}/payments/:paymentId/confirm`, cashOnly);
  app.post(`${API_PREFIX}/wallet/topup`, cashOnly);
  // v0.18.61 §83 (contract.json#paymentRead): GET /payments/{paymentId} for the rider and the admin. A trip's one
  // payment is pay_<tripId> (as GET /admin/payments). A rider sees only his own (anyone else's → 404 not_found); an
  // admin needs finance.read and the trip's zone (the §77 helper). Those checks come first; while cash-only no
  // payment intent exists, so it then answers the typed 400 of the card routes.
  app.get(`${API_PREFIX}/payments/:paymentId`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "admin"]);
    const { paymentId } = parseBody(z.object({ paymentId: z.string().min(1).max(200) }), request.params);
    // An admin without finance.read is refused before any lookup, so the answer never tells which payments exist.
    if (who.actor === "admin" && !(who.perms ?? []).includes("finance.read")) throw new ApiError("forbidden", "You do not have permission to do that.", { reason: "missing_permission" });
    const tripId = paymentId.startsWith("pay_") ? paymentId.slice(4) : null;
    const trip = tripId ? await deps.db.selectFrom("trips").select(["trip_id", "rider_id", "zone_id"]).where("trip_id", "=", tripId).executeTakeFirst() : undefined;
    const mine = trip !== undefined && (who.actor === "admin" || trip.rider_id === who.subjectId);
    if (!mine) throw new ApiError("not_found", "No such payment.", { reason: "not_found" });
    assertAdminTripScope(chatWho(who), trip, "finance.read");
    throw badRequest("Only cash is available for now.", "payment_method_not_available");
  });
  app.post(`${API_PREFIX}/payment-methods/default`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const body = parseBody(DefaultMethodBody, request.body);
    if (!deps.paymentMethods.includes(body.method)) throw badRequest("Only cash is available for now.", "payment_method_not_available");
    const result = await runIdempotent(deps.db, idem(request, who), async () => ({ status: 200, body: methodsPage() }));
    return result.body;
  });

  app.post(`${API_PREFIX}/account/deletion`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 202, body: await requestDeletion(trx, who.subjectId, now()) }));
    return reply.status(result.status).send(result.body);
  });
}
