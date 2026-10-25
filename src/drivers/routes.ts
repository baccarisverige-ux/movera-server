import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin, adminCoversZone } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { addVehicle, getDriverProfile, liveDrivers, listVehicles, postLocations, setAvailability, tripTrace, updateDriverProfile } from "./service.js";
import { fleetEarnings, getDriverFleet, joinFleet, leaveFleet, ownerRemoveDriver, recordJoinTry, submitOnboarding } from "./onboarding.js";
import { driverDocumentFile, listDocuments, uploadDocument, type Upload } from "../documents/service.js";
import type { DocumentKey } from "../documents/files.js";
import { ONBOARDING } from "./onboardingRules.js";

/** contract §2, §3.3, §12: driver profile, availability, location, vehicles; admin live drivers and trip trace. */

export type DriverDeps = { db: Db; jwtSecret: string; documentKey: DocumentKey; clock?: () => Date };

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const FixSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0), heading: z.number().min(0).lt(360).optional(), speedMps: z.number().min(0).optional(), moving: z.boolean().optional(), measuredAt: z.string().datetime() });
const AvailabilityBody = z.object({ expectedVersion: z.number().int().min(1), onlineStatus: z.enum(["online", "offline"]), location: FixSchema.optional() });
const When = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() });
const DocumentsQuery = z.object({ status: z.union([z.string(), z.array(z.string())]).optional() });

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

export async function driverRoutes(app: FastifyInstance, deps: DriverDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const idem = (request: FastifyRequest, subjectId: string) => ({ actor: "driver" as const, subjectId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });

  app.get(`${API_PREFIX}/driver/profile`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return getDriverProfile(deps.db, who.subjectId);
  });

  app.patch(`${API_PREFIX}/driver/profile`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await updateDriverProfile(trx, who.subjectId, request.body ?? {}, now()) }))).body;
  });

  app.post(`${API_PREFIX}/driver/availability`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const body = parseBody(AvailabilityBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await setAvailability(trx, who.subjectId, body, now()) }))).body;
  });

  app.post(`${API_PREFIX}/driver/location`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await postLocations(trx, who.subjectId, request.body ?? {}, now()) }))).body;
  });

  app.get(`${API_PREFIX}/driver/vehicles`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return listVehicles(deps.db, who.subjectId);
  });

  app.post(`${API_PREFIX}/driver/vehicles`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const result = await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 201, body: await addVehicle(trx, who.subjectId, request.body ?? {}, now()) }));
    return reply.status(result.status).send(result.body);
  });

  /* ---- v0.5.3 (§14): the details screen, fleets, documents */
  // A failed fleet join rolls the command back, so the try is counted afterwards, outside it.
  const countingJoinTries = async <T>(driverId: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ApiError && error.options.reason === "fleet_join_mismatch") await recordJoinTry(deps.db, driverId, now());
      throw error;
    }
  };
  app.post(`${API_PREFIX}/driver/onboarding`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return countingJoinTries(who.subjectId, async () => (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await submitOnboarding(trx, who.subjectId, request.body ?? {}, now()) }))).body);
  });
  app.get(`${API_PREFIX}/driver/fleet`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return getDriverFleet(deps.db, who.subjectId);
  });
  app.post(`${API_PREFIX}/driver/fleet/join`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return countingJoinTries(who.subjectId, async () => (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await joinFleet(trx, who.subjectId, request.body ?? {}, now()) }))).body);
  });
  app.post(`${API_PREFIX}/driver/fleet/leave`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await leaveFleet(trx, who.subjectId, now()) }))).body;
  });
  app.post(`${API_PREFIX}/driver/fleet/drivers/:driverId/remove`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { driverId } = parseBody(z.object({ driverId: ID }), request.params);
    await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => {
      await ownerRemoveDriver(trx, who.subjectId, driverId, now());
      return { status: 204, body: null };
    });
    return reply.status(204).send();
  });
  app.get(`${API_PREFIX}/driver/fleet/earnings`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const when = parseBody(When, request.query);
    return fleetEarnings(deps.db, who.subjectId, when, now());
  });
  app.get(`${API_PREFIX}/driver/documents`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { status } = parseBody(DocumentsQuery, request.query);
    return listDocuments(deps.db, who.subjectId, status === undefined ? undefined : Array.isArray(status) ? status : [status]);
  });
  // The upload may be 10 MB; the app's bodyLimit (1 MB) is for JSON.
  app.post(`${API_PREFIX}/driver/documents`, { bodyLimit: ONBOARDING.documents.upload.maxBytes + 64 * 1024 }, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const upload = await readUpload(request);
    const summary = { type: upload.type, ownerId: upload.ownerId ?? null, fileName: upload.fileName, size: upload.bytes.length };
    const result = await runIdempotent(deps.db, { ...idem(request, who.subjectId), body: summary }, async (trx) => ({ status: 201, body: await uploadDocument(trx, deps.documentKey, who.subjectId, upload, now()) }));
    return reply.status(result.status).send(result.body);
  });
  app.get(`${API_PREFIX}/driver/documents/:documentId/file`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { documentId } = parseBody(z.object({ documentId: ID }), request.params);
    const file = await driverDocumentFile(deps.db, deps.documentKey, who.subjectId, documentId);
    return sendFile(reply, file);
  });

  app.get(`${API_PREFIX}/admin/live/drivers`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const { zoneId } = parseBody(z.object({ zoneId: ID.optional() }), request.query);
    if (zoneId && !adminCoversZone(who, zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
    return liveDrivers(deps.db, zoneId, who.zones, now());
  });

  app.get(`${API_PREFIX}/admin/trips/:tripId/trace`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    const trip = await deps.db.selectFrom("trips").select("zone_id").where("trip_id", "=", tripId).executeTakeFirst();
    if (trip && !adminCoversZone(who, trip.zone_id)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
    return tripTrace(deps.db, tripId);
  });
}

/** The multipart upload of POST /driver/documents: the fields and the one file, read into memory (at most 10 MB). */
export async function readUpload(request: FastifyRequest): Promise<Upload> {
  if (!request.isMultipart()) throw new ApiError("invalid_request", "Send multipart/form-data with a file.", { reason: "unsupported_media_type" });
  const fields: Record<string, string> = {};
  let file: { fileName: string; mediaType: string; bytes: Buffer; truncated: boolean } | undefined;
  // A file over the limit is cut, not thrown: the upload then answers 400 file_too_large with the reason named.
  for await (const part of request.parts({ limits: { fileSize: ONBOARDING.documents.upload.maxBytes, files: 1, fields: 8 } })) {
    if (part.type === "file") {
      const bytes = await part.toBuffer();
      file = { fileName: part.filename, mediaType: part.mimetype, bytes, truncated: part.file.truncated };
    } else if (typeof part.value === "string") fields[part.fieldname] = part.value;
  }
  if (!fields.type) throw new ApiError("invalid_request", "type is required.", { reason: "invalid_body" });
  if (!file) throw new ApiError("invalid_request", "file is required.", { reason: "invalid_body" });
  return { type: fields.type, ownerId: fields.ownerId, expiresAt: fields.expiresAt, ...file };
}

export function sendFile(reply: import("fastify").FastifyReply, file: { mediaType: string; fileName: string; bytes: Buffer }) {
  return reply
    .header("Content-Type", file.mediaType)
    .header("Content-Disposition", `inline; filename="${file.fileName.replace(/[^\w.-]/g, "_")}"`)
    .header("Cache-Control", "private, no-store")
    .send(file.bytes);
}
