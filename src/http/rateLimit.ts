import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyAccessToken } from "../auth/jwt.js";
import { countryLimitsOf } from "../config/countryLimits.js";
import type { Executor } from "../db/db.js";
import type { WriteLimitEnv } from "../env.js";
import { ApiError } from "./errors.js";
import { API_PREFIX } from "./prefix.js";

/**
 * General write limit (contract v0.18.24, contract.json#rateLimit; architecture audit item 9). Every POST, PUT, PATCH
 * and DELETE under the API counts against one budget per minute: a signed-in caller's budget is keyed by its user
 * (token `sub`), so many accounts behind one address (the 500+500 load test, a mobile operator's NAT) never share a
 * budget; a caller without a valid token is keyed by its address (Render proxy: TRUST_PROXY_HOPS). Over the budget:
 * 429 rate_limited, reason too_many_requests, Retry-After = seconds until the window ends. The OTP limits in
 * auth/service.ts stay as they are; this one sits in front of them. In memory per copy: with WEB_COPIES > 1 each copy allows its share of the budget (shareOf).
 *
 * Owner 2026-11-04 "Yes, admin setting": the budgets are CountryRules.limits.writesPerUserPerMinute /
 * writesPerAddressPerMinute of each country's standard. They are read in the background at most once a minute
 * (CountryWriteLimits), never per request; env is the fallback and the floor (env.ts writeLimitsFrom).
 */
export type WriteLimitSettings = { user: WriteLimitEnv; address: WriteLimitEnv; windowMs?: number; copies?: number };

/** One copy's share of a budget when `copies` web copies each count in their own memory (never under 1). */
export function shareOf(limit: number, copies: number | undefined): number {
  return limit <= 0 || !copies || copies <= 1 ? limit : Math.max(1, Math.ceil(limit / copies));
}

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SWEEP_EVERY = 1000;
export const LIMITS_REFRESH_MS = 60_000;
/** Sign-in calls left out of the write limit outside production (registerWriteLimit exemptPaths). */
export const SIGN_IN_PATHS: readonly string[] = [`${API_PREFIX}/auth/otp/request`, `${API_PREFIX}/auth/otp/verify`];

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

type CountryWrites = { user: number; address: number };

/**
 * The admin's write limits per country and each zone's country, kept in memory. `get` never waits: when the copy is
 * older than LIMITS_REFRESH_MS it starts one background read and answers from the copy (empty until the first read).
 */
export class CountryWriteLimits {
  private byCountry = new Map<string, CountryWrites>();
  private zoneCountry = new Map<string, string>();
  private loadedAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | undefined;

  constructor(
    private readonly db: Executor,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  refresh(now: number): Promise<void> {
    this.loading ??= this.read()
      .then(() => {
        this.loadedAt = now;
      })
      .catch((error: unknown) => {
        // A failed read keeps the old copy and is tried again after the next interval.
        this.loadedAt = now;
        this.onError(error);
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  private async read(): Promise<void> {
    const [rules, zones] = await Promise.all([
      this.db.selectFrom("config_live").select(["zone_id", "document"]).where("doc", "=", "country_rules").where("zone_id", "like", "standard-%").execute(),
      this.db.selectFrom("zones").select(["zone_id", "country"]).execute(),
    ]);
    const byCountry = new Map<string, CountryWrites>();
    for (const row of rules) {
      const raw = (row.document as { limits?: Record<string, unknown> } | null)?.limits ?? {};
      const limits = countryLimitsOf(row.document);
      // Only a value the admin really set counts; a missing one leaves the env fallback in force.
      byCountry.set(row.zone_id.slice("standard-".length), {
        user: raw["writesPerUserPerMinute"] !== undefined ? limits.writesPerUserPerMinute : 0,
        address: raw["writesPerAddressPerMinute"] !== undefined ? limits.writesPerAddressPerMinute : 0,
      });
    }
    this.byCountry = byCountry;
    this.zoneCountry = new Map(zones.map((zone) => [zone.zone_id, zone.country]));
  }

  countryOfZone(zoneId: string | undefined): string | null {
    return zoneId === undefined ? null : (this.zoneCountry.get(zoneId) ?? null);
  }

  get(country: string | null, now: number): CountryWrites | null {
    if (now - this.loadedAt >= LIMITS_REFRESH_MS) void this.refresh(now);
    return country === null ? null : (this.byCountry.get(country) ?? null);
  }
}

/** The budget in force: env off wins; else the admin's value (when set) but never under the env floor. */
export function limitOf(env: WriteLimitEnv, admin: number | undefined): number {
  if (env.off) return 0;
  return admin !== undefined && admin > 0 ? Math.max(env.floor, admin) : env.fallback;
}

function keyOf(request: FastifyRequest, jwtSecret: string | undefined, now: Date): { key: string; zone: string | undefined; signedIn: boolean } {
  const header = request.headers.authorization;
  if (jwtSecret !== undefined && typeof header === "string" && header.startsWith("Bearer ")) {
    const verified = verifyAccessToken(header.slice(7).trim(), jwtSecret, now);
    if (verified.ok) return { key: `${verified.claims.actor}:${verified.claims.sub}`, zone: verified.claims.zones[0], signedIn: true };
  }
  return { key: `ip:${request.ip}`, zone: undefined, signedIn: false };
}

export function registerWriteLimit(
  app: FastifyInstance,
  settings: WriteLimitSettings,
  deps: { jwtSecret?: string | undefined; clock?: () => Date; db?: Executor | undefined; defaultZoneId?: string; exemptPaths?: readonly string[] },
): void {
  if (settings.user.off && settings.address.off) return;
  const limiter = new WriteLimiter(settings.windowMs ?? 60_000);
  const admin = deps.db !== undefined ? new CountryWriteLimits(deps.db, (error) => app.log.warn({ err: error }, "write limits not read; the last ones stay")) : undefined;
  if (admin !== undefined) app.addHook("onReady", async () => admin.refresh((deps.clock?.() ?? new Date()).getTime()));
  app.addHook("onRequest", async (request) => {
    if (!WRITES.has(request.method) || !request.url.startsWith(API_PREFIX)) return;
    // Staging / development: sign-in (OTP request + verify) is not counted per address, so the 500+500 load test can
    // sign 1000 accounts in from a few machines. Its own OTP limits (per phone, per address, countryLimits) still apply.
    if (deps.exemptPaths?.includes(request.url.split("?")[0]!)) return;
    const now = deps.clock?.() ?? new Date();
    const { key, zone, signedIn } = keyOf(request, deps.jwtSecret, now);
    const country = admin?.countryOfZone(signedIn ? zone : deps.defaultZoneId) ?? null;
    const set = admin?.get(country, now.getTime()) ?? null;
    const limit = shareOf(signedIn ? limitOf(settings.user, set?.user) : limitOf(settings.address, set?.address), settings.copies);
    if (limit <= 0) return;
    const wait = limiter.take(key, limit, now.getTime());
    if (wait > 0) {
      request.log.warn({ signedIn, limit }, "write rate limit reached");
      throw new ApiError("rate_limited", "Too many requests. Wait a moment and try again.", { reason: "too_many_requests", retryAfterSeconds: wait });
    }
  });
}
