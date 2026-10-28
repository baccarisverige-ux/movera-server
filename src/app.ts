import { pricingRoutes } from "./pricing/routes.js";
import { contentRoutes } from "./content/routes.js";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import { sql } from "kysely";
import type { Db } from "./db/db.js";
import { API_VERSION, CONTRACT_VERSION } from "./contract/contract.js";
import type { Env } from "./env.js";
import { ApiError, badRequest, notFound } from "./http/errors.js";

import { API_PREFIX } from "./http/prefix.js";
import { authRoutes } from "./auth/routes.js";
import { adminAuthRoutes } from "./admin/routes.js";
import { configRoutes } from "./config/routes.js";
import { EstimateRouter, OsrmRouter, type Router } from "./maps/routing.js";
import { quoteRoutes } from "./quotes/routes.js";
import { mapsRoutes } from "./maps/routes.js";
import { tripRoutes } from "./trips/routes.js";
import { rideRoutes } from "./trips/rideRoutes.js";
import { adminTripRoutes } from "./admin/tripRoutes.js";
import { realDataRoutes } from "./admin/realdataRoutes.js";
import { driverRoutes } from "./drivers/routes.js";
import { adminPeopleRoutes } from "./admin/peopleRoutes.js";
import { documentKeyFrom } from "./documents/files.js";
import { providersFrom, type Provider, type ProviderVerifier } from "./auth/provider.js";
import { telemetryRoutes } from "./telemetry/routes.js";
import { notificationRoutes } from "./notifications/routes.js";
import type { SmsProvider } from "./sms/sms.js";
import multipart from "@fastify/multipart";
import { dispatchRoutes } from "./dispatch/routes.js";
import { safetyRoutes } from "./safety/routes.js";
import type { NotificationHub } from "./realtime/hub.js";
import { closeAllStreams } from "./realtime/sse.js";
import { CachedPlaces, GooglePlaces, NoPlaces, type Places } from "./maps/places.js";

export { API_PREFIX };

const REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

export type BuildOptions = { env: Env; logger?: boolean | { stream: NodeJS.WritableStream }; db?: Db; clock?: () => Date; router?: Router; places?: Places; hub?: NotificationHub; sms?: SmsProvider; providers?: Partial<Record<Provider, ProviderVerifier>> };

const READY_TIMEOUT_MS = 2000;
const CORS_HEADERS = "Authorization, Content-Type, Idempotency-Key, X-Api-Version, X-Request-Id, Last-Event-ID, Accept, Accept-Language";

export async function buildApp({ env, logger = true, db, clock, router, places, hub, sms, providers }: BuildOptions): Promise<FastifyInstance> {
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
      reply.header("Access-Control-Expose-Headers", "X-Request-Id, X-Api-Version, Retry-After");
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

  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
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
    request.log.error({ err: error }, "unhandled error");
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

  app.get("/healthz", async () => ({ status: "ok", contract: CONTRACT_VERSION, apiVersion: API_VERSION, env: env.MOVERA_ENV }));
  // Ready to take traffic: the database answers within 2 s. A load balancer stops sending requests while not.
  app.get("/readyz", async () => {
    if (db === undefined) return { status: "ready", database: "not_configured" };
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        sql`SELECT 1`.execute(db),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), READY_TIMEOUT_MS);
        }),
      ]);
    } catch {
      throw new ApiError("unavailable", "The database is not reachable.", { reason: "database_unavailable", retryAfterSeconds: 5 });
    } finally {
      clearTimeout(timer);
    }
    return { status: "ready", database: "ok" };
  });

  if (db !== undefined) {
    const jwtSecret = env.JWT_SECRET ?? DEV_JWT_SECRET;
    const signInProviders = providers ?? providersFrom(env);
    await authRoutes(app, { db, jwtSecret, testSignInEnabled: env.MOVERA_ENV !== "production", providers: signInProviders, ...(clock ? { clock } : {}) });
    await notificationRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    await telemetryRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    // SMS: none until the owner picks a provider; messages are kept in sms_outbox as skipped.
    const invites = { sms: { provider: sms, warn: (data: Record<string, unknown>, message: string) => app.log.warn(data, message) }, appLink: env.DRIVER_APP_LINK };
    await adminAuthRoutes(app, { db, jwtSecret, panelUrl: env.ADMIN_PANEL_URL, ...(clock ? { clock } : {}) });
    await pricingRoutes(app, { db, jwtSecret, ...(clock ? { clock } : {}) });
    await contentRoutes(app, { db, jwtSecret, defaultZoneId: env.DEFAULT_ZONE_ID, ...(clock ? { clock } : {}) });
    await configRoutes(app, { db, jwtSecret, defaultZoneId: env.DEFAULT_ZONE_ID, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    const roads =
      router ??
      (env.OSRM_URL !== undefined ? new OsrmRouter(env.OSRM_URL, 2500, (error) => app.log.warn({ err: error }, "OSRM unavailable; distance estimated")) : new EstimateRouter());
    await quoteRoutes(app, { db, jwtSecret, router: roads, ...(clock ? { clock } : {}) });
    const search = places ?? (env.GOOGLE_MAPS_API_KEY !== undefined ? new CachedPlaces(new GooglePlaces(env.GOOGLE_MAPS_API_KEY)) : new NoPlaces());
    await tripRoutes(app, { db, jwtSecret, paymentMethods: env.PAYMENT_METHODS, currency: "SEK", ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    await adminTripRoutes(app, { db, jwtSecret, currency: "SEK", ...(clock ? { clock } : {}) });
    await rideRoutes(app, { db, jwtSecret, currency: "SEK", timeZone: "Europe/Stockholm", ...(clock ? { clock } : {}) });
    const documentKey = documentKeyFrom(env, jwtSecret);
    await driverRoutes(app, { db, jwtSecret, documentKey, invites, ...(clock ? { clock } : {}) });
    await adminPeopleRoutes(app, { db, jwtSecret, documentKey, invites, ...(clock ? { clock } : {}) });
    await dispatchRoutes(app, { db, jwtSecret, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    await safetyRoutes(app, { db, jwtSecret, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    await realDataRoutes(app, { db, jwtSecret, ...(hub ? { hub } : {}), ...(clock ? { clock } : {}) });
    await mapsRoutes(app, { db, jwtSecret, places: search, router: roads, ...(env.OSRM_URL ? { osrmUrl: env.OSRM_URL } : {}), ...(clock ? { clock } : {}) });
  }

  return app;
}

/** A laptop without JWT_SECRET gets a fresh secret per start (sign-ins end on restart); staging and production must set one. */
const DEV_JWT_SECRET = randomBytes(32).toString("hex");
