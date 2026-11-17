import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { signAccessToken } from "../../src/auth/jwt.js";
import { startSession } from "../../src/auth/service.js";
import { readEnv } from "../../src/env.js";
import { SIGN_IN_CEILING_FACTOR } from "../../src/http/rateLimit.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * S7 W2 Q117 / Q118 follow-up (supervisor audits/impact/s7-q117-q118-supervisor.md SF-1, SF-2; Rules
 * audits/impact/s7-q117-followup.md). SF-1: on the four sign-in / refresh calls a bearer token (valid or rightly signed
 * but expired) never skips the phone + address / session + address key or the two memory ceilings. SF-2: a body that
 * fails to parse on these calls counts against the address budget at 1 x (429 when full), as before Q118, not only on
 * the 10 x address ceiling.
 */

const SECRET = "f".repeat(40);
const at = new Date("2026-11-16T10:00:00Z");
const NAT = "198.51.100.88";
const BUDGET = 2;
const CEILING = BUDGET * SIGN_IN_CEILING_FACTOR;
const live = (sub: string) => signAccessToken({ sub, actor: "rider", sid: `s-${sub}`, zones: ["Z001"] }, SECRET, 900, at);
const expired = (sub: string) => signAccessToken({ sub, actor: "rider", sid: `s-${sub}`, zones: ["Z001"] }, SECRET, 900, new Date(at.getTime() - 960_000));
const phone = (n: number) => `+4671${String(1_000_000 + n)}`;

describe("Q117 follow-up (SF-1, SF-2): sign-in and refresh keys", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await freshDatabase();
  });
  afterAll(async () => {
    await database.drop();
  });

  // Production counts sign-in calls. The user budget is far above the address budget, so a token keyed by its user
  // would never reach 429 in these tests.
  const build = () =>
    buildApp({
      env: readEnv({
        MOVERA_ENV: "production",
        DATABASE_URL: "postgres://u:p@h/db",
        JWT_SECRET: SECRET,
        DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64"),
        MIGRATE_ON_START: "false",
        TRUST_PROXY_HOPS: "1",
        RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: String(BUDGET),
        RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: "1000",
      }),
      logger: false,
      db: database.db,
      clock: () => at,
    });
  type App = Awaited<ReturnType<typeof build>>;
  const send = (app: App, path: string, ip: string, payload: unknown, bearer?: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1${path}`,
      headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      payload: typeof payload === "string" ? payload : (payload as object),
    });

  describe("SF-1: a bearer token does not skip the body key or the ceilings", () => {
    it("a valid token: one phone from one address is keyed by phone + address at the address budget", async () => {
      const app = await build();
      const codes: number[] = [];
      // Each call sends a different user's valid token: keyed by user, none would ever be refused.
      for (let i = 0; i <= BUDGET; i++) codes.push((await send(app, "/auth/otp/request", NAT, { phone: phone(1), app: "rider" }, live(`R-sf1-${i}`))).statusCode);
      expect(codes.slice(0, BUDGET)).not.toContain(429);
      expect(codes[BUDGET]).toBe(429);
      await app.close();
    });

    it("an expired token: verify is keyed by phone + address too", async () => {
      const app = await build();
      const codes: number[] = [];
      for (let i = 0; i <= BUDGET; i++) codes.push((await send(app, "/auth/otp/verify", NAT, { phone: phone(2), sessionId: "none", code: "0000" }, expired(`R-sf1x-${i}`))).statusCode);
      expect(codes.slice(0, BUDGET)).not.toContain(429);
      const over = await send(app, "/auth/otp/verify", NAT, { phone: phone(2), sessionId: "none", code: "0000" }, expired("R-sf1x-last"));
      expect(over.statusCode).toBe(429);
      expect(over.json()).toMatchObject({ code: "rate_limited", reason: "too_many_requests" });
      await app.close();
    });

    it("one token from many addresses still hits the phone ceiling", async () => {
      const app = await build();
      const token = live("R-sf1-ceiling");
      const codes: number[] = [];
      for (let n = 0; n <= CEILING; n++) codes.push((await send(app, "/auth/otp/verify", `203.0.115.${n}`, { phone: phone(3), sessionId: "none", code: "0000" }, token)).statusCode);
      expect(codes.slice(0, CEILING)).not.toContain(429);
      expect(codes[CEILING]).toBe(429);
      await app.close();
    });

    it("one address with a token still hits the address ceiling", async () => {
      const app = await build();
      const token = expired("R-sf1-addr");
      const codes: number[] = [];
      for (let n = 0; n <= CEILING; n++) codes.push((await send(app, "/auth/otp/request", "203.0.113.70", { phone: phone(200 + n), app: "rider" }, token)).statusCode);
      expect(codes.slice(0, CEILING)).not.toContain(429);
      expect(codes[CEILING]).toBe(429);
      await app.close();
    });

    it("refresh with a token is keyed by the refresh token's session + address", async () => {
      const app = await build();
      let refreshToken = await database.db.transaction().execute(async (trx) => (await startSession(trx, { jwtSecret: SECRET }, { actor: "rider", subjectId: "R-sf1-refresh", zones: [] }, {}, at)).refreshToken);
      for (let i = 0; i < BUDGET; i++) {
        const res = await send(app, "/auth/refresh", NAT, { refreshToken }, live(`R-sf1-r${i}`));
        expect(res.statusCode, res.body).toBe(200);
        refreshToken = res.json().refreshToken;
      }
      expect((await send(app, "/auth/refresh", NAT, { refreshToken }, expired("R-sf1-rx"))).statusCode).toBe(429);
      await app.close();
    });
  });

  describe("SF-2: a body that fails to parse counts against the address at 1 x", () => {
    it("bad JSON on the code call: 400 within the address budget, then 429, and it shares the address key", async () => {
      const app = await build();
      const codes: number[] = [];
      for (let i = 0; i < BUDGET; i++) codes.push((await send(app, "/auth/otp/request", "203.0.113.80", "{not json")).statusCode);
      expect(codes.slice(0, BUDGET)).toEqual(Array(BUDGET).fill(400));
      const over = await send(app, "/auth/otp/request", "203.0.113.80", "{not json");
      expect(over.statusCode).toBe(429);
      expect(over.json()).toMatchObject({ code: "rate_limited", reason: "too_many_requests" });
      expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
      // The same address key as a body without a phone.
      expect((await send(app, "/auth/otp/request", "203.0.113.80", { app: "rider" })).statusCode).toBe(429);
      // A phone on that address keeps its own phone + address budget (the address ceiling is not full).
      expect((await send(app, "/auth/otp/request", "203.0.113.80", { phone: phone(300), app: "rider" })).statusCode).not.toBe(429);
      await app.close();
    });

    it("a body over 1 MB on refresh counts too (400 body_too_large, then 429)", async () => {
      const app = await build();
      const big = JSON.stringify({ refreshToken: "x".repeat(1024 * 1024 + 10) });
      const codes: number[] = [];
      const reasons: string[] = [];
      for (let i = 0; i <= BUDGET; i++) {
        const res = await send(app, "/admin/auth/refresh", "203.0.113.81", big);
        codes.push(res.statusCode);
        reasons.push(res.json().reason);
      }
      expect(codes).toEqual([400, 400, 429]);
      expect(reasons).toEqual(["body_too_large", "body_too_large", "too_many_requests"]);
      await app.close();
    });

    it("a call refused on its phone + address key is not counted again on the address", async () => {
      const app = await build();
      const codes: number[] = [];
      for (let i = 0; i < BUDGET + 2; i++) codes.push((await send(app, "/auth/otp/verify", "203.0.113.82", { phone: phone(400), sessionId: "none", code: "0000" })).statusCode);
      expect(codes.slice(BUDGET)).toEqual([429, 429]);
      // The address key was never used: a body without a phone still has its whole budget.
      for (let i = 0; i < BUDGET; i++) expect((await send(app, "/auth/otp/verify", "203.0.113.82", { sessionId: "none", code: "0000" })).statusCode).not.toBe(429);
      await app.close();
    });
  });
});
