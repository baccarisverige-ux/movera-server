import type { Env } from "../env.js";

/**
 * Contract v0.18.135 (contract.json#smsSignIn; owner 2026-11-19 "Yes, build it now (Rec.)", SMS company 46elks per
 * owner 2026-11-02, Rules decisions/servers-test-live.md): the sign-in code SMS goes out through 46elks' HTTPS API
 * (POST /a1/sms, basic auth, form body). The two keys live only in the server's environment (ELKS_API_USERNAME,
 * ELKS_API_PASSWORD, set by the owner on Render); they are never logged, and neither is the message (it holds the
 * code) or the number. `dontlog=message` asks 46elks not to keep the text in its own history either.
 * `accepted` is true only on a 2xx answer; a refusal, an error or a time-out is not accepted (the caller answers
 * 503 sms_not_sent). One try, no retry here: the person asks again. Tests inject a fake sender or a fake fetch:
 * no test calls 46elks.
 */

export type CodeSms = { to: string; text: string };
export type CodeSmsOutcome = { accepted: boolean; status?: number; ref?: string };
export interface CodeSmsSender {
  readonly name: string;
  /** Hands one SMS to the SMS company; never throws. */
  send(message: CodeSms): Promise<CodeSmsOutcome>;
}

export const ELKS_SMS_URL = "https://api.46elks.com/a1/sms";
export const SMS_SEND_TIMEOUT_MS = 8000;
/** What 46elks takes as a text sender: 3-11 letters and digits, starting with a letter. */
export const SENDER_NAME = /^[A-Za-z][A-Za-z0-9]{2,10}$/;
const REF = /^[A-Za-z0-9_-]{1,80}$/;

export function elksSender(options: { username: string; password: string; from: string; timeoutMs?: number; fetcher?: typeof fetch }): CodeSmsSender {
  const fetcher = options.fetcher ?? fetch;
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`, "utf8").toString("base64")}`;
  return {
    name: "46elks",
    async send(message) {
      try {
        const response = await fetcher(ELKS_SMS_URL, {
          method: "POST",
          headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ from: options.from, to: message.to, message: message.text, dontlog: "message" }).toString(),
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs ?? SMS_SEND_TIMEOUT_MS),
        });
        const accepted = response.status >= 200 && response.status < 300;
        let ref: string | undefined;
        if (accepted) {
          // Only the id is kept; the rest of the answer (it echoes the number) is never stored or logged.
          const id = ((await response.json().catch(() => null)) as { id?: unknown } | null)?.id;
          if (typeof id === "string" && REF.test(id)) ref = id;
        } else {
          await response.body?.cancel().catch(() => undefined);
        }
        return { accepted, status: response.status, ...(ref !== undefined ? { ref } : {}) };
      } catch {
        return { accepted: false };
      }
    },
  };
}

type ElksEnv = Pick<Env, "ELKS_API_USERNAME" | "ELKS_API_PASSWORD" | "SMS_SENDER_NAME">;
const set = (value: string | undefined): string | undefined => (value !== undefined && value.trim() !== "" ? value.trim() : undefined);

/** The sender the environment asks for: 46elks when BOTH keys are set, else none (every real number stays sign_in_restricted). */
export function signInSmsFrom(env: ElksEnv, defaultSender: string): CodeSmsSender | undefined {
  const username = set(env.ELKS_API_USERNAME);
  const password = set(env.ELKS_API_PASSWORD);
  if (username === undefined || password === undefined) return undefined;
  const asked = set(env.SMS_SENDER_NAME);
  return elksSender({ username, password, from: asked !== undefined && SENDER_NAME.test(asked) ? asked : defaultSender });
}

/** Start-up warnings (names only, never a value): half a key pair, or a sender name 46elks would refuse. */
export function smsStartupWarnings(env: ElksEnv): string[] {
  const out: string[] = [];
  const username = set(env.ELKS_API_USERNAME);
  const password = set(env.ELKS_API_PASSWORD);
  if ((username === undefined) !== (password === undefined)) out.push("Only one of ELKS_API_USERNAME and ELKS_API_PASSWORD is set: real SMS sign-in codes stay off until both are set.");
  const asked = set(env.SMS_SENDER_NAME);
  if (asked !== undefined && !SENDER_NAME.test(asked)) out.push("SMS_SENDER_NAME is not 3-11 letters and digits starting with a letter: the default sender name is used.");
  return out;
}
