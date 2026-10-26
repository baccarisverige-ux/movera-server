import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate, type Principal } from "../auth/guard.js";
import { schemaProblem } from "../contract/schemas.js";
import type { Db } from "../db/db.js";
import { ApiError, badRequest } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";

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

/** Keys whose values are never kept, whatever they hold. */
const PRIVATE_KEY = /^(lat|lng|lon|latitude|longitude|phone|email|e-?mail|token|accesstoken|refreshtoken|password|authorization|code|pin)$/i;

export function scrubText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[token]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/-?\d{1,3}\.\d{3,}\s*[,;\s]\s*-?\d{1,3}\.\d{3,}/g, "[coordinates]")
    .replace(/-?\b\d{1,3}\.\d{4,}\b/g, "[coordinate]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[phone]");
}

export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = PRIVATE_KEY.test(k) ? "[removed]" : scrub(v, depth + 1);
  return out;
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
}
