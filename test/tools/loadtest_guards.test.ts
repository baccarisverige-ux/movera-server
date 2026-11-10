import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminUrl } from "../support/globalSetup.js";
import { checkLimits, checkTarget, dropAllowed, HARD_MAX, redact, serverEnv } from "../../tools/loadtest/guards.mjs";

/**
 * Global plan step 59 (T1 part 1): the load tool refuses every dangerous run BEFORE it touches a database.
 * Unit tests cover guards.mjs; the "tool" tests start dispatch-load.mjs itself and read its refusal.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const TOOL = join(ROOT, "tools", "loadtest", "dispatch-load.mjs");
const SAFE_ARGS = ["--db", "movera_loadtest_guard", "--drivers", "5", "--riders", "10", "--seconds", "5", "--steps", "5"];

function runTool(args: string[], env: Record<string, string | undefined>) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: "utf8", timeout: 30_000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("load tool guard (a): target host + database name", () => {
  it("accepts a local host and a load-test database name", () => {
    expect(checkTarget("postgres://movera:movera@localhost/movera", "movera_loadtest_job1")).toEqual({ host: "localhost", dbName: "movera_loadtest_job1" });
    expect(checkTarget("postgres://movera:movera@127.0.0.1:5432/movera", "movera_load_test_a")).toMatchObject({ host: "127.0.0.1" });
    expect(checkTarget("postgres://movera:movera@db.movera.test/movera", "movera_loadtest_x")).toMatchObject({ host: "db.movera.test" });
    expect(checkTarget("postgres://movera:movera@localhost/movera?host=/var/tmp/movera-pg", "movera_loadtest_x").host).toBe("localhost");
  });
  it("refuses a staging / production host unless MOVERA_LOADTEST_ALLOW_HOST names it", () => {
    const prod = "postgres://movera:movera@db.prod.example.com:5432/movera";
    expect(() => checkTarget(prod, "movera_loadtest_x")).toThrow(/LOADTEST GUARD: refusing host "db.prod.example.com"/);
    expect(() => checkTarget("postgres://u:p@staging.internal/movera", "movera_loadtest_x", {})).toThrow(/refusing host/);
    expect(() => checkTarget(prod, "movera_loadtest_x", { MOVERA_LOADTEST_ALLOW_HOST: "other.example.com" })).toThrow(/refusing host/);
    expect(checkTarget(prod, "movera_loadtest_x", { MOVERA_LOADTEST_ALLOW_HOST: "db.prod.example.com" }).host).toBe("db.prod.example.com");
    expect(() => checkTarget("postgres://u:p@localhost/movera?host=db.prod.example.com", "movera_loadtest_x")).toThrow(/refusing \?host=/);
  });
  it("refuses a database name without test / loadtest in it, and a missing or non-postgres url", () => {
    expect(() => checkTarget("postgres://u:p@localhost/movera", "movera")).toThrow(/refusing database "movera"/);
    expect(() => checkTarget("postgres://u:p@localhost/movera", "movera_load_job1")).toThrow(/refusing database/);
    expect(() => checkTarget("postgres://u:p@localhost/movera", "movera_loadtest_Prod")).toThrow(/refusing database/);
    expect(() => checkTarget(undefined, "movera_loadtest_x")).toThrow(/set LOADTEST_ADMIN_URL/);
    expect(() => checkTarget("mysql://u:p@localhost/x", "movera_loadtest_x")).toThrow(/postgres:\/\//);
  });
  it("tool: exits 2 with the guard message before connecting to a production host", () => {
    const r = runTool(SAFE_ARGS, { LOADTEST_ADMIN_URL: "postgres://movera:hunter2@db.prod.example.com:5432/movera" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/LOADTEST GUARD: refusing host "db.prod.example.com"/);
    expect(r.out).not.toContain("hunter2");
  });
});

describe("load tool guard (b): drop only with --i-know-this-drops <dbname>", () => {
  it("is off without the flag, on when the flag names the run's database exactly", () => {
    expect(dropAllowed(["--db", "movera_loadtest_x"], "movera_loadtest_x")).toBe(false);
    expect(dropAllowed(["--i-know-this-drops", "movera_loadtest_x"], "movera_loadtest_x")).toBe(true);
  });
  it("refuses a flag that names another database or nothing", () => {
    expect(() => dropAllowed(["--i-know-this-drops", "movera_loadtest_y"], "movera_loadtest_x")).toThrow(/names "movera_loadtest_y" but the run uses "movera_loadtest_x"/);
    expect(() => dropAllowed(["--i-know-this-drops"], "movera_loadtest_x")).toThrow(/needs the database name/);
    expect(() => dropAllowed(["--i-know-this-drops", "--keep"], "movera_loadtest_x")).toThrow(/needs the database name/);
  });

  describe("tool: an existing database is never dropped without the flag", () => {
    const DB = "movera_loadtest_guard_keep";
    let admin: pg.Client;
    beforeAll(async () => {
      admin = new pg.Client({ connectionString: adminUrl() });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DB}`);
    });
    afterAll(async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    });
    it("refuses the run and leaves the database in place", async () => {
      const r = runTool(["--db", DB, "--drivers", "5", "--riders", "10", "--seconds", "5", "--steps", "5"], { LOADTEST_ADMIN_URL: adminUrl() });
      expect(r.code).toBe(2);
      expect(r.out).toMatch(new RegExp(`LOADTEST GUARD: database "${DB}" exists`));
      const left = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB]);
      expect(left.rowCount).toBe(1);
    });
    it("refuses when the flag names a different database", async () => {
      const r = runTool(["--db", DB, "--i-know-this-drops", "movera_loadtest_other", "--drivers", "5", "--riders", "10", "--seconds", "5", "--steps", "5"], { LOADTEST_ADMIN_URL: adminUrl() });
      expect(r.code).toBe(2);
      expect(r.out).toMatch(/refusing to drop anything/);
      expect((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB])).rowCount).toBe(1);
    });
  });
});

describe("load tool guard (c): no environment copy, no secrets in logs", () => {
  it("serverEnv passes only allow-listed inherited variables plus the tool's explicit ones", () => {
    const parent = { PATH: "/usr/bin", HOME: "/home/x", AWS_SECRET_ACCESS_KEY: "aws-secret-1", DATABASE_URL: "postgres://real:pw@prod/db", FIREBASE_SERVICE_ACCOUNT: "{json}", GITHUB_TOKEN: "ghp_x" };
    const env = serverEnv(parent, { DATABASE_URL: "postgres://movera:movera@localhost/movera_loadtest_x", JWT_SECRET: "load-test-secret", PORT: "18181" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", DATABASE_URL: "postgres://movera:movera@localhost/movera_loadtest_x", JWT_SECRET: "load-test-secret", PORT: "18181" });
    expect(JSON.stringify(env)).not.toMatch(/aws-secret-1|ghp_x|\{json\}|prod\/db/);
    expect(() => serverEnv(parent, { STRIPE_SECRET_KEY: "sk_x" })).toThrow(/refusing to pass STRIPE_SECRET_KEY/);
  });
  it("redact hides key / secret / password / token values and url passwords", () => {
    const text = 'JWT_SECRET=abc123 "apiKey": "k-999" password: hunter2 Authorization: Bearer eyJ.abc.def postgres://movera:pw-1@localhost/db TOKEN=t-7 plain=visible';
    const out = redact(text);
    for (const leaked of ["abc123", "k-999", "hunter2", "eyJ.abc.def", "pw-1", "t-7"]) expect(out).not.toContain(leaked);
    expect(out).toContain("plain=visible");
    expect(out).toContain("postgres://movera:[REDACTED]@localhost/db");
    expect(out).toContain("JWT_SECRET=[REDACTED]");
  });
  it("tool source: the started server never inherits the whole environment, and output goes through redact", () => {
    const src = readFileSync(TOOL, "utf8");
    expect(src).not.toMatch(/\.\.\.process\.env/);
    expect(src).toMatch(/serverEnv\(process\.env/);
    expect(src).toMatch(/redact\(serverErr\)/);
  });
});

describe("load tool guard (d): explicit, capped riders / drivers / duration", () => {
  const ok = { drivers: "300", riders: "4000", seconds: "90", steps: ["50", "100"], spikes: ["800"] };
  it("accepts explicit numbers within the hard max", () => {
    expect(checkLimits(ok)).toEqual({ drivers: 300, riders: 4000, seconds: 90, spikeSeconds: 45, steps: [50, 100], spikes: [800], totalSeconds: 2 * 90 + 45 + 90 });
  });
  it("requires --drivers, --riders and --seconds", () => {
    expect(() => checkLimits({ ...ok, drivers: undefined })).toThrow(/--drivers is required/);
    expect(() => checkLimits({ ...ok, riders: "" })).toThrow(/--riders is required/);
    expect(() => checkLimits({ ...ok, seconds: undefined })).toThrow(/--seconds is required/);
    expect(() => checkLimits({ ...ok, steps: [] })).toThrow(/--steps must list/);
    expect(() => checkLimits({ ...ok, riders: "lots" })).toThrow(/--riders must be a positive whole number/);
    expect(() => checkLimits({ ...ok, drivers: "0" })).toThrow(/--drivers must be a positive whole number/);
  });
  it("refuses numbers above the hard max unless --unsafe-max", () => {
    expect(() => checkLimits({ ...ok, riders: String(HARD_MAX.riders + 1) })).toThrow(/--riders 20001 is above the hard max 20000; pass --unsafe-max/);
    expect(() => checkLimits({ ...ok, drivers: String(HARD_MAX.drivers + 1) })).toThrow(/--drivers 2001 is above the hard max/);
    expect(() => checkLimits({ ...ok, seconds: String(HARD_MAX.seconds + 1) })).toThrow(/--seconds 601 is above the hard max/);
    expect(() => checkLimits({ ...ok, spikes: ["5000"] })).toThrow(/rate 5000 is above the hard max 2000/);
    expect(() => checkLimits({ ...ok, seconds: "600", steps: ["1", "2", "3", "4", "5", "6", "7"] })).toThrow(/total run time/);
    expect(checkLimits({ ...ok, riders: String(HARD_MAX.riders + 1), unsafeMax: true }).riders).toBe(HARD_MAX.riders + 1);
  });
  it("tool: refuses a run without explicit --riders before touching the database", () => {
    const r = runTool(["--db", "movera_loadtest_guard", "--drivers", "5", "--seconds", "5", "--steps", "5"], { LOADTEST_ADMIN_URL: "postgres://movera:movera@localhost/movera" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/LOADTEST GUARD: --riders is required/);
  });
});
