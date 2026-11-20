import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { checkSmsSignIn } from "../../src/auth/smsSignIn.js";
import { BREAKER_ERRORS, FAILED_CHECKS_PER_ADDRESS_PER_HOUR, canonicalToken, deviceBinding, deviceTokenHash, resetDeviceCheckState, resetFailedChecks, type DeviceVerifier } from "../../src/auth/deviceCheck.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { contract } from "../../src/contract/contract.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { FakeCodeSms } from "../support/smsSignIn.js";

/**
 * Contract v0.18.138 (contract.json#deviceCheck; owner 2026-11-20 "Ok" to Rules
 * audits/impact/sms-abuse-open-launch-2026-11-20.md, "build BOTH"): a code limit per app install and a real-phone
 * check before a sign-in SMS. The SMS company and the Google / Apple checks are fakes; nothing leaves the test.
 */

let database: TestDatabase;
let app: FastifyInstance;
const sms = new FakeCodeSms();
const clock = { now: new Date("2026-11-20T09:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
let n = 0;
let se = 0;
let ins = 0;
const realSE = () => `+467017${52000 + ++se}`;
const address = () => `198.51.${Math.floor(++n / 250)}.${n % 250}`;
/** A canonical base64url segment (Play Integrity tokens are JWE: base64url parts and dots). */
const tok = (label: string) => Buffer.from(label).toString("base64url");
const install = () => `install-${String(++ins).padStart(12, "0")}`;

/** Fake verifiers: `answer` decides; every call is kept (token, keyId, binding). */
class FakeVerifier implements DeviceVerifier {
  calls: Array<{ token: string; keyId?: string | undefined; binding: Buffer }> = [];
  answer: "ok" | "bad" | "throw" | "hang" | "google_5xx" = "ok";
  async verify(input: { token: string; keyId?: string | undefined; binding: Buffer }) {
    this.calls.push(input);
    if (this.answer === "throw") throw new Error("google down");
    if (this.answer === "hang") return new Promise<never>(() => undefined);
    if (this.answer === "google_5xx") return { ok: false, why: "google_5xx" } as const;
    return this.answer === "ok" ? ({ ok: true } as const) : ({ ok: false, why: "device_verdict" } as const);
  }
}
const android = new FakeVerifier();
const logLines: string[] = [];
/** The server's warnings so far (pino JSON lines: msg). */
const warnings: Array<{ message: string }> = [];
const readWarnings = () => { warnings.length = 0; for (const l of logLines) for (const part of l.split("\n")) { try { const j = JSON.parse(part) as { msg?: string }; if (j.msg) warnings.push({ message: j.msg }); } catch { /* not JSON */ } } };

let version = 500;
/** Publishes the SE country standard with smsSignIn and limits, as the admin's publish stores it. */
async function setSE(smsSignIn: Record<string, unknown>, limits: Record<string, unknown> = {}) {
  const document = JSON.stringify({ country: "SE", smsSignIn, limits });
  await database.db
    .insertInto("config_live")
    .values({ doc: "country_rules", zone_id: "standard-SE", version: ++version, document, published_at: clock.now, published_by: null })
    .onConflict((oc) => oc.columns(["doc", "zone_id"]).doUpdateSet({ version, document, published_at: clock.now }))
    .execute();
}

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const env = readEnv({ MOVERA_ENV: "development", DATABASE_URL: database.url, JWT_SECRET: "device-check".padEnd(48, "d"), RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: "0", RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: "0" });
  // Only Android has a verifier: the iPhone check is inactive (no Apple keys), as on the live server today.
  const stream = new Writable({ write: (chunk, _enc, done) => (logLines.push(String(chunk)), done()) });
  app = await buildApp({ env, logger: { stream }, db: database.db, clock: () => clock.now, signInSms: sms, deviceVerifiers: { android } });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  advance(25 * 3600);
  sms.sent.length = 0;
  android.calls.length = 0;
  android.answer = "ok";
  resetDeviceCheckState();
  resetFailedChecks();
  await setSE({ enabled: true });
});

const request = (body: Record<string, unknown>, remoteAddress = address()) =>
  app.inject({ method: "POST", url: "/api/v1/auth/otp/request", remoteAddress, headers: { "content-type": "application/json" }, payload: { app: "rider", ...body } });
const sessionsOf = (phone: string) => database.db.selectFrom("otp_sessions").selectAll().where("phone", "=", phone).execute();

describe("code limit per app install (countryLimits.codesPerDevicePerHour)", () => {
  it("defaults to 5 per hour over every number; the 6th is 429 otp_too_many and sends nothing", async () => {
    expect((contract as unknown as { countryLimits: { defaults: Record<string, number> } }).countryLimits.defaults["codesPerDevicePerHour"]).toBe(5);
    const id = install();
    for (let k = 0; k < 5; k++) expect((await request({ phone: realSE(), installId: id })).statusCode).toBe(200);
    expect(sms.sent).toHaveLength(5);
    const phone = realSE();
    const res = await request({ phone, installId: id });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: "rate_limited", reason: "otp_too_many" });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(3500);
    expect(sms.sent).toHaveLength(5);
    expect(await sessionsOf(phone)).toHaveLength(0);
    // Another install is not touched; after the hour the same install may ask again.
    expect((await request({ phone: realSE(), installId: install() })).statusCode).toBe(200);
    advance(3601);
    expect((await request({ phone: realSE(), installId: id })).statusCode).toBe(200);
  });

  it("follows the admin setting per country and counts test numbers too", async () => {
    await setSE({ enabled: true }, { codesPerDevicePerHour: 2 });
    const id = install();
    expect((await request({ phone: TEST_PHONES[0]!, installId: id })).statusCode).toBe(200);
    expect((await request({ phone: realSE(), installId: id })).statusCode).toBe(200);
    expect((await request({ phone: realSE(), installId: id })).statusCode).toBe(429);
  });

  it("keeps the install id with the code; a request without one is not counted on this limit", async () => {
    const id = install();
    const phone = realSE();
    await request({ phone, installId: id });
    expect((await sessionsOf(phone))[0]!.install_id).toBe(id);
    for (let k = 0; k < 6; k++) expect((await request({ phone: realSE() })).statusCode).toBe(200);
  });

  it("refuses an install id of the wrong shape (400) and a deviceCheck with an unknown key", async () => {
    expect((await request({ phone: realSE(), installId: "short" })).statusCode).toBe(400);
    expect((await request({ phone: realSE(), installId: "x".repeat(65) })).statusCode).toBe(400);
    expect((await request({ phone: realSE(), installId: "has space in it 12345" })).statusCode).toBe(400);
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok("t"), extra: 1 } })).statusCode).toBe(400);
    expect(sms.sent).toHaveLength(0);
  });
});

describe("real-phone check (CountryRules.smsSignIn.requireDeviceCheck)", () => {
  it("off (the default): the check is not read and the SMS goes out as before", async () => {
    expect((contract as unknown as { configDefaults: { smsSignIn: { requireDeviceCheck: boolean } } }).configDefaults.smsSignIn.requireDeviceCheck).toBe(false);
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok("anything") } })).statusCode).toBe(200);
    expect(android.calls).toHaveLength(0);
    expect(sms.sent).toHaveLength(1);
  });

  it("on: no check, a bad one, an iPhone one (inactive, no keys) or one without installId is 403 device_check_failed, no SMS, not counted on the cap", async () => {
    await setSE({ enabled: true, requireDeviceCheck: true });
    android.answer = "bad";
    const cases: Array<Record<string, unknown>> = [
      { phone: realSE(), installId: install() },
      { phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok("bad-token") } },
      { phone: realSE(), installId: install(), deviceCheck: { platform: "ios", token: "attestation", keyId: "a2V5" } },
      { phone: realSE(), deviceCheck: { platform: "android", token: tok("no-install") } },
    ];
    for (const body of cases) {
      const res = await request(body);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "forbidden", reason: "device_check_failed" });
      expect(await sessionsOf(body["phone"] as string)).toHaveLength(0);
    }
    expect(sms.sent).toHaveLength(0);
    expect(await database.db.selectFrom("sms_outbox").selectAll().where("created_at", ">=", clock.now).execute()).toHaveLength(0);
  });

  it("on: a valid Android check bound to app + number + install sends the SMS; the same token again is refused", async () => {
    await setSE({ enabled: true, requireDeviceCheck: true });
    const phone = realSE();
    const id = install();
    const res = await request({ phone, installId: id, deviceCheck: { platform: "android", token: tok("good-token") } });
    expect(res.statusCode).toBe(200);
    expect(sms.sent).toHaveLength(1);
    expect(android.calls[0]!.binding.equals(deviceBinding("rider", phone, id))).toBe(true);
    expect(android.calls[0]!.token).toBe(tok("good-token"));
    expect((await sessionsOf(phone))[0]!.device_check_sha256).toMatch(/^[0-9a-f]{64}$/);
    advance(60);
    const again = await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok("good-token") } });
    expect(again.statusCode).toBe(403);
    expect(again.json()).toMatchObject({ reason: "device_check_failed" });
    expect(sms.sent).toHaveLength(1);
  });

  it("on: Google throwing or not answering in time is a failed check (fail closed)", async () => {
    await setSE({ enabled: true, requireDeviceCheck: true });
    android.answer = "throw";
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok("t1") } })).json()).toMatchObject({ reason: "device_check_failed" });
    android.answer = "hang";
    const started = Date.now();
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok("t2") } })).json()).toMatchObject({ reason: "device_check_failed" });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(sms.sent).toHaveLength(0);
  }, 15_000);

  it("on: a test number needs no check (unchanged)", async () => {
    await setSE({ enabled: true, requireDeviceCheck: true });
    expect((await request({ phone: TEST_PHONES[1]!, installId: install() })).statusCode).toBe(200);
    expect(android.calls).toHaveLength(0);
  });

  it("the setting: a boolean on the country standard only, anything else is 400 invalid_document", () => {
    expect(() => checkSmsSignIn("standard", { smsSignIn: { enabled: true, requireDeviceCheck: true } })).not.toThrow();
    expect(() => checkSmsSignIn("standard", { smsSignIn: { requireDeviceCheck: "yes" } })).toThrow(/requireDeviceCheck/);
    expect(() => checkSmsSignIn("zone", { smsSignIn: { requireDeviceCheck: true } })).toThrow();
  });

  it("review MUST 1: one attestation has one spelling; a non-canonical token is refused before any call", () => {
    expect(canonicalToken({ platform: "ios", token: "QUJD" })?.toString()).toBe("ABC");
    expect(canonicalToken({ platform: "ios", token: "QUJD\n" })).toBeNull();
    expect(canonicalToken({ platform: "ios", token: "QUJ" })).toBeNull();
    expect(canonicalToken({ platform: "ios", token: "QU-D" })).toBeNull();
    expect(canonicalToken({ platform: "android", token: `${tok("hdr")}.${tok("key")}.${tok("iv")}` })).not.toBeNull();
    expect(canonicalToken({ platform: "android", token: "eyJh b" })).toBeNull();
    expect(deviceTokenHash({ platform: "ios", token: "QUJD" })).not.toBe(deviceTokenHash({ platform: "android", token: tok("QUJD") }));
  });

  it("review MUST 2: no Google call when the cheap guards already refuse (switch off, install limit full, token used, bad shape)", async () => {
    await setSE({ enabled: false, requireDeviceCheck: true });
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok("x1") } })).statusCode).toBe(403);
    await setSE({ enabled: true, requireDeviceCheck: true }, { codesPerDevicePerHour: 1 });
    const id = install();
    expect((await request({ phone: realSE(), installId: id, deviceCheck: { platform: "android", token: tok("x2") } })).statusCode).toBe(200);
    expect(android.calls).toHaveLength(1);
    expect((await request({ phone: realSE(), installId: id, deviceCheck: { platform: "android", token: tok("x3") } })).statusCode).toBe(429);
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok("x2") } })).json()).toMatchObject({ reason: "device_check_failed" });
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: "bad token" } })).json()).toMatchObject({ reason: "device_check_failed" });
    expect(android.calls).toHaveLength(1);
  });

  it("review MUST 2: the circuit breaker opens after errors in a row and then fails without calling", async () => {
    await setSE({ enabled: true, requireDeviceCheck: true });
    android.answer = "throw";
    for (let k = 0; k < BREAKER_ERRORS; k++) await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok(`e${k}`) } });
    expect(android.calls).toHaveLength(BREAKER_ERRORS);
    android.answer = "ok";
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok("after") } })).statusCode).toBe(403);
    expect(android.calls).toHaveLength(BREAKER_ERRORS);
  });

  it("review SHOULD 5: failed checks from one address hit a ceiling; then no more calls from it", async () => {
    await setSE({ enabled: true, requireDeviceCheck: true });
    android.answer = "bad";
    const ip = "203.0.113.77";
    for (let k = 0; k < FAILED_CHECKS_PER_ADDRESS_PER_HOUR; k++) await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok(`f${k}`) } }, ip);
    const before = android.calls.length;
    android.answer = "ok";
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok("late") } }, ip)).statusCode).toBe(403);
    expect(android.calls.length).toBe(before);
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok("other") } })).statusCode).toBe(200);
  });

  it("follow-up 3: one Android token has one spelling: a segment that is not canonical base64url is refused, and other spellings never pass the one-use list", async () => {
    // "QUJDRA" = "ABCD"; "QUJDRB" decodes to the same bytes with non-zero padding bits.
    expect(Buffer.from("QUJDRB", "base64url").equals(Buffer.from("QUJDRA", "base64url"))).toBe(true);
    expect(canonicalToken({ platform: "android", token: "QUJDRA.QUJD" })).not.toBeNull();
    expect(canonicalToken({ platform: "android", token: "QUJDRB.QUJD" })).toBeNull();
    expect(canonicalToken({ platform: "android", token: "QUJDRA==.QUJD" })).toBeNull();
    expect(canonicalToken({ platform: "android", token: "QUJDR.QUJD" })).toBeNull();
    expect(canonicalToken({ platform: "android", token: "QUJDRA..QUJD" })).toBeNull();
    await setSE({ enabled: true, requireDeviceCheck: true });
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: "QUJDRA.QUJD" } })).statusCode).toBe(200);
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: "QUJDRB.QUJD" } })).json()).toMatchObject({ reason: "device_check_failed" });
    expect(android.calls).toHaveLength(1);
  });

  it("follow-up 4: Google trouble (429 / 5xx), a full cap or an open breaker is not the caller's failed check; the breaker opening is logged", async () => {
    await setSE({ enabled: true, requireDeviceCheck: true });
    const ip = "203.0.113.88";
    android.answer = "google_5xx";
    for (let k = 0; k < FAILED_CHECKS_PER_ADDRESS_PER_HOUR + 5; k++) await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok(`g${k}`) } }, ip);
    readWarnings();
    expect(warnings.some((w) => w.message === "sign-in device check breaker open")).toBe(true);
    resetDeviceCheckState();
    android.answer = "ok";
    expect((await request({ phone: realSE(), installId: install(), deviceCheck: { platform: "android", token: tok("nat-user") } }, ip)).statusCode).toBe(200);
  });
});
