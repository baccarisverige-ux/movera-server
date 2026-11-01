import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { ApiError } from "../http/errors.js";
import { tripProjection } from "./projection.js";
import { stopCommand } from "./stops.js";
import { checkPin, contractAtLeast, riderPin, verifyPin } from "./pin.js";
import { driverReceipt, giveTip, riderReceipt } from "./finish.js";
import { completePreview, completeTrip, PriceChanged, driverCancel, driverEarnings, driverStep, endEarly, noShow, rateTrip } from "./ride.js";

/** contract §3: the driver's trip commands, the rider's early end, ratings and the driver's earnings. */

/** paymentMethods: what the server takes today (env PAYMENT_METHODS, default cash), for the tip method (v0.18.10). */
export type RideDeps = { db: Db; jwtSecret: string; currency: string; timeZone: string; paymentMethods?: readonly string[]; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Fix = z.object({ lat: z.number(), lng: z.number(), accuracy: z.number().min(0) }).passthrough();
const Command = z.object({ expectedVersion: z.number().int().min(1), location: Fix.optional() });
/** v0.18.8 (contract.json#arrivedWaiting.pin): board / start may carry the rider's PIN (or the token of /pin/verify). */
const StepBody = Command.extend({ pin: z.string().regex(/^\d{4}$/).optional() });
const Money = z.object({ amountMinor: z.number().int().min(0), currency: z.string().regex(/^[A-Z]{3}$/) });
const CompleteBody = Command.extend({ cashCollected: Money.optional(), previewId: ID.optional() });
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
  const supported = deps.paymentMethods ?? ["cash"];
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
      const body = parseBody(StepBody, request.body);
      // v0.18.8: the PIN is checked (and a wrong try counted) in its own transaction before the step. Checker round 1 (M4):
      // a driver app older than contract 0.18.8 (no or a lower X-Contract-Version) has no PIN step: the check is skipped and logged.
      const pinStep = command === "board" || command === "start_trip";
      const pinAware = contractAtLeast(request.headers["x-contract-version"]);
      let expected = body.expectedVersion;
      if (pinStep && pinAware && body.pin !== undefined) {
        const checked = await checkPin(deps.db, who.subjectId, id, body.pin, now());
        // A right PIN bumped the version (L5): the step goes on from the version the driver saw + that bump.
        if (checked?.bumped && checked.version === body.expectedVersion + 1) expected = checked.version;
      }
      if (pinStep && !pinAware) request.log.info({ tripId: id, driverId: who.subjectId }, "pin check skipped: driver app before contract 0.18.8");
      return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await driverStep(trx, who.subjectId, id, command, expected, now(), body.location, { skipPin: pinStep && !pinAware }), "driver") }))).body;
    });
  }

  // v0.18.8 (contract.json#arrivedWaiting.pin): the driver checks the rider's PIN; the rider reads it.
  app.post(`${API_PREFIX}/trips/:tripId/pin/verify`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    // The trip is looked up first (another driver gets 404, never a body error).
    return verifyPin(deps.db, who.subjectId, tripId(request), (request.body as { pin?: unknown } | null)?.pin, now());
  });
  app.get(`${API_PREFIX}/trips/:tripId/pin`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    return riderPin(deps.db, who.subjectId, tripId(request));
  });

  // v0.7.1 (§3.8): "Framme vid stoppet" and leaving the stop.
  for (const verb of ["arrive", "leave"] as const) {
    app.post(`${API_PREFIX}/driver/trips/:tripId/stops/:stopIndex/${verb}`, async (request) => {
      const who = await authenticate(request, guard, ["driver"]);
      const params = parseBody(z.object({ tripId: ID, stopIndex: z.coerce.number().int().min(0).max(9) }), request.params);
      const body = parseBody(z.object({ expectedVersion: z.number().int().min(1) }), request.body);
      return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await stopCommand(trx, who.subjectId, params.tripId, params.stopIndex, verb, body.expectedVersion, now()), "driver") }))).body;
    });
  }

  // contract v0.18.1 §26: the final price complete would set now (frozen 2 minutes), shown before Collect cash.
  app.get(`${API_PREFIX}/driver/trips/:tripId/complete-preview`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return completePreview(deps.db, who.subjectId, tripId(request), now());
  });

  app.post(`${API_PREFIX}/trips/:tripId/complete`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const id = tripId(request);
    const body = parseBody(CompleteBody, request.body);
    try {
      return (await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 200, body: tripProjection(await completeTrip(trx, { actor: "driver", subjectId: who.subjectId }, id, body, now()), "driver") }))).body;
    } catch (error) {
      if (!(error instanceof PriceChanged)) throw error;
      // contract v0.18.1 §26: the complete rolled back; a fresh frozen price for the sheet.
      const preview = await deps.db.transaction().execute((trx) => completePreview(trx, who.subjectId, id, now()));
      throw new ApiError("conflict", "The price changed. Collect the new amount.", { reason: "price_changed", preview });
    }
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
    const result = await runIdempotent(deps.db, idem(request, { actor, subjectId: who.subjectId }), async (trx) => {
      const rated = await rateTrip(trx, { actor, subjectId: who.subjectId }, id, request.body ?? {}, now());
      // v0.18.10 (contract.json#finish.tips): a tip sent with the rating, same rules as POST /trips/{tripId}/tip (default cash).
      const body = (request.body ?? {}) as { tip?: unknown; tipMethod?: unknown };
      // Checker (8): a tip that cannot be given never loses the stars: the rating stays, the answer carries tipError.
      // giveTip checks everything before it writes, so a refused tip changed nothing.
      if (actor === "rider" && body.tip !== undefined) {
        try {
          await giveTip(trx, who.subjectId, id, { amount: body.tip, method: body.tipMethod ?? "cash" }, supported, now());
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          const tipError = { code: error.code, ...(error.options.reason ? { reason: error.options.reason } : {}), message: error.message };
          return rated.status === 204 ? { status: 200, body: { tipError } } : { status: rated.status, body: { ...(rated.body as object), tipError } };
        }
      }
      return rated;
    });
    return result.status === 204 ? reply.status(204).send() : reply.status(result.status).send(result.body);
  });

  // v0.18.10 (contract.json#finish.tips): the rider's tip, 100 % to the driver.
  app.post(`${API_PREFIX}/trips/:tripId/tip`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const id = tripId(request);
    const result = await runIdempotent(deps.db, idem(request, who), async (trx) => ({ status: 201, body: await giveTip(trx, who.subjectId, id, request.body ?? {}, supported, now()) }));
    return reply.status(result.status).send(result.body);
  });

  // v0.18.10 (contract.json#finish.receipt): the receipt of an ended trip, for its rider and its driver.
  app.get(`${API_PREFIX}/trips/:tripId/receipt`, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    return riderReceipt(deps.db, who.subjectId, tripId(request));
  });
  app.get(`${API_PREFIX}/driver/trips/:tripId/receipt`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return driverReceipt(deps.db, who.subjectId, tripId(request));
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
