import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sweepAlerts } from "../../src/alerts/detector.js";
import { otherCountryMobile, smsSignInOtherOf } from "../../src/auth/smsSignIn.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { FakeCodeSms } from "../support/smsSignIn.js";

/**
 * Contract v0.18.157 (contract.json#smsSignIn.otherCountries; owner 2026-11-24 "SMS sign-in codes must work for ANY
 * phone number from ANY country"): one switch and one daily limit for every number whose country is not served here.
 * The server serves Sweden only in this test (FR / TN have no country standard). The SMS company is a fake.
 */
let database: TestDatabase;
let app: FastifyInstance;
const sms = new FakeCodeSms();
const clock = { now: new Date("2026-11-24T09:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
let n = 0;
let k = 0;
const address = () => `198.51.${Math.floor(++n / 250)}.${n % 250}`;
const tn = () => `+2162012${String(3000 + ++k)}`; // Tunisia mobile (2x xxx xxx)
const de = () => `+4915112${String(340000 + ++k)}`; // Germany mobile (151 ...)
const se = () => `+467017${String(51000 + ++k)}`;
let version = 500;

/** Publishes the Sweden standard with its own switch and the other-countries setting (undefined = left out). */
async function publishSE(smsSignIn: unknown, other: unknown): Promise<void> {
  const document = JSON.stringify({ country: "SE", ...(smsSignIn === undefined ? {} : { smsSignIn }), ...(other === undefined ? {} : { smsSignInOtherCountries: other }) });
  await database.db
    .insertInto("config_live")
    .values({ doc: "country_rules", zone_id: "standard-SE", version: ++version, document, published_at: clock.now, published_by: null })
    .onConflict((oc) => oc.columns(["doc", "zone_id"]).doUpdateSet({ version, document, published_at: clock.now }))
    .execute();
}

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "sms-other".padEnd(48, "o"), RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: "0", RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: "0" });
  app = await buildApp({ env, logger: false, db: database.db, clock: () => clock.now, signInSms: sms });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  advance(25 * 3600);
  sms.sent.length = 0;
  sms.next = { accepted: true, ref: "fake-ref" };
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").where("zone_id", "in", ["standard-FR", "standard-TN"]).execute();
  await publishSE({ enabled: true }, undefined);
});

const request = (phone: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/api/v1/auth/otp/request", remoteAddress: address(), headers: { "content-type": "application/json" }, payload: { phone, app: "rider", ...extra } });

describe("numbers from other countries (a Tunisian and a German visitor in Sweden)", () => {
  it("default ON for the rider app (owner 2026-11-24): never saved, a +216 and a +49 number get a code; the driver app does not", async () => {
    expect(smsSignInOtherOf(undefined)).toEqual({ enabled: true, dailyCap: 50, perCodeDailyCap: 10, perMinuteCap: 30, blockedCallingCodes: [], providerOrder: ["infobip", "46elks"] });
    for (const phone of [tn(), de()]) expect((await request(phone)).statusCode, phone).toBe(200);
    const driver = await request(de(), { app: "driver" });
    expect(driver.statusCode).toBe(403);
    expect(driver.json().reason).toBe("sign_in_restricted");
    expect(sms.sent).toHaveLength(2);
  });

  it("switch off: +216 and +49 numbers are sign_in_restricted and nothing is sent", async () => {
    await publishSE({ enabled: true }, { enabled: false, dailyCap: 50 });
    for (const phone of [tn(), de()]) {
      const res = await request(phone);
      expect(res.statusCode, phone).toBe(403);
      expect(res.json()).toMatchObject({ code: "forbidden", reason: "sign_in_restricted" });
    }
    expect(sms.sent).toEqual([]);
  });

  it("switch on: a code is sent to +216 and +49, in the request locale, else English, from the same sender", async () => {
    await publishSE({ enabled: true }, { enabled: true });
    const t = tn();
    const a = await request(t, { locale: "fr" });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().codeLength).toBe(6);
    const d = de();
    const b = await request(d);
    expect(b.statusCode, b.body).toBe(200);
    expect(sms.sent.map((m) => m.to)).toEqual([t, d]);
    expect(sms.sent[0]!.text).toContain("votre code de connexion");
    expect(sms.sent[1]!.text).toContain("your sign-in code");
    // The code signs in.
    const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", remoteAddress: address(), headers: { "content-type": "application/json" }, payload: { phone: d, sessionId: b.json().sessionId, code: sms.lastCode() } });
    expect(verify.statusCode, verify.body).toBe(200);
  });

  it("a served country keeps its own switch: Sweden off stays off even with other countries on", async () => {
    await publishSE({ enabled: false }, { enabled: true });
    const res = await request(se());
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("sign_in_restricted");
    expect(sms.sent).toEqual([]);
  });

  it("a landline or a number that is not valid E.164 is refused and nothing is sent", async () => {
    await publishSE({ enabled: true }, { enabled: true });
    // Berlin landline, Tunis landline, too short, UK landline.
    for (const phone of ["+493012345678", "+21671123456", "+4912345", "+442071234567"]) {
      const res = await request(phone);
      expect(res.statusCode, phone).toBe(403);
      expect(res.json().reason, phone).toBe("sign_in_restricted");
    }
    expect((await request("+49 151 1234")).statusCode).toBe(400);
    expect(sms.sent).toEqual([]);
    expect(otherCountryMobile("+12025550123")).toBe(true);
    expect(otherCountryMobile("+8613812345678")).toBe(true); // an unknown type passes on its E.164 shape
    expect(otherCountryMobile("+4915112345678")).toBe(true);
    expect(otherCountryMobile("+0123456789")).toBe(false);
  });

  it("the daily cap of all other countries together: at the cap refused (503 sms_daily_limit) with admin alerts; Sweden goes on", async () => {
    await publishSE({ enabled: true }, { enabled: true, dailyCap: 10 });
    const sweep = async () => {
      await database.db.transaction().execute((trx) => sweepAlerts(trx, clock.now, "system"));
      return database.db.selectFrom("admin_alerts_live").select(["cause_key", "level", "state", "title"]).where("cause_key", "like", "system_health:sms_cap%:other").where("state", "=", "open").execute();
    };
    for (let i = 0; i < 8; i++) expect((await request(i % 2 === 0 ? tn() : de())).statusCode).toBe(200);
    const near = await sweep();
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ cause_key: "system_health:sms_cap_near:other", level: "important" });
    for (let i = 0; i < 2; i++) expect((await request(de())).statusCode).toBe(200);
    const over = await request(tn());
    expect(over.statusCode).toBe(503);
    expect(over.json()).toMatchObject({ code: "unavailable", reason: "sms_daily_limit" });
    const reached = await sweep();
    expect(reached).toHaveLength(1);
    expect(reached[0]).toMatchObject({ cause_key: "system_health:sms_cap:other", level: "critical" });
    expect(reached[0]!.title).toContain("10 of 10");
    // Sweden has its own count.
    expect((await request(se())).statusCode).toBe(200);
    expect(sms.sent).toHaveLength(11);
  });

  it("the per-number limits still apply (resend wait)", async () => {
    await publishSE({ enabled: true }, { enabled: true });
    const phone = de();
    expect((await request(phone)).statusCode).toBe(200);
    const again = await request(phone);
    expect(again.statusCode).toBe(429);
    expect(again.json().reason).toBe("otp_resend_too_soon");
  });
});

describe("anti SMS pumping guards (46elks AIT advice, contract smsSignIn.otherCountries.guards)", () => {
  const openAlerts = async (like: string) => {
    await database.db.transaction().execute((trx) => sweepAlerts(trx, clock.now, "system"));
    return database.db.selectFrom("admin_alerts_live").select(["cause_key", "level", "title"]).where("cause_key", "like", like).where("state", "=", "open").execute();
  };

  it("per calling code: at perCodeDailyCap one code is stopped (503 sms_daily_limit) with a spike alert; other codes go on", async () => {
    await publishSE({ enabled: true }, { enabled: true, perCodeDailyCap: 3 });
    for (let i = 0; i < 3; i++) expect((await request(de())).statusCode).toBe(200);
    const over = await request(de());
    expect(over.statusCode).toBe(503);
    expect(over.json().reason).toBe("sms_daily_limit");
    expect((await request(tn())).statusCode).toBe(200);
    const spike = await openAlerts("system_health:sms_cap:other:%");
    expect(spike.map((a) => a.cause_key)).toEqual(["system_health:sms_cap:other:+49"]);
  });

  it("a blocked calling code is sign_in_restricted and nothing is sent; the list is empty by default", async () => {
    await publishSE({ enabled: true }, { enabled: true, blockedCallingCodes: ["+216"] });
    const res = await request(tn());
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("sign_in_restricted");
    expect((await request(de())).statusCode).toBe(200);
    expect(sms.sent).toHaveLength(1);
  });

  it("the burst limit counts every sign-in SMS of the server per minute (Sweden too), with a critical alert", async () => {
    await publishSE({ enabled: true }, { enabled: true, perMinuteCap: 2 });
    expect((await request(se())).statusCode).toBe(200);
    expect((await request(de())).statusCode).toBe(200);
    const over = await request(se());
    expect(over.statusCode).toBe(503);
    expect(over.json().reason).toBe("sms_daily_limit");
    expect(Number(over.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect((await openAlerts("system_health:sms_burst")).map((a) => a.level)).toEqual(["critical"]);
    advance(61);
    expect((await request(tn())).statusCode).toBe(200);
  });
});
