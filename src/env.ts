import { z } from "zod";
import { parseExtraTestPhones } from "./auth/testPhones.js";
import { smsStartupWarnings } from "./sms/elks.js";
import { OSRM_BREAKER_COOLDOWN_SECONDS_DEFAULT, OSRM_BREAKER_FAILURES_DEFAULT, OSRM_TIMEOUT_MS_DEFAULT } from "./maps/osrmSettings.js";
import { READ_RETRY_DEFAULTS } from "./realtime/retry.js";
import { SESSION_CHECK_DEFAULT_MS, SESSION_CHECK_MAX_MS } from "./realtime/sessionWatch.js";

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
  /** B1.22 (owner W1 Q82): the apps' telemetry lines (POST /telemetry/logs|analytics|crashes) per address per minute,
   * their own budget outside the write limit above. Unset: 120 (the budget they always had). Shared by WEB_COPIES. */
  TELEMETRY_PER_ADDRESS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).optional(),
  /** B1.25 (owner W1 Q85): the TOTAL telemetry lines and body bytes one server copy stores per minute for callers without
   * a valid token (all addresses together); over it the call answers 202 and is not stored (counted in GET /internal/load).
   * Per server copy, NOT divided by WEB_COPIES: each copy guards its own share of the database disk (fleet total = copies
   * x cap). Signed-in callers are never counted. Unset: 600 lines and 2 MiB (2097152). */
  TELEMETRY_ANON_ROWS_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).optional(),
  TELEMETRY_ANON_BYTES_PER_MINUTE: z.coerce.number().int().min(1024).max(1_073_741_824).optional(),
  /** B1.22 supervisor N1: the app's own ride checks (new checkIds, safety/rideCheck.ts) per trip and side. The endpoint
   * is outside the write limit, so over this many no new check and no no-answer timer is made (the newest app check
   * answers); answers, I need help and the server's own checks are never capped. 30 is far above the apps' cadence
   * (one ask per reason per contract.json#onTrip.rideCheck repeatMinutes 10). Range 1-500. */
  RIDE_CHECK_APP_MAX_PER_TRIP: z.coerce.number().int().min(1).max(500).default(30),
  /** How many web copies of the server run behind the load balancer (load test part 6). Each copy keeps its own write
   * counts in memory, so each one allows 1/WEB_COPIES of the budget. Default 1 = today. */
  WEB_COPIES: z.coerce.number().int().min(1).max(16).optional(),
  /** Signs access tokens. At least 32 characters; required on staging and production (a laptop gets a random one). */
  JWT_SECRET: z.string().min(32).optional(),
  /** Movera's own OSRM (owner decision 4), e.g. http://osrm:5000. Unset: distances are estimated. */
  OSRM_URL: z.string().url().optional(),
  /**
   * B1.3 (owner W1 Q67, 2026-11-11): infra knobs for the OSRM client (maps/routing.ts OsrmRouter), env because they
   * describe the route server, not a per-country rule. A route ask waits at most OSRM_TIMEOUT_MS, then the distance
   * is estimated (2500 = the value hardcoded before). After OSRM_BREAKER_FAILURES failures in a row OSRM is not called
   * for OSRM_BREAKER_COOLDOWN_SECONDS (estimate at once), then one probe; 0 failures turns the breaker off.
   */
  OSRM_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(OSRM_TIMEOUT_MS_DEFAULT),
  OSRM_BREAKER_FAILURES: z.coerce.number().int().min(0).max(1000).default(OSRM_BREAKER_FAILURES_DEFAULT),
  OSRM_BREAKER_COOLDOWN_SECONDS: z.coerce.number().int().min(1).max(3600).default(OSRM_BREAKER_COOLDOWN_SECONDS_DEFAULT),
  /** Google Places / Geocoding key for address search (owner decision 4). Unset: address search answers 503. */
  GOOGLE_MAPS_API_KEY: z.string().min(10).optional(),
  /**
   * G30b (owner 2026-11-12 Q1, contract.json#emailVerified.delivery): Resend's API key for the e-mail change codes,
   * filled in Render's dashboard (never committed, never logged). Unset: no e-mail is sent, delivery pending_provider.
   */
  RESEND_API_KEY: z.string().min(8).optional(),
  /**
   * Contract v0.18.133 (contract.json#smsSignIn.serverKeys): the 46elks API username and password for the sign-in code
   * SMS, filled in Render's dashboard by the owner (never committed, never logged). Read leniently on purpose: a wrong
   * or half-filled value must never stop the server from starting; without BOTH, real SMS codes stay off and every real
   * number is answered sign_in_restricted as before (sms/elks.ts).
   */
  ELKS_API_USERNAME: z.string().optional(),
  ELKS_API_PASSWORD: z.string().optional(),
  /** The SMS sender name (3-11 letters and digits). Unset or not usable: contract.json#smsSignIn.sender ("Movera"). */
  SMS_SENDER_NAME: z.string().optional(),
  /** The sender of those e-mails. Unset: Resend's own test sender "Movera <onboarding@resend.dev>" (no own domain yet). */
  EMAIL_FROM: z.string().min(3).max(200).optional(),
  /** One send waits at most this long for Resend, then counts as not sent (pending_provider). */
  EMAIL_SEND_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5000),
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
  /**
   * v0.18.116 §94 (Share my trip): the origin the rider's live links start with, e.g. https://go.movera.example (the
   * link is <base>/s/<token>). Not a secret. Unset: the origin the request came to (this server's own address).
   */
  SHARE_LINK_BASE: z.string().url().optional(),
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
  /**
   * Job 1 (fast dispatch, fix plan R1): timer loops per instance. One loop runs only dispatch rounds and offer
   * withdrawals (rides are offered in seconds even while other timers pile up); the others take any timer.
   */
  TIMER_LANES: z.coerce.number().int().min(1).max(16).default(4),
  /**
   * Stress T-A part 4: loops per instance that run ONLY dispatch rounds and offer withdrawals (on top of TIMER_LANES).
   * One round waits on ~35 database round trips (≈ 110–150 ms on a busy copy); with one loop, 700+ drivers need more
   * rounds per second than it can run and new searches queue behind overdue rounds. Rounds of different trips are
   * safe side by side (each locks its own trip row; chosen drivers are locked NOWAIT and checked again).
   */
  DISPATCH_LANES: z.coerce.number().int().min(1).max(16).default(1),
  /**
   * B1.7 (owner W1 Q71): loops per instance that run ONLY housekeeping (the clean-ups, the hourly sweep, the nightly run;
   * jobs/workerConfig.ts HOUSEKEEPING_LANE_KINDS), on top of TIMER_LANES and DISPATCH_LANES. Housekeeping never runs on the
   * general lanes, so SOS escalation and booked rides never wait behind a long clean-up (stress T-A part 4: a 74 s sweep).
   * Default 1: one more pooled connection at most per instance, the same housekeeping work as before (it is not urgent).
   */
  HOUSEKEEPING_LANES: z.coerce.number().int().min(1).max(16).default(1),
  /**
   * G34 S3 (contract v0.18.83 fastDispatch.lateAlarm; owner 2026-11-13 12:18 UTC, GM S3b): loops per instance for the
   * per-trip GPS timers (trip_eta, ride_check_scan, near_dropoff). Default 1, as before: more lanes are not proven to help
   * (sup1 P3); /healthz/jobs reports when these timers fall behind.
   */
  TRIP_LANES: z.coerce.number().int().min(1).max(16).default(1),
  /** Job 1 (stress H3): shed new low-priority requests (503 server_busy: quotes, rider map, address search, admin lists) while more than this many queries wait for a pooled connection (0: off). */
  SHED_POOL_WAITING: z.coerce.number().int().min(0).max(100_000).default(200),
  /** Job 1 (stress H3): shed new low-priority requests while the event loop is this many ms late (p99 in both of the last two 0.5 s samples; 0: off). */
  SHED_LOOP_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(1000),
  /**
   * B1.9 (owner W1 Q73, 2026-11-11): a failed stream read (trip, offer, settings, admin live, dispatch, incident
   * streams) is retried this many times (1, 2, 4 s …); the next failure closes the stream so the app reconnects and
   * re-reads (0: close at the first failure). Infra knobs, env like SHED_*.
   */
  STREAM_READ_RETRIES: z.coerce.number().int().min(0).max(10).default(READ_RETRY_DEFAULTS.maxRetries),
  /** B1.9: a stream that gave up closes after a random 0 – this many ms, so one DB blip does not reconnect every app at once (0: at once). */
  STREAM_CLOSE_SPREAD_MS: z.coerce.number().int().min(0).max(300_000).default(READ_RETRY_DEFAULTS.closeSpreadMs),
  /**
   * B1.15 (owner W1 Q76): each server copy re-checks the session rows of all its open streams this often (one batched
   * query), so a stream of a signed-out / revoked session ends within this time; at most 60 s (the contract's promise).
   */
  STREAM_SESSION_CHECK_MS: z.coerce.number().int().min(100).max(SESSION_CHECK_MAX_MS).default(SESSION_CHECK_DEFAULT_MS),
  /** Job 1 (fix plan R22): a single SQL statement of a request is stopped after this many ms (0: no limit). */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(30_000),
  /**
   * B1.4 (owner W1 Q68): migrations run WITHOUT the statement limit above, but a migration that waits this many ms for a
   * table lock fails (the next start tries again) instead of holding every app query behind it (0: no limit).
   */
  DATABASE_MIGRATION_LOCK_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(5000),
  /**
   * Global plan step 63 (T6b): serve this copy's load numbers at GET /internal/load (stress test T-A only).
   * Staging and development only: production refuses to start with it on.
   */
  LOAD_COUNTERS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /**
   * v0.18.56 §78 (contract.json#inAppCalls.turnEnv, G9-2.4): STUN / TURN servers of in-app calls, names only here
   * (values on the hosting service, never in git). Comma lists of stun: / turn: / turns: URLs; MOVERA_TURN_URLS and
   * MOVERA_TURN_SECRET go together. src/calls/settings.ts reads them.
   */
  MOVERA_STUN_URLS: z.string().optional().pipe(z.string().regex(/^\s*stuns?:[^,\s]+(\s*,\s*stuns?:[^,\s]+)*\s*$/, "a comma list of stun: URLs").optional()),
  MOVERA_TURN_URLS: z.string().optional().pipe(z.string().regex(/^\s*turns?:[^,\s]+(\s*,\s*turns?:[^,\s]+)*\s*$/, "a comma list of turn: / turns: URLs").optional()),
  MOVERA_TURN_SECRET: z.string().min(16, "at least 16 characters").optional(),
}).superRefine((env, ctx) => {
  if ((env.MOVERA_TURN_URLS === undefined) !== (env.MOVERA_TURN_SECRET === undefined)) {
    const missing = env.MOVERA_TURN_URLS === undefined ? "MOVERA_TURN_URLS" : "MOVERA_TURN_SECRET";
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [missing], message: "MOVERA_TURN_URLS and MOVERA_TURN_SECRET are set together" });
  }
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
      ["LOAD_COUNTERS", env.LOAD_COUNTERS],
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
export function writeLimitsFrom(env: Env): { user: WriteLimitEnv; address: WriteLimitEnv; copies: number } {
  const production = env.MOVERA_ENV === "production";
  const part = (given: number | undefined, prodDefault: number, testDefault: number): WriteLimitEnv => {
    if (given !== undefined) return { fallback: given, floor: given, off: given === 0 };
    return production ? { fallback: prodDefault, floor: 0, off: false } : { fallback: testDefault, floor: testDefault, off: false };
  };
  return { user: part(env.RATE_LIMIT_WRITES_PER_USER_PER_MINUTE, 120, 1200), address: part(env.RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE, 60, 600), copies: env.WEB_COPIES ?? 1 };
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

/**
 * v0.18.56 §78 (inAppCalls.turnEnv, G9-2.4): start-up warnings that do not stop the server. Without TURN, in-app
 * calls work only on open networks (owner to-do: set MOVERA_TURN_URLS + MOVERA_TURN_SECRET on the hosting service).
 */
export function startupWarnings(env: Env): string[] {
  const out: string[] = [];
  if (env.MOVERA_ENV !== "development" && env.MOVERA_TURN_URLS === undefined) {
    out.push("MOVERA_TURN_URLS and MOVERA_TURN_SECRET are not set: in-app calls work only on open networks (no TURN relay).");
  }
  out.push(...smsStartupWarnings(env));
  return out;
}
