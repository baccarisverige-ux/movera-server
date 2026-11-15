import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../auth/guard.js";
import type { Db } from "../db/db.js";
import { ApiError, notFound } from "../http/errors.js";
import { runIdempotent } from "../http/idempotency.js";
import { API_PREFIX } from "../http/prefix.js";
import { parseBody } from "../http/validate.js";
import { pageLanguage, renderSharePage, type SharePage } from "./sharePage.js";
import { createShare, listShares, looksLikeToken, readShare, revokeShares, SHARE, shareToken, type ShareItem } from "./tripShare.js";

/**
 * Contract v0.18.116 §94 (contract.json#shareTrip; BQ-S10): the rider's three share routes and the two public reads.
 *
 * NEVER log, audit or echo `request.url`, the `token` parameter or a link here: the request log writes the route
 * pattern only (app.ts, B1.27), and test/e2e/51_share_trip.test.ts fails if a token reaches the log.
 */

export type ShareDeps = {
  db: Db;
  jwtSecret: string;
  /** SHARE_LINK_BASE; unset = the origin the request came to. */
  linkBase?: string;
  /** This copy's public read budget per address and per link (app.ts gives each copy its share). */
  perAddressPerMinute: number;
  perTokenPerMinute: number;
  clock?: () => Date;
};

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const MINUTE_MS = 60_000;
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const keyOf = (request: FastifyRequest) => {
  const value = request.headers["idempotency-key"];
  return Array.isArray(value) ? value[0] : value;
};

/** A fixed one-minute window per key, in this copy's memory (like telemetry's). Returns the seconds to wait when over. */
function fixedWindow(budget: number) {
  const windows = new Map<string, { start: number; n: number }>();
  return (key: string, at: number): number | null => {
    const window = windows.get(key);
    if (window === undefined || at - window.start >= MINUTE_MS) {
      if (windows.size > 10_000) windows.clear();
      windows.set(key, { start: at, n: 1 });
      return null;
    }
    if (++window.n <= budget) return null;
    return Math.max(1, Math.ceil((window.start + MINUTE_MS - at) / 1000));
  };
}

export async function shareRoutes(app: FastifyInstance, deps: ShareDeps): Promise<void> {
  const guard = { db: deps.db, jwtSecret: deps.jwtSecret, ...(deps.clock ? { clock: deps.clock } : {}) };
  const now = () => deps.clock?.() ?? new Date();
  const tripParam = (request: FastifyRequest) => parseBody(z.object({ tripId: ID }), request.params).tripId;
  const idem = (request: FastifyRequest, riderId: string) => ({ actor: "rider" as const, subjectId: riderId, key: keyOf(request), method: request.method, route: request.url.split("?")[0]!, body: request.body ?? null });
  const base = deps.linkBase?.replace(/\/+$/, "");
  const urlOf = (request: FastifyRequest, shareId: string) => `${base ?? `${request.protocol}://${request.host}`}/s/${shareToken(deps.jwtSecret, shareId)}`;

  const path = `${API_PREFIX}/rider/trips/:tripId/share`;
  app.post(path, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const tripId = tripParam(request);
    // The stored (replayed) answer has no url: it is made again from the link's id, here, on every answer.
    const result = await runIdempotent<ShareItem>(deps.db, idem(request, who.subjectId), async (trx) => ({ status: 201, body: await createShare(trx, who.subjectId, tripId, deps.jwtSecret, now()) }));
    return reply.status(201).send({ ...result.body, url: urlOf(request, result.body.shareId) });
  });
  app.get(path, async (request) => {
    const who = await authenticate(request, guard, ["rider"]);
    return listShares(deps.db, who.subjectId, tripParam(request), now());
  });
  app.delete(path, async (request, reply) => {
    const who = await authenticate(request, guard, ["rider"]);
    const tripId = tripParam(request);
    await runIdempotent(deps.db, idem(request, who.subjectId), async (trx) => {
      await revokeShares(trx, who.subjectId, tripId, now());
      return { status: 204, body: undefined };
    });
    return reply.status(204).send();
  });

  /* ---------------------------------------------------------------- public: no sign-in */

  const perAddress = fixedWindow(deps.perAddressPerMinute);
  const perToken = fixedWindow(deps.perTokenPerMinute);
  /** Both public routes share the two budgets. The per-link key is a hash, so no token sits in memory either. */
  const overBudget = (request: FastifyRequest, token: string): number | null => {
    const at = now().getTime();
    const address = perAddress(request.ip, at);
    if (address !== null) return address;
    return looksLikeToken(token) ? perToken(createHash("sha256").update(token).digest("base64"), at) : null;
  };
  const tokenOf = (request: FastifyRequest): string => {
    const token = (request.params as { token?: unknown }).token;
    return typeof token === "string" ? token : "";
  };
  const publicHeaders = (reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    reply.header("X-Content-Type-Options", "nosniff");
  };

  app.get(`${API_PREFIX}/share/:token`, async (request, reply) => {
    publicHeaders(reply);
    const token = tokenOf(request);
    const wait = overBudget(request, token);
    if (wait !== null) throw new ApiError("rate_limited", "Too many views of this link. Try again in a minute.", { reason: "share_too_many", retryAfterSeconds: wait });
    const read = await readShare(deps.db, token, now());
    if (read.state === "not_found") throw notFound("Link not found.", "share_not_found");
    if (read.state === "ended") return reply.status(410).send({ state: "ended", reason: "share_ended" });
    return read.view;
  });

  app.get("/s/:token", async (request, reply) => {
    publicHeaders(reply);
    reply.header("Content-Security-Policy", CSP);
    reply.type("text/html; charset=utf-8");
    const accept = request.headers["accept-language"];
    const send = (status: number, country: string | null, page: SharePage) => reply.status(status).send(renderSharePage(pageLanguage(accept, country), page));
    const token = tokenOf(request);
    const wait = overBudget(request, token);
    if (wait !== null) {
      reply.header("Retry-After", String(wait));
      return send(429, null, { kind: "too_many" });
    }
    const read = await readShare(deps.db, token, now());
    if (read.state === "not_found") return send(404, null, { kind: "not_found" });
    if (read.state === "ended") return send(410, read.country, { kind: "ended" });
    return send(200, read.country, { kind: "live", view: read.view, timeZone: read.timeZone });
  });
}

/** The contract's budgets (contract.json#shareTrip.limits). */
export const SHARE_LIMITS = SHARE.limits;
