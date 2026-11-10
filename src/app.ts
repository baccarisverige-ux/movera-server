import { pricingRoutes } from "./pricing/routes.js";
import { contentRoutes } from "./content/routes.js";
import { legalRoutes } from "./legal/routes.js";
import { zoneRoutes } from "./zones/routes.js";
import { airportQueueRoutes } from "./airportQueue/routes.js";
import { blockedPairRoutes } from "./blockedPairs/routes.js";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import { sql } from "kysely";
import { isDatabaseBusy, type Db } from "./db/db.js";
import { API_VERSION, CONTRACT_VERSION } from "./contract/contract.js";
import { writeLimitsFrom, type Env } from "./env.js";
import { registerWriteLimit, SIGN_IN_PATHS } from "./http/rateLimit.js";
import { poolStats } from "./db/db.js";
import { ApiError, badRequest, notFound } from "./http/errors.js";

import { API_PREFIX } from "./http/prefix.js";
import { authRoutes } from "./auth/routes.js";
import { adminAuthRoutes } from "./admin/routes.js";
import { configRoutes } from "./config/routes.js";
import { EstimateRouter, OsrmRouter, type Router } from "./maps/routing.js";
import { quoteRoutes } from "./quotes/routes.js";
import { mapsRoutes } from "./maps/routes.js";
import { tripRoutes } from "./trips/routes.js";
import { callRoutes } from "./calls/routes.js";
import { rideRoutes } from "./trips/rideRoutes.js";
import { supportedPaymentMethods } from "./trips/finish.js";
import { adminTripRoutes } from "./admin/tripRoutes.js";
import { realDataRoutes } from "./admin/realdataRoutes.js";
import { adminEventRoutes } from "./realtime/adminEvents.js";
import { driverRoutes } from "./drivers/routes.js";
import { adminPeopleRoutes } from "./admin/peopleRoutes.js";
import { revealRoutes } from "./admin/revealRoutes.js";
import { documentKeyFrom } from "./documents/files.js";
import { providersFrom, type Provider, type ProviderVerifier } from "./auth/provider.js";
import { recordServerError } from "./telemetry/errors.js";
import { loadSnapshot, registerServerTiming } from "./telemetry/load.js";
import { telemetryRoutes } from "./telemetry/routes.js";
import { notificationRoutes } from "./notifications/routes.js";
import type { SmsProvider } from "./sms/sms.js";
import multipart from "@fastify/multipart";
import { dispatchRoutes } from "./dispatch/routes.js";
import { reservationRoutes } from "./reservations/routes.js";
import { dispatchToolRoutes } from "./dispatch/toolRoutes.js";
import { safetyRoutes } from "./safety/routes.js";
import type { NotificationHub } from "./realtime/hub.js";
import { closeAllStreams } from "./realtime/sse.js";
import { pushServicesFrom, type PushServices } from "./push/config.js";
import { pushRoutes } from "./push/routes.js";
import { CachedPlaces, GooglePlaces, NoPlaces, type Places } from "./maps/places.js";

export { API_PREFIX };

const REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

export type BuildOptions = { env: Env; logger?: boolean | { stream: NodeJS.WritableStream }; db?: Db; clock?: () => Date; router?: Router; places?: Places; hub?: NotificationHub; sms?: SmsProvider; providers?: Partial<Record<Provider, ProviderVerifier>>; push?: PushServices };

const READY_TIMEOUT_MS = 2000;
const HEALTH_DB_TIMEOUT_MS = 1000;

/** True when the database answers SELECT 1 within `ms`; never throws. */
async function databaseAnswers(db: Db, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sql`SELECT 1`.execute(db),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
    return true;
  } catch {
    return false;
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
const CORS_HEADERS = "Authorization, Content-Type, Idempotency-Key, X-Api-Version, X-Contract-Version, X-Request-Id, Last-Event-ID, Accept, Accept-Language";

export async function buildApp({ env, logger = true, db, clock, router, places, hub, sms, providers, push }: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger
      ? {
          level: env.LOG_LEVEL,
          ...(typeof logger === "object" ? { stream: logger.stream } : {}),
          // Audit Phase 4 (P4-7): the request line is logged without its query string, which can hold a phone
          // number or an e-mail (admin searches `?q=`) or a place; the path alone is enough to trace a request.
          serializers: {
            req: (request: { method: string; url: string; id: string }) => ({ method: request.method, url: request.url.split("?")[0], reqId: request.id }),
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
    // Trust exactly TRUST_PROXY_HOPS proxies: the address is the one the nearest trusted proxy saw.
    trustProxy: env.TRUST_PROXY_HOPS > 0 ? (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS : false,
  });

  // Step 63 (T6): Server-Timing on every answer; first, so `total` covers every other hook.
  registerServerTiming(app);

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

  // B11: the general write limit (contract.json#rateLimit), before any route reads the body or the database.
  registerWriteLimit(app, writeLimitsFrom(env), { jwtSecret: db !== undefined ? (env.JWT_SECRET ?? DEV_JWT_SECRET) : env.JWT_SECRET, db, defaultZoneId: env.DEFAULT_ZONE_ID, exemptPaths: env.MOVERA_ENV === "production" ? [] : SIGN_IN_PATHS, ...(clock ? { clock } : {}) });

  app.setErrorHandler(async (error: FastifyError | ApiError, request, reply) => {
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
      const route = request.routeOptions.url ?? request.url.split("?")[0] ?? "";
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
    database: db === undefined ? "not_configured" : (await databaseAnswers(db, HEALTH_DB_TIMEOUT_MS)) ? "ok" : "unavailable",
  }));
  // Ready to take traffic: the database answers within 2 s. A load balancer stops sending requests while not.
  app.get("/readyz", async () => {
    if (db === undefined) return { status: "ready", database: "not_configured" };
    if (!(await databaseAnswers(db, READY_TIMEOUT_MS))) {
      throw new ApiError("unavailable", "The database is not reachable.", { reason: "database_unavailable", retryAfterSeconds: 5 });
    }
    return { status: "ready", database: "ok" };
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
    const signInProviders = providers ?? providersFrom(env);
    await authRoutes(app, { db, jwtSecret, testSignInEnabled: env.MOVERA_ENV !== "production", fastTestSignIn: env.MOVERA_ENV === "staging", providers: signInProviders, ...(clock ? { clock } : {}) });
    await notificationRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    await telemetryRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
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
    await configRoutes(app, { db, jwtSecret, defaultZoneId: env.DEFAULT_ZONE_ID, paymentMethods: supportedPaymentMethods(env.PAYMENT_METHODS_PAUSED), ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    const roads =
      router ??
      (env.OSRM_URL !== undefined ? new OsrmRouter(env.OSRM_URL, 2500, (error) => app.log.warn({ err: error }, "OSRM unavailable; distance estimated")) : new EstimateRouter());
    // v0.18.7: the ETA timer (trips/eta.ts) routes with the same router as the quotes; main.ts reads it here.
    app.decorate("router", roads);
    await quoteRoutes(app, { db, jwtSecret, router: roads, ...(clock ? { clock } : {}) });
    const search = places ?? (env.GOOGLE_MAPS_API_KEY !== undefined ? new CachedPlaces(new GooglePlaces(env.GOOGLE_MAPS_API_KEY)) : new NoPlaces());
    await tripRoutes(app, { db, jwtSecret, router: roads, paymentMethods: supportedPaymentMethods(env.PAYMENT_METHODS_PAUSED), currency: "SEK", ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    await adminTripRoutes(app, { db, jwtSecret, currency: "SEK", ...(clock ? { clock } : {}) });
    // v0.18.38 §62: in-app call steps (answer, end, signal) and the admin call log.
    await callRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    await rideRoutes(app, { db, jwtSecret, currency: "SEK", timeZone: "Europe/Stockholm", paymentMethods: supportedPaymentMethods(env.PAYMENT_METHODS_PAUSED), ...(clock ? { clock } : {}) });
    const documentKey = documentKeyFrom(env, jwtSecret);
    await driverRoutes(app, { db, jwtSecret, documentKey, invites, ...(clock ? { clock } : {}) });
    await adminPeopleRoutes(app, { db, jwtSecret, documentKey, invites, ...(clock ? { clock } : {}) });
    // v0.18.54 §76: Reveal with a reason (riders, drivers, fleets) and the one-click SOS reveal.
    await revealRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    await dispatchRoutes(app, { db, jwtSecret, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    await reservationRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    // v0.18.6 §32 (owner G4-F2..F6): the admin's Dispatch tools and the driver's events.
    await dispatchToolRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    await safetyRoutes(app, { db, jwtSecret, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    await realDataRoutes(app, { db, jwtSecret, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    await adminEventRoutes(app, { db, jwtSecret, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    await mapsRoutes(app, { db, jwtSecret, places: search, router: roads, ...(env.OSRM_URL ? { osrmUrl: env.OSRM_URL } : {}), ...(clock ? { clock } : {}) });
  }

  return app;
}

/** A laptop without JWT_SECRET gets a fresh secret per start (sign-ins end on restart); staging and production must set one. */
const DEV_JWT_SECRET = randomBytes(32).toString("hex");
