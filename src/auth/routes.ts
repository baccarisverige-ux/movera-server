import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_PREFIX } from "../http/prefix.js";
import { runIdempotent } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { authenticate, authenticateAdmin } from "./guard.js";
import { unlockSignIn, refreshTokens, requestOtp, signInWithProvider, signOut, verifyOtp, type AuthDeps } from "./service.js";
import { startEmailChange, startPhoneChange, verifyEmailChange, verifyPhoneChange } from "./accountChange.js";
import { joinWaitlist, listTestAccounts, listWaitlist } from "./waitlist.js";

/** contract §8: /auth/otp/request, /auth/otp/verify, /auth/provider, /auth/refresh, /auth/sign-out, /push/devices(/unregister). */

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
const ProviderBody = z.object({ provider: z.enum(["apple", "google"]), idToken: z.string().min(1).max(8192), app: z.enum(["rider", "driver"]), name: z.string().max(120).optional() });
const WaitlistBody = z.object({ phone: z.string(), app: z.enum(["rider", "driver"]), locale: Language.optional() });
const WaitlistQuery = z.object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), app: z.enum(["rider", "driver"]).optional() });
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
    return requestOtp(deps, { phone: body.phone, app: body.app, locale: body.locale, linkToken: body.linkToken, requestId: request.id }, client(request));
  });

  app.post(`${API_PREFIX}/auth/otp/verify`, async (request) => {
    const body = parseBody(OtpVerifyBody, request.body);
    return verifyOtp(deps, { phone: body.phone, sessionId: body.sessionId, code: body.code, linkToken: body.linkToken }, client(request));
  });

  // v0.5.3: Apple / Google. Without the provider's client ids: 503 provider_not_configured (the apps say coming soon).
  app.post(`${API_PREFIX}/auth/provider`, async (request) => {
    const body = parseBody(ProviderBody, request.body);
    return signInWithProvider(deps, { provider: body.provider, idToken: body.idToken, app: body.app, name: body.name }, client(request));
  });

  // v0.15.0 §24 (owner 2026-10-29, decision 5): a number answered sign_in_restricted joins the waiting list.
  app.post(`${API_PREFIX}/auth/waitlist`, async (request) => {
    const body = parseBody(WaitlistBody, request.body);
    return joinWaitlist(deps.db, { phone: body.phone, app: body.app, locale: body.locale, requestId: request.id }, client(request), deps.clock?.() ?? new Date());
  });

  // v0.15.0 §24 (decision 6, "Only in test builds"): only outside production; production has no such route (404).
  // v0.18.18 (owner 2026-11-03 "Close it now"): signed-in admin with drivers.read only (401 signed out, 403 without it).
  if (deps.testSignInEnabled) {
    app.get(`${API_PREFIX}/auth/test-accounts`, async (request) => {
      await authenticateAdmin(request, guard, "drivers.read");
      return listTestAccounts(deps.db);
    });
  }

  app.get(`${API_PREFIX}/admin/waitlist`, async (request) => {
    const who = await authenticateAdmin(request, guard, "overview.read");
    return listWaitlist(deps.db, parseBody(WaitlistQuery, request.query), who);
  });

  app.post(`${API_PREFIX}/auth/refresh`, async (request) => {
    const body = parseBody(RefreshBody, request.body);
    return refreshTokens(deps, body.refreshToken);
  });

  // v0.18.14 (owner 2026-11-02): phone and e-mail change by code, for riders and drivers.
  app.post(`${API_PREFIX}/account/phone/change`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const body = parseBody(z.object({ phone: z.string() }), request.body);
    return startPhoneChange(deps, who as never, body.phone, client(request), deps.clock?.() ?? new Date());
  });
  app.post(`${API_PREFIX}/account/phone/verify`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const body = parseBody(z.object({ phone: z.string(), sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), code: z.string() }), request.body);
    return verifyPhoneChange(deps, who as never, body, deps.clock?.() ?? new Date());
  });
  app.post(`${API_PREFIX}/account/email/change`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const body = parseBody(z.object({ email: z.string().max(200) }), request.body);
    return startEmailChange(deps.db, who as never, body.email, deps.clock?.() ?? new Date(), deps.testSignInEnabled ? (code) => request.log.info({ code }, "e-mail change code (no e-mail provider yet)") : undefined);
  });
  app.post(`${API_PREFIX}/account/email/verify`, async (request) => {
    const who = await authenticate(request, guard, ["rider", "driver"]);
    const body = parseBody(z.object({ challengeId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), code: z.string().max(12) }), request.body);
    return verifyEmailChange(deps.db, who as never, body, deps.clock?.() ?? new Date());
  });
  // Checker MED 3: an admin lifts a number's wrong-code lock.
  app.post(`${API_PREFIX}/admin/auth/sign-in-locks/unlock`, async (request) => {
    const who = await authenticateAdmin(request, guard, "settings.edit");
    const body = parseBody(z.object({ phone: z.string() }), request.body);
    return deps.db.transaction().execute((trx) => unlockSignIn(trx, who.subjectId, body.phone, deps.clock?.() ?? new Date()));
  });
  app.post(`${API_PREFIX}/auth/sign-out`, async (request, reply) => {
    // Works with an expired access token or an already-ended session, so signing out twice is fine (204).
    // v0.18.49 §71 (owner Q8): a driver with a current trip is refused (409 sign_out_on_trip) while his session is active.
    const who = await authenticate(request, guard, ["rider", "driver"], { allowEndedSession: true });
    await signOut(deps.db, who.sessionId, deps.clock?.() ?? new Date(), who.actor === "driver" ? who.subjectId : undefined);
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
