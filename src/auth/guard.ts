import type { FastifyRequest } from "fastify";
import type { Executor } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { verifyAccessToken, type Actor } from "./jwt.js";
import { sessionIsActive } from "./service.js";

/** Who is calling, from the access token (contract: actor and ids come from the token, never from the body). */
export type Principal = { actor: Actor; subjectId: string; sessionId: string; zones: string[] };

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
  const result = verifyAccessToken(token, deps.jwtSecret, now, options.allowEndedSession === true);
  if (!result.ok) throw new ApiError("unauthenticated", "Please sign in again.", { reason: result.reason === "expired" ? "token_expired" : "token_invalid" });
  const { claims } = result;
  if (!actors.includes(claims.actor)) throw new ApiError("forbidden", "This app cannot do that.", { reason: "wrong_actor" });
  if (options.allowEndedSession !== true && !(await sessionIsActive(deps.db, claims.sid, now))) {
    throw new ApiError("unauthenticated", "Please sign in again.", { reason: "session_ended" });
  }
  return { actor: claims.actor, subjectId: claims.sub, sessionId: claims.sid, zones: claims.zones };
}
