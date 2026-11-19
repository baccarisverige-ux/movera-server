import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sweepAlerts } from "../../src/alerts/detector.js";
import { OTP, TEST_CODE } from "../../src/auth/service.js";
import { checkSmsSignIn, maskPhone, signInSmsText, smsSignInOf } from "../../src/auth/smsSignIn.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { contract } from "../../src/contract/contract.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { FakeCodeSms, setSmsSignIn } from "../support/smsSignIn.js";

/**
 * Contract v0.18.135 (contract.json#smsSignIn; owner 2026-11-19 "Yes, build it now (Rec.)"): real sign-in codes by SMS.
 * The SMS company is a fake here; no test sends an SMS. Numbers are from the PTS / ARCEP fiction ranges.
 */

let database: TestDatabase;
let app: FastifyInstance;
let noSender: FastifyInstance;
const sms = new FakeCodeSms();
const clock = { now: new Date("2026-11-19T09:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
const logLines: string[] = [];
const SECRET = "sms-sign-in".padEnd(48, "s");
let n = 0;
let se = 0;
let fr = 0;
/** A new real (not test) Swedish / French mobile number each call (fiction ranges), and a new client address. */
const realSE = () => `+467017${41000 + ++se}`;
const realFR = () => `+3363998${String(1000 + ++fr)}`;
const address = () => `198.51.${Math.floor(++n / 250)}.${n % 250}`;

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET, RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: "0", RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: "0" });
  const stream = new Writable({ write: (chunk, _enc, done) => (logLines.push(String(chunk)), done()) });
  app = await buildApp({ env, logger: { stream }, db: database.db, clock: () => clock.now, signInSms: sms });
  noSender = await buildApp({ env, logger: false, db: database.db, clock: () => clock.now });
});
afterAll(async () => {
  await app.close();
  await noSender.close();
  await database.drop();
});
beforeEach(async () => {
  // Each test starts a day later (all hourly and daily windows are empty) with Sweden and France on, default limit.
  advance(25 * 3600);
  sms.sent.length = 0;
  sms.next = { accepted: true, ref: "fake-ref" };
  logLines.length = 0;
  await setSmsSignIn(database.db, "SE", { enabled: true }, clock.now);
  await setSmsSignIn(database.db, "FR", { enabled: true }, clock.now);
  await setSmsSignIn(database.db, "TN", undefined, clock.now);
});

const post = (url: string, payload: unknown, remoteAddress = address(), on: FastifyInstance = app, headers: Record<string, string> = {}) =>
  on.inject({ method: "POST", url: `/api/v1${url}`, remoteAddress, headers: { "content-type": "application/json", ...headers }, payload: payload as object });
const request = (phone: string, extra: Record<string, unknown> = {}, remoteAddress = address(), on: FastifyInstance = app) => post("/auth/otp/request", { phone, app: "rider", ...extra }, remoteAddress, on);
const verify = (phone: string, sessionId: string, code: string, remoteAddress = address()) => post("/auth/otp/verify", { phone, sessionId, code }, remoteAddress);
const outbox = (phone: string) => database.db.selectFrom("sms_outbox").selectAll().where("phone", "=", phone).orderBy("created_at").execute();
const wrongCodeFor = (code: string) => (code === "0000" ? "0001" : "0000");

describe("nothing changes until BOTH the keys and the country switch are there", () => {
  it("no SMS keys on the server: a real number is sign_in_restricted even with the switch on", async () => {
    const res = await request(realSE(), {}, address(), noSender);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "forbidden", reason: "sign_in_restricted" });
  });

  it("keys but the country switch off (the default): sign_in_restricted, nothing is sent or stored", async () => {
    await setSmsSignIn(database.db, "SE", undefined, clock.now);
    const phone = realSE();
    const res = await request(phone);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "forbidden", reason: "sign_in_restricted" });
    await setSmsSignIn(database.db, "SE", { enabled: false, dailyCap: 5000 }, clock.now);
    expect((await request(phone)).json().reason).toBe("sign_in_restricted");
    // Only the exact boolean true switches it on.
    await setSmsSignIn(database.db, "SE", { enabled: "true" }, clock.now);
    expect((await request(phone)).json().reason).toBe("sign_in_restricted");
    expect(sms.sent).toHaveLength(0);
    expect(await outbox(phone)).toHaveLength(0);
    expect(await database.db.selectFrom("otp_sessions").select("session_id").where("phone", "=", phone).execute()).toHaveLength(0);
  });

  it("a number outside +46 / +33 / +216 is sign_in_restricted; a country that is off stays off while another is on", async () => {
    for (const phone of ["+4790000001", "+12025550101", "+447700900001", "+3584000000001"]) {
      expect((await request(phone)).json().reason, phone).toBe("sign_in_restricted");
    }
    expect((await request("+21620000001")).json().reason).toBe("sign_in_restricted");
    await setSmsSignIn(database.db, "FR", { enabled: false }, clock.now);
    expect((await request(realFR())).json().reason).toBe("sign_in_restricted");
    expect(sms.sent).toHaveLength(0);
    expect((await request(realSE())).statusCode).toBe(200);
  });

  it("only a MOBILE number of the country can get an SMS (the apps' own rule): a landline, premium or wrong-length number is sign_in_restricted", async () => {
    for (const phone of ["+4681234567", "+46900123456", "+467012345", "+4670123456789", "+46771234567", "+46751234567", "+46741234567", "+46711234567", "+46781234567", "+33123456789", "+33899123456"]) {
      const res = await request(phone);
      expect(res.statusCode, phone).toBe(403);
      expect(res.json().reason, phone).toBe("sign_in_restricted");
    }
    await setSmsSignIn(database.db, "TN", { enabled: true }, clock.now);
    expect((await request("+21671123456")).json().reason).toBe("sign_in_restricted");
    expect(sms.sent).toHaveLength(0);
    expect(await database.db.selectFrom("sms_outbox").select("sms_id").where("created_at", ">=", clock.now).execute()).toHaveLength(0);
  });

  it("a test number never gets an SMS and keeps the test code, with the keys and the switch on", async () => {
    const phone = TEST_PHONES[2]!;
    const challenge = await request(phone);
    expect(challenge.statusCode).toBe(200);
    expect(sms.sent).toHaveLength(0);
    expect(await outbox(phone)).toHaveLength(0);
    const tokens = await verify(phone, challenge.json().sessionId, TEST_CODE);
    expect(tokens.statusCode).toBe(200);
    expect(tokens.json().accessToken).toBeTypeOf("string");
  });
});

describe("a real number with the keys and the switch on", () => {
  it("gets one SMS with a random code, signs in with it once, and the answer has the usual shape", async () => {
    const phone = realSE();
    const res = await request(phone);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(["expiresAt", "requestId", "retryAfterSeconds", "sessionId"]);
    expect(res.json().retryAfterSeconds).toBe(OTP.retryAfterSeconds);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.to).toBe(phone);
    const code = sms.lastCode();
    expect(code).toMatch(new RegExp(`^[0-9]{${OTP.codeLength}}$`));
    expect(code).not.toBe(TEST_CODE);
    expect(sms.sent[0]!.text).toBe(signInSmsText("sv", code));

    const wrong = await verify(phone, res.json().sessionId, wrongCodeFor(code));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().reason).toBe("invalid_otp_code");
    const tokens = await verify(phone, res.json().sessionId, code);
    expect(tokens.statusCode).toBe(200);
    expect(tokens.json()).toMatchObject({ actor: "rider", isNewRider: true });
    // Replay: the same code and session a second time is refused.
    const replay = await verify(phone, res.json().sessionId, code);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().reason).toBe("invalid_otp_session");
    const row = (await outbox(phone))[0]!;
    expect(row).toMatchObject({ kind: "sign_in_code", status: "sent", provider: "fake", provider_ref: "fake-ref" });
  });

  it("every Swedish mobile range (70, 72, 73, 76, 79) can sign in", async () => {
    for (const phone of ["+46700000017", "+46720000017", "+46730000017", "+46760000017", "+46790000017"]) {
      expect((await request(phone)).statusCode, phone).toBe(200);
      expect(sms.sent.at(-1)!.to).toBe(phone);
    }
  });

  it("the test code never signs a real number in", async () => {
    const phone = realSE();
    const res = await request(phone);
    const answer = await verify(phone, res.json().sessionId, TEST_CODE);
    expect(answer.statusCode).toBe(400);
    expect(answer.json().reason).toBe("invalid_otp_code");
  });

  it("codes differ from request to request (not a fixed code)", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 12; i++) {
      expect((await request(realSE())).statusCode).toBe(200);
      codes.add(sms.lastCode());
    }
    expect(codes.size).toBeGreaterThan(6);
  });

  it("neither the stored SMS row, nor the stored code, nor the log holds the code; the log has no full number", async () => {
    const phone = realSE();
    const res = await request(phone);
    const code = sms.lastCode();
    const row = (await outbox(phone))[0]!;
    expect(row.text).not.toContain(code);
    expect(row.text).toContain("•".repeat(OTP.codeLength));
    const session = await database.db.selectFrom("otp_sessions").selectAll().where("session_id", "=", res.json().sessionId).executeTakeFirstOrThrow();
    expect(session.is_test).toBe(false);
    // Not the plain hash a table copy could be tried against: it is keyed with the server's secret.
    expect(session.code_sha256).not.toBe(createHash("sha256").update(`${session.session_id}:${code}`).digest("hex"));
    expect(session.code_sha256).not.toContain(code);
    sms.next = { accepted: false, status: 403 };
    advance(OTP.retryAfterSeconds + 1);
    expect((await request(phone)).statusCode).toBe(503);
    const log = logLines.join("");
    expect(log).toContain("sign-in SMS not sent");
    expect(log).toContain(maskPhone(phone));
    expect(log).not.toContain(phone);
    expect(log).not.toContain(phone.slice(1));
    expect(log).not.toContain(code);
    expect(log).not.toContain(sms.lastCode());
  });

  it("the SMS speaks the request's language, else the country's (TN and FR French), else the country default", async () => {
    await setSmsSignIn(database.db, "TN", { enabled: true }, clock.now);
    const cases: Array<[string, Record<string, unknown>, "sv" | "fr" | "en"]> = [
      [realSE(), { locale: "en" }, "en"],
      [realSE(), { locale: "fr" }, "fr"],
      [realSE(), {}, "sv"],
      [realFR(), {}, "fr"],
      [realFR(), { locale: "sv" }, "sv"],
      ["+21620000002", {}, "fr"],
    ];
    for (const [phone, extra, lang] of cases) {
      expect((await request(phone, extra)).statusCode, phone).toBe(200);
      const text = sms.sent.at(-1)!.text;
      expect(text, `${phone} ${lang}`).toBe(signInSmsText(lang, sms.lastCode()));
      expect(text).toMatch(/^Movera/);
      expect(text).not.toMatch(/https?:|www\.|\//);
    }
  });

  it("does not tell an existing account from a new number", async () => {
    const known = realSE();
    const first = await request(known);
    expect((await verify(known, first.json().sessionId, sms.lastCode())).statusCode).toBe(200);
    advance(3700);
    sms.sent.length = 0;
    const again = await request(known);
    const fresh = await request(realSE());
    expect(again.statusCode).toBe(200);
    expect(fresh.statusCode).toBe(200);
    expect(Object.keys(again.json()).sort()).toEqual(Object.keys(fresh.json()).sort());
    expect(again.json().retryAfterSeconds).toBe(fresh.json().retryAfterSeconds);
    expect(sms.sent).toHaveLength(2);
  });
});

describe("the limits of the test sign-in hold for real numbers (each SMS asked for counts)", () => {
  it("a new code within the resend wait is refused and sends nothing; a new code replaces the earlier one", async () => {
    const phone = realSE();
    const first = await request(phone);
    const firstCode = sms.lastCode();
    const soon = await request(phone);
    expect(soon.statusCode).toBe(429);
    expect(soon.json().reason).toBe("otp_resend_too_soon");
    expect(sms.sent).toHaveLength(1);
    advance(OTP.retryAfterSeconds + 1);
    const second = await request(phone);
    expect(second.statusCode).toBe(200);
    expect(sms.sent).toHaveLength(2);
    // One active code per phone and app: the first is no longer active.
    const old = await verify(phone, first.json().sessionId, firstCode);
    expect(old.json().reason).toBe("invalid_otp_session");
    expect((await verify(phone, second.json().sessionId, sms.lastCode())).statusCode).toBe(200);
  });

  it("the fast test path never applies: a real number on staging waits like on production", async () => {
    const phone = realSE();
    expect((await request(phone)).json().retryAfterSeconds).toBe(OTP.retryAfterSeconds);
    expect((await request(phone)).statusCode).toBe(429);
  });

  it("too many wrong codes end the code; an expired code is refused", async () => {
    const phone = realSE();
    const from = address();
    const res = await request(phone, {}, from);
    const code = sms.lastCode();
    let last;
    for (let i = 0; i < OTP.maxAttempts; i++) last = await verify(phone, res.json().sessionId, wrongCodeFor(code), from);
    expect(last!.statusCode).toBe(429);
    expect(last!.json().reason).toBe("otp_too_many_attempts");
    const right = await verify(phone, res.json().sessionId, code, from);
    expect(right.statusCode).toBe(429);

    const other = realSE();
    const second = await request(other);
    const otherCode = sms.lastCode();
    advance(OTP.expiresSeconds + 1);
    const late = await verify(other, second.json().sessionId, otherCode);
    expect(late.statusCode).toBe(410);
    expect(late.json().code).toBe("otp_expired");
  });

  it("the wrong-code lock of the day holds for a real number: no new SMS, and not even the right code", async () => {
    const limits = (contract as unknown as { countryLimits: { defaults: { wrongCodesPerDay: number } } }).countryLimits.defaults;
    const phone = realSE();
    const from = address();
    let wrong = 0;
    let last;
    let challenge = { sessionId: "" };
    while (wrong < limits.wrongCodesPerDay) {
      advance(400);
      challenge = (await request(phone, {}, from)).json();
      expect(challenge.sessionId, `after ${wrong} wrong`).toBeTypeOf("string");
      for (let i = 0; i < 4 && wrong < limits.wrongCodesPerDay; i++, wrong++) last = await verify(phone, challenge.sessionId, wrongCodeFor(sms.lastCode()), from);
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.json().reason).toBe("otp_locked_today");
    const right = await verify(phone, challenge.sessionId, sms.lastCode(), from);
    expect(right.json().reason).toBe("otp_locked_today");
    advance(400);
    const sentBefore = sms.sent.length;
    const again = await request(phone, {}, from);
    expect(again.statusCode).toBe(429);
    expect(again.json().reason).toBe("otp_locked_today");
    expect(sms.sent.length).toBe(sentBefore);
  });

  it("codes per number per hour and per address per hour stop the SMS", async () => {
    const limits = (contract as unknown as { countryLimits: { defaults: { codesPerPhonePerHour: number; codesPerAddressPerHour: number } } }).countryLimits.defaults;
    const phone = realSE();
    for (let i = 0; i < limits.codesPerPhonePerHour; i++) {
      expect((await request(phone)).statusCode, `code ${i}`).toBe(200);
      advance(OTP.retryAfterSeconds + 1);
    }
    const over = await request(phone);
    expect(over.statusCode).toBe(429);
    expect(over.json().reason).toBe("otp_too_many");
    expect(sms.sent).toHaveLength(limits.codesPerPhonePerHour);

    // One address asking for many different numbers (SMS pumping from one wifi).
    advance(2 * 3600);
    sms.sent.length = 0;
    await setSmsSignIn(database.db, "SE", { enabled: true, dailyCap: 5000 }, clock.now);
    const wifi = "203.0.113.77";
    for (let i = 0; i < limits.codesPerAddressPerHour; i++) expect((await request(realSE(), {}, wifi)).statusCode, `number ${i}`).toBe(200);
    const pumped = await request(realSE(), {}, wifi);
    expect(pumped.statusCode).toBe(429);
    expect(pumped.json().reason).toBe("otp_too_many");
    expect(sms.sent).toHaveLength(limits.codesPerAddressPerHour);
  });
});

describe("an SMS the company did not take", () => {
  it.each([
    ["refused", { accepted: false, status: 403 } as const],
    ["no answer", { accepted: false } as const],
    ["thrown", "throw" as const],
  ])("%s: 503 sms_not_sent (retryable), the code is void, and the person can ask again after the resend wait", async (_name, next) => {
    const phone = realSE();
    sms.next = next;
    const res = await request(phone);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "unavailable", reason: "sms_not_sent", retryable: true });
    expect(res.headers["retry-after"]).toBe(String(OTP.retryAfterSeconds));
    expect(JSON.stringify(res.json())).not.toContain(sms.lastCode());
    const rows = await outbox(phone);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    const sessions = await database.db.selectFrom("otp_sessions").selectAll().where("phone", "=", phone).execute();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.consumed_at).not.toBeNull();
    // The void code cannot be used even by someone who saw it.
    expect((await verify(phone, sessions[0]!.session_id, sms.lastCode())).json().reason).toBe("invalid_otp_session");
    // The failed try still counts on the resend wait (no hammering the SMS company).
    expect((await request(phone)).json().reason).toBe("otp_resend_too_soon");
    sms.next = { accepted: true, ref: "r2" };
    advance(OTP.retryAfterSeconds + 1);
    const again = await request(phone);
    expect(again.statusCode).toBe(200);
    expect((await verify(phone, again.json().sessionId, sms.lastCode())).statusCode).toBe(200);
  });
});

describe("the daily SMS limit per country (cost guard)", () => {
  const systemAlerts = async () => {
    await database.db.transaction().execute((trx) => sweepAlerts(trx, clock.now, "system"));
    return database.db.selectFrom("admin_alerts_live").select(["cause_key", "level", "state", "title"]).where("cause_key", "like", "system_health:sms_cap%").orderBy("cause_key").execute();
  };

  it("at the limit new codes are refused (503 sms_daily_limit, fail closed) with a critical admin alert; other countries and test numbers go on", async () => {
    await setSmsSignIn(database.db, "SE", { enabled: true, dailyCap: 10 }, clock.now);
    for (let i = 0; i < 7; i++) expect((await request(realSE())).statusCode).toBe(200);
    expect((await systemAlerts()).filter((a) => a.state === "open")).toEqual([]);
    expect((await request(realSE())).statusCode).toBe(200);
    // 8 of 10 = 80 %: the "near" alert.
    const near = (await systemAlerts()).filter((a) => a.state === "open");
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ cause_key: "system_health:sms_cap_near:SE", level: "important" });
    expect(near[0]!.title).toContain("8 of 10");
    advance(60);
    for (let i = 0; i < 2; i++) expect((await request(realSE())).statusCode).toBe(200);
    expect(sms.sent).toHaveLength(10);

    const phone = realSE();
    const over = await request(phone);
    expect(over.statusCode).toBe(503);
    expect(over.json()).toMatchObject({ code: "unavailable", reason: "sms_daily_limit", retryable: true });
    const wait = Number(over.headers["retry-after"]);
    expect(wait).toBeGreaterThan(23 * 3600);
    expect(wait).toBeLessThanOrEqual(24 * 3600);
    expect(sms.sent).toHaveLength(10);
    expect(await outbox(phone)).toHaveLength(0);
    expect(await database.db.selectFrom("otp_sessions").select("session_id").where("phone", "=", phone).execute()).toHaveLength(0);
    // The refusal asked for an alert sweep at once (a "poke" timer), and the sweep opens the critical alert.
    expect(await database.db.selectFrom("timers").select("ref_id").where("kind", "=", "alert_sweep").where("ref_id", "=", "poke").execute()).toHaveLength(1);
    const open = (await systemAlerts()).filter((a) => a.state === "open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ cause_key: "system_health:sms_cap:SE", level: "critical" });
    expect(open[0]!.title).toContain("10 of 10");

    // France has its own count; a test number is neither counted nor stopped.
    expect((await request(realFR())).statusCode).toBe(200);
    expect((await request(TEST_PHONES[3]!)).statusCode).toBe(200);
    // A higher limit lets people in again at once.
    await setSmsSignIn(database.db, "SE", { enabled: true, dailyCap: 20 }, clock.now);
    expect((await request(phone)).statusCode).toBe(200);
    // 24 h later the window is empty and the alerts are solved by themselves.
    await setSmsSignIn(database.db, "SE", { enabled: true, dailyCap: 10 }, clock.now);
    advance(24 * 3600 + 120);
    expect((await request(realSE())).statusCode).toBe(200);
    expect((await systemAlerts()).filter((a) => a.state === "open")).toEqual([]);
  });

  it("an SMS the company did not answer, or answered with a server error, counts (it may have gone out and been billed), and so does a row left 'queued' by a crash; only a refusal is free", async () => {
    await setSmsSignIn(database.db, "SE", { enabled: true, dailyCap: 10 }, clock.now);
    sms.next = { accepted: false };
    for (let i = 0; i < 6; i++) expect((await request(realSE())).json().reason).toBe("sms_not_sent");
    sms.next = "throw";
    expect((await request(realSE())).json().reason).toBe("sms_not_sent");
    // A server error of the company (it may have taken the SMS before it failed) counts too.
    sms.next = { accepted: false, status: 502 };
    expect((await request(realSE())).json().reason).toBe("sms_not_sent");
    // A send the server never finished (it stopped between saving the code and handing the SMS over).
    for (let i = 0; i < 2; i++) await database.db.insertInto("sms_outbox").values({ sms_id: `sms_crash_${i}_${clock.now.getTime()}`, phone: realSE(), text: "x", kind: "sign_in_code", status: "queued", provider: "fake", created_at: clock.now }).execute();
    sms.next = { accepted: true };
    sms.sent.length = 0;
    const over = await request(realSE());
    expect(over.statusCode).toBe(503);
    expect(over.json().reason).toBe("sms_daily_limit");
    expect(sms.sent).toHaveLength(0);
    // Refusals (an HTTP answer that is not 2xx) do not fill it.
    advance(25 * 3600);
    sms.next = { accepted: false, status: 402 };
    for (let i = 0; i < 12; i++) expect((await request(realSE())).json().reason).toBe("sms_not_sent");
    sms.next = { accepted: true };
    expect((await request(realSE())).statusCode).toBe(200);
  });

  it("a refused SMS is not counted; parallel requests cannot pass the limit together", async () => {
    await setSmsSignIn(database.db, "SE", { enabled: true, dailyCap: 10 }, clock.now);
    sms.next = { accepted: false, status: 403 };
    for (let i = 0; i < 12; i++) expect((await request(realSE())).statusCode).toBe(503);
    sms.next = { accepted: true };
    sms.sent.length = 0;
    const answers = await Promise.all(Array.from({ length: 25 }, () => request(realSE())));
    expect(answers.filter((a) => a.statusCode === 200)).toHaveLength(10);
    expect(answers.filter((a) => a.statusCode === 503 && a.json().reason === "sms_daily_limit")).toHaveLength(15);
    expect(sms.sent).toHaveLength(10);
  });
});

describe("changing the phone number of a signed-in account", () => {
  it("the new real number gets the SMS and its code changes the number", async () => {
    const from = address();
    const old = TEST_PHONES[4]!;
    const challenge = await post("/auth/otp/request", { phone: old, app: "rider" }, from);
    const tokens = (await verify(old, challenge.json().sessionId, TEST_CODE, from)).json();
    const fresh = realSE();
    const start = await post("/account/phone/change", { phone: fresh }, from, app, { authorization: `Bearer ${tokens.accessToken}` });
    expect(start.statusCode).toBe(200);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.to).toBe(fresh);
    const code = sms.lastCode();
    const wrong = await post("/account/phone/verify", { phone: fresh, sessionId: start.json().sessionId, code: wrongCodeFor(code) }, from, app, { authorization: `Bearer ${tokens.accessToken}` });
    expect(wrong.json().reason).toBe("invalid_otp_code");
    const done = await post("/account/phone/verify", { phone: fresh, sessionId: start.json().sessionId, code }, from, app, { authorization: `Bearer ${tokens.accessToken}` });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ phone: fresh });
    // Put the test number back for the other tests.
    await database.db.updateTable("riders").set({ phone: old }).where("phone", "=", fresh).execute();
  });

  it("a number that already has an account: the same answer, no SMS, and about the time of a real send (no telling by the clock)", async () => {
    const from = address();
    // An account with a real number, and a signed-in test rider who asks to change to that number.
    const taken = realSE();
    const first = await request(taken);
    expect((await verify(taken, first.json().sessionId, sms.lastCode())).statusCode).toBe(200);
    const own = TEST_PHONES[1]!;
    const challenge = await post("/auth/otp/request", { phone: own, app: "rider" }, from);
    const tokens = (await verify(own, challenge.json().sessionId, TEST_CODE, from)).json();
    const auth = { authorization: `Bearer ${tokens.accessToken}` };
    sms.delayMs = 250;
    try {
      const freeBegan = Date.now();
      const free = await post("/account/phone/change", { phone: realSE() }, from, app, auth);
      const freeMs = Date.now() - freeBegan;
      expect(free.statusCode).toBe(200);
      const sentBefore = sms.sent.length;
      const takenBegan = Date.now();
      const silent = await post("/account/phone/change", { phone: taken }, from, app, auth);
      const takenMs = Date.now() - takenBegan;
      expect(silent.statusCode).toBe(200);
      expect(Object.keys(silent.json()).sort()).toEqual(Object.keys(free.json()).sort());
      expect(sms.sent.length).toBe(sentBefore);
      expect(freeMs).toBeGreaterThanOrEqual(240);
      expect(takenMs).toBeGreaterThanOrEqual(240);
    } finally {
      sms.delayMs = 0;
    }
  });
});

describe("CountryRules.smsSignIn (the admin setting)", () => {
  it("reads as off with the default limit unless it is exactly valid", () => {
    const defaults = (contract as unknown as { configDefaults: { smsSignIn: { enabled: boolean; dailyCap: number } } }).configDefaults.smsSignIn;
    expect(defaults.enabled).toBe(false);
    expect(smsSignInOf(null)).toEqual({ enabled: false, dailyCap: defaults.dailyCap });
    expect(smsSignInOf({})).toEqual({ enabled: false, dailyCap: defaults.dailyCap });
    expect(smsSignInOf({ smsSignIn: { enabled: 1, dailyCap: 5 } })).toEqual({ enabled: false, dailyCap: defaults.dailyCap });
    expect(smsSignInOf({ smsSignIn: { enabled: true, dailyCap: 1_000_000 } })).toEqual({ enabled: true, dailyCap: defaults.dailyCap });
    expect(smsSignInOf({ smsSignIn: { enabled: true, dailyCap: 50 } })).toEqual({ enabled: true, dailyCap: 50 });
  });

  it("is refused on a zone, with a wrong value, or with another key", () => {
    const reason = (kind: string, document: unknown) => {
      try {
        checkSmsSignIn(kind, document);
        return "ok";
      } catch (error) {
        return (error as { options: { reason: string } }).options.reason;
      }
    };
    expect(reason("standard", { country: "SE" })).toBe("ok");
    expect(reason("standard", { smsSignIn: { enabled: true, dailyCap: 200 } })).toBe("ok");
    expect(reason("standard", { smsSignIn: { enabled: false } })).toBe("ok");
    expect(reason("zone", { smsSignIn: { enabled: false } })).toBe("sms_sign_in_country_only");
    for (const bad of [true, null, [], "on", { enabled: "yes" }, { dailyCap: 9 }, { dailyCap: 100_001 }, { dailyCap: 20.5 }, { dailyCap: "200" }, { enabled: true, username: "x" }]) {
      expect(reason("standard", { smsSignIn: bad }), JSON.stringify(bad)).toBe("invalid_document");
    }
  });

  it("the log mask keeps the calling code and two digits only", () => {
    expect(maskPhone("+46701740777")).toBe("+46…77");
    expect(maskPhone("+21620000002")).toBe("+216…02");
    expect(maskPhone("+4790000001")).toBe("+…01");
  });
});
