import type { FastifyRequest } from "fastify";
import type { Executor } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { verifyAccessToken, type Actor } from "./jwt.js";
import { REFRESH_TTL_MS, sessionIsActive } from "./service.js";

/** Who is calling, from the access token (contract: actor and ids come from the token, never from the body). */
export type Principal = { actor: Actor; subjectId: string; sessionId: string; zones: string[]; role?: string; perms?: string[]; preview?: true };

/** v0.18.25 (contract.json#previewSession): what a preview token may call — reads only. */
const PREVIEW_METHODS = new Set(["GET", "HEAD"]);

export type GuardDeps = { db: Executor; jwtSecret: string; clock?: () => Date };

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(header.trim());
  return match?.[1];
}

/**
 * 401 unauthenticated when the token is missing, wrong, expired, or its session was ended (sign-out takes effect
 * at once, not after the token's 15 minutes); 403 forbidden when this actor may not call the operation.
 */
export async function authenticate(
  request: FastifyRequest,
  deps: GuardDeps,
  actors: readonly Actor[],
  options: { allowEndedSession?: boolean } = {},
): Promise<Principal> {
  const token = bearer(request);
  if (token === undefined) throw new ApiError("unauthenticated", "Please sign in.", { reason: "token_missing" });
  const now = deps.clock?.() ?? new Date();
  // Sign-out accepts an expired token, but only one young enough that its session could still be alive.
  const grace = options.allowEndedSession === true ? REFRESH_TTL_MS / 1000 : 0;
  const result = verifyAccessToken(token, deps.jwtSecret, now, grace);
  if (!result.ok) throw new ApiError("unauthenticated", "Please sign in again.", { reason: result.reason === "expired" ? "token_expired" : "token_invalid" });
  const { claims } = result;
  if (!actors.includes(claims.actor)) throw new ApiError("forbidden", "This app cannot do that.", { reason: "wrong_actor" });
  if (claims.pv === true) {
    // An admin's preview of the real app (owner P1/P2): it reads the live server, never writes. No session row:
    // the token lives 15 minutes and cannot be refreshed. Only rider / driver tokens can be previews.
    if (claims.actor === "admin") throw new ApiError("unauthenticated", "Please sign in again.", { reason: "token_invalid" });
    if (!PREVIEW_METHODS.has(request.method.toUpperCase())) throw new ApiError("forbidden", "Preview – not sent.", { reason: "preview_blocked" });
    return { actor: claims.actor, subjectId: claims.sub, sessionId: claims.sid, zones: claims.zones, preview: true };
  }
  if (options.allowEndedSession !== true && !(await sessionIsActive(deps.db, claims.sid, now))) {
    // v0.18.14 (one phone at a time): the old phone hears why.
    const ended = await deps.db.selectFrom("auth_sessions").select("revoked_reason").where("session_id", "=", claims.sid).executeTakeFirst();
    throw new ApiError("unauthenticated", "Please sign in again.", { reason: ended?.revoked_reason === "signed_in_elsewhere" ? "signed_in_elsewhere" : "session_ended" });
  }
  return {
    actor: claims.actor,
    subjectId: claims.sub,
    sessionId: claims.sid,
    zones: claims.zones,
    ...(claims.role !== undefined ? { role: claims.role, perms: claims.perms ?? [] } : {}),
  };
}

/** An admin with this permission (contract x-permission); 403 forbidden, reason missing_permission, otherwise. */
export async function authenticateAdmin(request: FastifyRequest, deps: GuardDeps, permission?: string): Promise<Principal> {
  const who = await authenticate(request, deps, ["admin"]);
  if (permission !== undefined && !(who.perms ?? []).includes(permission)) {
    throw new ApiError("forbidden", "You do not have permission to do that.", { reason: "missing_permission" });
  }
  return who;
}

/** May this admin act in this zone? ("*" = every zone.) */
export function adminCoversZone(who: Principal, zoneId: string): boolean {
  return who.zones.includes("*") || who.zones.includes(zoneId);
}
