import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { contract } from "../../src/contract/contract.js";
import { COUNTRY_LIMITS, countryLimitsOf, countryOfPhone } from "../../src/config/countryLimits.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Deep fix 2026-11-02 (Rules plan/FIX-LIST-2026-11-02.md HIGH 8, g1-g3 H2 + M2): the sign-in code is 6 digits; a number
 * with wrongCodesPerDay wrong codes in 24 h is locked (default 15, admin setting per country); the per-address
 * (one wifi) limit is an admin setting (default 60). SE (+46) and FR (+33) numbers.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-06T09:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "deep-fix-1".padEnd(48, "d") }), logger: false, db: database.db, clock: () => clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(() => advance(2 * 86_400));

const post = (url: string, payload: unknown, remoteAddress = "203.0.113.9") => app.inject({ method: "POST", url: `/api/v1${url}`, remoteAddress, headers: { "content-type": "application/json" }, payload: payload as object });
async function countryLimits(country: string, limits: Record<string, number>) {
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").where("zone_id", "=", `standard-${country}`).execute();
  await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: `standard-${country}`, version: 1, document: JSON.stringify({ version: 1, country, limits }), published_at: clock.now, published_by: null }).execute();
}
/** Wrong codes on fresh sessions (each new code 31 s after the last), until `count` wrong codes were sent. */
async function wrongCodes(phone: string, count: number, appName: "rider" | "driver" = "rider") {
  let last;
  for (let sent = 0; sent < count; ) {
    advance(400); // past the resend wait and the hourly code limit (10 per hour)
    const challenge = (await post("/auth/otp/request", { phone, app: appName })).json();
    for (let i = 0; i < 4 && sent < count; i++, sent++) last = await post("/auth/otp/verify", { phone, sessionId: challenge.sessionId, code: "000000" });
  }
  return last!;
}

describe("sign-in code: 6 digits, per-number daily lock, per-address limit as admin settings", () => {
  it("the contract says 6 digits and the test code is 6 digits; a 4-digit code is refused", async () => {
    expect((contract as unknown as { auth: { otp: { codeLength: number }; testSignIn: { code: string } } }).auth.otp.codeLength).toBe(6);
    expect((contract as unknown as { auth: { testSignIn: { code: string } } }).auth.testSignIn.code).toMatch(/^\d{6}$/);
    const challenge = (await post("/auth/otp/request", { phone: TEST_PHONES[0]!, app: "rider" })).json();
    expect((await post("/auth/otp/verify", { phone: TEST_PHONES[0]!, sessionId: challenge.sessionId, code: "1234" })).json()).toMatchObject({ reason: "invalid_otp_code" });
  });

  it("defaults, ranges and the phone's country", () => {
    expect(COUNTRY_LIMITS.defaults).toEqual({ wrongCodesPerDay: 15, codesPerAddressPerHour: 60, uploadsPerHour: 30 });
    expect(countryLimitsOf({ limits: { wrongCodesPerDay: 1, codesPerAddressPerHour: 200, uploadsPerHour: "x" } })).toEqual({ wrongCodesPerDay: 15, codesPerAddressPerHour: 200, uploadsPerHour: 30 });
    expect([countryOfPhone("+46701740600"), countryOfPhone("+33612345678"), countryOfPhone("+4930123456")]).toEqual(["SE", "FR", null]);
  });

  it("SE: the 15th wrong code in 24 h locks the number (fail-before: never locked); even the right code then; free again after 24 h", async () => {
    const phone = TEST_PHONES[2]!;
    const fifteenth = await wrongCodes(phone, 15);
    expect(fifteenth.statusCode).toBe(429);
    expect(fifteenth.json()).toMatchObject({ code: "rate_limited", reason: "otp_locked_today" });
    advance(400);
    const request = await post("/auth/otp/request", { phone, app: "driver" });
    expect(request.statusCode).toBe(429);
    expect(request.json()).toMatchObject({ reason: "otp_locked_today" });
    expect(Number(request.headers["retry-after"])).toBeGreaterThan(0);
    advance(86_400);
    const challenge = (await post("/auth/otp/request", { phone, app: "rider" })).json();
    expect((await post("/auth/otp/verify", { phone, sessionId: challenge.sessionId, code: "123456" })).statusCode).toBe(200);
  });

  it("FR: the admin's own number (wrongCodesPerDay 5) applies to +33 numbers only", async () => {
    await countryLimits("FR", { wrongCodesPerDay: 5 });
    const fr = await database.db.selectFrom("test_phones").select("phone").where("phone", "like", "+33%").executeTakeFirst();
    const phone = fr?.phone ?? "+33600000001";
    if (!fr) await database.db.insertInto("test_phones").values({ phone, app: "rider", created_at: clock.now }).execute();
    expect((await wrongCodes(phone, 5)).json()).toMatchObject({ reason: "otp_locked_today" });
    // A Swedish number still has the default 15.
    expect((await wrongCodes(TEST_PHONES[3]!, 5)).json()).toMatchObject({ reason: "invalid_otp_code" });
  });

  it("the per-address limit is the admin's codesPerAddressPerHour (SE 10), not a fixed 60", async () => {
    await countryLimits("SE", { codesPerAddressPerHour: 10 });
    const ip = "198.51.100.44";
    const rows = Array.from({ length: 10 }, (_, i) => ({ session_id: `otp_DEEPIP${String(i).padStart(10, "0")}`, phone: TEST_PHONES[5]!, app: "rider" as const, code_sha256: "00", is_test: true, locale: null, ip, max_attempts: 5, expires_at: clock.now, consumed_at: clock.now, created_at: new Date(clock.now.getTime() - 60_000) }));
    await database.db.insertInto("otp_sessions").values(rows).execute();
    const res = await post("/auth/otp/request", { phone: TEST_PHONES[0]!, app: "rider" }, ip);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ reason: "otp_too_many" });
  });
});

describe("one phone at a time (owner 2026-11-02, driver)", () => {
  it("a new driver sign-in ends the old phone's session (401 signed_in_elsewhere on calls and refresh) and leaves a notice; riders keep both", async () => {
    const signIn = async (phone: string, appName: "rider" | "driver") => {
      advance(60);
      const c = (await post("/auth/otp/request", { phone, app: appName })).json();
      return (await post("/auth/otp/verify", { phone, sessionId: c.sessionId, code: "123456" })).json();
    };
    const first = await signIn(TEST_PHONES[1]!, "driver");
    const second = await signIn(TEST_PHONES[1]!, "driver");
    const old = await app.inject({ method: "GET", url: "/api/v1/driver/profile", headers: { authorization: `Bearer ${first.accessToken}` } });
    expect(old.statusCode).toBe(401);
    expect(old.json()).toMatchObject({ reason: "signed_in_elsewhere" });
    expect((await post("/auth/refresh", { refreshToken: first.refreshToken })).json()).toMatchObject({ reason: "signed_in_elsewhere" });
    const list = await app.inject({ method: "GET", url: "/api/v1/notifications", headers: { authorization: `Bearer ${second.accessToken}` } });
    expect(list.json().items.some((n: { kind: string }) => n.kind === "signed_in_elsewhere")).toBe(true);
    const r1 = await signIn(TEST_PHONES[0]!, "rider");
    await signIn(TEST_PHONES[0]!, "rider");
    expect((await app.inject({ method: "GET", url: "/api/v1/rider/profile", headers: { authorization: `Bearer ${r1.accessToken}` } })).statusCode).toBe(200);
  });
});
