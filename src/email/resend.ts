import type { Env } from "../env.js";

/**
 * G30b (owner 2026-11-12 Q1 "Resend", contract.json#emailVerified.delivery): the server sends the e-mail change code
 * through Resend's HTTP API. The key lives only in the server's environment (RESEND_API_KEY, set on Render); it is never
 * logged, and neither is the message (it holds the code). `accepted` is true only on a 2xx answer: a refusal (e.g. no own
 * domain yet: Resend then delivers only to the account owner's address), an error or a time-out is not accepted and the
 * caller answers delivery 'pending_provider'. Tests inject a fake sender or a fake fetch: no test calls Resend.
 */

export type EmailMessage = { to: string; subject: string; text: string };
export type EmailOutcome = { accepted: boolean; status?: number };
export interface EmailSender {
  readonly name: string;
  /** Sends one e-mail; never throws. */
  send(message: EmailMessage): Promise<EmailOutcome>;
}

export const RESEND_URL = "https://api.resend.com/emails";
/** Resend's own test sender: works without an own domain (delivers only to the Resend account owner's address). */
export const RESEND_DEFAULT_FROM = "Movera <onboarding@resend.dev>";
export const EMAIL_SEND_TIMEOUT_MS_DEFAULT = 5000;

export function resendSender(options: { apiKey: string; from: string; timeoutMs: number; fetcher?: typeof fetch }): EmailSender & { readonly from: string } {
  const fetcher = options.fetcher ?? fetch;
  return {
    name: "resend",
    from: options.from,
    async send(message) {
      try {
        const response = await fetcher(RESEND_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from: options.from, to: [message.to], subject: message.subject, text: message.text }),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        // The answer body is not read into any log (it may echo the address).
        await response.body?.cancel().catch(() => undefined);
        return { accepted: response.status >= 200 && response.status < 300, status: response.status };
      } catch {
        return { accepted: false };
      }
    },
  };
}

/** The sender the environment asks for: Resend when RESEND_API_KEY is set, else none (delivery stays pending_provider). */
export function emailSenderFrom(env: Pick<Env, "RESEND_API_KEY" | "EMAIL_FROM" | "EMAIL_SEND_TIMEOUT_MS">): (EmailSender & { readonly from: string }) | undefined {
  if (env.RESEND_API_KEY === undefined) return undefined;
  return resendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM ?? RESEND_DEFAULT_FROM, timeoutMs: env.EMAIL_SEND_TIMEOUT_MS });
}
