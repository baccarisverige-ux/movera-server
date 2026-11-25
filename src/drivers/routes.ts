import { needStripe, type StripeApi } from "../payments/stripe.js";
import { driverStripeOn, startDriverPayment } from "./payMoveraStripe.js";
import { geometry } from "../config/geometryCache.js";
import { appClientOf } from "../config/appUpdate.js";
import { driverPerformance } from "./performance.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, authenticateAdmin, adminCoversZone } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { readIdempotencyKey, runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { narrowToZones, parseQuery, ZoneFilterQuery } from "../admin/zoneFilter.js";
import { addVehicle, driverView, getDriverProfile, liveDrivers, type MapBox, listVehicles, loadDriver, postLocations, setAvailability, tripTrace, updateDriverProfile } from "./service.js";
import { setNextTrips } from "./presence.js";
import { fleetEarnings, getDriverFleet, leaveFleet, ownerRemoveDriver, recordJoinTry, setDriverCountry, startOwnCompany, submitOnboarding } from "./onboarding.js";
import { listReminders } from "./reminders.js";
import { listNotifications, NOTIFICATION_PAGE } from "../notifications/service.js";
import { documentTypes, driverReadSettings, onboardingSettings } from "./onboardingSettings.js";
import { acceptInvitation, cancelInvitation, declineInvitation, inviteByPhone, listInvitations, requestJoin, type InviteDeps } from "./invitations.js";
import { schemaProblem } from "../contract/schemas.js";
import { driverDocumentFile, listDocuments, uploadDocument, type Upload } from "../documents/service.js";
import type { DocumentKey } from "../documents/files.js";
import { ONBOARDING } from "./onboardingRules.js";
import { riderDriverPhoto } from "../trips/driverPhoto.js";
import { countryLimitsFor, countryOfPhone } from "../config/countryLimits.js";
import { publicProfileRoutes } from "./publicProfileRoutes.js";
import { phoneDataRoutes } from "../accounts/phoneDataRoutes.js";
import { snapDriverGaps } from "../trips/ride/gapRoads.js";
import type { Router } from "../maps/routing.js";
import { driverPayMovera } from "./payRequest.js";

/** contract §2, §3.3, §12: driver profile, availability, location, vehicles; admin live drivers and trip trace. */

import { requestAccountDeletion } from "../accounts/deletion.js";

export type DriverDeps = { db: Db; jwtSecret: string; documentKey: DocumentKey; invites: InviteDeps; clock?: () => Date; router?: Router; stripe?: StripeApi | null };

/** Document uploads a driver may start per hour by default (deep fix 2026-11-02: admin CountryRules.limits.uploadsPerHour). */
export const UPLOADS_PER_HOUR = 30;

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const FixSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0), heading: z.number().min(0).lt(360).optional(), speedMps: z.number().min(0).optional(), moving: z.boolean().optional(), measuredAt: z.string().datetime() });
// v0.18.65 §86 (contract.json#nextTripsSwitch): the trip sheet's radar, stop / start next trips.
const NextTripsBody = z.object({ on: z.boolean() });
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
  // BASE B13 (contract v0.18.26 §47): saved places, ride preferences and emergency contacts on the server. Registered
  // here so app.ts stays as it is.
  await phoneDataRoutes(app, { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) });
  // v0.18.155 (contract.json#driverProfile.routes): the rider's profile read, Min profil, admin moderation.
  await publicProfileRoutes(app, { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) });

  // v0.18.4 (G3-D2): his own acceptance %, cancellation % and rating.
  const profileOf = async (driverId: string) => ({ ...(await getDriverProfile(deps.db, driverId, now())), performance: await driverPerformance(deps.db, driverId, now()) });
  // v0.18.0 (owner item 14): every type of the lists with its texts, so the app renders types it does not know.
  const settingsOf = async (country: string) => {
    const settings = driverReadSettings(await onboardingSettings(deps.db, country), now());
    return { ...settings, country, documentTypes: documentTypes(settings) };
  };
  // G30: the line email_not_verified only for driver apps on contract 0.18.76 or later (X-Contract-Version).
  const remindersOf = (request: FastifyRequest, row: Awaited<ReturnType<typeof loadDriver>>) => listReminders(deps.db, row, now(), { contractVersion: request.headers["x-contract-version"] });

  app.get(`${API_PREFIX}/driver/profile`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return profileOf(who.subjectId);
  });

  /**
   * v0.18.145 (S4c load cut, contract.json#loadCut.homeBadges): the driver Home's four badge reads in one request, each
   * part exactly what its own read answers (GET /driver/profile, GET /notifications?unreadOnly=true first page,
   * GET /driver/reminders, GET /driver/onboarding/settings of his own country; null while the account has no country).
   * One after the other on one request, so a Home refresh holds at most one pool connection at a time. Never shed: it
   * carries the profile, which is never shed (http/shed.ts). The four reads stay for older apps.
   */
  app.get(`${API_PREFIX}/driver/home-badges`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const profile = await profileOf(who.subjectId);
    const notifications = await listNotifications(deps.db, { audience: "driver", subjectId: who.subjectId }, { limit: NOTIFICATION_PAGE, unreadOnly: true });
    const row = await loadDriver(deps.db, who.subjectId);
    const reminders = await remindersOf(request, row);
    return { profile, notifications, reminders, onboardingSettings: row.country ? await settingsOf(row.country) : null };
  });

  // v0.18.134 (contract.json#accountDeletion): Profile > Delete my account. WAITS FOR THE NEW SERVER.
  app.post(`${API_PREFIX}/driver/account/deletion`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const result = await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 202, body: await requestAccountDeletion(trx, "driver", who.subjectId, now()) }));
    return reply.status(result.status).send(result.body);
  });

  app.patch(`${API_PREFIX}/driver/profile`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await updateDriverProfile(trx, who.subjectId, request.body ?? {}, now()) }))).body;
  });

  // v0.18.0 (§27): the Home sheet's important reminders, the country's onboarding settings, Start my own company.
  app.get(`${API_PREFIX}/driver/reminders`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return remindersOf(request, await loadDriver(deps.db, who.subjectId));
  });
  // v0.18.139 (contract.json#driverPayRequest.read): what he owes Movera now, the reference and — while his country's
  // monthly pay request is on — the payment link. Read only; a payment is confirmed by the admin's "Driver paid Movera".
  app.get(`${API_PREFIX}/driver/pay-movera`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const view = await driverPayMovera(deps.db, who.subjectId, now());
    // DRAFT (contract.json#driverPayRequest.stripe): the Stripe Pay button instead of the link. The legacy link is
    // sent only while Stripe is not available; with neither, the request reads as off (nothing to pay with).
    const stripe = driverStripeOn(deps.stripe, view.enabled, view.owedToMovera.currency);
    const { payLink, minAmount, ...rest } = view as typeof view & { payLink?: string; minAmount?: unknown };
    const usable = view.enabled && (stripe || Boolean(payLink));
    return { ...rest, enabled: usable, ...(usable ? { ...(!stripe && payLink ? { payLink } : {}), minAmount } : {}), stripe };
  });
  app.post(`${API_PREFIX}/driver/pay-movera/pay`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const stripe = needStripe(deps.stripe);
    const toCancel: string[] = [];
    // Not through the Idempotency-Key store (the answer holds clientSecret); a repeat gets the same open intent.
    const view = await deps.db.transaction().execute((trx) => startDriverPayment(trx, stripe, who.subjectId, now(), toCancel));
    for (const id of toCancel) await stripe.cancelPaymentIntent(id).catch((error: unknown) => request.log.warn({ paymentIntentId: id, error: String(error) }, "stripe: cancel failed"));
    return view;
  });
  app.get(`${API_PREFIX}/driver/onboarding/settings`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const { country } = parseBody(z.object({ country: z.string().regex(/^[A-Z]{2}$/).optional() }), request.query);
    const row = await loadDriver(deps.db, who.subjectId);
    const pick = row.country ?? country;
    if (!pick) throw new ApiError("invalid_request", "Name the country.", { reason: "country_required" });
    return settingsOf(pick);
  });
  app.post(`${API_PREFIX}/driver/fleet/start-company`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await startOwnCompany(trx, who.subjectId, request.body ?? {}, now()) }))).body;
  });

  app.post(`${API_PREFIX}/driver/availability`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const body = parseBody(AvailabilityBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await setAvailability(trx, who.subjectId, body, now(), appClientOf(request)) }))).body;
  });

  app.post(`${API_PREFIX}/driver/next-trips`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    const body = parseBody(NextTripsBody, request.body);
    return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => {
      await setNextTrips(trx, who.subjectId, body.on, now());
      return { status: 200, body: await driverView(trx, await loadDriver(trx, who.subjectId), "driver", now()) };
    })).body;
  });

  app.post(`${API_PREFIX}/driver/location`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    // Stress T-A part 3: the zone / area geometry is loaded (when the cache is on and cold) before the transaction opens.
    await geometry(deps.db);
    // S7 W2 Q114 (= Q-B11, plan 0.20; owner "Yes, stop storing (Rec.)", decisions/session-2026-11-06.md "Sitting W2"):
    // the Idempotency-Key is checked like every mutation's header (contract §1 Headers) and then ignored. No
    // idempotency_keys row per GPS send (two writes in the transaction, and a row per driver every 10 s for a day). A
    // resent batch is safe without it: a fix that is not new writes no event (Q113), the trace insert is ON CONFLICT DO
    // NOTHING, and the timers, airport queue and position are upserts. Still ONE transaction, so the Q112 lock limit
    // (set by its first statement, locationFacts) and the 503 server_busy rollback are as before.
    readIdempotencyKey(keyOf(request));
    const body = await deps.db.transaction().execute((trx) => postLocations(trx, who.subjectId, request.body ?? {}, now()));
    // Owner decision 2026-11-10: road snapping of GPS gaps, after the transaction (no row locked).
    if (deps.router) await snapDriverGaps(deps.db, deps.router, who.subjectId);
    return body;
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
    return countingJoinTries(who.subjectId, async () => (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await submitOnboarding(trx, deps.invites, who.subjectId, request.body ?? {}, now()) }))).body);
  });
  // v0.18.162 (contract.json#driverCountryFirst.step): the first-sign-in country step.
  app.put(`${API_PREFIX}/driver/country`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await setDriverCountry(trx, who.subjectId, request.body ?? {}, now()) }))).body;
  });
  app.get(`${API_PREFIX}/driver/fleet`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return getDriverFleet(deps.db, who.subjectId, now());
  });
  // v0.5.3: joining is an invitation the other side accepts (contract.json#driverOnboarding.fleetInvitations).
  app.post(`${API_PREFIX}/driver/fleet/join`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const body = request.body ?? {};
    const problem = schemaProblem("FleetJoinRequest", body);
    if (problem !== null) throw new ApiError("invalid_request", `The join request is not valid: ${problem}.`, { reason: "invalid_body" });
    const result = await countingJoinTries(who.subjectId, () => runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 201, body: await requestJoin(trx, deps.invites, who.subjectId, body as { code: string; ownerName: string; ownerEmail: string }, now()) })));
    return reply.status(result.status).send(result.body);
  });
  app.post(`${API_PREFIX}/driver/fleet/invite`, async (request, reply) => {
    const who = await authenticate(request, guard, ["driver"]);
    const body = request.body ?? {};
    const problem = schemaProblem("FleetInviteRequest", body);
    if (problem !== null) throw new ApiError("invalid_request", `The invitation is not valid: ${problem}.`, { reason: "invalid_body" });
    const result = await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 201, body: await inviteByPhone(trx, deps.invites, who.subjectId, body as { phone: string }, now()) }));
    return reply.status(result.status).send(result.body);
  });
  app.get(`${API_PREFIX}/driver/fleet/invitations`, async (request) => {
    const who = await authenticate(request, guard, ["driver"]);
    return listInvitations(deps.db, who.subjectId, now());
  });
  for (const [segment, decide] of [["accept", acceptInvitation], ["decline", declineInvitation], ["cancel", cancelInvitation]] as const) {
    app.post(`${API_PREFIX}/driver/fleet/invitations/:invitationId/${segment}`, async (request) => {
      const who = await authenticate(request, guard, ["driver"]);
      const { invitationId } = parseBody(z.object({ invitationId: ID }), request.params);
      return (await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 200, body: await decide(trx, deps.invites, who.subjectId, invitationId, now()) }))).body;
    });
  }
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
    // Audit Phase 4 (P4-2): at most UPLOADS_PER_HOUR uploads per driver, counted before the file is read.
    const since = new Date(now().getTime() - 3600_000);
    const recent = await deps.db.selectFrom("document_upload_attempts").select("at").where("driver_id", "=", who.subjectId).where("at", ">", since).orderBy("at").execute();
    const driver = await deps.db.selectFrom("drivers").select(["country", "phone"]).where("driver_id", "=", who.subjectId).executeTakeFirst();
    const perHour = (await countryLimitsFor(deps.db, driver?.country ?? (driver ? countryOfPhone(driver.phone) : null))).uploadsPerHour;
    if (recent.length >= perHour) {
      const retry = Math.max(1, Math.ceil((recent[recent.length - perHour]!.at.getTime() + 3600_000 - now().getTime()) / 1000));
      throw new ApiError("rate_limited", "Too many uploads; try again later.", { reason: "upload_limit", retryAfterSeconds: retry });
    }
    await deps.db.insertInto("document_upload_attempts").values({ driver_id: who.subjectId, at: now() }).execute();
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

  // v0.18.5 (G2-D3, contract.json#driverOnboarding.riderDriverPhoto): the trip's rider sees the driver's approved photo.
  app.get(`${API_PREFIX}/rider/trips/:tripId/driver-photo`, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const { tripId } = parseBody(z.object({ tripId: ID }), request.params);
    return sendFile(reply, await riderDriverPhoto(deps.db, deps.documentKey, who.subjectId, tripId, now()));
  });

  app.get(`${API_PREFIX}/admin/live/drivers`, async (request) => {
    const who = await authenticateAdmin(request, guard, "trips.read");
    const { minLat, minLng, maxLat, maxLng, limit, cursor, ...filter } = request.query as Record<string, unknown>;
    const narrowed = await narrowToZones(deps.db, who, parseQuery(ZoneFilterQuery, filter));
    // v0.18.34 §65 (A8/A10, rule 33): optional keyset paging by driverId; without `limit` every row (older panels).
    const page = parseQuery(LivePageQuery, { ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) });
    // Job 1 (stress M4): optional map box; all four or none, lat -90..90, lng -180..180, min <= max.
    const given = [minLat, minLng, maxLat, maxLng].filter((v) => v !== undefined);
    let box: MapBox | undefined;
    if (given.length > 0) {
      const b = parseQuery(MapBoxQuery, { minLat, minLng, maxLat, maxLng });
      if (b.minLat > b.maxLat || b.minLng > b.maxLng) throw badRequest("minLat/minLng must not be above maxLat/maxLng.", "invalid_map_box");
      box = b;
    }
    return liveDrivers(deps.db, undefined, narrowed.zones, now(), box, page.limit !== undefined ? { limit: page.limit, ...(page.cursor ? { cursor: page.cursor } : {}) } : undefined);
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
/** v0.18.34 §65: the live drivers page (contract.json#liveDriversPaging). */
const LivePageQuery = { limit: z.coerce.number().int().min(1).max(1000).optional(), cursor: z.string().min(1).max(128).optional() };
const MapBoxQuery = { minLat: z.coerce.number().min(-90).max(90), minLng: z.coerce.number().min(-180).max(180), maxLat: z.coerce.number().min(-90).max(90), maxLng: z.coerce.number().min(-180).max(180) };

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
