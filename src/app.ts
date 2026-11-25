import { GoogleRoutesRouter, setLiveTrafficConfigured } from "./maps/googleRoutes.js";
import { configureSessionCache } from "./auth/sessionCache.js";
import { pricingRoutes } from "./pricing/routes.js";
import { jobsHeartbeat } from "./jobs/heartbeat.js";
import { contentRoutes } from "./content/routes.js";
import { legalRoutes } from "./legal/routes.js";
import { zoneRoutes } from "./zones/routes.js";
import { airportQueueRoutes } from "./airportQueue/routes.js";
import { blockedPairRoutes } from "./blockedPairs/routes.js";
import { bonusRoutes } from "./bonuses/routes.js";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyInstance, type FastifyError } from "fastify";
import { sql } from "kysely";
import { isDatabaseBusy, type Db } from "./db/db.js";
import { API_VERSION, CONTRACT_VERSION } from "./contract/contract.js";
import { writeLimitsFrom, type Env } from "./env.js";
import { registerWriteLimit, shareOf, SIGN_IN_PATHS } from "./http/rateLimit.js";
import { poolStats } from "./db/db.js";
import { ApiError, badRequest, notFound } from "./http/errors.js";

import { API_PREFIX } from "./http/prefix.js";
import { authRoutes } from "./auth/routes.js";
import { adminAuthRoutes } from "./admin/routes.js";
import { configRoutes } from "./config/routes.js";
import { EstimateRouter, type Router } from "./maps/routing.js";
import { quoteRoutes } from "./quotes/routes.js";
import { mapsRoutes } from "./maps/routes.js";
import { tripRoutes } from "./trips/routes.js";
import { chatRoutes } from "./chat/routes.js";
import type { Translator } from "./chat/translate.js";
import { callRoutes } from "./calls/routes.js";
import { rideRoutes } from "./trips/rideRoutes.js";
import { supportedPaymentMethods } from "./trips/finish.js";
import { adminTripRoutes } from "./admin/tripRoutes.js";
import { setServerStripeStatus, stripeFromEnv, stripeKeyStatus, type StripeApi } from "./payments/stripe.js";
import { stripeWebhookRoutes } from "./payments/stripeWebhook.js";
import { riderFeeUse } from "./riders/feeStripe.js";
import { driverInvoiceUse } from "./drivers/payMoveraStripe.js";
import { realDataRoutes } from "./admin/realdataRoutes.js";
import { financeRoutes } from "./finance/routes.js";
import { adminEventRoutes } from "./realtime/adminEvents.js";
import { driverRoutes } from "./drivers/routes.js";
import { adminPeopleRoutes } from "./admin/peopleRoutes.js";
import { revealRoutes } from "./admin/revealRoutes.js";
import { adminSessionRoutes } from "./admin/sessionRoutes.js";
import { documentKeyFrom } from "./documents/files.js";
import { providersFrom, type Provider, type ProviderVerifier } from "./auth/provider.js";
import { recordServerError } from "./telemetry/errors.js";
import { scrubLogError } from "./telemetry/scrub.js";
import { loadSnapshot, registerServerTiming } from "./telemetry/load.js";
import { TELEMETRY, telemetryRoutes } from "./telemetry/routes.js";
import { notificationRoutes } from "./notifications/routes.js";
import type { SmsProvider } from "./sms/sms.js";
import { emailSenderFrom, type EmailSender } from "./email/resend.js";
import { signInSmsFrom, sosContactsProviderFrom, type CodeSmsSender } from "./sms/elks.js";
import { SMS_SIGN_IN } from "./auth/smsSignIn.js";
import multipart from "@fastify/multipart";
import { dispatchRoutes } from "./dispatch/routes.js";
import { reservationRoutes } from "./reservations/routes.js";
import { dispatchToolRoutes } from "./dispatch/toolRoutes.js";
import { shareRoutes, SHARE_LIMITS } from "./safety/shareRoutes.js";
import { isSharePath, registerLoadShedding, setShareHeaders, type ShedOptions } from "./http/shed.js";
import { safetyRoutes } from "./safety/routes.js";
import type { NotificationHub } from "./realtime/hub.js";
import { closeAllStreams } from "./realtime/sse.js";
import { watchStreamSessions } from "./realtime/sessionWatch.js";
import { pushServicesFrom, type PushServices } from "./push/config.js";
import { pushRoutes } from "./push/routes.js";
import { configureReadRetry } from "./realtime/retry.js";
import { CachedPlaces, GooglePlaces, NoPlaces, type Places } from "./maps/places.js";

export { API_PREFIX };

const REQUEST_ID = /^[\x21-\x7e]{1,128}$/;
/** B1.27: what a log line and a stored server error say for a request that matched no route (its path is never written). */
const NO_ROUTE = "(no route)";

export type BuildOptions = { env: Env; logger?: boolean | { stream: NodeJS.WritableStream }; db?: Db; clock?: () => Date; router?: Router; traffic?: Router | null; places?: Places; hub?: NotificationHub; sms?: SmsProvider; providers?: Partial<Record<Provider, ProviderVerifier>>; push?: PushServices; translator?: Translator; email?: EmailSender; signInSms?: CodeSmsSender; healthDb?: Db; shed?: ShedOptions; stripe?: StripeApi | null };

const READY_TIMEOUT_MS = 2000;
const HEALTH_DB_TIMEOUT_MS = 1000;

/**
 * L20-6 (load test 20k): what the health checks say about the database. "ok": SELECT 1 answered in time. "busy": the
 * database is there but slow or full (our wait ran out, Postgres cancelled the statement 57014, or it has no free
 * connection 53300/53400). "unavailable": anything else (refused, reset, unknown host, failed to connect). Never throws.
 */
export type DatabaseState = "ok" | "busy" | "unavailable";
const BUSY_CODES = new Set(["57014", "53300", "53400"]);
export async function databaseState(db: Db, ms: number): Promise<DatabaseState> {
  let timer: NodeJS.Timeout | undefined;
  const TIMEOUT = Symbol("timeout");
  try {
    await Promise.race([
      sql`SELECT 1`.execute(db),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(TIMEOUT), ms);
      }),
    ]);
    return "ok";
  } catch (error) {
    if (error === TIMEOUT) return "busy";
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && BUSY_CODES.has(code) ? "busy" : "unavailable";
  } finally {
    clearTimeout(timer);
  }
}
/** Step 63 (T6b): one read-only aggregate, asked only by GET /internal/load. */
async function timerBacklog(db: Db): Promise<Record<string, { parked: number; overdue: number; overdueOldestMs: number }>> {
  const { rows } = await sql<{ kind: string; parked: string; overdue: string; oldest_ms: string | null }>`
    SELECT kind, count(*) FILTER (WHERE due_at = 'infinity') AS parked,
           count(*) FILTER (WHERE due_at <= now()) AS overdue,
           (extract(epoch FROM now() - min(due_at) FILTER (WHERE due_at <= now())) * 1000)::bigint AS oldest_ms
    FROM timers WHERE due_at <= now() OR due_at = 'infinity' GROUP BY kind`.execute(db);
  return Object.fromEntries(rows.map((r) => [r.kind, { parked: Number(r.parked), overdue: Number(r.overdue), overdueOldestMs: Number(r.oldest_ms ?? 0) }]));
}
const CORS_HEADERS = "Authorization, Content-Type, Idempotency-Key, X-Api-Version, X-Contract-Version, X-Request-Id, X-App-Version, X-App-Platform, Last-Event-ID, Accept, Accept-Language";

export async function buildApp({ env, logger = true, db, clock, router, traffic, places, hub, sms, providers, push, translator, email, signInSms, healthDb, shed, stripe }: BuildOptions): Promise<FastifyInstance> {
  // G34 P2: the health checks ask the database on their own small pool (main.ts, db.ts createHealthPool) when given, so a
  // full app pool is never reported as "database not reachable"; without one (tests, tools) they use the app's.
  const probeDb = healthDb ?? db;
  const app = Fastify({
    logger: logger
      ? {
          level: env.LOG_LEVEL,
          ...(typeof logger === "object" ? { stream: logger.stream } : {}),
          // Audit Phase 4 (P4-7): the request line is logged without its query string, which can hold a phone
          // number or an e-mail (admin searches `?q=`) or a place.
          // B1.27 (owner, Sitting W1): and without the path values either: the route pattern only
          // (`/routes/driving/:coordinates`, `/trips/:tripId`); a path that matches no route is never written.
          // Every `{ err }` keeps only its type, scrubbed message and stack, and code (scrubLogError).
          serializers: {
            req: (request: { method: string; id: string; routeOptions?: { url?: string } }) => ({ method: request.method, url: request.routeOptions?.url ?? NO_ROUTE, reqId: request.id }),
            err: scrubLogError,
          },
        }
      : false,
    // X-Request-Id: the client's id when it sends a sane one, else ours. Echoed on every response (§1 Headers).
    genReqId: (request) => {
      const sent = request.headers["x-request-id"];
      return typeof sent === "string" && REQUEST_ID.test(sent) ? sent : randomUUID();
    },
    requestIdHeader: false,
    bodyLimit: 1024 * 1024,
    // v0.18.116 §94 (supervisor SF-4): Fastify answers a path value over its length limit (and a badly encoded path)
    // itself, before any hook, echoing the path. On the two share paths that answer is the same 404 as every other
    // miss, never cached or indexed, and without the path; every other path keeps Fastify's own answer.
    frameworkErrors: (error, request, typedReply) => {
      const reply = typedReply as unknown as FastifyReply;
      if (isSharePath(request.raw.url ?? "")) {
        setShareHeaders(reply);
        return reply.status(404).send(notFound("Link not found.", "share_not_found").body(request.id));
      }
      return reply.status(error.statusCode ?? 400).send({ error: "Bad Request", code: error.code, message: error.message, statusCode: error.statusCode ?? 400 });
    },
    // Trust exactly TRUST_PROXY_HOPS proxies: the address is the one the nearest trusted proxy saw.
    trustProxy: env.TRUST_PROXY_HOPS > 0 ? (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS : false,
  });

  // Step 63 (T6): Server-Timing on every answer; first, so `total` covers every other hook.
  registerServerTiming(app);
  // B1.9 (Q73): stream reads give up after STREAM_READ_RETRIES retries; closes spread over STREAM_CLOSE_SPREAD_MS.
  configureReadRetry({ maxRetries: env.STREAM_READ_RETRIES, closeSpreadMs: env.STREAM_CLOSE_SPREAD_MS });

  // An empty body with Content-Type: application/json (the apps' sign-out) is "no body", not bad JSON.
  const json = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    json(request, text, done);
  });

  // Document uploads (contract v0.5.3 §14): multipart, one file of at most 10 MB, read by the upload route itself.
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 + 1, files: 1, fields: 8, parts: 10 }, throwFileSizeLimit: false });

  // Browsers on the allowed web origins (CORS_ORIGINS) may call the API; the token travels in a header, never a cookie.
  const corsOrigins = new Set(env.CORS_ORIGINS);
  if (corsOrigins.size > 0) {
    app.addHook("onRequest", async (request, reply) => {
      const origin = request.headers.origin;
      if (typeof origin !== "string" || !corsOrigins.has(origin)) return;
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Expose-Headers", "X-Request-Id, X-Api-Version, Retry-After, Date"); // v0.18.50 §72 (L9): Date for the web apps' server clock
      if (request.method === "OPTIONS" && request.headers["access-control-request-method"] !== undefined) {
        reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
        reply.header("Access-Control-Allow-Headers", CORS_HEADERS);
        reply.header("Access-Control-Max-Age", "600");
        return reply.status(204).send();
      }
    });
  }

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
    reply.header("X-Api-Version", API_VERSION);
    // X-Api-Version is optional; when sent it must be this server's (contract headers). An app built for
    // another contract version is told so plainly instead of being served a shape it does not expect.
    const sent = request.headers["x-api-version"];
    if (request.url.startsWith(API_PREFIX) && sent !== undefined && sent !== API_VERSION) {
      throw badRequest(`This server speaks API ${API_VERSION}; the request said ${String(sent)}.`, "unsupported_api_version");
    }
  });

  // S06 F13: API answers are never cached by a browser or proxy (unless the route chose a cache header itself) and
  // are never content-sniffed. SSE streams are hijacked, so they set their own headers (realtime/sse.ts).
  app.addHook("onSend", async (request, reply, payload) => {
    if (!request.url.startsWith(API_PREFIX)) return payload;
    if (!reply.hasHeader("cache-control")) reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return payload;
  });

  // B11: the general write limit (contract.json#rateLimit), before any route reads the body or the database.
  const unreadBody = registerWriteLimit(app, writeLimitsFrom(env), { jwtSecret: db !== undefined ? (env.JWT_SECRET ?? DEV_JWT_SECRET) : env.JWT_SECRET, db, defaultZoneId: env.DEFAULT_ZONE_ID, exemptPaths: env.MOVERA_ENV === "production" ? [] : SIGN_IN_PATHS, ...(clock ? { clock } : {}) });

  app.setErrorHandler(async (thrown: FastifyError | ApiError, request, reply) => {
    // Q117 follow-up SF-2: a sign-in / refresh body that never parsed is counted on the address (429 when full).
    const error = unreadBody?.(request) ?? thrown;
    if (error instanceof ApiError) {
      if (error.options.retryAfterSeconds !== undefined) reply.header("Retry-After", String(error.options.retryAfterSeconds));
      return reply.status(error.status).send(error.body(request.id));
    }
    if (error.validation) {
      return reply.status(400).send(badRequest(error.message, "invalid_body").body(request.id));
    }
    if (error.statusCode === 415 || error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.status(400).send(badRequest("Send application/json.", "unsupported_media_type").body(request.id));
    }
    if (error.code === "FST_ERR_CTP_INVALID_JSON_BODY" || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY" || error.statusCode === 400) {
      return reply.status(400).send(badRequest("The body is not valid JSON.", "invalid_json").body(request.id));
    }
    if (error.statusCode === 413) {
      return reply.status(400).send(badRequest("The body is too large.", "body_too_large").body(request.id));
    }
    // Job 1 (fix plan R22): an overloaded database is not a bug: 503 server_busy, retry in a moment (contract.json#errors).
    if (isDatabaseBusy(error)) {
      request.log.warn({ err: error }, "database busy");
      reply.header("Retry-After", "2");
      return reply.status(503).send(new ApiError("unavailable", "The server is busy. Try again in a moment.", { reason: "server_busy", retryAfterSeconds: 2 }).body(request.id));
    }
    request.log.error({ err: error }, "unhandled error");
    // contract v0.16.0: the server's own unhandled 5xx errors show in the admin's Crashes & errors (app server, scrubbed).
    if (db !== undefined) {
      const at = clock?.() ?? new Date();
      const route = request.routeOptions.url ?? NO_ROUTE;
      await recordServerError(db, error, { method: request.method, route, ip: request.ip, at }).catch((failure: unknown) => request.log.warn({ err: failure }, "server error not recorded"));
    }
    return reply.status(500).send(new ApiError("internal", "Something went wrong on the server.").body(request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    // A contract operation this server does not serve yet answers 404 with a reason, so an app can tell
    // "not enabled on this server" from "this trip does not exist".
    const error = request.url.startsWith(API_PREFIX)
      ? notFound("This operation is not enabled on this server.", "operation_not_enabled")
      : notFound();
    // v0.18.116 §94 (supervisor SF-4): a share path that matches no route (an over-long token) is not cached or indexed either.
    if (isSharePath(request.url)) setShareHeaders(reply);
    return reply.status(404).send(error.body(request.id));
  });

  app.addHook("preClose", async () => closeAllStreams(app));

  // Liveness: always 200 while the process runs. `database` says whether the database answers (rule 28: a database
  // that is restarting shows here as "unavailable" instead of stopping the server; /readyz answers 503 meanwhile).
  app.get("/healthz", async () => ({
    status: "ok",
    contract: CONTRACT_VERSION,
    apiVersion: API_VERSION,
    env: env.MOVERA_ENV,
    ...(db !== undefined ? { dbPool: poolStats() } : {}),
    // L20-6: "busy" (slow / full) is told apart from "unavailable" (down).
    database: probeDb === undefined ? "not_configured" : await databaseState(probeDb, HEALTH_DB_TIMEOUT_MS),
    // S04 A4: the LISTEN connection every stream depends on (not in the contract: /healthz is an ops endpoint).
    ...(hub !== undefined ? { realtime: hub.healthSnapshot() } : {}),
  }));
  // Ready to take traffic: the database answers within 2 s. A load balancer stops sending requests while not.
  // PM-1: the LISTEN link's state is shown (`realtime`). Round 4 (owner 2026-11-15 "Wait up to 30 s (Rec.)"): a NEW
  // copy answers 503 until its first LISTEN connect, at most LISTEN_READY_WAIT_MS (30 s) after its start, so a deploy
  // does not swap a copy with working realtime for one without; after that it is ready anyway. Once ready, a LISTEN
  // drop never makes it "not ready" again: the copy still serves every request and stream read, and a 503 would make
  // the host take working copies out of service (the same reason /healthz/jobs is not the hosting health check).
  app.get("/readyz", async () => {
    if (probeDb === undefined) return { status: "ready", database: "not_configured" };
    // L20-6: only a database that is DOWN makes a copy "not ready". A busy database (slow answer, no free connection)
    // is shared by every copy, so a 503 would make the host pull all of them at once and turn slowness into an outage;
    // the copy stays in service and says database "busy".
    const database = await databaseState(probeDb, READY_TIMEOUT_MS);
    if (database === "unavailable") {
      throw new ApiError("unavailable", "The database is not reachable.", { reason: "database_unavailable", retryAfterSeconds: 5 });
    }
    if (hub !== undefined && !hub.readyForTraffic()) {
      throw new ApiError("unavailable", "The live link to the database is still connecting.", { reason: "realtime_starting", retryAfterSeconds: 5 });
    }
    return { status: "ready", database, ...(hub !== undefined ? { realtime: hub.healthSnapshot().status } : {}) };
  });
  // S4 B1.28 (owner W1 Q88): 503 when a recurring server job is parked, missing or more than 3× its period late
  // (jobs/heartbeat.ts). No token, kind + state only. For the outside monitor (U9); never the hosting health check.
  app.get("/healthz/jobs", async (_request, reply) => {
    if (probeDb === undefined) return { status: "not_configured" };
    if ((await databaseState(probeDb, READY_TIMEOUT_MS)) !== "ok") {
      throw new ApiError("unavailable", "The database is not reachable.", { reason: "database_unavailable", retryAfterSeconds: 5 });
    }
    const heartbeat = await jobsHeartbeat(probeDb, clock?.() ?? new Date());
    return reply.code(heartbeat.status === "ok" ? 200 : 503).send(heartbeat);
  });

  // Step 63 (T6b): this copy's load numbers for the stress test; only with LOAD_COUNTERS (never in production).
  if (env.LOAD_COUNTERS) {
    app.get("/internal/load", async () => ({
      ...loadSnapshot(),
      // The whole fleet's timers (shared table), by kind: parked (due 'infinity') and overdue (due, not yet taken).
      ...(db !== undefined ? { timersInDatabase: await timerBacklog(db) } : {}),
      ...(db !== undefined ? { dbPool: poolStats() } : {}),
      ...(hub !== undefined ? { listenSubscribers: hub.subscriberCount() } : {}),
    }));
  }

  // Push (contract v0.18.3 R7): GET /push/config needs no token and no database.
  const pushServices = push ?? pushServicesFrom(env, { ...(clock ? { clock } : {}), warn: (message) => app.log.warn(message) });
  if (pushServices.status === "invalid") app.log.warn({ problem: pushServices.problem }, "FIREBASE_SERVICE_ACCOUNT is not usable: push is off");
  await pushRoutes(app, { config: pushServices.config });

  if (db !== undefined) {
    const jwtSecret = env.JWT_SECRET ?? DEV_JWT_SECRET;
    // B1.15 (Q76): every open stream of this copy is re-checked against its session row, one batched query per interval.
    watchStreamSessions(app, db, { everyMs: env.STREAM_SESSION_CHECK_MS, warn: (data, message) => app.log.warn(data, message), ...(clock ? { clock } : {}) });
    const signInProviders = providers ?? providersFrom(env);
    // G30b (owner Q1): e-mail change codes go out through Resend when RESEND_API_KEY is set (tests inject a fake).
    const emailSender = email ?? emailSenderFrom(env);
    // v0.18.133 (contract.json#smsSignIn): the sign-in code SMS goes out through 46elks only when BOTH keys are set
    // (tests inject a fake); without a sender every real number stays sign_in_restricted. The country switch is the
    // second condition (auth/smsSignIn.ts). `sms` (fleet invitations) is unchanged; the SOS contacts SMS use it only with the switch below (v0.18.151).
    const codeSms = signInSms ?? signInSmsFrom(env, SMS_SIGN_IN.sender);
    // v0.18.151 (contract.json#sosContactsSms.send): the SOS contacts SMS use the sign-in sender only with the server
    // switch on (default off); a test's injected `sms` stays as it is.
    const sosSms = sms ?? sosContactsProviderFrom(env.SOS_CONTACTS_SMS_SEND, codeSms);
    await authRoutes(app, { db, jwtSecret, testSignInEnabled: env.MOVERA_ENV !== "production", fastTestSignIn: env.MOVERA_ENV === "staging", providers: signInProviders, ...(emailSender ? { email: emailSender } : {}), ...(codeSms ? { signInSms: codeSms } : {}), warn: (data, message) => app.log.warn(data, message), logCodes: env.MOVERA_ENV === "development", ...(clock ? { clock } : {}) });
    await notificationRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    await telemetryRoutes(app, { db, jwtSecret, perAddressPerMinute: shareOf(env.TELEMETRY_PER_ADDRESS_PER_MINUTE ?? TELEMETRY.perAddressPerMinute, env.WEB_COPIES), anonRowsPerMinute: env.TELEMETRY_ANON_ROWS_PER_MINUTE ?? TELEMETRY.anonRowsPerMinute, anonBytesPerMinute: env.TELEMETRY_ANON_BYTES_PER_MINUTE ?? TELEMETRY.anonBytesPerMinute, ...(clock ? { clock } : {}) });
    // SMS: none until the owner picks a provider; messages are kept in sms_outbox as skipped.
    const invites = { sms: { provider: sms, warn: (data: Record<string, unknown>, message: string) => app.log.warn(data, message) }, appLink: env.DRIVER_APP_LINK };
    await adminAuthRoutes(app, { db, jwtSecret, panelUrl: env.ADMIN_PANEL_URL, ...(clock ? { clock } : {}) });
    await pricingRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    await contentRoutes(app, { db, jwtSecret, defaultZoneId: env.DEFAULT_ZONE_ID, ...(clock ? { clock } : {}) });
    // v0.18.5 (G1-B2): terms and privacy per country.
    await legalRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    await zoneRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    // v0.18.36 §60 (fix job 9): the airport queue.
    await airportQueueRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    // v0.18.43 §64 fix job 10: blocked pairs (Admin › Trips › Block this pair, Support undo).
    await blockedPairRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    // v0.18.110 BQ-V44 (contract.json#bonusCampaigns): Admin › Drivers › Bonuses and the driver's Campaigns.
    await bonusRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    await configRoutes(app, { db, jwtSecret, defaultZoneId: env.DEFAULT_ZONE_ID, smsConnected: sosSms !== undefined, paymentMethods: supportedPaymentMethods(env.PAYMENT_METHODS_PAUSED), ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    // v0.18.163 (owner 2026-11-25 "We cannot use data for open street map"): no OSRM any more, whatever OSRM_URL says
    // (the variable is left as it is; OsrmRouter stays in maps/routing.ts, unused, Rule 21). Roads = the straight-line
    // estimate; trip times come from Google live traffic (below) where the zone has it on.
    const roads = router ?? new EstimateRouter();
    // v0.18.163 (contract.json#liveTraffic): trip times with live traffic from Google Routes (the existing
    // GOOGLE_MAPS_API_KEY, Routes API enabled on its project), falling back to the estimate. About 2 calls per trip
    // (owner 2026-11-25): the quote (duration, distance, polyline), the driver's drive to the pickup after accept; the
    // ETA during the trip is worked out along the stored polyline (trips/etaRoute.ts), with a new call only off the
    // route or far behind. Tests pass `traffic` (null = none); an injected `router` alone means no Google.
    const trafficRoads =
      traffic !== undefined
        ? (traffic ?? undefined)
        : router === undefined && env.GOOGLE_MAPS_API_KEY !== undefined
          ? new GoogleRoutesRouter(env.GOOGLE_MAPS_API_KEY, roads, {
              timeoutMs: env.GOOGLE_ROUTES_TIMEOUT_MS,
              perMinute: env.GOOGLE_ROUTES_PER_MINUTE,
              log: app.log,
            })
          : undefined;
    setLiveTrafficConfigured(trafficRoads !== undefined);
    // v0.18.7: the ETA timer (trips/eta.ts) routes with the same router as the quotes; main.ts reads it here.
    // v0.18.163: main.ts hands `trafficRouter` to the leave-on-time check and the ETA ticks (trips/etaRoute.ts).
    app.decorate("router", roads);
    app.decorate("trafficRouter", trafficRoads ?? null);
    await quoteRoutes(app, { db, jwtSecret, router: roads, ...(trafficRoads ? { traffic: trafficRoads } : {}), ...(clock ? { clock } : {}) });
    const search = places ?? (env.GOOGLE_MAPS_API_KEY !== undefined ? new CachedPlaces(new GooglePlaces(env.GOOGLE_MAPS_API_KEY)) : new NoPlaces());
    await tripRoutes(app, { db, jwtSecret, router: roads, ...(trafficRoads ? { traffic: trafficRoads } : {}), paymentMethods: supportedPaymentMethods(env.PAYMENT_METHODS_PAUSED), currency: "SEK", nearbyCacheMs: env.NEARBY_CACHE_MS, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    // v0.18.136 (DRAFT, contract.json#stripeFees): one Stripe module (test or live keys); the rider fee is its first use.
    const payments = stripe !== undefined ? stripe : stripeFromEnv(env);
    // Live mode (contract.json#stripeFees.status): the admin status and the system_health alert read this copy's mode.
    setServerStripeStatus(stripe === undefined ? stripeKeyStatus(env) : stripe ? { mode: stripe.mode ?? "test" } : { mode: "off", reason: "no_keys" });
    await stripeWebhookRoutes(app, { db, stripe: payments, uses: { rider_fee: riderFeeUse, driver_invoice: driverInvoiceUse }, ...(clock ? { clock } : {}) });
    await adminTripRoutes(app, { db, jwtSecret, currency: "SEK", stripe: payments, ...(clock ? { clock } : {}) });
    // v0.18.38 §62: in-app call steps (answer, end, signal) and the admin call log.
    await callRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    // v0.18.56 §78 (G9 part 2): chat options, translate (503 coming_soon without a provider), admin chats + Message.
    await chatRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}), ...(translator ? { translator } : {}) });
    await rideRoutes(app, { db, jwtSecret, currency: "SEK", timeZone: "Europe/Stockholm", paymentMethods: supportedPaymentMethods(env.PAYMENT_METHODS_PAUSED), ...(clock ? { clock } : {}) });
    const documentKey = documentKeyFrom(env, jwtSecret);
    await driverRoutes(app, { db, jwtSecret, documentKey, invites, router: roads, stripe: payments, ...(clock ? { clock } : {}) });
    await adminPeopleRoutes(app, { db, jwtSecret, documentKey, invites, ...(clock ? { clock } : {}) });
    // v0.18.54 §76: Reveal with a reason (riders, drivers, fleets) and the one-click SOS reveal.
    await revealRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    // v0.18.149 (owner G12 Q6): a rider's / driver's signed-in sessions, signed out one or all by an admin.
    await adminSessionRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    await dispatchRoutes(app, { db, jwtSecret, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    await reservationRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    // v0.18.6 §32 (owner G4-F2..F6): the admin's Dispatch tools and the driver's events.
    await dispatchToolRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    await safetyRoutes(app, { db, jwtSecret, rideCheckAppMaxPerTrip: env.RIDE_CHECK_APP_MAX_PER_TRIP, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}), ...(sosSms ? { sms: sosSms } : {}), warn: (data, message) => app.log.warn(data, message) });
    // v0.18.116 §94 (BQ-S10): the rider's live trip link and its two public reads (their own budget, per copy).
    await shareRoutes(app, { db, jwtSecret, ...(env.SHARE_LINK_BASE ? { linkBase: env.SHARE_LINK_BASE } : {}), perAddressPerMinute: shareOf(SHARE_LIMITS.perAddressPerMinute, env.WEB_COPIES), perTokenPerMinute: shareOf(SHARE_LIMITS.perTokenPerMinute, env.WEB_COPIES), ...(clock ? { clock } : {}) });
    await realDataRoutes(app, { db, jwtSecret, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    await financeRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) }); // v0.18.153 P29 driver income year (DAC7)
    await adminEventRoutes(app, { db, jwtSecret, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    await mapsRoutes(app, { db, jwtSecret, places: search, router: roads, ...(trafficRoads ? { traffic: trafficRoads } : {}), ...(clock ? { clock } : {}) });
  }

  // Live outage 2026-11-17 (#268 post-mortem): the load-shedding hooks are part of EVERY built app, last (as main.ts
  // added them after buildApp), so the inject()/listen tests run the same hooks as live. main.ts passes the real limits
  // (SHED_*, its pool); without `shed` (tests, tools) both limits are 0 = never shed, but the gone-client checks still run.
  const stopShedding = registerLoadShedding(app, shed ?? { maxPoolWaiting: 0, maxLoopDelayMs: 0, poolWaiting: () => 0 });
  app.addHook("onClose", async () => stopShedding());
  // S4c fix 3: the session check cache, only with a LISTEN hub (auth/sessionCache.ts).
  const stopSessionCache = configureSessionCache(env.SESSION_CACHE_MS, hub);
  app.addHook("onClose", async () => stopSessionCache());

  return app;
}

/** A laptop without JWT_SECRET gets a fresh secret per start (sign-ins end on restart); staging and production must set one. */
const DEV_JWT_SECRET = randomBytes(32).toString("hex");
