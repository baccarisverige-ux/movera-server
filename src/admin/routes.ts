import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminCoversZone, authenticate, authenticateAdmin } from "../auth/guard.js";
import { ApiError } from "../http/errors.js";
import { signOut } from "../auth/service.js";
import { API_PREFIX } from "../http/prefix.js";
import { readIdempotencyKey } from "../http/idempotency.js";
import { parseBody } from "../http/validate.js";
import { adminRefresh, adminSignIn, checkSetupLink, createSetupLink, loadAdminMe, setupPassword, type AdminDeps } from "./auth.js";

/** contract v0.5.1 §9: /admin/auth/* and /admin/agents/{adminId}/setup-link. */

const SignInBody = z.object({ email: z.string().min(3).max(254), password: z.string().min(1).max(256) });
const SetupBody = z.object({ setupToken: z.string().min(16).max(256), password: z.string().min(1).max(256) });
const SetupCheckBody = z.object({ setupToken: z.string().min(16).max(256) });
const RefreshBody = z.object({ refreshToken: z.string().min(1).max(512) });
const AdminIdParam = z.object({ adminId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

export async function adminAuthRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const client = (request: { ip: string; headers: Record<string, unknown> }) => ({
    ip: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? (request.headers["user-agent"] as string) : undefined,
  });

  app.post(`${API_PREFIX}/admin/auth/sign-in`, async (request) => adminSignIn(deps, parseBody(SignInBody, request.body), client(request)));

  app.post(`${API_PREFIX}/admin/auth/setup-password/check`, async (request) => checkSetupLink(deps, parseBody(SetupCheckBody, request.body).setupToken));

  app.post(`${API_PREFIX}/admin/auth/setup-password`, async (request) => setupPassword(deps, parseBody(SetupBody, request.body), client(request)));

  app.post(`${API_PREFIX}/admin/auth/refresh`, async (request) => adminRefresh(deps, parseBody(RefreshBody, request.body).refreshToken));

  app.post(`${API_PREFIX}/admin/auth/sign-out`, async (request, reply) => {
    const who = await authenticate(request, guard, ["admin"], { allowEndedSession: true });
    await signOut(deps.db, who.sessionId, deps.clock?.() ?? new Date());
    return reply.status(204).send();
  });

  app.get(`${API_PREFIX}/admin/auth/me`, async (request) => {
    const who = await authenticateAdmin(request, guard);
    return loadAdminMe(deps.db, who.subjectId);
  });

  app.post(`${API_PREFIX}/admin/agents/:adminId/setup-link`, async (request, reply) => {
    const who = await authenticateAdmin(request, guard, "team.edit");
    const { adminId } = parseBody(AdminIdParam, request.params);
    // The key is required like on every change, but the answer is not stored for replay: it holds a live
    // password link, and only its hash may be kept. A repeat makes a new link, which replaces the first.
    const key = request.headers["idempotency-key"];
    readIdempotencyKey(Array.isArray(key) ? key[0] : key);
    // A link lets its holder set the password, so only an admin whose zones cover the target's may make one
    // (audit Phase 4, P4-1: a Super admin limited to one zone could take over an all-zones Super admin).
    const target = await deps.db.selectFrom("admins").select("zone_ids").where("admin_id", "=", adminId).executeTakeFirst();
    if (target !== undefined && !who.zones.includes("*") && (target.zone_ids === null || !target.zone_ids.every((z) => adminCoversZone(who, z)))) {
      throw new ApiError("forbidden", "This admin's zones are outside your scope.", { reason: "zone_out_of_scope" });
    }
    return reply.status(201).send(await createSetupLink(deps, adminId, who.subjectId));
  });
}
