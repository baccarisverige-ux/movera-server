import type { CodeSmsSender } from "./elks.js";
import { SMS_SEND_TIMEOUT_MS } from "./elks.js";

/**
 * Contract v0.18.168 (contract.json#smsProviders.infobip; owner 2026-11-26 "Am going to change company sms to infobip",
 * then "Infobip + 46elks en secours (Recommandé)"): one SMS through Infobip's HTTP API, POST
 * {INFOBIP_BASE_URL}/sms/2/text/advanced with `Authorization: App <key>` and a JSON body. The base URL is the account's
 * own address (like xxxxx.api.infobip.com) and the key live only in the server's environment; neither is ever logged,
 * and neither is the message (it holds the code) or the number. Same rules as the 46elks sender (sms/elks.ts): never
 * throws, one try, short time limit, only the message id is kept. Accepted only on a 2xx whose message status group is
 * not REJECTED. Tests inject a fake fetch: no test calls Infobip.
 */

export const INFOBIP_SMS_PATH = "/sms/2/text/advanced";
const REF = /^[A-Za-z0-9_-]{1,80}$/;

/** The account address as an https origin, or undefined when it is not a plain host name (or https URL with no path). */
export function infobipOrigin(raw: string): string | undefined {
  const value = raw.trim().replace(/\/+$/, "");
  if (value === "") return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== "")) return undefined;
    if (!/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes(".")) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

type InfobipAnswer = { messages?: Array<{ messageId?: unknown; status?: { groupName?: unknown } }> };

export function infobipSender(options: { origin: string; apiKey: string; from: string; timeoutMs?: number; fetcher?: typeof fetch }): CodeSmsSender {
  const fetcher = options.fetcher ?? fetch;
  const url = `${options.origin}${INFOBIP_SMS_PATH}`;
  const authorization = `App ${options.apiKey}`;
  return {
    name: "infobip",
    async send(message) {
      try {
        const response = await fetcher(url, {
          method: "POST",
          headers: { authorization, "content-type": "application/json", accept: "application/json" },
          // Infobip takes the number in international form without the +.
          body: JSON.stringify({ messages: [{ destinations: [{ to: message.to.replace(/^\+/, "") }], from: options.from, text: message.text }] }),
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs ?? SMS_SEND_TIMEOUT_MS),
        });
        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel().catch(() => undefined);
          return { accepted: false, status: response.status };
        }
        // Only the id and the status group are read; the rest (it echoes the number) is never stored or logged.
        const first = ((await response.json().catch(() => null)) as InfobipAnswer | null)?.messages?.[0];
        if (first?.status?.groupName === "REJECTED") return { accepted: false, status: response.status };
        const id = first?.messageId;
        return { accepted: true, status: response.status, ...(typeof id === "string" && REF.test(id) ? { ref: id } : {}) };
      } catch {
        return { accepted: false };
      }
    },
  };
}
