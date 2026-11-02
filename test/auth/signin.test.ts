import { TEST_CODE } from "../../src/auth/service.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { REFRESH_RETRY_WINDOW_MS } from "../../src/auth/service.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

let database: TestDatabase;
let app: FastifyInstance;
let production: FastifyInstance;
const clock = { now: new Date("2026-10-24T10:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
const SECRET = "test-secret-".padEnd(48, "x");

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, clock: () => clock.now });
  production = await buildApp({ env: readEnv({ MOVERA_ENV: "production", DATABASE_URL: database.url, JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64") }), logger: false, db: database.db, clock: () => clock.now });
});
afterAll(async () => {
  await app.close();
  await production.close();
  await database.drop();
});
beforeEach(() => {
  advance(3600); // a fresh hour: no rate limit carries over between tests
});

const [RIDER_PHONE, DRIVER_PHONE, OTHER_TEST_PHONE] = TEST_PHONES as [string, string, string];
let keyCounter = 0;
const key = () => `test-key-${String(++keyCounter).padStart(8, "0")}`;

function post(url: string, payload?: unknown, headers: Record<string, string> = {}, server: FastifyInstance = app) {
  return server.inject({ method: "POST", url: `/api/v1${url}`, headers: { "content-type": "application/json", ...headers }, ...(payload === undefined ? { body: "" } : { payload: payload as object }) });
}

async function signIn(phone: string, appName: "rider" | "driver" = "rider") {
  const challenge = await post("/auth/otp/request", { phone, app: appName });
  expect(challenge.statusCode).toBe(200);
  const verify = await post("/auth/otp/verify", { phone, sessionId: challenge.json().sessionId, code: TEST_CODE });
  expect(verify.statusCode).toBe(200);
  return verify.json() as { accessToken: string; refreshToken: string; expiresIn: number; actor: string; isNewRider?: boolean; isNewDriver?: boolean };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("requesting a code", () => {
  it("a test number gets a challenge in the contract's shape", async () => {
    const res = await post("/auth/otp/request", { phone: RIDER_PHONE, app: "rider", locale: "sv" }, { "x-request-id": "req-otp-1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ requestId: "req-otp-1", sessionId: expect.stringMatching(/^otp_[0-9A-Z]{26}$/), expiresAt: new Date(clock.now.getTime() + 300_000).toISOString(), retryAfterSeconds: 30 });
  });

  it("any other number is 403 forbidden, sign_in_restricted (no SMS in the test week)", async () => {
    const res = await post("/auth/otp/request", { phone: "+46705551234", app: "rider" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "forbidden", reason: "sign_in_restricted", retryable: false });
  });

  it("test numbers do nothing on production", async () => {
    const res = await post("/auth/otp/request", { phone: RIDER_PHONE, app: "rider" }, {}, production);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "sign_in_restricted" });
  });

  it.each([
    [{ phone: "0701234567", app: "rider" }, "invalid_phone"],
    [{ phone: "+46 70 174 06 05", app: "rider" }, "invalid_phone"],
    [{ phone: RIDER_PHONE }, "invalid_body"],
    [{ phone: RIDER_PHONE, app: "admin" }, "invalid_body"],
    [{ phone: RIDER_PHONE, app: "rider", locale: "de" }, "invalid_body"],
  ])("%j is 400 %s", async (payload, reason) => {
    const res = await post("/auth/otp/request", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_request", reason });
  });

  it("a new code within 30 s is 429 with Retry-After; after 30 s it works and replaces the first", async () => {
    const first = await post("/auth/otp/request", { phone: RIDER_PHONE, app: "rider" });
    advance(10);
    const tooSoon = await post("/auth/otp/request", { phone: RIDER_PHONE, app: "rider" });
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.headers["retry-after"]).toBe("20");
    expect(tooSoon.json()).toMatchObject({ code: "rate_limited", reason: "otp_resend_too_soon", retryable: true });
    advance(20);
    const second = await post("/auth/otp/request", { phone: RIDER_PHONE, app: "rider" });
    expect(second.statusCode).toBe(200);
    const old = await post("/auth/otp/verify", { phone: RIDER_PHONE, sessionId: first.json().sessionId, code: TEST_CODE });
    expect(old.json()).toMatchObject({ code: "invalid_request", reason: "invalid_otp_session" });
  });

  it("at most 10 codes per number per hour", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post("/auth/otp/request", { phone: OTHER_TEST_PHONE, app: "driver" })).statusCode).toBe(200);
      advance(31);
    }
    const res = await post("/auth/otp/request", { phone: OTHER_TEST_PHONE, app: "driver" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ reason: "otp_too_many" });
  });

  it("over 60 codes per address per hour, the wait is the real time until the oldest one leaves the hour", async () => {
    const ip = "198.51.100.7";
    const rows = Array.from({ length: 60 }, (_, i) => ({
      session_id: `otp_IPLIMIT${String(clock.now.getTime()).slice(-8)}${String(i).padStart(10, "0")}`,
      phone: OTHER_TEST_PHONE,
      app: "rider" as const,
      code_sha256: "00",
      is_test: true,
      locale: null,
      ip,
      max_attempts: 5,
      expires_at: clock.now,
      consumed_at: clock.now,
      // the oldest was 20 minutes ago, the others 1 minute ago: 40 minutes = 2400 s are left
      created_at: new Date(clock.now.getTime() - (i === 0 ? 1200 : 60) * 1000),
    }));
    await database.db.insertInto("otp_sessions").values(rows).execute();
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", remoteAddress: ip, headers: { "content-type": "application/json" }, payload: { phone: RIDER_PHONE, app: "rider" } });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: "rate_limited", reason: "otp_too_many" });
    expect(res.headers["retry-after"]).toBe("2400");
  });
});

describe("verifying the code", () => {
  it("the fixed code signs a new rider in: isNewRider, then false the next time", async () => {
    const phone = TEST_PHONES[3]!;
    const first = await signIn(phone);
    expect(first).toMatchObject({ actor: "rider", expiresIn: 900, isNewRider: true });
    expect(first.refreshToken).toMatch(/^rt_/);
    expect(Object.keys(first).sort()).toEqual(["accessToken", "actor", "expiresIn", "isNewRider", "refreshToken"]);
    expect(first.isNewDriver).toBeUndefined();
    advance(60);
    expect((await signIn(phone)).isNewRider).toBe(false);
    const riders = await database.db.selectFrom("riders").select("rider_id").where("phone", "=", phone).execute();
    expect(riders).toHaveLength(1);
  });

  it("the same number in the driver app is a separate driver account (isNewDriver)", async () => {
    const tokens = await signIn(DRIVER_PHONE, "driver");
    expect(tokens).toMatchObject({ actor: "driver", isNewDriver: true });
    const driver = await database.db.selectFrom("drivers").selectAll().where("phone", "=", DRIVER_PHONE).executeTakeFirstOrThrow();
    expect(driver.account_status).toBe("pending");
  });

  // v0.18.5 (G1-B3): the 5th wrong code itself is 429 (was: the 6th try); see test/auth/deepfix_g1.test.ts.
  it("a wrong code is 400 invalid_otp_code; the 5th wrong code is 429, and the right code after it too", async () => {
    const challenge = (await post("/auth/otp/request", { phone: TEST_PHONES[4]!, app: "rider" })).json();
    for (let i = 0; i < 4; i++) {
      const wrong = await post("/auth/otp/verify", { phone: TEST_PHONES[4]!, sessionId: challenge.sessionId, code: "0000" });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json()).toMatchObject({ code: "invalid_request", reason: "invalid_otp_code" });
    }
    const fifth = await post("/auth/otp/verify", { phone: TEST_PHONES[4]!, sessionId: challenge.sessionId, code: "0000" });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({ code: "rate_limited", reason: "otp_too_many_attempts" });
    const locked = await post("/auth/otp/verify", { phone: TEST_PHONES[4]!, sessionId: challenge.sessionId, code: TEST_CODE });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ code: "rate_limited", reason: "otp_too_many_attempts" });
  });

  it("an expired code is 410 otp_expired", async () => {
    const challenge = (await post("/auth/otp/request", { phone: TEST_PHONES[5]!, app: "rider" })).json();
    advance(301);
    const res = await post("/auth/otp/verify", { phone: TEST_PHONES[5]!, sessionId: challenge.sessionId, code: TEST_CODE });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: "otp_expired", retryable: false });
  });

  it("a code works once; an unknown session or another phone is invalid_otp_session", async () => {
    const challenge = (await post("/auth/otp/request", { phone: RIDER_PHONE, app: "rider" })).json();
    expect((await post("/auth/otp/verify", { phone: RIDER_PHONE, sessionId: challenge.sessionId, code: TEST_CODE })).statusCode).toBe(200);
    const again = await post("/auth/otp/verify", { phone: RIDER_PHONE, sessionId: challenge.sessionId, code: TEST_CODE });
    expect(again.json()).toMatchObject({ reason: "invalid_otp_session" });
    const other = await post("/auth/otp/verify", { phone: DRIVER_PHONE, sessionId: challenge.sessionId, code: TEST_CODE });
    expect(other.json()).toMatchObject({ reason: "invalid_otp_session" });
    const unknown = await post("/auth/otp/verify", { phone: RIDER_PHONE, sessionId: "otp_nope", code: TEST_CODE });
    expect(unknown.json()).toMatchObject({ reason: "invalid_otp_session" });
  });

  it("a code that is not 4 digits is 400 invalid_otp_code", async () => {
    const res = await post("/auth/otp/verify", { phone: RIDER_PHONE, sessionId: "otp_x", code: "12a4" });
    expect(res.json()).toMatchObject({ reason: "invalid_otp_code" });
  });

  it("Apple/Google link tokens are refused while that sign-in is off", async () => {
    const res = await post("/auth/otp/request", { phone: RIDER_PHONE, app: "rider", linkToken: "lnk_1" });
    expect(res.json()).toMatchObject({ code: "invalid_request", reason: "invalid_link_token" });
  });
});

describe("tokens, refresh and sign-out", () => {
  it("a refresh gives a new pair; the old refresh token used again later ends the session", async () => {
    const first = await signIn(RIDER_PHONE);
    advance(5);
    const refreshed = await post("/auth/refresh", { refreshToken: first.refreshToken });
    expect(refreshed.statusCode).toBe(200);
    const second = refreshed.json();
    expect(second).toMatchObject({ actor: "rider", expiresIn: 900 });
    expect(second.refreshToken).not.toBe(first.refreshToken);
    advance(REFRESH_RETRY_WINDOW_MS / 1000 + 1);
    const reused = await post("/auth/refresh", { refreshToken: first.refreshToken });
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toMatchObject({ code: "unauthenticated", reason: "refresh_token_reused" });
    // Theft ends the session: even the newest token stops working.
    const newest = await post("/auth/refresh", { refreshToken: second.refreshToken });
    expect(newest.json()).toMatchObject({ code: "unauthenticated", reason: "session_ended" });
  });

  it("a refresh answer lost on a bad connection: the same token again within a minute still works", async () => {
    const first = await signIn(RIDER_PHONE);
    const lost = (await post("/auth/refresh", { refreshToken: first.refreshToken })).json();
    advance(10);
    const retry = await post("/auth/refresh", { refreshToken: first.refreshToken });
    expect(retry.statusCode).toBe(200);
    // The answer that never arrived can no longer be used.
    const stale = await post("/auth/refresh", { refreshToken: lost.refreshToken });
    expect(stale.statusCode).toBe(401);
  });

  it("an unknown refresh token is 401; a session expires 30 days after its last refresh", async () => {
    expect((await post("/auth/refresh", { refreshToken: "rt_nope" })).json()).toMatchObject({ code: "unauthenticated", reason: "refresh_token_unknown" });
    const tokens = await signIn(RIDER_PHONE);
    advance(29 * 24 * 3600);
    const kept = await post("/auth/refresh", { refreshToken: tokens.refreshToken });
    expect(kept.statusCode).toBe(200);
    advance(31 * 24 * 3600);
    expect((await post("/auth/refresh", { refreshToken: kept.json().refreshToken })).json()).toMatchObject({ reason: "session_expired" });
  });

  it("sign-out with the apps' empty body is 204, repeatable, and ends the session at once", async () => {
    const tokens = await signIn(RIDER_PHONE);
    const register = await post("/push/devices", { token: "fcm-token-1", provider: "fcm", platform: "android" }, { ...bearer(tokens.accessToken), "idempotency-key": key() });
    expect(register.statusCode).toBe(200);
    const out = await post("/auth/sign-out", undefined, bearer(tokens.accessToken));
    expect(out.statusCode).toBe(204);
    expect(out.body).toBe("");
    expect((await post("/auth/sign-out", undefined, bearer(tokens.accessToken))).statusCode).toBe(204);
    const after = await post("/push/devices", { token: "fcm-token-1", provider: "fcm", platform: "android" }, { ...bearer(tokens.accessToken), "idempotency-key": key() });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ reason: "session_ended" });
    expect((await post("/auth/refresh", { refreshToken: tokens.refreshToken })).json()).toMatchObject({ reason: "session_ended" });
    const devices = await database.db.selectFrom("push_devices").selectAll().where("token", "=", "fcm-token-1").execute();
    expect(devices).toEqual([]);
  });

  it("sign-out still works with an expired access token", async () => {
    const tokens = await signIn(RIDER_PHONE);
    advance(901);
    expect((await post("/auth/sign-out", undefined, bearer(tokens.accessToken))).statusCode).toBe(204);
  });

  it("an expired access token is 401 token_expired; a missing one 401 token_missing", async () => {
    const tokens = await signIn(RIDER_PHONE);
    advance(901);
    const expired = await post("/push/devices", { token: "t", provider: "fcm", platform: "ios" }, { ...bearer(tokens.accessToken), "idempotency-key": key() });
    expect(expired.json()).toMatchObject({ code: "unauthenticated", reason: "token_expired" });
    const missing = await post("/push/devices", { token: "t", provider: "fcm", platform: "ios" }, { "idempotency-key": key() });
    expect(missing.json()).toMatchObject({ code: "unauthenticated", reason: "token_missing" });
  });
});

describe("push devices", () => {
  it("register is keyed by token and actor; registering again updates it; repeat with the same key replays", async () => {
    const tokens = await signIn(RIDER_PHONE);
    const k = key();
    const body = { token: "apns-token-9", provider: "apns", platform: "ios", appVersion: "1.2.3", locale: "sv" };
    const first = await post("/push/devices", body, { ...bearer(tokens.accessToken), "idempotency-key": k });
    expect(first.json()).toEqual({ status: "registered", requestId: expect.any(String) });
    const replay = await post("/push/devices", body, { ...bearer(tokens.accessToken), "idempotency-key": k });
    expect(replay.json()).toEqual(first.json());
    await post("/push/devices", { ...body, appVersion: "1.2.4" }, { ...bearer(tokens.accessToken), "idempotency-key": key() });
    const rows = await database.db.selectFrom("push_devices").selectAll().where("token", "=", "apns-token-9").execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "rider", app_version: "1.2.4", locale: "sv" });
    const gone = await post("/push/devices/unregister", { token: "apns-token-9" }, { ...bearer(tokens.accessToken), "idempotency-key": key() });
    expect(gone.json()).toMatchObject({ status: "unregistered" });
    expect(await database.db.selectFrom("push_devices").selectAll().where("token", "=", "apns-token-9").execute()).toEqual([]);
  });

  it("needs an Idempotency-Key and a valid body", async () => {
    const tokens = await signIn(RIDER_PHONE);
    const noKey = await post("/push/devices", { token: "x", provider: "fcm", platform: "ios" }, bearer(tokens.accessToken));
    expect(noKey.json()).toMatchObject({ reason: "idempotency_key_missing" });
    const bad = await post("/push/devices", { token: "x", provider: "huawei", platform: "ios" }, { ...bearer(tokens.accessToken), "idempotency-key": key() });
    expect(bad.json()).toMatchObject({ reason: "invalid_body" });
  });
});

describe("review fixes", () => {
  it("two refreshes at the same moment (a retry and a normal one) never fail with 500", async () => {
    for (let round = 0; round < 8; round++) {
      const first = await signIn(RIDER_PHONE);
      const second = (await post("/auth/refresh", { refreshToken: first.refreshToken })).json();
      const [retry, normal] = await Promise.all([
        post("/auth/refresh", { refreshToken: first.refreshToken }),
        post("/auth/refresh", { refreshToken: second.refreshToken }),
      ]);
      for (const res of [retry, normal]) expect([200, 401]).toContain(res.statusCode);
      advance(3600);
    }
  });

  it("sign-out refuses a token older than any session could be", async () => {
    const tokens = await signIn(RIDER_PHONE);
    advance(31 * 24 * 3600 + 900);
    const res = await post("/auth/sign-out", undefined, bearer(tokens.accessToken));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ reason: "token_expired" });
  });

  it("behind one proxy, a faked X-Forwarded-For does not change the address limits see", async () => {
    const proxied = await buildApp({
      env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET, TRUST_PROXY_HOPS: "1" }),
      logger: false,
      db: database.db,
      clock: () => clock.now,
    });
    let seen = "";
    proxied.addHook("onRequest", async (request) => {
      seen = request.ip;
    });
    await proxied.inject({ method: "GET", url: "/healthz", headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.9" }, remoteAddress: "10.0.0.2" });
    await proxied.close();
    expect(seen).toBe("203.0.113.9");
  });
});
