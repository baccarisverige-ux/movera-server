import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate, authenticateAdmin, type Principal } from "../auth/guard.js";
import { schemaProblem } from "../contract/schemas.js";
import type { Db } from "../db/db.js";
import { z } from "zod";
import { ApiError, badRequest } from "../http/errors.js";
import { runIdempotent } from "../http/idempotency.js";
import { API_PREFIX } from "../http/prefix.js";
import { parseBody } from "../http/validate.js";
import { listErrorGroups, recordError, setErrorStatus, type ErrorApp, type ErrorKind, type ErrorPlatform } from "./errors.js";
import { scrub } from "./scrub.js";

/**
 * contract §11 (`contract.json#telemetry`): POST /telemetry/logs|analytics|crashes from any app. No token needed (one
 * is used when sent), no Idempotency-Key, 202 with an empty body, at most 16 KB, rate limited per address. The apps
 * scrub e-mails, phone numbers and coordinates; the server scrubs again before storing and keeps entries 30 days.
 */

export type TelemetryDeps = { db: Db; jwtSecret: string; clock?: () => Date };

export const TELEMETRY = { maxBodyBytes: 16 * 1024, perAddressPerMinute: 120, keepDays: 30 } as const;

const KINDS = [
  ["logs", "log", "TelemetryLog"],
  ["analytics", "analytics", "TelemetryEvent"],
  ["crashes", "crash", "TelemetryCrash"],
] as const;

export { scrub, scrubText } from "./scrub.js";

const ErrorsQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  app: z.enum(["driver", "rider", "server"]).optional(),
  platform: z.enum(["android", "ios", "web", "server"]).optional(),
  version: z.string().min(1).max(40).optional(),
  status: z.enum(["open", "fixed"]).optional(),
});
const ErrorStatusBody = z.object({ status: z.enum(["open", "fixed"]) });
const ERROR_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** contract v0.16.0: the app of a crash report, from the body or else the signed-in caller; null when unknown. */
function appOf(body: Record<string, unknown>, who: Principal | null): ErrorApp | null {
  if (body["app"] === "driver" || body["app"] === "rider") return body["app"];
  if (who?.actor === "driver" || who?.actor === "rider") return who.actor;
  return null;
}

export async function telemetryRoutes(app: FastifyInstance, deps: TelemetryDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  // Per address, a fixed one-minute window (one server in the test week; several instances would each count).
  const windows = new Map<string, { start: number; n: number }>();

  const caller = async (request: FastifyRequest): Promise<Principal | null> => {
    if (request.headers.authorization === undefined) return null;
    try {
      return await authenticate(request, guard, ["rider", "driver", "admin"]);
    } catch {
      return null; // a stale token never loses the log line
    }
  };

  for (const [segment, kind, schema] of KINDS) {
    app.post(`${API_PREFIX}/telemetry/${segment}`, { bodyLimit: 4 * TELEMETRY.maxBodyBytes }, async (request, reply) => {
      const at = now();
      const minute = 60_000;
      const window = windows.get(request.ip);
      if (window === undefined || at.getTime() - window.start >= minute) {
        if (windows.size > 10_000) windows.clear();
        windows.set(request.ip, { start: at.getTime(), n: 1 });
      } else if (++window.n > TELEMETRY.perAddressPerMinute) {
        throw new ApiError("rate_limited", "Too many telemetry calls.", { reason: "telemetry_too_many", retryAfterSeconds: Math.max(1, Math.ceil((window.start + minute - at.getTime()) / 1000)) });
      }
      const body = request.body ?? {};
      if (Buffer.byteLength(JSON.stringify(body)) > TELEMETRY.maxBodyBytes) throw badRequest("The body is larger than 16 KB.", "payload_too_large");
      const problem = schemaProblem(schema, body);
      if (problem !== null) throw badRequest(`The ${kind} is not valid: ${problem}.`, "invalid_body");
      const who = await caller(request);
      const clean = scrub(body) as Record<string, unknown>;
      // v0.16.0: a crash report that names its app (or comes with a rider/driver token) and platform is grouped
      // for the admin's Crashes & errors. One without (an older app) is kept as before, ungrouped.
      const errorApp = kind === "crash" ? appOf(clean, who) : null;
      const platform = clean["platform"] as ErrorPlatform | undefined;
      if (errorApp !== null && platform !== undefined) {
        await recordError(deps.db, {
          app: errorApp,
          platform,
          kind: (clean["kind"] as ErrorKind | undefined) ?? "crash",
          message: String(clean["error"]),
          stack: typeof clean["stack"] === "string" ? clean["stack"] : undefined,
          appVersion: typeof clean["appVersion"] === "string" ? clean["appVersion"] : undefined,
          device: who !== null ? `${who.actor}:${who.subjectId}` : `ip:${request.ip}`,
          body: clean,
          actor: who?.actor ?? null,
          subjectId: who?.subjectId ?? null,
          at,
        });
        return reply.status(202).send();
      }
      await deps.db
        .insertInto("telemetry")
        .values({
          kind,
          level: typeof clean["level"] === "string" ? clean["level"] : null,
          event: typeof clean["event"] === "string" ? clean["event"] : null,
          actor: who?.actor ?? null,
          subject_id: who?.subjectId ?? null,
          body: JSON.stringify(clean),
          at,
        })
        .execute();
      return reply.status(202).send();
    });
  }

  // v0.16.0 (owner 2026-10-29): Crashes & errors. Any signed-in admin, every role ("All admin roles (Recommended)"); no permission id, like GET /admin/auth/me.
  app.get(`${API_PREFIX}/admin/errors`, async (request) => {
    await authenticateAdmin(request, guard);
    const q = parseBody(ErrorsQuery, request.query);
    return listErrorGroups(deps.db, { cursor: q.cursor, limit: q.limit, app: q.app, platform: q.platform, version: q.version, status: q.status });
  });
  app.patch(`${API_PREFIX}/admin/errors/:errorId`, async (request) => {
    const who = await authenticateAdmin(request, guard);
    const errorId = (request.params as { errorId: string }).errorId;
    if (!ERROR_ID.test(errorId)) throw badRequest("Not a valid id.", "invalid_id");
    const body = parseBody(ErrorStatusBody, request.body);
    const key = request.headers["idempotency-key"];
    const result = await runIdempotent(
      deps.db,
      { actor: "admin", subjectId: who.subjectId, key: Array.isArray(key) ? key[0] : key, method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null },
      async (trx) => ({ status: 200, body: await setErrorStatus(trx, who, errorId, body.status, now()) }),
    );
    return result.body;
  });
}
