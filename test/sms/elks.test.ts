import { describe, expect, it } from "vitest";
import { readEnv } from "../../src/env.js";
import { ELKS_SMS_URL, elksSender, signInSmsFrom, smsStartupWarnings } from "../../src/sms/elks.js";

/** Contract v0.18.135 (contract.json#smsSignIn): the 46elks sender. No test calls 46elks: fetch is a fake. */

type Call = { url: string; init: RequestInit };
const fakeFetch = (calls: Call[], answer: () => Response | Promise<Response>): typeof fetch => (async (url: unknown, init?: RequestInit) => {
  calls.push({ url: String(url), init: init ?? {} });
  return answer();
}) as typeof fetch;

describe("46elks sender", () => {
  it("posts one form to the 46elks SMS address over HTTPS with basic auth, and keeps only the id", async () => {
    const calls: Call[] = [];
    const sender = elksSender({ username: "u-name", password: "p-word", from: "Movera", fetcher: fakeFetch(calls, () => new Response(JSON.stringify({ id: "s70df59406a1b4643b96f3f91e0bfb7b0", to: "+46701740608", status: "created" }), { status: 200 })) });
    const outcome = await sender.send({ to: "+46701740608", text: "Movera: your sign-in code is 4821. Do not share it with anyone." });
    expect(outcome).toEqual({ accepted: true, status: 200, ref: "s70df59406a1b4643b96f3f91e0bfb7b0" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ELKS_SMS_URL);
    expect(ELKS_SMS_URL.startsWith("https://api.46elks.com/")).toBe(true);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Basic ${Buffer.from("u-name:p-word").toString("base64")}`);
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(Object.fromEntries(form)).toEqual({ from: "Movera", to: "+46701740608", message: "Movera: your sign-in code is 4821. Do not share it with anyone.", dontlog: "message" });
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it.each([401, 402, 403, 500])("a %i answer is not accepted", async (status) => {
    const sender = elksSender({ username: "u", password: "p", from: "Movera", fetcher: fakeFetch([], () => new Response("Missing key", { status })) });
    expect(await sender.send({ to: "+46701740608", text: "x" })).toEqual({ accepted: false, status });
  });

  it("a network error or a time-out is not accepted and never throws", async () => {
    const failing = elksSender({ username: "u", password: "p", from: "Movera", fetcher: fakeFetch([], () => Promise.reject(new Error("ECONNRESET to +46701740608"))) });
    expect(await failing.send({ to: "+46701740608", text: "x" })).toEqual({ accepted: false });
    const slow = elksSender({ username: "u", password: "p", from: "Movera", timeoutMs: 30, fetcher: ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch });
    expect(await slow.send({ to: "+46701740608", text: "x" })).toEqual({ accepted: false });
  });

  it("an accepted answer without a usable id still counts as accepted (no ref)", async () => {
    const sender = elksSender({ username: "u", password: "p", from: "Movera", fetcher: fakeFetch([], () => new Response("not json", { status: 200 })) });
    expect(await sender.send({ to: "+46701740608", text: "x" })).toEqual({ accepted: true, status: 200 });
  });
});

describe("the sender from the environment", () => {
  const base = { MOVERA_ENV: "development" };
  it("exists only when BOTH keys are set", () => {
    expect(signInSmsFrom(readEnv(base), "Movera")).toBeUndefined();
    expect(signInSmsFrom(readEnv({ ...base, ELKS_API_USERNAME: "u" }), "Movera")).toBeUndefined();
    expect(signInSmsFrom(readEnv({ ...base, ELKS_API_PASSWORD: "p" }), "Movera")).toBeUndefined();
    expect(signInSmsFrom(readEnv({ ...base, ELKS_API_USERNAME: "  ", ELKS_API_PASSWORD: "p" }), "Movera")).toBeUndefined();
    expect(signInSmsFrom(readEnv({ ...base, ELKS_API_USERNAME: "u", ELKS_API_PASSWORD: "p" }), "Movera")?.name).toBe("46elks");
  });

  it("a half-filled pair or a bad sender name never stops the start: one warning, names only", () => {
    expect(smsStartupWarnings(readEnv(base))).toEqual([]);
    const half = smsStartupWarnings(readEnv({ ...base, ELKS_API_USERNAME: "secret-user-value" }));
    expect(half).toHaveLength(1);
    expect(half[0]).toContain("ELKS_API_PASSWORD");
    expect(half.join(" ")).not.toContain("secret-user-value");
    const name = smsStartupWarnings(readEnv({ ...base, ELKS_API_USERNAME: "u", ELKS_API_PASSWORD: "p", SMS_SENDER_NAME: "a name that is far too long" }));
    expect(name).toHaveLength(1);
    expect(name[0]).toContain("SMS_SENDER_NAME");
  });

  it("uses SMS_SENDER_NAME when 46elks would take it, else the default", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new URLSearchParams(String(init?.body)).get("from") ?? "");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await signInSmsFrom(readEnv({ ...base, ELKS_API_USERNAME: "u", ELKS_API_PASSWORD: "p", SMS_SENDER_NAME: "MoveraSE" }), "Movera")!.send({ to: "+46701740608", text: "x" });
      await signInSmsFrom(readEnv({ ...base, ELKS_API_USERNAME: "u", ELKS_API_PASSWORD: "p", SMS_SENDER_NAME: "+4670 000" }), "Movera")!.send({ to: "+46701740608", text: "x" });
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual(["MoveraSE", "Movera"]);
  });
});
