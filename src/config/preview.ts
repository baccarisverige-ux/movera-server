import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminCoversZone, authenticateAdmin, type GuardDeps } from "../auth/guard.js";
import { signAccessToken, verifyAccessToken } from "../auth/jwt.js";
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

type Empty = (who: { sub: string; zone: string; currency: string; now: Date }) => { status: number; body?: unknown };
const page = () => ({ status: 200, body: { items: [], nextCursor: null } });

/**
 * Owner 2026-11-04 (B7, "B: Empty screens"): a preview account has no rows, so its own-account reads answer what a
 * brand-new account gets — empty lists, a blank profile, a zero wallet — never an error and never fake data. Reads
 * that already answer empty for an unknown account (trips, offers, payouts, documents, notifications…) need no entry.
 */
const PREVIEW_DRIVER_PROFILE = ({ sub, zone }: { sub: string; zone: string }) => ({ driverId: sub, accountStatus: "active", onlineStatus: "offline", moving: false, firstName: "", zoneIds: [zone], categoryIds: [], documents: [], version: 1 });

export const PREVIEW_EMPTY_READS: Record<string, Empty> = {
  "/rider/profile": ({ sub }) => ({ status: 200, body: { riderId: sub, firstName: "", status: "active", version: 1, rating: null, outstanding: null, outstandingByCurrency: [] } }),
  "/wallet": ({ sub, currency, now }) => ({ status: 200, body: { ownerId: sub, balance: { amountMinor: 0, currency }, updatedAt: now.toISOString() } }),
  "/driver/profile": (who) => ({ status: 200, body: PREVIEW_DRIVER_PROFILE(who) }),
  "/driver/fleet": () => ({ status: 404, body: { code: "not_found", message: "You are not in a fleet yet.", retryable: false, reason: "no_fleet" } }),
  "/driver/fleet/invitations": () => ({ status: 200, body: { items: [] } }),
  "/driver/reminders": () => ({ status: 200, body: { items: [], blocksOnline: 0 } }),
  // v0.18.145 (contract.json#loadCut.homeBadges): the four answers above in one; a preview account has no country.
  "/driver/home-badges": (who) => ({ status: 200, body: { profile: PREVIEW_DRIVER_PROFILE(who), notifications: { items: [], nextCursor: null }, reminders: { items: [], blocksOnline: 0 }, onboardingSettings: null } }),
  "/driver/reservations": page,
  "/driver/vehicles": page,
};

export async function previewRoutes(app: FastifyInstance, deps: GuardDeps): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "GET") return;
    const path = request.url.split("?")[0]!.slice(API_PREFIX.length);
    const empty = PREVIEW_EMPTY_READS[path];
    if (empty === undefined) return;
    const header = request.headers.authorization;
    const token = typeof header === "string" ? /^Bearer (\S+)$/.exec(header.trim())?.[1] : undefined;
    if (token === undefined) return;
    const now = deps.clock?.() ?? new Date();
    const result = verifyAccessToken(token, deps.jwtSecret, now);
    if (!result.ok || result.claims.pv !== true) return;
    if (result.claims.actor !== (path.startsWith("/driver/") ? "driver" : "rider")) return; // the normal wrong_actor answer
    const zone = result.claims.zones[0] ?? "";
    const row = await deps.db.selectFrom("zones").select("currency").where("zone_id", "=", zone).executeTakeFirst();
    const answer = empty({ sub: result.claims.sub, zone, currency: row?.currency ?? "SEK", now });
    return reply.status(answer.status).send(answer.status >= 400 ? { ...(answer.body as object), requestId: request.id } : answer.body);
  });
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
