import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyAccessToken } from "../auth/jwt.js";
import { ApiError } from "./errors.js";
import { API_PREFIX } from "./prefix.js";

/**
 * General write limit (contract v0.18.24, contract.json#rateLimit; architecture audit item 9). Every POST, PUT, PATCH
 * and DELETE under the API counts against one budget per minute: a signed-in caller's budget is keyed by its user
 * (token `sub`), so many accounts behind one address (the 500+500 load test, a mobile operator's NAT) never share a
 * budget; a caller without a valid token is keyed by its address (Render proxy: TRUST_PROXY_HOPS). Over the budget:
 * 429 rate_limited, reason too_many_requests, Retry-After = seconds until the window ends. The OTP limits in
 * auth/service.ts stay as they are; this one sits in front of them. In memory per instance (one web instance).
 */
export type RateLimitSettings = { userPerMinute: number; addressPerMinute: number; windowMs?: number };

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SWEEP_EVERY = 1000;

export class WriteLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private seen = 0;
  constructor(private readonly windowMs: number) {}

  /** Counts one write; returns the seconds to wait when the key is over `limit`, else 0. */
  take(key: string, limit: number, now: number): number {
    if (++this.seen % SWEEP_EVERY === 0) this.sweep(now);
    let window = this.windows.get(key);
    if (window === undefined || now - window.start >= this.windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (window.count <= limit) return 0;
    return Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000));
  }

  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(key);
  }
}

function keyOf(request: FastifyRequest, jwtSecret: string | undefined, now: Date): { key: string; signedIn: boolean } {
  const header = request.headers.authorization;
  if (jwtSecret !== undefined && typeof header === "string" && header.startsWith("Bearer ")) {
    const verified = verifyAccessToken(header.slice(7).trim(), jwtSecret, now);
    if (verified.ok) return { key: `${verified.claims.actor}:${verified.claims.sub}`, signedIn: true };
  }
  return { key: `ip:${request.ip}`, signedIn: false };
}

export function registerWriteLimit(app: FastifyInstance, settings: RateLimitSettings, deps: { jwtSecret?: string | undefined; clock?: () => Date }): void {
  if (settings.userPerMinute <= 0 && settings.addressPerMinute <= 0) return;
  const limiter = new WriteLimiter(settings.windowMs ?? 60_000);
  app.addHook("onRequest", async (request) => {
    if (!WRITES.has(request.method) || !request.url.startsWith(API_PREFIX)) return;
    const now = deps.clock?.() ?? new Date();
    const { key, signedIn } = keyOf(request, deps.jwtSecret, now);
    const limit = signedIn ? settings.userPerMinute : settings.addressPerMinute;
    if (limit <= 0) return;
    const wait = limiter.take(key, limit, now.getTime());
    if (wait > 0) {
      request.log.warn({ signedIn, limit }, "write rate limit reached");
      throw new ApiError("rate_limited", "Too many requests. Wait a moment and try again.", { reason: "too_many_requests", retryAfterSeconds: wait });
    }
  });
}
