import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { tripProjection } from "./projection.js";
import { stopCommand } from "./stops.js";
import { completePreview, completeTrip, driverCancel, driverEarnings, driverStep, endEarly, noShow, rateTrip } from "./ride.js";

/** contract §3: the driver's trip commands, the rider's early end, ratings and the driver's earnings. */

export type RideDeps = { db: Db; jwtSecret: string; currency: string; timeZone: string; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Fix = z.object({ lat: z.number(), lng: z.number(), accuracy: z.number().min(0) }).passthrough();
const Command = z.object({ expectedVersion: z.number().int().min(1), location: Fix.optional() });
const Money = z.object({ amountMinor: z.number().int().min(0), currency: z.string().regex(/^[A-Z]{3}$/) });
const CompleteBody = Command.extend({ cashCollected: Money.optional() });
const NoShowBody = Command.extend({ reasonCode: z.string().optional() });
const CancelBody = z.object({ expectedVersion: z.number().int().min(1), reasonCode: z.string().min(1), note: z.string().max(1000).optional(), location: Fix.optional() });
const EarningsQuery = z.object({ period: z.enum(["day", "week", "month"]).default("week"), from: z.string().datetime().optional(), to: z.string().datetime().optional() });

const STEPS = { "head-to-pickup": "head_to_pickup", arrive: "arrive", board: "board", start: "start_trip" } as const;

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export async function rideRoutes(app: FastifyInstance, deps: RideDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, who: { actor: string; subjectId: string }) => ({
    actor: who.actor as "rider" | "driver",
    subjectId: who.subjectId,
    key: keyOf(request),
    method: request.method,
    route: request.url.split("?")[0]!.replace(`${API_PREFIX}/rides/`, `${API_PREFIX}/trips/`),
    body: request.body ?? null,
  });
  const tripId = (request: FastifyRequest) => parseBody(z.object({ tripId: ID }), request.params).tripId;

  for (const [path, command] of Object.entries(STEPS)) {
    app.post(`${API_PREFIX}/trips/:tripId/${path}`, async (request) => {
      const who = await authenticate(request, guard, ["driver"]);
      const id = tripId(request);
      const body = parseBody(Command, request.body);
      return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await driverStep(trx, who.subjectId, id, command, body.expectedVersion, now(), body.location), "driver") }))).body;
    });
  }

  // v0.7.1 (§3.8): "Framme vid stoppet" and leaving the stop.
  for (const verb of ["arrive", "leave"] as const) {
    app.post(`${API_PREFIX}/driver/trips/:tripId/stops/:stopIndex/${verb}`, async (request) => {
      const who = await authenticate(request, guard, ["driver"]);
      const params = parseBody(z.object({ tripId: ID, stopIndex: z.coerce.number().int().min(0).max(9) }), request.params);
      const body = parseBody(z.object({ expectedVersion: z.number().int().min(1) }), request.body);
      return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await stopCommand(trx, who.subjectId, params.tripId, params.stopIndex, verb, body.expectedVersion, now()), "driver") }))).body;
    });
  }

  // contract v0.17.3 §26: the final price complete would set now (read-only), shown before Collect cash.
  app.get(`${API_PREFIX}/driver/trips/:tripId/complete-preview`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return completePreview(deps.db, who.subjectId, tripId(request), now());
  });

  app.post(`${API_PREFIX}/trips/:tripId/complete`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const id = tripId(request);
    const body = parseBody(CompleteBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await completeTrip(trx, { actor: "driver", subjectId: who.subjectId }, id, body, now()), "driver") }))).body;
  });

  app.post(`${API_PREFIX}/trips/:tripId/no-show`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const id = tripId(request);
    const body = parseBody(NoShowBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await noShow(trx, who.subjectId, id, body, now()), "driver") }))).body;
  });

  app.post(`${API_PREFIX}/trips/:tripId/end-early`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    const id = tripId(request);
    return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await endEarly(trx, who.subjectId, id, (request.body ?? {}) as never, now()), "rider") }))).body;
  });

  app.post(`${API_PREFIX}/trips/:tripId/rating`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const id = tripId(request);
    const actor = who.actor as "rider" | "driver";
    const result = await runIdempotent(deps.db, idem(request, { actor, subjectId: who.subjectId }), async (trx) => rateTrip(trx, { actor, subjectId: who.subjectId }, id, request.body ?? {}, now()));
    return result.status === 204 ? reply.status(204).send() : reply.status(result.status).send(result.body);
  });

  app.get(`${API_PREFIX}/driver/earnings`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const query = parseBody(EarningsQuery, request.query);
    return driverEarnings(deps.db, who.subjectId, { period: query.period, ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}), timeZone: deps.timeZone, currency: deps.currency }, now());
  });
}

/** The driver's cancel, used by POST /trips/{tripId}/cancel (and the /rides alias) when the caller is a driver. */
export const DriverCancelBody = CancelBody;
export { driverCancel };
