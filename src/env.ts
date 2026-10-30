import { z } from "zod";

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
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
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
  /** Payment methods riders may book with (test week: cash only). Comma-separated. */
  PAYMENT_METHODS: z
    .string()
    .default("cash")
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
