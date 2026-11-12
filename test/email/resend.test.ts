import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { RESEND_URL, emailSenderFrom, resendSender } from "../../src/email/resend.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * G30b (owner Q1 "Resend", contract.json#emailVerified.delivery): the code goes out through Resend's HTTP API with the
 * key from the server's environment. No test calls Resend: every fetch here is a fake.
 */

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: (call: Call) => Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, fetcher };
}
const KEY = "re_test_0123456789abcdef";
const message = { to: "anna@example.se", subject: "Your Movera code", text: "Your Movera code is 1234." };

describe("G30b: Resend sender", () => {
  it("POSTs the e-mail to Resend with the Bearer key, the from-address and a time-out; 2xx = accepted", async () => {
    const { calls, fetcher } = fakeFetch(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    const sender = resendSender({ apiKey: KEY, from: "Movera <codes@example.se>", timeoutMs: 4000, fetcher });
    expect(await sender.send(message)).toEqual({ accepted: true, status: 200 });
    expect(RESEND_URL).toBe("https://api.resend.com/emails");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RESEND_URL);
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ from: "Movera <codes@example.se>", to: ["anna@example.se"], subject: "Your Movera code", text: "Your Movera code is 1234." });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a refusal (no own domain: 403), a server error or a network error is not accepted and never throws", async () => {
    for (const status of [403, 422, 429, 500]) {
      const { fetcher } = fakeFetch(async () => new Response("{}", { status }));
      expect(await resendSender({ apiKey: KEY, from: "a@b.se", timeoutMs: 1000, fetcher }).send(message)).toEqual({ accepted: false, status });
    }
    const { fetcher } = fakeFetch(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await resendSender({ apiKey: KEY, from: "a@b.se", timeoutMs: 1000, fetcher }).send(message)).toEqual({ accepted: false });
  });

  it("a send that takes longer than the time-out is not accepted", async () => {
    const { fetcher } = fakeFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        }),
    );
    const started = Date.now();
    expect(await resendSender({ apiKey: KEY, from: "a@b.se", timeoutMs: 50, fetcher }).send(message)).toEqual({ accepted: false });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("from the environment: none without RESEND_API_KEY; the default from-address is Resend's onboarding sender; EMAIL_FROM overrides", () => {
    const base = { MOVERA_ENV: "development" } as const;
    expect(emailSenderFrom(readEnv(base))).toBeUndefined();
    const sender = emailSenderFrom(readEnv({ ...base, RESEND_API_KEY: KEY }));
    expect(sender?.name).toBe("resend");
    expect(sender?.from).toBe("Movera <onboarding@resend.dev>");
    expect(emailSenderFrom(readEnv({ ...base, RESEND_API_KEY: KEY, EMAIL_FROM: "Movera <codes@example.se>" }))?.from).toBe("Movera <codes@example.se>");
    expect(readEnv({ ...base, RESEND_API_KEY: KEY }).EMAIL_SEND_TIMEOUT_MS).toBe(5000);
  });
});

describe("G30b: neither the code nor the key reaches the server log (B1.27 rule)", () => {
  let database: TestDatabase;
  const lines: string[] = [];
  const clock = { now: new Date("2026-11-12T16:00:00Z") };
  let sentBody = "";
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    database = await freshDatabase();
    await seedTestPhones(database.db);
    const stream = new Writable({ write: (chunk, _enc, done) => (lines.push(String(chunk)), done()) });
    const { fetcher } = fakeFetch(async (call) => {
      sentBody = String(call.init.body);
      return new Response(JSON.stringify({ id: "em_2" }), { status: 200 });
    });
    const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "g30b-logs".padEnd(48, "l"), RESEND_API_KEY: KEY, LOG_LEVEL: "trace" });
    app = await buildApp({ env, logger: { stream }, db: database.db, clock: () => clock.now, email: resendSender({ apiKey: KEY, from: "Movera <onboarding@resend.dev>", timeoutMs: 1000, fetcher }) } as Parameters<typeof buildApp>[0]);
  });
  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  it("a code sent through Resend on staging is not logged, and the key never is", async () => {
    const phone = "+46701740605";
    const c = (await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone, app: "rider" } })).json();
    const tokens = (await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone, sessionId: c.sessionId, code: TEST_CODE } })).json();
    const start = await app.inject({ method: "POST", url: "/api/v1/account/email/change", headers: { authorization: `Bearer ${tokens.accessToken}`, "content-type": "application/json" }, payload: { email: "logs@example.se" } });
    expect(start.json()).toMatchObject({ delivery: "sent" });
    const code = /\b(\d{4})\b/.exec(JSON.parse(sentBody).text as string)?.[1];
    expect(code).toBeDefined();
    const log = lines.join("");
    expect(log).not.toContain("e-mail change code");
    expect(log).not.toMatch(new RegExp(`"code":"${code}"`));
    expect(log).not.toContain(KEY);
  });
});
