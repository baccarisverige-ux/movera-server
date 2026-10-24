import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_PREFIX } from "../http/prefix.js";
import { badRequest } from "../http/errors.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { authenticate } from "./guard.js";
import { refreshTokens, requestOtp, signOut, verifyOtp, type AuthDeps } from "./service.js";

/** contract §8: /auth/otp/request, /auth/otp/verify, /auth/refresh, /auth/sign-out, /push/devices(/unregister). */

const Language = z.enum(["en", "fr", "sv"]);
const OtpRequestBody = z.object({
  phone: z.string(),
  app: z.enum(["rider", "driver"]),
  linkToken: z.string().min(1).optional(),
  locale: Language.optional(),
});
const OtpVerifyBody = z.object({
  phone: z.string(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  code: z.string(),
  linkToken: z.string().min(1).optional(),
});
const RefreshBody = z.object({ refreshToken: z.string().min(1).max(512) });
const PushDeviceBody = z.object({
  token: z.string().min(1).max(4096),
  provider: z.enum(["fcm", "apns"]),
  platform: z.enum(["ios", "android", "web"]),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  locale: Language.optional(),
});
const PushUnregisterBody = z.object({ token: z.string().min(1).max(4096) });

export async function authRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const client = (request: { ip: string; headers: Record<string, unknown> }) => ({
    ip: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? (request.headers["user-agent"] as string) : undefined,
  });
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };

  app.post(`${API_PREFIX}/auth/otp/request`, async (request) => {
    const body = parseBody(OtpRequestBody, request.body);
    if (body.linkToken !== undefined) throw linkTokenUnknown();
    return requestOtp(deps, { phone: body.phone, app: body.app, locale: body.locale, requestId: request.id }, client(request));
  });

  app.post(`${API_PREFIX}/auth/otp/verify`, async (request) => {
    const body = parseBody(OtpVerifyBody, request.body);
    if (body.linkToken !== undefined) throw linkTokenUnknown();
    return verifyOtp(deps, { phone: body.phone, sessionId: body.sessionId, code: body.code }, client(request));
  });

  app.post(`${API_PREFIX}/auth/refresh`, async (request) => {
    const body = parseBody(RefreshBody, request.body);
    return refreshTokens(deps, body.refreshToken);
  });

  app.post(`${API_PREFIX}/auth/sign-out`, async (request, reply) => {
    // Works with an expired access token or an already-ended session, so signing out twice is fine (204).
    const who = await authenticate(request, guard, ["rider", "driver"], { allowEndedSession: true });
    await signOut(deps.db, who.sessionId, deps.clock?.() ?? new Date());
    return reply.status(204).send();
  });

  app.post(`${API_PREFIX}/push/devices`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const body = parseBody(PushDeviceBody, request.body);
    const result = await runIdempotent(
      deps.db,
      { actor: who.actor, subjectId: who.subjectId, key: header(request.headers["idempotency-key"]), method: "POST", route: request.url.split("?")[0]!, body },
      async (trx) => {
        const values = {
          token: body.token,
          actor: who.actor as "rider" | "driver",
          subject_id: who.subjectId,
          session_id: who.sessionId,
          provider: body.provider,
          platform: body.platform,
          app_version: body.appVersion ?? null,
          locale: body.locale ?? null,
          updated_at: deps.clock?.() ?? new Date(),
        };
        // The same token on a new account (another rider on a shared phone) moves to that account.
        await trx
          .insertInto("push_devices")
          .values(values)
          .onConflict((conflict) => conflict.columns(["token", "actor"]).doUpdateSet(values))
          .execute();
        return { status: 200, body: { status: "registered" as const, requestId: request.id } };
      },
    );
    return result.body;
  });

  app.post(`${API_PREFIX}/push/devices/unregister`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"], { allowEndedSession: true });
    const body = parseBody(PushUnregisterBody, request.body);
    const result = await runIdempotent(
      deps.db,
      { actor: who.actor, subjectId: who.subjectId, key: header(request.headers["idempotency-key"]), method: "POST", route: request.url.split("?")[0]!, body },
      async (trx) => {
        // Only this account's registration; another account's use of the token is left alone.
        await trx.deleteFrom("push_devices").where("token", "=", body.token).where("actor", "=", who.actor as "rider" | "driver").where("subject_id", "=", who.subjectId).execute();
        return { status: 200, body: { status: "unregistered" as const, requestId: request.id } };
      },
    );
    return result.body;
  });
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Apple / Google sign-in is off in the test week (owner decision 12), so no link token can be valid yet. */
function linkTokenUnknown() {
  return badRequest("This sign-in link is not valid. Sign in with your phone number.", "invalid_link_token");
}
