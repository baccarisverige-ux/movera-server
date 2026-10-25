import type { Executor } from "../db/db.js";
import { newId } from "../ids.js";

/**
 * Text messages the server sends (fleet invitations; later the sign-in code for real numbers). Every message is
 * written to sms_outbox first, then handed to the provider; without one (the test week until the owner picks
 * 46elks or Twilio) it is kept as `skipped`, logged, and nothing else happens. The row is written inside the
 * caller's transaction, so a rolled-back command sends nothing.
 */

export type SmsMessage = { phone: string; text: string; kind: string };

export interface SmsProvider {
  readonly name: string;
  /** Sends one message; answers the provider's reference. Throws on failure. */
  send(message: SmsMessage): Promise<string>;
}

export type SmsDeps = { provider?: SmsProvider | undefined; warn?: ((data: Record<string, unknown>, message: string) => void) | undefined };

/** Writes the message to the outbox and sends it when a provider exists. Never throws into the caller's command. */
export async function sendSms(ex: Executor, deps: SmsDeps, message: SmsMessage, now: Date): Promise<{ smsId: string; status: "sent" | "failed" | "skipped" }> {
  const smsId = newId("sms", now.getTime());
  if (deps.provider === undefined) {
    await ex.insertInto("sms_outbox").values({ sms_id: smsId, phone: message.phone, text: message.text, kind: message.kind, status: "skipped", provider: null, created_at: now }).execute();
    deps.warn?.({ smsId, phone: message.phone.slice(0, 4) + "…", kind: message.kind }, "No SMS provider is set; the message was kept in sms_outbox");
    return { smsId, status: "skipped" };
  }
  try {
    const ref = await deps.provider.send(message);
    await ex.insertInto("sms_outbox").values({ sms_id: smsId, phone: message.phone, text: message.text, kind: message.kind, status: "sent", provider: deps.provider.name, provider_ref: ref, created_at: now, sent_at: now }).execute();
    return { smsId, status: "sent" };
  } catch (error) {
    await ex.insertInto("sms_outbox").values({ sms_id: smsId, phone: message.phone, text: message.text, kind: message.kind, status: "failed", provider: deps.provider.name, error: String(error).slice(0, 500), created_at: now }).execute();
    deps.warn?.({ smsId, err: String(error) }, "SMS failed");
    return { smsId, status: "failed" };
  }
}
