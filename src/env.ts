import { z } from "zod";
import { parseExtraTestPhones } from "./auth/testPhones.js";

/**
 * Server settings, read from the environment once at start. Anything missing or malformed stops the server
 * before it listens, with the variable named, so a bad deploy never half-starts.
 */
const ids = () =>
  z
    .string()
    .optional()
    .transform((value) => (value ?? "").split(",").map((m) => m.trim()).filter(Boolean));

const schema = z.object({
  /**
   * development (laptop), staging (the test week), production (public). Test sign-in numbers exist only outside
   * production, so a deploy that forgets this setting is production: the safe side.
   */
  MOVERA_ENV: z.enum(["development", "staging", "production"]).default("production"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** postgres://user:pass@host:5432/db. Required on staging and production; a laptop may run without one. */
  DATABASE_URL: z.string().url().optional(),
  /** Apply new migrations when the server starts (safe with several instances: they take turns). */
  MIGRATE_ON_START: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /**
   * B12 (architecture audit item 14): database connections. Render basic-1gb Postgres allows about 100 connections;
   * the web service has 1 CPU. 20 per instance + 1 LISTEN client leaves room for a second instance during a deploy
   * (2 × 21), migrations and the admin CLI. Raise only together with the database plan.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  /** An idle pooled connection is closed after this many ms (0: never). */
  DATABASE_POOL_IDLE_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
  /** A query waits at most this long for a free pooled connection, then fails (0: wait forever). */
  DATABASE_POOL_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),
  /**
   * The realtime LISTEN client (realtime/hub.ts): a separate connection string, e.g. a direct (non-pooler) address.
   * Unset: DATABASE_URL. Never logged.
   */
  DATABASE_LISTEN_URL: z.string().url().optional(),
  /**
   * B11 (architecture audit item 9, contract.json#rateLimit): writes (POST/PUT/PATCH/DELETE) per minute per signed-in
   * user, and per address for callers without a token. 0 turns that limit off. Unset: 120 / 60 in production,
   * 1200 / 600 on staging and development (the load test signs in many accounts from a few addresses).
   */
  RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: z.coerce.number().int().min(0).max(100_000).optional(),
  RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: z.coerce.number().int().min(0).max(100_000).optional(),
  /** Signs access tokens. At least 32 characters; required on staging and production (a laptop gets a random one). */
  JWT_SECRET: z.string().min(32).optional(),
  /** Movera's own OSRM (owner decision 4), e.g. http://osrm:5000. Unset: distances are estimated. */
  OSRM_URL: z.string().url().optional(),
  /** Google Places / Geocoding key for address search (owner decision 4). Unset: address search answers 503. */
  GOOGLE_MAPS_API_KEY: z.string().min(10).optional(),
  /**
   * Seals uploaded driver documents at rest (AES-256-GCM): 32 random bytes, base64 (`openssl rand -base64 32`).
   * Required in production; elsewhere a key derived from JWT_SECRET stands in (contract v0.5.3 §14).
   */
  DOCUMENT_FILES_KEY: z.string().min(40).optional(),
  /**
   * Apple / Google sign-in (contract §8, contract.json#auth.providerKeys): the client ids the apps' identity tokens
   * are issued for, comma-separated (Apple: the bundle ids / service id; Google: the OAuth client ids). Unset: that
   * provider answers 503 unavailable (provider_not_configured) and the apps show the button as coming soon.
   */
  APPLE_CLIENT_IDS: ids(),
  GOOGLE_CLIENT_IDS: ids(),
  /** Where a phone without an account is sent to install the driver app (the SMS of an owner's invitation). */
  DRIVER_APP_LINK: z.string().url().optional(),
  /**
   * v0.18.13 (audit M5, contract.json#finish.paymentMethods.serverSupport): emergency kill-switch only. The admin's
   * per-zone switches decide which methods riders get; the methods the server can take are in code
   * (SERVER_PAYMENT_METHODS). A method listed here (comma-separated, default none; cash is ignored and logged) is served as coming_soon and refused
   * with payment_method_coming_soon until it is taken off the list. The old PAYMENT_METHODS list is no longer read.
   */
  PAYMENT_METHODS_PAUSED: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((m) => m.trim()).filter(Boolean)),
  /** The zone an app gets when it asks for settings without naming one. */
  DEFAULT_ZONE_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default("Z001"),
  /** Where the admin panel lives; setup links point at its /setup-password page. */
  ADMIN_PANEL_URL: z.string().url().default("http://localhost:5173"),
  /**
   * How many proxies sit in front of the server (the host's load balancer = 1). The client address is read from
   * X-Forwarded-For only that many hops deep, so a phone cannot fake its address. 0: no proxy.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /**
   * Web pages on another site that may call the API from a browser (the apps' web builds on GitHub Pages), as exact
   * origins, comma-separated: https://owner.github.io. Unset: no cross-site browser calls (the phone apps and a
   * same-site panel never need it).
   */
  /**
   * Hosts without a shell (Render's free plan): at start, make the test accounts once and publish the sample
   * settings where a zone has none, as `npm run admin -- seed-test` does. Staging and development only.
   */
  SEED_TEST_ON_START: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /**
   * The big test (owner 2026-11-03): more test numbers than the six built in, as a comma list of numbers and ranges
   * ("+46701740611-+46701740660,+33639980001"). Seeded at start like the six (both apps, fixed sign-in code).
   * Staging and development only.
   */
  MOVERA_EXTRA_TEST_PHONES: z
    .string()
    .optional()
    .transform((value, ctx) => {
      try {
        return parseExtraTestPhones(value);
      } catch (error) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
        return z.NEVER;
      }
    }),
  /** Also for a host without a shell: this Super admin is made at start and its password link written to the log. */
  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
  ADMIN_BOOTSTRAP_NAME: z.string().min(1).max(120).optional(),
  /**
   * Forgot password (audit Phase 4): any new text here makes one new password link for ADMIN_BOOTSTRAP_EMAIL at the
   * next start, written to the log like the first one, even though a password exists. One link per value; remove it
   * (or change it for another reset) afterwards. Staging and development only, like ADMIN_BOOTSTRAP_EMAIL.
   */
  ADMIN_PASSWORD_RESET: z.string().min(1).max(200).optional(),
  /**
   * A second Super admin for automated checks on staging, made at start like ADMIN_BOOTSTRAP_EMAIL (kept if it exists;
   * its password link is written to the log while it has no password). ADMIN_TEST_PASSWORD_RESET works for it like
   * ADMIN_PASSWORD_RESET. Staging and development only.
   */
  ADMIN_TEST_EMAIL: z.string().email().optional(),
  ADMIN_TEST_NAME: z.string().min(1).max(120).optional(),
  ADMIN_TEST_PASSWORD_RESET: z.string().min(1).max(200).optional(),
  /**
   * Push (contract v0.18.3 R7): the Firebase service account JSON (project movera-200b2). Sends every bell notice as an
   * FCM push and serves GET /push/config. Unset or unusable: push is off, nothing else changes. Never logged.
   */
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((value) => (value ?? "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean))
    .pipe(z.array(z.string().regex(/^https?:\/\/[^/\s]+$/, "an origin like https://example.github.io"))),
}).superRefine((env, ctx) => {
  if (env.MOVERA_ENV !== "development" && env.DATABASE_URL === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DATABASE_URL"], message: `required when MOVERA_ENV is ${env.MOVERA_ENV}` });
  }
  if (env.MOVERA_ENV === "production" && env.DOCUMENT_FILES_KEY === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DOCUMENT_FILES_KEY"], message: "required when MOVERA_ENV is production" });
  }
  if (env.MOVERA_ENV === "production") {
    const stagingOnly = [
      ["SEED_TEST_ON_START", env.SEED_TEST_ON_START],
      ["ADMIN_BOOTSTRAP_EMAIL", env.ADMIN_BOOTSTRAP_EMAIL !== undefined],
      ["ADMIN_TEST_EMAIL", env.ADMIN_TEST_EMAIL !== undefined],
      ["MOVERA_EXTRA_TEST_PHONES", env.MOVERA_EXTRA_TEST_PHONES.length > 0],
    ] as const;
    for (const [path, set] of stagingOnly) {
      if (set) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "for staging and development only" });
    }
  }
  if (env.MOVERA_ENV !== "development" && env.JWT_SECRET === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["JWT_SECRET"], message: `required when MOVERA_ENV is ${env.MOVERA_ENV}` });
  }
});

export type Env = z.infer<typeof schema>;

/**
 * The write limit's env part (B11, contract.json#rateLimit). `fallback` is used while no admin setting is known; `floor`
 * is the least the admin setting may give (0: none). An env value that is set is both; unset in production the
 * fallback is the contract default (120 / 60) and the admin may go lower; unset on staging and development 1200 / 600
 * are both (the load test). `off`: env 0 turns that limit off whatever the admin says.
 */
export type WriteLimitEnv = { fallback: number; floor: number; off: boolean };
export function writeLimitsFrom(env: Env): { user: WriteLimitEnv; address: WriteLimitEnv } {
  const production = env.MOVERA_ENV === "production";
  const part = (given: number | undefined, prodDefault: number, testDefault: number): WriteLimitEnv => {
    if (given !== undefined) return { fallback: given, floor: given, off: given === 0 };
    return production ? { fallback: prodDefault, floor: 0, off: false } : { fallback: testDefault, floor: testDefault, off: false };
  };
  return { user: part(env.RATE_LIMIT_WRITES_PER_USER_PER_MINUTE, 120, 1200), address: part(env.RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE, 60, 600) };
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // A host's dashboard may keep a variable that was left blank as an empty string: that means "not set".
  const given = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""));
  const parsed = schema.safeParse(given);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
