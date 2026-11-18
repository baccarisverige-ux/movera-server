import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { signAccessToken } from "../../src/auth/jwt.js";
import { ADMIN, createAdmin } from "../../src/admin/auth.js";
import { startSession } from "../../src/auth/service.js";
import { readEnv } from "../../src/env.js";
import { SIGN_IN_CEILING_FACTOR } from "../../src/http/rateLimit.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * S7 W2 (owner 2026-11-15). Q117 "Yes, per user": the write limit is keyed by the user even with an expired sign-in,
 * so drivers behind one mobile address get 401 (and refresh), not 429. Q118 "Yes, phone + address": sign-in and refresh
 * are keyed by phone + address / session + address; phone alone and address alone are only high ceilings.
 */

const SECRET = "q".repeat(40);
const at = new Date("2026-11-16T10:00:00Z");
const NAT = "198.51.100.77";
/** A driver's access token that ran out `agoSeconds` ago (900 s lifetime). */
const expired = (sub: string, agoSeconds = 60) => signAccessToken({ sub, actor: "driver", sid: `s-${sub}`, zones: ["Z001"] }, SECRET, 900, new Date(at.getTime() - (900 + agoSeconds) * 1000));
const live = (sub: string) => signAccessToken({ sub, actor: "driver", sid: `s-${sub}`, zones: ["Z001"] }, SECRET, 900, at);

describe("Q117: an expired, rightly signed token is keyed by its user", () => {
  const build = () =>
    buildApp({ env: readEnv({ MOVERA_ENV: "development", JWT_SECRET: SECRET, TRUST_PROXY_HOPS: "1", RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: "2", RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: "2" }), logger: false, clock: () => at });
  const write = (app: Awaited<ReturnType<typeof build>>, ip: string, bearer?: string) =>
    app.inject({ method: "POST", url: "/api/v1/trips", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, payload: "{}" });

  it("many drivers behind one address with expired tokens each get their own budget (not 429 for all)", async () => {
    const app = await build();
    for (let driver = 0; driver < 10; driver++) {
      for (let i = 0; i < 2; i++) expect((await write(app, NAT, expired(`D${driver}`))).statusCode, `driver ${driver} write ${i}`).not.toBe(429);
    }
    // One driver over his own budget is refused; the others and the address are not.
    expect((await write(app, NAT, expired("D0"))).statusCode).toBe(429);
    expect((await write(app, NAT)).statusCode).not.toBe(429);
    // A stolen expired token never uses up the user's live budget: the two keys are apart.
    for (let i = 0; i < 2; i++) expect((await write(app, NAT, live("D0"))).statusCode).not.toBe(429);
    await app.close();
  });

  it("a forged token, a changed user, or a token older than the refresh lifetime falls back to the address", async () => {
    const app = await build();
    const real = expired("D1");
    const [head, , signature] = real.split(".") as [string, string, string];
    const otherUser = (sub: string) => Buffer.from(JSON.stringify({ sub, actor: "driver", sid: "s", zones: ["Z001"], iat: 1, exp: 2, iss: "movera", typ: "access" })).toString("base64url");
    // Each of these names another user; none is signed for it, so all count against the one address (budget 2).
    const forged = [`${head}.${otherUser("V1")}.${signature}`, `${head}.${otherUser("V2")}.${signature}`, `${real.slice(0, -3)}abc`];
    const codes: number[] = [];
    for (const token of forged) codes.push((await write(app, "203.0.113.20", token)).statusCode);
    expect(codes.slice(0, 2)).not.toContain(429);
    expect(codes[2]).toBe(429);
    // The victims' own keys were never touched.
    for (const victim of ["V1", "V2"]) expect((await write(app, NAT, expired(victim))).statusCode).not.toBe(429);
    // Older than the refresh lifetime (30 days): no session can be alive, so it is an address again.
    const old = expired("D2", 31 * 86_400);
    for (let i = 0; i < 2; i++) expect((await write(app, "203.0.113.21", old)).statusCode).not.toBe(429);
    expect((await write(app, "203.0.113.21", expired("D3", 31 * 86_400))).statusCode).toBe(429);
    await app.close();
  });
});

describe("Q117: an expired token never gets the safety-write pass (supervisor MF-1 b, mutant M2b)", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await freshDatabase();
  });
  afterAll(async () => {
    await database.drop();
  });

  it("an SOS with an expired rider token is counted on its user budget (429 when full), not passed like a valid one", async () => {
    // The safety routes only exist with a database. User budget 2.
    const app = await buildApp({
      env: readEnv({ MOVERA_ENV: "development", DATABASE_URL: database.url, JWT_SECRET: SECRET, TRUST_PROXY_HOPS: "1", RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: "2", RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: "2" }),
      logger: false,
      db: database.db,
      clock: () => at,
    });
    const token = signAccessToken({ sub: "R-q117-sos", actor: "rider", sid: "s-R-q117-sos", zones: ["Z001"] }, SECRET, 900, new Date(at.getTime() - 960_000));
    const sos = () => app.inject({ method: "POST", url: "/api/v1/rider/trips/T-none/sos", headers: { "content-type": "application/json", "x-forwarded-for": NAT, authorization: `Bearer ${token}` }, payload: {} });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await sos()).statusCode);
    // Within the budget: the route's own 401 (the app refreshes). Over it: 429, as for any other write.
    expect(codes).toEqual([401, 401, 429]);
    await app.close();
  });
});

describe("Q118: sign-in and refresh keyed by phone + address / session + address", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await freshDatabase();
  });
  afterAll(async () => {
    await database.drop();
  });

  // Production counts sign-in calls (staging and development leave them out for the load test).
  const build = () =>
    buildApp({
      env: readEnv({ MOVERA_ENV: "production", DATABASE_URL: "postgres://u:p@h/db", JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64"), MIGRATE_ON_START: "false", TRUST_PROXY_HOPS: "1", RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: "2" }),
      logger: false,
      db: database.db,
      clock: () => at,
    });
  type App = Awaited<ReturnType<typeof build>>;
  const send = (app: App, path: string, ip: string, payload: unknown) => app.inject({ method: "POST", url: `/api/v1${path}`, headers: { "content-type": "application/json", "x-forwarded-for": ip }, payload: payload as object });
  const phone = (n: number) => `+4670${String(1_000_000 + n)}`;

  it("many phones from one address are not blocked together below the ceiling", async () => {
    const app = await build();
    for (let n = 0; n < 5; n++) {
      expect((await send(app, "/auth/otp/request", NAT, { phone: phone(n), app: "driver" })).statusCode, `phone ${n} request`).not.toBe(429);
      expect((await send(app, "/auth/otp/verify", NAT, { phone: phone(n), sessionId: "none", code: "0000" })).statusCode, `phone ${n} verify`).not.toBe(429);
    }
    // One phone over its budget from this address: refused; the next phone on the same address is not.
    const over = await send(app, "/auth/otp/request", NAT, { phone: phone(0), app: "driver" });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: "rate_limited", reason: "too_many_requests" });
    expect((await send(app, "/auth/otp/request", NAT, { phone: phone(5), app: "driver" })).statusCode).not.toBe(429);
    await app.close();
  });

  it("the address alone is only a high ceiling, and a body without a phone counts against the address", async () => {
    const app = await build();
    const ceiling = 2 * SIGN_IN_CEILING_FACTOR;
    const codes: number[] = [];
    for (let n = 0; n <= ceiling; n++) codes.push((await send(app, "/auth/otp/request", "203.0.113.30", { phone: phone(100 + n), app: "driver" })).statusCode);
    expect(codes.slice(0, ceiling)).not.toContain(429);
    expect(codes[ceiling]).toBe(429);
    const none: number[] = [];
    for (let i = 0; i < 3; i++) none.push((await send(app, "/auth/otp/request", "203.0.113.31", { app: "driver" })).statusCode);
    expect(none.slice(0, 2)).not.toContain(429);
    expect(none[2]).toBe(429);
    await app.close();
  });

  it("one phone from many addresses hits the phone ceiling", async () => {
    const app = await build();
    const ceiling = 2 * SIGN_IN_CEILING_FACTOR;
    const codes: number[] = [];
    for (let n = 0; n <= ceiling; n++) codes.push((await send(app, "/auth/otp/verify", `203.0.114.${n}`, { phone: phone(999), sessionId: "none", code: "0000" })).statusCode);
    expect(codes.slice(0, ceiling)).not.toContain(429);
    expect(codes[ceiling]).toBe(429);
    await app.close();
  });

  it("refresh is keyed by the token's session + address; an unknown token by the address", async () => {
    const app = await build();
    const sessions = await database.db.transaction().execute(async (trx) => {
      const out: string[] = [];
      for (let n = 0; n < 5; n++) out.push((await startSession(trx, { jwtSecret: SECRET }, { actor: "rider", subjectId: `R-q118-${n}`, zones: [] }, {}, at)).refreshToken);
      return out;
    });
    // 5 riders behind one address, each refreshing twice in one minute (the token rotates): none is refused.
    for (let n = 0; n < 5; n++) {
      for (let i = 0; i < 2; i++) {
        const res = await send(app, "/auth/refresh", NAT, { refreshToken: sessions[n] });
        expect(res.statusCode, `rider ${n} refresh ${i}`).toBe(200);
        sessions[n] = res.json().refreshToken;
      }
    }
    // The same session a third time in the minute: refused, though its token is a new one. Another address: its own budget.
    expect((await send(app, "/auth/refresh", NAT, { refreshToken: sessions[0] })).statusCode).toBe(429);
    expect((await send(app, "/auth/refresh", "203.0.113.40", { refreshToken: sessions[0] })).statusCode).toBe(200);
    // Guessing tokens: every unknown token counts against the address.
    const guesses: number[] = [];
    for (let i = 0; i < 3; i++) guesses.push((await send(app, "/auth/refresh", "203.0.113.41", { refreshToken: `rt_guess${i}` })).statusCode);
    expect(guesses).toEqual([401, 401, 429]);
    await app.close();
  });

  it("one address over its budget for one number never fills that number's ceiling (supervisor MF-1 c, mutant M6)", async () => {
    const app = await build();
    const ceiling = 2 * SIGN_IN_CEILING_FACTOR;
    // One address sends as many calls for one number as its own address ceiling lets through: only the first 2 pass.
    const codes: number[] = [];
    for (let i = 0; i < ceiling; i++) codes.push((await send(app, "/auth/otp/verify", "203.0.113.50", { phone: phone(500), sessionId: "none", code: "0000" })).statusCode);
    expect(codes.slice(0, 2)).not.toContain(429);
    expect(codes.slice(2).every((code) => code === 429)).toBe(true);
    // The refused calls added nothing to the number's ceiling: the real owner on another address still gets through.
    const owner = await send(app, "/auth/otp/verify", "203.0.113.51", { phone: phone(500), sessionId: "none", code: "0000" });
    expect(owner.statusCode, owner.body).not.toBe(429);
    await app.close();
  });

  it("/admin/auth/refresh is keyed by the token's session + address too (supervisor SF-4)", async () => {
    const app = await build();
    const tokens = await database.db.transaction().execute(async (trx) => {
      const out: string[] = [];
      for (let n = 0; n < 3; n++) {
        const { adminId } = await createAdmin(trx, { email: `q118-refresh-${n}@movera.test`, name: `q118 ${n}`, role: "super" }, at);
        out.push((await startSession(trx, { jwtSecret: SECRET }, { actor: "admin", subjectId: adminId, zones: [] }, {}, at, ADMIN.refreshTtlMs)).refreshToken);
      }
      return out;
    });
    // 3 admins behind one office address, each refreshing twice in one minute: none is refused (address budget 2).
    for (let n = 0; n < 3; n++) {
      for (let i = 0; i < 2; i++) {
        const res = await send(app, "/admin/auth/refresh", NAT, { refreshToken: tokens[n] });
        expect(res.statusCode, `admin ${n} refresh ${i}: ${res.body}`).toBe(200);
        tokens[n] = res.json().refreshToken;
      }
    }
    // The same session a third time: refused on this address; from another address it has its own budget.
    expect((await send(app, "/admin/auth/refresh", NAT, { refreshToken: tokens[0] })).statusCode).toBe(429);
    expect((await send(app, "/admin/auth/refresh", "203.0.113.60", { refreshToken: tokens[0] })).statusCode).toBe(200);
    await app.close();
  });
});
