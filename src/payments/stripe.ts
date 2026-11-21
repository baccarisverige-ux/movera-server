import { createHmac, timingSafeEqual } from "node:crypto";
import type { ColumnType } from "kysely";
import type { Trx } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { stripeKeyStatus, type StripeEnv, type StripeMode } from "./stripeKeys.js";

export { serverStripeStatus, setServerStripeStatus, stripeKeyStatus, type StripeKeyStatus, type StripeMode, type StripeOffReason } from "./stripeKeys.js";

class AlreadyRefunded extends Error {}

/**
 * Contract v0.18.136 `stripeFees` (DRAFT, Stripe test or live keys; owner 2026-11-20 "So we use stripe" + "Stripe is used
 * for exactly TWO things: the rider cancellation fee; the DRIVER paying his monthly invoice to Movera"). The ONE server
 * Stripe module for both uses: the keys (env names only), the small Stripe HTTP client, the webhook signature check and
 * the stripe_payments / stripe_events tables (migration 0124). Each use (riders/feeStripe.ts, later the driver's
 * monthly payment) owns its own money effect; this module never moves money in Movera's books.
 *
 * Keys: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET (server env only). Live mode (owner 2026-11-21
 * "Yes, build live mode now (Recommended)", contract.json#stripeFees.keys): one mode at a time from the key prefixes,
 * sk_test_ + pk_test_ or sk_live_ + pk_live_ (+ the whsec_ of that mode's webhook endpoint); production takes live keys
 * only, staging and development test keys only. Anything else (none, a mix, a wrong mode for this server) = Stripe off
 * (503 payments_unavailable), nothing is charged, and every reason except no_keys is a system_health alert.
 */

export type StripePurpose = "rider_fee" | "driver_invoice";
export type StripeStatus = "requires_payment" | "processing" | "succeeded" | "failed" | "canceled" | "refund_pending" | "refunded";
export const OPEN_STATUSES: readonly StripeStatus[] = ["requires_payment", "processing"];
/** Stripe is used here for these currencies only (minor units 2, as Movera's); TND (3 decimals) is not. */
export const STRIPE_CURRENCIES = new Set(["SEK", "EUR"]);

export interface StripePaymentsTable {
  payment_intent_id: string;
  purpose: StripePurpose;
  subject_id: string;
  ref_id: string;
  currency: string;
  amount_minor: ColumnType<string, number, number>;
  status: StripeStatus;
  client_secret: string | null;
  paid_twice: ColumnType<boolean, boolean | undefined, boolean>;
  overpaid_minor: ColumnType<string, number | undefined, number>;
  amount_mismatch: ColumnType<boolean, boolean | undefined, boolean>;
  refund_id: string | null;
  created_at: Date;
  paid_at: Date | null;
  refunded_at: Date | null;
}
export interface StripeEventsTable {
  event_id: string;
  type: string;
  received_at: Date;
}
declare module "../db/schema.js" {
  interface Database {
    stripe_payments: StripePaymentsTable;
    stripe_events: StripeEventsTable;
  }
}

export type PaymentIntent = { id: string; clientSecret: string; amountMinor: number; currency: string; status: string };

/** What the server asks of Stripe (tests use a fake; real calls go through stripeHttp). */
export interface StripeApi {
  /** The keys' mode (missing = test: the tests' fakes). A webhook event of the other mode is refused (wrong_mode). */
  readonly mode?: StripeMode;
  readonly publishableKey: string;
  readonly webhookSecret: string;
  createPaymentIntent(input: { amountMinor: number; currency: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<PaymentIntent>;
  cancelPaymentIntent(id: string): Promise<void>;
  /** amountMinor: a part refund (the overpaid part); missing = the whole payment. */
  refund(input: { paymentIntentId: string; idempotencyKey: string; amountMinor?: number }): Promise<{ id: string }>;
}

/** The Stripe client from the server env, or null (off) unless stripeKeyStatus gives test or live. */
export function stripeFromEnv(env: StripeEnv, fetcher: typeof fetch = fetch): StripeApi | null {
  const status = stripeKeyStatus(env);
  if (status.mode === "off") return null;
  return stripeHttp(status.mode, env.STRIPE_SECRET_KEY!, env.STRIPE_PUBLISHABLE_KEY!, env.STRIPE_WEBHOOK_SECRET!, fetcher);
}

function stripeHttp(mode: StripeMode, secret: string, publishableKey: string, webhookSecret: string, fetcher: typeof fetch): StripeApi {
  const post = async (path: string, form: Record<string, string>, idempotencyKey?: string) => {
    const res = await fetcher(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = String(((body["error"] ?? {}) as Record<string, unknown>)["code"] ?? "");
      if (code === "charge_already_refunded") throw new AlreadyRefunded();
      throw new ApiError("unavailable", "The card payment service did not answer.", { reason: "payments_unavailable" });
    }
    return body;
  };
  return {
    mode,
    publishableKey,
    webhookSecret,
    async createPaymentIntent({ amountMinor, currency, metadata, idempotencyKey }) {
      const form: Record<string, string> = { amount: String(amountMinor), currency: currency.toLowerCase(), "automatic_payment_methods[enabled]": "true" };
      for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
      const pi = await post("payment_intents", form, idempotencyKey);
      return { id: String(pi["id"]), clientSecret: String(pi["client_secret"]), amountMinor: Number(pi["amount"]), currency: String(pi["currency"]).toUpperCase(), status: String(pi["status"]) };
    },
    async cancelPaymentIntent(id) {
      await post(`payment_intents/${encodeURIComponent(id)}/cancel`, {});
    },
    async refund({ paymentIntentId, idempotencyKey, amountMinor }) {
      try {
        const r = await post("refunds", { payment_intent: paymentIntentId, ...(amountMinor !== undefined ? { amount: String(amountMinor) } : {}) }, idempotencyKey);
        return { id: String(r["id"]) };
      } catch (e) {
        // Money review (5): a refund already done (e.g. a first try whose database step rolled back) counts as done.
        if (e instanceof AlreadyRefunded) return { id: "already_refunded" };
        throw e;
      }
    },
  };
}

/** Off (stripeKeyStatus not test or live): the Stripe routes answer 503 payments_unavailable. */
export function needStripe(stripe: StripeApi | null | undefined): StripeApi {
  if (!stripe) throw new ApiError("unavailable", "Card payment is not available now.", { reason: "payments_unavailable" });
  return stripe;
}

export const SIGNATURE_TOLERANCE_S = 300;
/**
 * Stripe's webhook signature: header "t=<unix>,v1=<hex>[,v1=…]", v1 = HMAC-SHA256(secret, "<t>.<raw body>"). True only
 * for a matching v1 and t at most SIGNATURE_TOLERANCE_S from now.
 */
export function verifyStripeSignature(rawBody: string, header: string | undefined, secret: string, now: Date): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("=", 2) as [string, string | undefined]);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!Number.isInteger(t) || Math.abs(now.getTime() / 1000 - t) > SIGNATURE_TOLERANCE_S) return false;
  const want = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return parts.some(([k, v]) => {
    if (k !== "v1" || !v || !/^[0-9a-f]{64}$/.test(v)) return false;
    return timingSafeEqual(Buffer.from(v, "hex"), want);
  });
}

/** For tests and tools: the header Stripe would send for this body. */
export function stripeSignatureHeader(rawBody: string, secret: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

export type StripeEvent = { id: string; type: string; livemode?: unknown; data: { object: Record<string, unknown> } };

/**
 * Money review (4): when what a payment pays for stops being owed another way (Mark as paid, waive, paid with a ride),
 * its open PaymentIntents become canceled here and lose their client secret. The webhook still takes money that
 * arrives for one, flagged paidTwice for the admin to refund.
 */
export async function closeOpenIntents(trx: Trx, purpose: StripePurpose, refIds: readonly string[]): Promise<void> {
  if (refIds.length === 0) return;
  await trx.updateTable("stripe_payments").set({ status: "canceled", client_secret: null }).where("purpose", "=", purpose).where("ref_id", "in", [...refIds]).where("status", "in", [...OPEN_STATUSES]).execute();
}
