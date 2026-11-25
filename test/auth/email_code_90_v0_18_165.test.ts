import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { EMAIL_CODE, lifeText } from "../../src/auth/accountChange.js";
import { OTP, TEST_CODE } from "../../src/auth/service.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Contract v0.18.165 (owner 2026-11-25 "Mail 90 s"): the account e-mail change code lives auth.emailCode.expiresSeconds (90 s)
 * and a new code for the same address may be asked only after auth.emailCode.retryAfterSeconds (90 s); the SMS codes keep
 * auth.otp (60 s). The mail says "90 seconds".
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-25T15:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
const PHONES = Array.from({ length: 6 }, (_, i) => `+467017416${String(i).padStart(2, "0")}`);
let nextPhone = 0;
const freshPhone = () => PHONES[nextPhone++]!;
const mails: { to: string; text: string }[] = [];
const email = { name: "fake", send: async (m: { to: string; text: string }) => (mails.push(m), { accepted: true, status: 200 }) };

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db, PHONES);
  const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "email-code-90".padEnd(48, "f") });
  app = await buildApp({ env, logger: false, db: database.db, clock: () => clock.now, email } as Parameters<typeof buildApp>[0]);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(() => {
  advance(2 * 3600);
  mails.length = 0;
});

const headers = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });
const post = (url: string, payload: object, t?: string) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: t ? headers(t) : { "content-type": "application/json" }, payload });
async function signIn(phone: string): Promise<string> {
  advance(61);
  const c = (await post("/auth/otp/request", { phone, app: "rider" })).json();
  return (await post("/auth/otp/verify", { phone, sessionId: c.sessionId, code: TEST_CODE })).json().accessToken as string;
}
const knownCode = (challengeId: string) =>
  database.db.updateTable("email_changes").set({ code_sha256: createHash("sha256").update(`${challengeId}:4242`).digest("hex") }).where("challenge_id", "=", challengeId).execute();

describe("v0.18.165: the e-mail change code lives 90 s", () => {
  it("the contract values: e-mail 90/90, SMS stays 60/60", () => {
    expect(EMAIL_CODE).toEqual({ expiresSeconds: 90, retryAfterSeconds: 90, since: "0.18.165", note: expect.stringContaining("Mail 90 s") });
    expect([OTP.expiresSeconds, OTP.retryAfterSeconds]).toEqual([60, 60]);
    expect([lifeText("sv", 90), lifeText("fr", 90), lifeText("en", 90)]).toEqual(["90 sekunder", "90 secondes", "90 seconds"]);
    expect(lifeText("en", 300)).toBe("5 minutes");
  });

  it("expiresAt is 90 s; the mail says 90 seconds; the code works at 89 s", async () => {
    const me = await signIn(freshPhone());
    const s = await post("/account/email/change", { email: "a90@example.se" }, me);
    expect(s.statusCode).toBe(200);
    expect(s.json().expiresAt).toBe(new Date(clock.now.getTime() + 90_000).toISOString());
    expect(mails.map((m) => m.to)).toEqual(["a90@example.se"]);
    expect(mails[0]!.text).toMatch(/90 (sekunder|secondes|seconds)/);
    await knownCode(s.json().challengeId);
    advance(89);
    expect((await post("/account/email/verify", { challengeId: s.json().challengeId, code: "4242" }, me)).statusCode).toBe(200);
  });

  it("at 90 s the code is 410 otp_expired, with no new code asked", async () => {
    const me = await signIn(freshPhone());
    const s = (await post("/account/email/change", { email: "b90@example.se" }, me)).json();
    await knownCode(s.challengeId);
    advance(90);
    const late = await post("/account/email/verify", { challengeId: s.challengeId, code: "4242" }, me);
    expect(late.statusCode).toBe(410);
    expect(late.json()).toMatchObject({ code: "otp_expired" });
  });

  it("a new code for the same address before 90 s is 429 otp_resend_too_soon (no mail); at 90 s it goes out", async () => {
    const me = await signIn(freshPhone());
    expect((await post("/account/email/change", { email: "c90@example.se" }, me)).statusCode).toBe(200);
    advance(30);
    const soon = await post("/account/email/change", { email: "c90@example.se" }, me);
    expect(soon.statusCode).toBe(429);
    expect(soon.headers["retry-after"]).toBe("60");
    expect(soon.json()).toMatchObject({ code: "rate_limited", reason: "otp_resend_too_soon" });
    expect(mails.length).toBe(1);
    advance(60);
    expect((await post("/account/email/change", { email: "c90@example.se" }, me)).statusCode).toBe(200);
    expect(mails.length).toBe(2);
  });

  it("another address is a new start (the hourly limits hold it), not a resend", async () => {
    const me = await signIn(freshPhone());
    expect((await post("/account/email/change", { email: "d1@example.se" }, me)).statusCode).toBe(200);
    expect((await post("/account/email/change", { email: "d2@example.se" }, me)).statusCode).toBe(200);
  });
});
