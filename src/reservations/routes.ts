import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { adminCoversZone, authenticate, authenticateAdmin } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { contract } from "../contract/contract.js";
import { tripProjection } from "../trips/projection.js";
import { driverView } from "../drivers/service.js";
import { reservationPolicy, saveReservationPolicy } from "./policy.js";
import { acceptReservation, keepReservation, adminDispatchNow, adminUnassign, driverReservations, releaseReservation, rescheduleTrip, startReservation } from "./service.js";

/** v0.18.17 Book later (CONTRACT.md §41, contract.json#bookLater): driver Scheduled rides, rider change, admin actions. */

export type ReservationDeps = { db: Db; jwtSecret: string; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Version = z.object({ expectedVersion: z.number().int().min(1).optional() });
const Release = z.object({ reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), note: z.string().max(1000).optional() });
// v0.18.174 (contract.json#priceChangeAsk): agreedQuoteId + priceAccepted; a client amount is refused (noClientAmount).
const NO_CLIENT_AMOUNT = (contract as unknown as { priceChangeAsk: { noClientAmount: { fields: string[] } } }).priceChangeAsk.noClientAmount.fields;
const Reschedule = z
  .object({ quoteId: ID, expectedVersion: z.number().int().min(1), agreedQuoteId: ID.optional(), priceAccepted: z.boolean().optional() })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const field of NO_CLIENT_AMOUNT) if (field in value) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "a price is never sent by the app" });
  })
  .transform(({ quoteId, expectedVersion, agreedQuoteId, priceAccepted }) => ({ quoteId, expectedVersion, agreedQuoteId, priceAccepted }));
const AdminBody = z.object({ expectedVersion: z.number().int().min(1), reason: z.string().max(500).optional() });

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export async function reservationRoutes(app: FastifyInstance, deps: ReservationDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: { actor: "rider" | "driver" | "admin"; subjectId: string }) => ({ actor: who.actor, subjectId: who.subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });
  const tripParam = (request: FastifyRequest) => parseBody(z.object({ tripId: ID }), request.params).tripId;

  app.get(`${API_PREFIX}/driver/reservations`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { scope } = parseBody(z.object({ scope: z.enum(["open", "accepted"]).default("open") }).passthrough(), request.query);
    return driverReservations(deps.db, who.subjectId, scope, now());
  });

  app.post(`${API_PREFIX}/driver/reservations/:tripId/accept`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const tripId = tripParam(request);
    const body = parseBody(Version, request.body ?? {});
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await acceptReservation(trx, who.subjectId, tripId, body.expectedVersion, now()), "driver") }));
    return result.body;
  });

  app.post(`${API_PREFIX}/driver/reservations/:tripId/release`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const tripId = tripParam(request);
    const body = parseBody(Release, request.body);
    await runIdempotent(deps.db, idem(request, who), async (trx) => {
      await releaseReservation(trx, who.subjectId, tripId, body.note ? { reasonCode: body.reasonCode, note: body.note } : { reasonCode: body.reasonCode }, now());
      return { status: 204, body: null };
    });
    return reply.status(204).send();
  });

  app.post(`${API_PREFIX}/driver/reservations/:tripId/start`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const tripId = tripParam(request);
    const body = parseBody(Version, request.body ?? {});
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await startReservation(trx, who.subjectId, tripId, body.expectedVersion, now()), "driver") }));
    return result.body;
  });

  app.post(`${API_PREFIX}/driver/reservations/:tripId/keep`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const tripId = tripParam(request);
    const body = parseBody(z.object({ keep: z.boolean() }), request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await keepReservation(trx, who.subjectId, tripId, body.keep, now()), "driver") }));
    return result.body;
  });

  // Owner BL-Q4: the driver's home area (who sees "home nearby" booked rides).
  const HomeArea = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), label: z.string().trim().max(120).optional() });
  for (const method of ["put", "delete"] as const) {
    app[method](`${API_PREFIX}/driver/home-area`, async (request) => {
      const who = await authenticate(request, guard, ["driver"]);
      const area = method === "put" ? parseBody(HomeArea, request.body) : null;
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => {
        await trx.updateTable("drivers").set({ home_area: area ? JSON.stringify(area) : null, updated_at: now() }).where("driver_id", "=", who.subjectId).execute();
        const row = await trx.selectFrom("drivers").selectAll().where("driver_id", "=", who.subjectId).executeTakeFirstOrThrow();
        return { status: 200, body: await driverView(trx, row, "driver", now()) };
      });
      return result.body;
    });
  }

  // Owner BL-Q4: the rider's favourite drivers (marked after a ride).
  const favourites = async (ex: Db | Parameters<Parameters<typeof runIdempotent>[2]>[0], riderId: string) => ({
    items: (await ex.selectFrom("rider_favourite_drivers").innerJoin("drivers", "drivers.driver_id", "rider_favourite_drivers.driver_id").select(["drivers.driver_id as driverId", "drivers.first_name as firstName"]).where("rider_favourite_drivers.rider_id", "=", riderId).orderBy("rider_favourite_drivers.created_at").execute()),
  });
  app.get(`${API_PREFIX}/rider/favourite-drivers`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    return favourites(deps.db, who.subjectId);
  });
  for (const method of ["put", "delete"] as const) {
    app[method](`${API_PREFIX}/rider/favourite-drivers/:driverId`, async (request) => {
      const who = await authenticate(request, guard, ["rider"]);
      const { driverId } = parseBody(z.object({ driverId: ID }), request.params);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => {
        if (method === "put") {
          const drove = await trx.selectFrom("trips").select("trip_id").where("rider_id", "=", who.subjectId).where("driver_id", "=", driverId).where("status", "=", "completed").executeTakeFirst();
          if (!drove) throw new ApiError("not_found", "Only a driver of one of your rides can be a favourite.", { reason: "driver_not_found" });
          await trx.insertInto("rider_favourite_drivers").values({ rider_id: who.subjectId, driver_id: driverId }).onConflict((c) => c.doNothing()).execute();
        } else {
          await trx.deleteFrom("rider_favourite_drivers").where("rider_id", "=", who.subjectId).where("driver_id", "=", driverId).execute();
        }
        return { status: 200, body: await favourites(trx, who.subjectId) };
      });
      return result.body;
    });
  }

  app.post(`${API_PREFIX}/trips/:tripId/reschedule`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const tripId = tripParam(request);
    const body = parseBody(Reschedule, request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await rescheduleTrip(trx, who.subjectId, tripId, body, now()), "rider") }));
    return result.body;
  });

  for (const [segment, run] of [["unassign", adminUnassign], ["dispatch-now", adminDispatchNow]] as const) {
    app.post(`${API_PREFIX}/admin/trips/:tripId/reservation/${segment}`, async (request) => {
      const who = await authenticateAdmin(request, guard, "trips.intervene");
      const tripId = tripParam(request);
      const body = parseBody(AdminBody, request.body);
      const result = await runIdempotent(deps.db, idem(request, who), async (trx) => {
        const zone = await trx.selectFrom("trips").select("zone_id").where("trip_id", "=", tripId).executeTakeFirst();
        if (!zone) throw new ApiError("not_found", "No such trip.", { reason: "trip_not_found" });
        if (!adminCoversZone(who, zone.zone_id)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
        return { status: 200, body: tripProjection(await run(trx, who, tripId, body.reason ? { expectedVersion: body.expectedVersion, reason: body.reason } : { expectedVersion: body.expectedVersion }, now()), "admin") };
      });
      return result.body;
    });
  }

  /* v0.18.19 (owner, bookLater.liveFixes.includedWaiting): the all-zones reservation policy. */
  app.get(`${API_PREFIX}/admin/reservations/policy`, async (request) => {
    await authenticateAdmin(request, guard, "trips.read");
    return reservationPolicy(deps.db);
  });
  app.put(`${API_PREFIX}/admin/reservations/policy`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.intervene");
    const body = parseBody(z.object({ expectedRev: z.number().int().min(1), includedWaitingMinutes: z.number().int().min(0).max(60) }), request.body);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: await saveReservationPolicy(trx, who, body, now()) }));
    return result.body;
  });
}
