import { contract } from "../contract/contract.js";
import type { Env } from "../env.js";
import { SENDER_NAME, SMS_COMPANIES, signInSmsFrom, type CodeSmsOutcome, type CodeSmsSender, type SmsCompany } from "./elks.js";
import { infobipOrigin, infobipSender } from "./infobip.js";

/**
 * Contract v0.18.168 (contract.json#smsProviders; owner 2026-11-26 "Am going to change company sms to infobip", then
 * "Infobip + 46elks en secours (Recommandé)"): the server's SMS sender tries the companies in order (the country's
 * providerOrder, default 46elks then Infobip: owner 2026-11-26 "Keep 46elks working primary until we fix Infobip"), one try each. When a company took the SMS no other is asked (never two
 * SMS for one code); when it did not (time-out, broken connection, refusal, error answer, wrong key) the same SMS goes
 * once to the next company that has keys. A company without keys is skipped; only one with keys = that one alone; none
 * = no sender (every real number stays sign_in_restricted, as before). Never throws.
 */

type SpContract = { providers: SmsCompany[]; defaultOrder: SmsCompany[] };
const SP = (contract as unknown as { smsProviders: SpContract }).smsProviders;
export const DEFAULT_SMS_ORDER: readonly SmsCompany[] = SP.defaultOrder;

const isCompany = (value: unknown): value is SmsCompany => typeof value === "string" && (SMS_COMPANIES as readonly string[]).includes(value);
/** A stored providerOrder: 1 or 2 different companies, else undefined (the caller reads the default). */
export function providerOrderOk(value: unknown): value is SmsCompany[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= SP.providers.length && new Set(value).size === value.length && value.every(isCompany);
}

export function chainSender(senders: Partial<Record<SmsCompany, CodeSmsSender>>): CodeSmsSender | undefined {
  const available = DEFAULT_SMS_ORDER.filter((company) => senders[company] !== undefined);
  if (available.length === 0) return undefined;
  return {
    // The company tried first by default (what sms_outbox.provider holds until the send answers).
    name: available[0]!,
    async send(message) {
      const order = (message.order !== undefined && providerOrderOk(message.order) ? message.order : DEFAULT_SMS_ORDER).filter((company) => senders[company] !== undefined);
      // An order naming only companies without keys still sends through one that has them (the SMS is the point).
      const tries = order.length > 0 ? order : available;
      let last: CodeSmsOutcome = { accepted: false };
      for (const [index, company] of tries.entries()) {
        const outcome = await senders[company]!.send({ to: message.to, text: message.text }).catch((): CodeSmsOutcome => ({ accepted: false }));
        last = { ...outcome, provider: company, ...(index > 0 ? { backup: true } : {}) };
        if (outcome.accepted) return last;
      }
      return last;
    },
  };
}

type SmsEnv = Pick<Env, "ELKS_API_USERNAME" | "ELKS_API_PASSWORD" | "SMS_SENDER_NAME" | "INFOBIP_BASE_URL" | "INFOBIP_API_KEY">;
const set = (value: string | undefined): string | undefined => (value !== undefined && value.trim() !== "" ? value.trim() : undefined);

/** Infobip when both its address (a usable https host) and its key are set, else none. */
export function infobipSenderFrom(env: SmsEnv, defaultSender: string, fetcher?: typeof fetch): CodeSmsSender | undefined {
  const base = set(env.INFOBIP_BASE_URL);
  const apiKey = set(env.INFOBIP_API_KEY);
  if (base === undefined || apiKey === undefined) return undefined;
  const origin = infobipOrigin(base);
  if (origin === undefined) return undefined;
  const asked = set(env.SMS_SENDER_NAME);
  return infobipSender({ origin, apiKey, from: asked !== undefined && SENDER_NAME.test(asked) ? asked : defaultSender, ...(fetcher ? { fetcher } : {}) });
}

/** The server's SMS sender: every company with keys, tried in order. */
export function smsSenderFrom(env: SmsEnv, defaultSender: string): CodeSmsSender | undefined {
  const infobip = infobipSenderFrom(env, defaultSender);
  const elks = signInSmsFrom(env, defaultSender);
  return chainSender({ ...(infobip ? { infobip } : {}), ...(elks ? { "46elks": elks } : {}) });
}

/** Start-up warnings for Infobip (names only, never a value). */
export function infobipStartupWarnings(env: SmsEnv): string[] {
  const base = set(env.INFOBIP_BASE_URL);
  const apiKey = set(env.INFOBIP_API_KEY);
  if ((base === undefined) !== (apiKey === undefined)) return ["Only one of INFOBIP_BASE_URL and INFOBIP_API_KEY is set: Infobip is skipped until both are set."];
  if (base !== undefined && infobipOrigin(base) === undefined) return ["INFOBIP_BASE_URL is not an https host name like xxxxx.api.infobip.com: Infobip is skipped."];
  return [];
}
