import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import { sql } from "kysely";
import type { Db } from "./db/db.js";
import { API_VERSION, CONTRACT_VERSION } from "./contract/contract.js";
import type { Env } from "./env.js";
import { ApiError, badRequest, notFound } from "./http/errors.js";

import { API_PREFIX } from "./http/prefix.js";
import { authRoutes } from "./auth/routes.js";

export { API_PREFIX };

const REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

export type BuildOptions = { env: Env; logger?: boolean; db?: Db; clock?: () => Date };

const READY_TIMEOUT_MS = 2000;

export async function buildApp({ env, logger = true, db, clock }: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ? { level: env.LOG_LEVEL } : false,
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
    await authRoutes(app, { db, jwtSecret, testSignInEnabled: env.MOVERA_ENV !== "production", ...(clock ? { clock } : {}) });
  }

  return app;
}

/** A laptop without JWT_SECRET gets a fresh secret per start (sign-ins end on restart); staging and production must set one. */
const DEV_JWT_SECRET = randomBytes(32).toString("hex");
