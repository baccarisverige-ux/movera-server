import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { signAccessToken } from "../../src/auth/jwt.js";
import { readEnv, writeLimitsFrom } from "../../src/env.js";

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

  it("defaults: safe in production, higher on staging, 0 turns a limit off", () => {
    expect(writeLimitsFrom(readEnv({ MOVERA_ENV: "development" }))).toEqual({ userPerMinute: 1200, addressPerMinute: 600 });
    const prod = readEnv({ MOVERA_ENV: "production", DATABASE_URL: "postgres://u:p@h/db", JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: "k".repeat(44) });
    expect(writeLimitsFrom(prod)).toEqual({ userPerMinute: 120, addressPerMinute: 60 });
    expect(writeLimitsFrom(readEnv({ MOVERA_ENV: "development", RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: "0" })).userPerMinute).toBe(0);
  });
});
