import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyAccessToken } from "../auth/jwt.js";
import { PHONE, REFRESH_TTL_MS, refreshSessionOf } from "../auth/service.js";
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
 * auth/service.ts stay as they are; this one sits in front of them. S7 W2 Q117: an expired token with a right
 * signature is still keyed by its user (keyOf); Q118: sign-in and refresh are keyed by phone + address / session +
 * address (BODY_KEYED_ROUTES). B1.22: signed-in safety writes (SAFETY_WRITE_ROUTES)
 * and telemetry (OWN_BUDGET_ROUTES) are not counted here. In memory per copy: with WEB_COPIES > 1 each copy allows its share of the budget (shareOf).
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

/**
 * S7 W2 Q118 (owner 2026-11-15 "Yes, phone + address"): these calls carry no access token, so many phones behind one
 * mobile address used to share the one address budget. They are keyed by what the body names instead, at the same
 * budget: the code calls by phone + address, a refresh by its token's session + address (an unknown token, or a body
 * without a phone: the address, as before). The phone alone and the address alone are only ceilings of
 * SIGN_IN_CEILING_FACTOR times the budget. The body is read after the address ceiling was counted (preHandler).
 * Follow-up SF-1: a bearer token on these calls (valid or rightly signed but expired) changes nothing: they are always
 * keyed by the body and the address. SF-2: a call whose body never reached preHandler (bad JSON, over 1 MB, wrong
 * media type) is counted on the address at 1 x by the error handler (unreadBody), as before Q118.
 */
const OTP_ROUTES: ReadonlySet<string> = new Set(SIGN_IN_PATHS.map((path) => `POST ${path}`));
const REFRESH_ROUTES: ReadonlySet<string> = new Set([`POST ${API_PREFIX}/auth/refresh`, `POST ${API_PREFIX}/admin/auth/refresh`]);
export const SIGN_IN_CEILING_FACTOR = 10;

/**
 * B1.22 (owner W1 Q82, 2026-11-11): safety writes are never refused, nor counted, by this limit when the caller has a
 * valid token: SOS and ride-check answers (rider and driver), and trip cancels (rider, its /rides alias, driver, admin).
 * Without a valid token they count against the address like any other write. Matched on the route pattern.
 */
export const SAFETY_WRITE_ROUTES: ReadonlySet<string> = new Set(
  [
    "/rider/trips/:tripId/sos",
    "/driver/trips/:tripId/sos",
    "/rider/trips/:tripId/ride-check",
    "/driver/trips/:tripId/ride-check",
    "/trips/:tripId/cancel",
    "/rides/:rideId/cancel",
    "/admin/trips/:tripId/cancel",
  ].map((route) => `POST ${API_PREFIX}${route}`),
);

/** B1.22: the apps' telemetry lines have their own budget per address (telemetry/routes.ts), never this one. */
export const OWN_BUDGET_ROUTES: ReadonlySet<string> = new Set(["logs", "analytics", "crashes"].map((kind) => `POST ${API_PREFIX}/telemetry/${kind}`));

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

/**
 * S7 W2 Q117 (owner 2026-11-15 "Yes, per user"): a token that ran out but carries this server's signature still names
 * its user, so drivers behind one mobile address whose tokens ran out get 401 (and refresh) from their own budget, not
 * 429 from the shared address budget. Only the signature is trusted: a forged token, or one whose `sub` was changed,
 * fails it and is keyed by the address. The key is apart from the live one (`expired:`), so a stolen old token can
 * never use up its user's live budget, and it is not "signed in" (no safety-write pass). A token that ran out longer
 * ago than a refresh token lives (no session of it can be alive) is an address again.
 */
const EXPIRED_KEY_SECONDS = REFRESH_TTL_MS / 1000;

type Caller = { key: string; zone: string | undefined; signedIn: boolean; byUser: boolean };

function keyOf(request: FastifyRequest, jwtSecret: string | undefined, now: Date): Caller {
  const header = request.headers.authorization;
  if (jwtSecret !== undefined && typeof header === "string" && header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    const verified = verifyAccessToken(token, jwtSecret, now);
    if (verified.ok) return { key: `${verified.claims.actor}:${verified.claims.sub}`, zone: verified.claims.zones[0], signedIn: true, byUser: true };
    if (verified.reason === "expired") {
      const late = verifyAccessToken(token, jwtSecret, now, EXPIRED_KEY_SECONDS);
      if (late.ok) return { key: `expired:${late.claims.actor}:${late.claims.sub}`, zone: late.claims.zones[0], signedIn: false, byUser: true };
    }
  }
  return addressOf(request);
}

function addressOf(request: FastifyRequest): Caller {
  return { key: `ip:${request.ip}`, zone: undefined, signedIn: false, byUser: false };
}

/**
 * Called by the app's error handler first. For a sign-in / refresh call whose body was never read (SF-2): counts it on
 * the address at 1 x and returns the 429 to answer instead when the address is over its budget; else undefined.
 */
export type UnreadBodyCharge = (request: FastifyRequest) => ApiError | undefined;

export function registerWriteLimit(
  app: FastifyInstance,
  settings: WriteLimitSettings,
  deps: { jwtSecret?: string | undefined; clock?: () => Date; db?: Executor | undefined; defaultZoneId?: string; exemptPaths?: readonly string[] },
): UnreadBodyCharge | undefined {
  if (settings.user.off && settings.address.off) return undefined;
  const limiter = new WriteLimiter(settings.windowMs ?? 60_000);
  const admin = deps.db !== undefined ? new CountryWriteLimits(deps.db, (error) => app.log.warn({ err: error }, "write limits not read; the last ones stay")) : undefined;
  if (admin !== undefined) app.addHook("onReady", async () => admin.refresh((deps.clock?.() ?? new Date()).getTime()));
  const bodyKeyed = new WeakMap<FastifyRequest, { route: string; limit: number; now: Date }>();
  const take = (request: FastifyRequest, key: string, limit: number, now: Date, signedIn: boolean): void => {
    const wait = limiter.take(key, limit, now.getTime());
    if (wait > 0) {
      request.log.warn({ signedIn, limit }, "write rate limit reached");
      throw new ApiError("rate_limited", "Too many requests. Wait a moment and try again.", { reason: "too_many_requests", retryAfterSeconds: wait });
    }
  };
  app.addHook("onRequest", async (request) => {
    if (!WRITES.has(request.method) || !request.url.startsWith(API_PREFIX)) return;
    // Staging / development: sign-in (OTP request + verify) is not counted per address, so the 500+500 load test can
    // sign 1000 accounts in from a few machines. Its own OTP limits (per phone, per address, countryLimits) still apply.
    if (deps.exemptPaths?.includes(request.url.split("?")[0]!)) return;
    const route = `${request.method} ${request.routeOptions.url ?? ""}`;
    if (OWN_BUDGET_ROUTES.has(route)) return;
    const now = deps.clock?.() ?? new Date();
    // SF-1: the four sign-in / refresh calls never read the token; they are keyed by the body and the address.
    const signIn = OTP_ROUTES.has(route) || REFRESH_ROUTES.has(route);
    const { key, zone, signedIn, byUser } = signIn ? addressOf(request) : keyOf(request, deps.jwtSecret, now);
    if (signedIn && SAFETY_WRITE_ROUTES.has(route)) return;
    const country = admin?.countryOfZone(byUser ? zone : deps.defaultZoneId) ?? null;
    const set = admin?.get(country, now.getTime()) ?? null;
    const limit = shareOf(byUser ? limitOf(settings.user, set?.user) : limitOf(settings.address, set?.address), settings.copies);
    if (limit <= 0) return;
    if (signIn) {
      // Q118: the address alone is only a ceiling here; the phone or session key is counted once the body is read.
      take(request, `ceiling:ip:${request.ip}`, limit * SIGN_IN_CEILING_FACTOR, now, signedIn);
      bodyKeyed.set(request, { route, limit, now });
      return;
    }
    take(request, key, limit, now, signedIn);
  });
  app.addHook("preHandler", async (request) => {
    const pending = bodyKeyed.get(request);
    if (pending === undefined) return;
    bodyKeyed.delete(request);
    const { route, limit, now } = pending;
    const body = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
    if (OTP_ROUTES.has(route) && typeof body["phone"] === "string" && PHONE.test(body["phone"])) {
      // Phone + address first: an address over its budget for a phone adds nothing more to that phone's ceiling.
      take(request, `otp:${body["phone"]}|${request.ip}`, limit, now, false);
      take(request, `ceiling:otp:${body["phone"]}`, limit * SIGN_IN_CEILING_FACTOR, now, false);
      return;
    }
    if (REFRESH_ROUTES.has(route) && typeof body["refreshToken"] === "string" && body["refreshToken"].length <= 512 && deps.db !== undefined) {
      // One indexed read; a failed read counts against the address, like an unknown token.
      const session = await refreshSessionOf(deps.db, body["refreshToken"]).catch(() => undefined);
      if (session !== undefined) return take(request, `refresh:${session}|${request.ip}`, limit, now, false);
    }
    take(request, `ip:${request.ip}`, limit, now, false);
  });
  return (request) => {
    const pending = bodyKeyed.get(request);
    if (pending === undefined) return undefined;
    bodyKeyed.delete(request);
    try {
      take(request, `ip:${request.ip}`, pending.limit, pending.now, false);
      return undefined;
    } catch (error) {
      return error as ApiError;
    }
  };
}
