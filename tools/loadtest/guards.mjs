/* global URL */
// Guards for the load tool (global plan step 59, T1 part 1). Pure functions: no I/O, no process access, so they are
// unit-tested in test/tools/loadtest_guards.test.ts. dispatch-load.mjs runs them BEFORE it touches any database.
//
//   target   – only a local / test Postgres host and a test database name (never staging or production)
//   drop     – a database is dropped only when --i-know-this-drops <dbname> names it exactly
//   secrets  – the started server gets an allow-list of variables, never a copy of the whole environment; logs are redacted
//   limits   – riders, drivers and durations are explicit and capped (hard max, unless --unsafe-max)

/** Thrown for every refused run; dispatch-load.mjs prints the message and exits 2 without touching anything. */
export class LoadtestGuardError extends Error {
  constructor(message) {
    super(`LOADTEST GUARD: ${message}`);
    this.name = "LoadtestGuardError";
  }
}

export const HARD_MAX = Object.freeze({ drivers: 2_000, riders: 20_000, seconds: 600, spikeSeconds: 300, rps: 2_000, totalSeconds: 3_600 });

/** Hosts a run may target without MOVERA_LOADTEST_ALLOW_HOST: the local machine and *.test names (RFC 6761). */
export function isLocalHost(hostname) {
  const h = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "" || h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".test");
}

/**
 * Guard (a): the admin url must point at an allowed host and the database name must be a load-test name.
 * Allowed host: local (isLocalHost) or exactly env.MOVERA_LOADTEST_ALLOW_HOST. A `?host=` query (pg socket directory)
 * must be an absolute path on this machine. Allowed name: movera_load_… or movera_loadtest_… containing "test".
 */
export function checkTarget(adminUrl, dbName, env = {}) {
  if (!adminUrl) throw new LoadtestGuardError("set LOADTEST_ADMIN_URL (a LOCAL postgres admin url)");
  let url;
  try {
    url = new URL(adminUrl);
  } catch {
    throw new LoadtestGuardError("LOADTEST_ADMIN_URL is not a valid url");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new LoadtestGuardError(`LOADTEST_ADMIN_URL must be a postgres:// url, got ${url.protocol}`);
  const allow = String(env.MOVERA_LOADTEST_ALLOW_HOST ?? "").trim().toLowerCase();
  const host = url.hostname.toLowerCase();
  if (/(^|\.)render\.com$|(^|\.)onrender\.com$/.test(host)) {
    throw new LoadtestGuardError(`refusing host "${host}": a Render database is never a load-test target, not even with MOVERA_LOADTEST_ALLOW_HOST`);
  }
  if (!isLocalHost(host) && !(allow && host === allow)) {
    throw new LoadtestGuardError(`refusing host "${host}": only localhost / 127.0.0.1 / *.test are allowed (or set MOVERA_LOADTEST_ALLOW_HOST=${host} on purpose)`);
  }
  const socketHost = url.searchParams.get("host");
  if (socketHost !== null && !socketHost.startsWith("/")) {
    throw new LoadtestGuardError(`refusing ?host=${socketHost}: only a local socket directory (absolute path) is allowed`);
  }
  if (!/^movera_load(test)?_[a-z0-9_]+$/.test(dbName) || !/test/.test(dbName)) {
    throw new LoadtestGuardError(`refusing database "${dbName}": --db must look like movera_loadtest_<name> (a private test copy)`);
  }
  return { host, dbName };
}

/**
 * Guard (b): dropping / resetting a database needs `--i-know-this-drops <dbname>` naming the run's database exactly.
 * Returns true when the flag names it, false when the flag is absent; a flag naming another database is an error.
 */
export function dropAllowed(argv, dbName) {
  const i = argv.indexOf("--i-know-this-drops");
  if (i < 0) return false;
  const named = argv[i + 1];
  if (!named || named.startsWith("--")) throw new LoadtestGuardError("--i-know-this-drops needs the database name after it");
  if (named !== dbName) throw new LoadtestGuardError(`--i-know-this-drops names "${named}" but the run uses "${dbName}": refusing to drop anything`);
  return true;
}

/** Variables the started server may inherit. Everything else (cloud keys, tokens, real DATABASE_URL …) stays here. */
export const SERVER_ENV_ALLOW = Object.freeze(["PATH", "HOME", "TMPDIR", "TZ", "LANG", "LC_ALL", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"]);

/** Guard (c): the environment for the spawned server: allow-listed inherited variables + the tool's own explicit values. */
export function serverEnv(parentEnv, explicit) {
  const out = {};
  for (const k of SERVER_ENV_ALLOW) if (parentEnv[k] !== undefined) out[k] = parentEnv[k];
  for (const [k, v] of Object.entries(explicit)) {
    if (/key|secret|password|passwd|token/i.test(k) && k !== "JWT_SECRET") throw new LoadtestGuardError(`refusing to pass ${k} to the load server`);
    out[k] = v;
  }
  return out;
}

/** Guard (c): redact values that look like credentials in anything the tool prints (logs, server stderr, errors). */
export function redact(text) {
  return String(text ?? "")
    // postgres://user:password@host → postgres://user:[REDACTED]@host
    .replace(/(\w+:\/\/[^\s:@/]+):[^\s@/]+@/g, "$1:[REDACTED]@")
    // KEY=value, "secret": "value", token: value, password=value …
    .replace(/((?:[\w.-]*)(?:key|secret|password|passwd|token)[\w.-]*["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi, "$1[REDACTED]")
    // Authorization: Bearer <jwt>
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]");
}

/**
 * Guard (d): riders, drivers and seconds must be given as explicit numbers; every number must be a positive integer
 * within HARD_MAX unless `unsafeMax` is true. Returns the checked numbers.
 */
export function checkLimits({ drivers, riders, seconds, spikeSeconds, steps, spikes, unsafeMax = false }) {
  const num = (name, raw, required) => {
    if (raw === undefined || raw === "") {
      if (required) throw new LoadtestGuardError(`--${name} is required (give an explicit number; hard max ${HARD_MAX[name] ?? "-"} without --unsafe-max)`);
      return undefined;
    }
    const n = /^\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN;
    if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) throw new LoadtestGuardError(`--${name} must be a positive whole number, got "${raw}"`);
    return n;
  };
  const cap = (name, value, max) => {
    if (value !== undefined && value > max && !unsafeMax) throw new LoadtestGuardError(`--${name} ${value} is above the hard max ${max}; pass --unsafe-max if you really mean it`);
  };
  const out = {
    drivers: num("drivers", drivers, true),
    riders: num("riders", riders, true),
    seconds: num("seconds", seconds, true),
    spikeSeconds: num("spike-seconds", spikeSeconds, false) ?? 45,
    steps: (steps ?? []).map((s) => num("steps", s, true)),
    spikes: (spikes ?? []).map((s) => num("spikes", s, true)),
  };
  if (out.steps.length === 0) throw new LoadtestGuardError("--steps must list at least one rate (req/s)");
  cap("drivers", out.drivers, HARD_MAX.drivers);
  cap("riders", out.riders, HARD_MAX.riders);
  cap("seconds", out.seconds, HARD_MAX.seconds);
  cap("spike-seconds", out.spikeSeconds, HARD_MAX.spikeSeconds);
  for (const r of [...out.steps, ...out.spikes]) cap("steps/spikes rate", r, HARD_MAX.rps);
  const total = out.steps.length * out.seconds + out.spikes.length * (out.spikeSeconds + out.seconds);
  cap("total run time (s)", total, HARD_MAX.totalSeconds);
  return { ...out, totalSeconds: total };
}

/** Hard max for the phone tool's open arrival rate (new riders per minute) and its first access-token life. */
export const PHONE_MAX = Object.freeze({ riderArrivalsPerMinute: 2_000, accessTtlSeconds: 900 });

/**
 * Guard (d) for phone-load.mjs (step 60): drivers, riders (the account pool) and seconds as checkLimits (explicit,
 * capped); the Poisson rate --rider-arrivals (per minute) must be a positive number within PHONE_MAX unless unsafeMax;
 * --access-ttl (seconds of the first access token, so the run goes through POST /auth/refresh) 10…900.
 */
export function checkPhoneLimits({ drivers, riders, seconds, riderArrivals, accessTtl, unsafeMax = false }) {
  const base = checkLimits({ drivers, riders, seconds, steps: [1], unsafeMax });
  const rate = Number(String(riderArrivals ?? "").trim());
  if (riderArrivals === undefined || riderArrivals === "" || !Number.isFinite(rate) || rate <= 0) throw new LoadtestGuardError(`--rider-arrivals must be a positive number of new riders per minute, got "${riderArrivals ?? ""}"`);
  if (rate > PHONE_MAX.riderArrivalsPerMinute && !unsafeMax) throw new LoadtestGuardError(`--rider-arrivals ${rate} is above the hard max ${PHONE_MAX.riderArrivalsPerMinute}; pass --unsafe-max if you really mean it`);
  const ttl = accessTtl === undefined || accessTtl === "" ? 900 : Number(accessTtl);
  if (!Number.isInteger(ttl) || ttl < 10 || ttl > PHONE_MAX.accessTtlSeconds) throw new LoadtestGuardError(`--access-ttl must be a whole number of seconds 10…${PHONE_MAX.accessTtlSeconds}, got "${accessTtl}"`);
  return { drivers: base.drivers, riders: base.riders, seconds: base.seconds, riderArrivalsPerMinute: rate, accessTtlSeconds: ttl };
}
