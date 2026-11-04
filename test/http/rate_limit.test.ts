import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { signAccessToken } from "../../src/auth/jwt.js";
import { readEnv, writeLimitsFrom } from "../../src/env.js";
import { limitOf } from "../../src/http/rateLimit.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/** B11 (contract.json#rateLimit): a general write limit per signed-in user, else per address. */

const SECRET = "x".repeat(40);
const at = new Date("2026-11-04T10:00:00Z");
const token = (sub: string) => signAccessToken({ sub, actor: "rider", sid: `s-${sub}`, zones: ["Z001"] }, SECRET, 900, at);

async function appWith(extra: Record<string, string>) {
  let now = at.getTime();
  const app = await buildApp({
    env: readEnv({ MOVERA_ENV: "development", JWT_SECRET: SECRET, TRUST_PROXY_HOPS: "1", ...extra }),
    logger: false,
    clock: () => new Date(now),
  });
  return { app, advance: (ms: number) => (now += ms) };
}

const post = (app: Awaited<ReturnType<typeof appWith>>["app"], headers: Record<string, string>) =>
  app.inject({ method: "POST", url: "/api/v1/trips", headers: { "content-type": "application/json", ...headers }, payload: "{}" });

describe("general write limit", () => {
  it("answers 429 rate_limited too_many_requests with Retry-After over the address budget", async () => {
    const { app, advance } = await appWith({ RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: "3" });
    for (let i = 0; i < 3; i++) expect((await post(app, { "x-forwarded-for": "203.0.113.5" })).statusCode).not.toBe(429);
    const over = await post(app, { "x-forwarded-for": "203.0.113.5" });
    expect(over.statusCode).toBe(429);
    expect(over.headers["retry-after"]).toBe("60");
    expect(over.json()).toMatchObject({ code: "rate_limited", reason: "too_many_requests", retryable: true });
    // Another address behind the same proxy has its own budget.
    expect((await post(app, { "x-forwarded-for": "203.0.113.6" })).statusCode).not.toBe(429);
    // Reads are never limited.
    expect((await app.inject({ method: "GET", url: "/api/v1/trips", headers: { "x-forwarded-for": "203.0.113.5" } })).statusCode).not.toBe(429);
    advance(60_000);
    expect((await post(app, { "x-forwarded-for": "203.0.113.5" })).statusCode).not.toBe(429);
    await app.close();
  });

  it("keys signed-in callers by user, so many accounts on one address do not share a budget (load test)", async () => {
    const { app } = await appWith({ RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: "2", RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: "2" });
    for (let user = 0; user < 10; user++) {
      for (let i = 0; i < 2; i++) expect((await post(app, { "x-forwarded-for": "198.51.100.1", authorization: `Bearer ${token(`R${user}`)}` })).statusCode).not.toBe(429);
    }
    const over = await post(app, { "x-forwarded-for": "198.51.100.1", authorization: `Bearer ${token("R0")}` });
    expect(over.statusCode).toBe(429);
    // A forged token counts against the address, not a user.
    const forged = `${token("R0").slice(0, -3)}abc`;
    expect((await post(app, { "x-forwarded-for": "198.51.100.9", authorization: `Bearer ${forged}` })).statusCode).not.toBe(429);
    expect((await post(app, { "x-forwarded-for": "198.51.100.9", authorization: `Bearer ${forged}` })).statusCode).not.toBe(429);
    expect((await post(app, { "x-forwarded-for": "198.51.100.9" })).statusCode).toBe(429);
    await app.close();
  });

  it("defaults: safe in production, higher on staging, 0 turns a limit off; env is fallback and floor", () => {
    expect(writeLimitsFrom(readEnv({ MOVERA_ENV: "development" }))).toEqual({ user: { fallback: 1200, floor: 1200, off: false }, address: { fallback: 600, floor: 600, off: false } });
    const prod = readEnv({ MOVERA_ENV: "production", DATABASE_URL: "postgres://u:p@h/db", JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: "k".repeat(44) });
    expect(writeLimitsFrom(prod)).toEqual({ user: { fallback: 120, floor: 0, off: false }, address: { fallback: 60, floor: 0, off: false } });
    expect(writeLimitsFrom(readEnv({ MOVERA_ENV: "development", RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: "0" })).user.off).toBe(true);
    const prodEnv = writeLimitsFrom(prod).user;
    expect(limitOf(prodEnv, undefined)).toBe(120);
    expect(limitOf(prodEnv, 40)).toBe(40);
    expect(limitOf({ fallback: 1200, floor: 1200, off: false }, 40)).toBe(1200);
    expect(limitOf({ fallback: 0, floor: 0, off: true }, 500)).toBe(0);
  });
});

describe("general write limit: sign-in on staging (load test)", () => {
  it("staging does not count OTP request/verify per address; production does", async () => {
    const { app } = await appWith({ MOVERA_ENV: "staging", DATABASE_URL: "postgres://u:p@h/db", RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: "2" });
    for (let i = 0; i < 5; i++) {
      for (const path of ["/api/v1/auth/otp/request", "/api/v1/auth/otp/verify"]) {
        const res = await app.inject({ method: "POST", url: path, headers: { "x-forwarded-for": "203.0.113.50", "content-type": "application/json" }, payload: "{}" });
        expect(res.statusCode).not.toBe(429);
      }
    }
    // Other anonymous writes still count.
    for (let i = 0; i < 2; i++) await post(app, { "x-forwarded-for": "203.0.113.50" });
    expect((await post(app, { "x-forwarded-for": "203.0.113.50" })).statusCode).toBe(429);
    await app.close();
    const prod = await buildApp({ env: readEnv({ MOVERA_ENV: "production", DATABASE_URL: "postgres://u:p@h/db", JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64"), TRUST_PROXY_HOPS: "1", RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: "2" }), logger: false });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await prod.inject({ method: "POST", url: "/api/v1/auth/otp/request", headers: { "x-forwarded-for": "203.0.113.50", "content-type": "application/json" }, payload: "{}" })).statusCode);
    expect(codes[2]).toBe(429);
    await prod.close();
  });
});

describe("general write limit: admin setting per country (owner 2026-11-04)", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await freshDatabase();
    const rules = (country: string, limits: Record<string, number>) => ({ doc: "country_rules" as const, zone_id: `standard-${country}`, version: 99, document: JSON.stringify({ country, limits }), published_at: at, published_by: null });
    await database.db.insertInto("config_live").values([rules("SE", { writesPerUserPerMinute: 30 }), rules("FR", {})]).onConflict((oc) => oc.columns(["doc", "zone_id"]).doUpdateSet((eb) => ({ document: eb.ref("excluded.document") }))).execute();
  });
  afterAll(async () => {
    await database.drop();
  });

  it("uses the user's country setting from memory (no read per request), env as floor in production", async () => {
    const env = readEnv({ MOVERA_ENV: "production", DATABASE_URL: "postgres://u:p@h/db", JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64"), MIGRATE_ON_START: "false" });
    const app = await buildApp({ env, logger: false, db: database.db, clock: () => at });
    await app.ready();
    const se = signAccessToken({ sub: "RSE", actor: "rider", sid: "s1", zones: ["Z001"] }, SECRET, 900, at);
    const fr = signAccessToken({ sub: "RFR", actor: "rider", sid: "s2", zones: ["FR-PC"] }, SECRET, 900, at);
    const hit = (t: string) => app.inject({ method: "POST", url: "/api/v1/limit-probe", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, payload: "{}" });
    for (let i = 0; i < 30; i++) expect((await hit(se)).statusCode).not.toBe(429);
    const over = await hit(se);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: "rate_limited", reason: "too_many_requests" });
    // FR has no write limit set: the production fallback 120 applies.
    for (let i = 0; i < 31; i++) expect((await hit(fr)).statusCode).not.toBe(429);
    await app.close();
  });
});
