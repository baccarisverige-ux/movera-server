import { describe, expect, it } from "vitest";
import { readEnv } from "../../src/env.js";
import type { CodeSms, CodeSmsOutcome, CodeSmsSender } from "../../src/sms/elks.js";
import { INFOBIP_SMS_PATH, infobipOrigin, infobipSender } from "../../src/sms/infobip.js";
import { DEFAULT_SMS_ORDER, chainSender, infobipSenderFrom, infobipStartupWarnings, providerOrderOk, smsSenderFrom } from "../../src/sms/providers.js";
import { checkSmsSignIn, checkSmsSignInOther, smsSignInOf, smsSignInOtherOf } from "../../src/auth/smsSignIn.js";

/** Contract v0.18.168 (contract.json#smsProviders): Infobip first, 46elks as backup. No test calls a real SMS company. */

type Call = { url: string; init: RequestInit };
const fakeFetch = (calls: Call[], answer: () => Response | Promise<Response>): typeof fetch => (async (url: unknown, init?: RequestInit) => {
  calls.push({ url: String(url), init: init ?? {} });
  return answer();
}) as typeof fetch;
const CODE_TEXT = "Movera: your sign-in code is 482193. Do not share it with anyone.";
const fake = (name: string, answers: CodeSmsOutcome[] | "throw"): CodeSmsSender & { sent: CodeSms[] } => {
  const sent: CodeSms[] = [];
  return {
    name,
    sent,
    async send(message) {
      sent.push(message);
      if (answers === "throw") throw new Error("boom +46701740608");
      return answers.shift() ?? { accepted: false };
    },
  };
};
const base = { MOVERA_ENV: "development" } as Record<string, string>;

describe("Infobip sender", () => {
  it("posts JSON to {base}/sms/2/text/advanced with App auth, the number without +, and keeps only the id", async () => {
    const calls: Call[] = [];
    const sender = infobipSender({ origin: "https://abc123.api.infobip.com", apiKey: "k-e-y", from: "Movera", fetcher: fakeFetch(calls, () => new Response(JSON.stringify({ bulkId: "b", messages: [{ messageId: "msg-123_ab", to: "46701740608", status: { groupId: 1, groupName: "PENDING" } }] }), { status: 200 })) });
    expect(await sender.send({ to: "+46701740608", text: CODE_TEXT })).toEqual({ accepted: true, status: 200, ref: "msg-123_ab" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://abc123.api.infobip.com${INFOBIP_SMS_PATH}`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("App k-e-y");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ messages: [{ destinations: [{ to: "46701740608" }], from: "Movera", text: CODE_TEXT }] });
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it.each([400, 401, 403, 429, 500, 503])("a %i answer is not accepted", async (status) => {
    const sender = infobipSender({ origin: "https://x.api.infobip.com", apiKey: "k", from: "Movera", fetcher: fakeFetch([], () => new Response("{}", { status })) });
    expect(await sender.send({ to: "+46701740608", text: "x" })).toEqual({ accepted: false, status });
  });

  it("a 200 whose message is REJECTED is not accepted; a 200 with an odd body is accepted (no double send)", async () => {
    const rejected = infobipSender({ origin: "https://x.api.infobip.com", apiKey: "k", from: "Movera", fetcher: fakeFetch([], () => new Response(JSON.stringify({ messages: [{ messageId: "m", status: { groupName: "REJECTED" } }] }), { status: 200 })) });
    expect(await rejected.send({ to: "+46701740608", text: "x" })).toEqual({ accepted: false, status: 200 });
    const odd = infobipSender({ origin: "https://x.api.infobip.com", apiKey: "k", from: "Movera", fetcher: fakeFetch([], () => new Response("not json", { status: 200 })) });
    expect(await odd.send({ to: "+46701740608", text: "x" })).toEqual({ accepted: true, status: 200 });
  });

  it("a network error or a time-out is not accepted and never throws", async () => {
    const failing = infobipSender({ origin: "https://x.api.infobip.com", apiKey: "k", from: "Movera", fetcher: fakeFetch([], () => Promise.reject(new Error("ECONNRESET"))) });
    expect(await failing.send({ to: "+46701740608", text: "x" })).toEqual({ accepted: false });
    const slow = infobipSender({ origin: "https://x.api.infobip.com", apiKey: "k", from: "Movera", timeoutMs: 30, fetcher: ((_u: unknown, init?: RequestInit) => new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch });
    expect(await slow.send({ to: "+46701740608", text: "x" })).toEqual({ accepted: false });
  });

  it("takes the account address with or without https://, refuses anything else", () => {
    expect(infobipOrigin("abc.api.infobip.com")).toBe("https://abc.api.infobip.com");
    expect(infobipOrigin("https://abc.api.infobip.com/")).toBe("https://abc.api.infobip.com");
    for (const bad of ["", "http://abc.api.infobip.com", "https://abc.api.infobip.com/sms", "https://u:p@abc.api.infobip.com", "localhost", "abc.api.infobip.com?x=1"]) expect(infobipOrigin(bad)).toBeUndefined();
  });
});

describe("company order and backup", () => {
  it("default order is Infobip then 46elks", () => {
    expect(DEFAULT_SMS_ORDER).toEqual(["infobip", "46elks"]);
  });

  it("Infobip took it: 46elks is never asked (no double send)", async () => {
    const infobip = fake("infobip", [{ accepted: true, status: 200, ref: "i1" }]);
    const elks = fake("46elks", [{ accepted: true, status: 200, ref: "e1" }]);
    const out = await chainSender({ infobip, "46elks": elks })!.send({ to: "+46701740608", text: CODE_TEXT });
    expect(out).toEqual({ accepted: true, status: 200, ref: "i1", provider: "infobip" });
    expect(infobip.sent).toHaveLength(1);
    expect(elks.sent).toHaveLength(0);
  });

  it.each<[string, CodeSmsOutcome[] | "throw"]>([["5xx", [{ accepted: false, status: 503 }]], ["auth", [{ accepted: false, status: 401 }]], ["time-out / network", [{ accepted: false }]], ["a throwing sender", "throw"]])("Infobip failed (%s): the same SMS goes once to 46elks", async (_label, answer) => {
    const infobip = fake("infobip", answer);
    const elks = fake("46elks", [{ accepted: true, status: 200, ref: "e1" }]);
    const out = await chainSender({ infobip, "46elks": elks })!.send({ to: "+46701740608", text: CODE_TEXT });
    expect(out).toEqual({ accepted: true, status: 200, ref: "e1", provider: "46elks", backup: true });
    expect(elks.sent).toEqual([{ to: "+46701740608", text: CODE_TEXT }]);
    expect(infobip.sent).toHaveLength(1);
  });

  it("both failed: not accepted, the last company is named, each was tried once", async () => {
    const infobip = fake("infobip", [{ accepted: false, status: 500 }]);
    const elks = fake("46elks", [{ accepted: false, status: 402 }]);
    expect(await chainSender({ infobip, "46elks": elks })!.send({ to: "+46701740608", text: "x" })).toEqual({ accepted: false, status: 402, provider: "46elks", backup: true });
    expect(infobip.sent).toHaveLength(1);
    expect(elks.sent).toHaveLength(1);
  });

  it("the country's order is followed: 46elks first, or one company alone", async () => {
    const infobip = fake("infobip", [{ accepted: true }]);
    const elks = fake("46elks", [{ accepted: true }, { accepted: false }]);
    const chain = chainSender({ infobip, "46elks": elks })!;
    expect((await chain.send({ to: "+46701740608", text: "x", order: ["46elks", "infobip"] })).provider).toBe("46elks");
    expect(infobip.sent).toHaveLength(0);
    expect(await chain.send({ to: "+46701740608", text: "x", order: ["46elks"] })).toEqual({ accepted: false, provider: "46elks" });
    expect(infobip.sent).toHaveLength(0);
  });

  it("only one company has keys: that one alone, whatever the order", async () => {
    const elks = fake("46elks", [{ accepted: true }, { accepted: true }]);
    const chain = chainSender({ "46elks": elks })!;
    expect(chain.name).toBe("46elks");
    expect((await chain.send({ to: "+46701740608", text: "x" })).provider).toBe("46elks");
    expect((await chain.send({ to: "+46701740608", text: "x", order: ["infobip"] })).provider).toBe("46elks");
    expect(chainSender({})).toBeUndefined();
  });
});

describe("server keys (names only)", () => {
  const ib = { INFOBIP_BASE_URL: "abc.api.infobip.com", INFOBIP_API_KEY: "secret-key-value" };
  const el = { ELKS_API_USERNAME: "u", ELKS_API_PASSWORD: "p" };
  it("picks every company with keys; none = no sender", () => {
    expect(smsSenderFrom(readEnv(base), "Movera")).toBeUndefined();
    expect(smsSenderFrom(readEnv({ ...base, ...ib }), "Movera")?.name).toBe("infobip");
    expect(smsSenderFrom(readEnv({ ...base, ...el }), "Movera")?.name).toBe("46elks");
    expect(smsSenderFrom(readEnv({ ...base, ...ib, ...el }), "Movera")?.name).toBe("infobip");
    expect(smsSenderFrom(readEnv({ ...base, INFOBIP_BASE_URL: "abc.api.infobip.com" }), "Movera")).toBeUndefined();
    expect(smsSenderFrom(readEnv({ ...base, INFOBIP_BASE_URL: "http://abc.api.infobip.com", INFOBIP_API_KEY: "k", ...el }), "Movera")?.name).toBe("46elks");
  });

  it("start-up warnings name the variable, never its value", () => {
    expect(infobipStartupWarnings(readEnv(base))).toEqual([]);
    expect(infobipStartupWarnings(readEnv({ ...base, ...ib }))).toEqual([]);
    const half = infobipStartupWarnings(readEnv({ ...base, INFOBIP_API_KEY: "secret-key-value" }));
    expect(half).toHaveLength(1);
    expect(half.join(" ")).toContain("INFOBIP_BASE_URL");
    expect(half.join(" ")).not.toContain("secret-key-value");
    expect(infobipStartupWarnings(readEnv({ ...base, INFOBIP_BASE_URL: "http://nope", INFOBIP_API_KEY: "secret-key-value" })).join(" ")).not.toContain("secret-key-value");
  });

  it("uses SMS_SENDER_NAME for Infobip too", async () => {
    const calls: Call[] = [];
    const ok = () => new Response("{}", { status: 200 });
    await infobipSenderFrom(readEnv({ ...base, ...ib, SMS_SENDER_NAME: "MoveraSE" }), "Movera", fakeFetch(calls, ok))!.send({ to: "+46701740608", text: "x" });
    await infobipSenderFrom(readEnv({ ...base, ...ib, SMS_SENDER_NAME: "+4670 000" }), "Movera", fakeFetch(calls, ok))!.send({ to: "+46701740608", text: "x" });
    expect(calls.map((c) => JSON.parse(String(c.init.body)).messages[0].from)).toEqual(["MoveraSE", "Movera"]);
  });
});

describe("providerOrder setting", () => {
  it("reads the default when missing or wrong, the stored order when right", () => {
    expect(smsSignInOf({}).providerOrder).toEqual(["infobip", "46elks"]);
    expect(smsSignInOf({ smsSignIn: { providerOrder: ["46elks"] } }).providerOrder).toEqual(["46elks"]);
    expect(smsSignInOf({ smsSignIn: { providerOrder: ["twilio"] } }).providerOrder).toEqual(["infobip", "46elks"]);
    expect(smsSignInOtherOf({ smsSignInOtherCountries: { providerOrder: ["46elks", "infobip"] } }).providerOrder).toEqual(["46elks", "infobip"]);
    expect(smsSignInOtherOf({}).providerOrder).toEqual(["infobip", "46elks"]);
  });

  it("PUT refuses a wrong order", () => {
    expect(providerOrderOk(["infobip", "46elks"])).toBe(true);
    for (const bad of [[], ["infobip", "infobip"], ["x"], ["infobip", "46elks", "infobip"], "infobip"]) {
      expect(providerOrderOk(bad)).toBe(false);
      expect(() => checkSmsSignIn("standard", { smsSignIn: { providerOrder: bad } })).toThrow(/providerOrder/);
      expect(() => checkSmsSignInOther("standard", "SE", { smsSignInOtherCountries: { providerOrder: bad } })).toThrow(/providerOrder/);
    }
    expect(() => checkSmsSignIn("standard", { smsSignIn: { enabled: true, providerOrder: ["46elks", "infobip"] } })).not.toThrow();
    expect(() => checkSmsSignInOther("standard", "SE", { smsSignInOtherCountries: { providerOrder: ["infobip"] } })).not.toThrow();
  });
});
