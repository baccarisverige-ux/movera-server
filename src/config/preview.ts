import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminCoversZone, authenticateAdmin, type GuardDeps } from "../auth/guard.js";
import { signAccessToken } from "../auth/jwt.js";
import type { Executor } from "../db/db.js";
import type { ConfigDoc } from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import { API_PREFIX } from "../http/prefix.js";
import { parseBody } from "../http/validate.js";
import { audit } from "../admin/audit.js";
import { getZone, type LiveDocument } from "./service.js";

/**
 * v0.18.25 admin real app preview (contract.json#previewSession; owner P1 a, P2 b, P3 a, 2026-11-04).
 * The admin panel frames the REAL rider / driver web app with a short-lived, read-only token: the app reads the live
 * server, and the guard refuses every write with 403 preview_blocked (auth/guard.ts), so nothing is ever booked,
 * accepted, paid or put online.
 */
export const PREVIEW_TTL_SECONDS = 900;

const Body = z.object({ role: z.enum(["rider", "driver"]), zoneId: z.string().min(1).max(64), useDraft: z.boolean().optional() });

/** The zone's saved draft for a preview token (null when the zone has no draft: the caller serves live). */
export async function draftForPreview(ex: Executor, doc: ConfigDoc, zoneId: string): Promise<LiveDocument<Record<string, unknown>> | null> {
  const row = await ex.selectFrom("config_drafts").select(["version", "document"]).where("doc", "=", doc).where("zone_id", "=", zoneId).executeTakeFirst();
  if (row === undefined || row.document === null || typeof row.document !== "object") return null;
  return { version: row.version, document: row.document as Record<string, unknown>, usesStandard: false, scope: zoneId };
}

export async function previewRoutes(app: FastifyInstance, deps: GuardDeps): Promise<void> {
  app.post(`${API_PREFIX}/admin/preview-sessions`, async (request, reply) => {
    const who = await authenticateAdmin(request, deps, "settings.read");
    const body = parseBody(Body, request.body);
    if (!adminCoversZone(who, body.zoneId)) throw new ApiError("forbidden", "This zone is outside your scope.", { reason: "zone_out_of_scope" });
    await getZone(deps.db, body.zoneId);
    const now = deps.clock?.() ?? new Date();
    const subjectId = `preview:${body.role}:${body.zoneId}`;
    const token = signAccessToken(
      { sub: subjectId, actor: body.role, sid: `prv_${randomBytes(12).toString("hex")}`, zones: [body.zoneId], pv: true },
      deps.jwtSecret,
      PREVIEW_TTL_SECONDS,
      now,
    );
    await audit(deps.db, { adminId: who.subjectId, action: "preview.open", targetType: "zone", targetId: body.zoneId, zoneId: body.zoneId, detail: { role: body.role, useDraft: body.useDraft === true }, at: now });
    void reply.code(201);
    return {
      token,
      role: body.role,
      zoneId: body.zoneId,
      useDraft: body.useDraft === true,
      expiresAt: new Date(now.getTime() + PREVIEW_TTL_SECONDS * 1000).toISOString(),
      subjectId,
    };
  });
}
