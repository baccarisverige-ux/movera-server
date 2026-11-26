import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readEnv } from "../../src/env.js";
import type { CodeSms, CodeSmsOutcome, CodeSmsSender } from "../../src/sms/elks.js";
import { chainSender } from "../../src/sms/providers.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { setSmsSignIn } from "../support/smsSignIn.js";

/**
 * Contract v0.18.168 (contract.json#smsProviders; owner 2026-11-26 "Infobip + 46elks en secours (Recommandé)"): the
 * sign-in SMS goes through Infobip first, 46elks only when Infobip did not take it; sms_outbox.provider is the company
 * that sent it; the country's providerOrder is followed; the log never holds the code or the number. Fakes only.
 */

class Company implements CodeSmsSender {
  sent: CodeSms[] = [];
  next: CodeSmsOutcome = { accepted: true, status: 200 };
  constructor(readonly name: string) {}
  async send(message: CodeSms): Promise<CodeSmsOutcome> {
    this.sent.push(message);
    return { ...this.next, ...(this.next.accepted ? { ref: `${this.name}-ref` } : {}) };
  }
}

let database: TestDatabase;
let app: FastifyInstance;
const infobip = new Company("infobip");
const elks = new Company("46elks");
const clock = { now: new Date("2026-11-26T09:00:00Z") };
const logLines: string[] = [];
let n = 0;
const realSE = () => `+467017${52000 + ++n}`;

beforeAll(async () => {
  database = await freshDatabase();
  const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "sms-providers".padEnd(48, "s"), RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: "0", RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: "0" });
  const stream = new Writable({ write: (chunk, _enc, done) => (logLines.push(String(chunk)), done()) });
  app = await buildApp({ env, logger: { stream }, db: database.db, clock: () => clock.now, signInSms: chainSender({ infobip, "46elks": elks })! });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  clock.now = new Date(clock.now.getTime() + 25 * 3_600_000);
  infobip.sent.length = 0;
  elks.sent.length = 0;
  infobip.next = { accepted: true, status: 200 };
  elks.next = { accepted: true, status: 200 };
  logLines.length = 0;
  await setSmsSignIn(database.db, "SE", { enabled: true }, clock.now);
});

const request = (phone: string) => app.inject({ method: "POST", url: "/api/v1/auth/otp/request", remoteAddress: `198.51.100.${n % 250}`, headers: { "content-type": "application/json" }, payload: { phone, app: "rider" } });
const row = (phone: string) => database.db.selectFrom("sms_outbox").selectAll().where("phone", "=", phone).executeTakeFirstOrThrow();
const codeOf = (message: CodeSms) => /(\d{6})/.exec(message.text)![1]!;

describe("Infobip first, 46elks as backup", () => {
  it("Infobip took it: one SMS, 46elks never asked, sms_outbox says infobip", async () => {
    const phone = realSE();
    expect((await request(phone)).statusCode).toBe(200);
    expect(infobip.sent).toHaveLength(1);
    expect(elks.sent).toHaveLength(0);
    expect(await row(phone)).toMatchObject({ status: "sent", provider: "infobip", provider_ref: "infobip-ref" });
  });

  it("Infobip failed: the same SMS goes once by 46elks, the log names the backup but never the code or the number", async () => {
    infobip.next = { accepted: false, status: 503 };
    const phone = realSE();
    expect((await request(phone)).statusCode).toBe(200);
    expect(elks.sent).toEqual([{ to: phone, text: infobip.sent[0]!.text }]);
    expect(await row(phone)).toMatchObject({ status: "sent", provider: "46elks", provider_ref: "46elks-ref" });
    const log = logLines.join("\n");
    expect(log).toContain("backup SMS company");
    expect(log).not.toContain(codeOf(elks.sent[0]!));
    expect(log).not.toContain(phone);
  });

  it("both failed: 503 sms_not_sent, each tried once, the row names the last one, no code or number in the log", async () => {
    infobip.next = { accepted: false };
    elks.next = { accepted: false, status: 500 };
    const phone = realSE();
    const res = await request(phone);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ reason: "sms_not_sent" });
    expect(infobip.sent).toHaveLength(1);
    expect(elks.sent).toHaveLength(1);
    expect(await row(phone)).toMatchObject({ status: "failed", provider: "46elks", error: "http_500" });
    const log = logLines.join("\n");
    expect(log).not.toContain(codeOf(infobip.sent[0]!));
    expect(log).not.toContain(phone);
  });

  it("the country's providerOrder is followed (46elks first, or 46elks alone)", async () => {
    await setSmsSignIn(database.db, "SE", { enabled: true, providerOrder: ["46elks", "infobip"] }, clock.now);
    const first = realSE();
    expect((await request(first)).statusCode).toBe(200);
    expect(infobip.sent).toHaveLength(0);
    expect(await row(first)).toMatchObject({ provider: "46elks" });
    await setSmsSignIn(database.db, "SE", { enabled: true, providerOrder: ["46elks"] }, clock.now);
    elks.next = { accepted: false, status: 500 };
    expect((await request(realSE())).statusCode).toBe(503);
    expect(infobip.sent).toHaveLength(0);
  });
});
