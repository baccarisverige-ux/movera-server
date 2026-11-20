import type { FastifyInstance } from "fastify";
import { API_PREFIX } from "../http/prefix.js";
import type { Db, Trx } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { verifyStripeSignature, type StripeApi, type StripeEvent, type StripePaymentsTable, type StripePurpose } from "./stripe.js";

/**
 * Contract v0.18.141 stripeFees.webhook: POST /webhooks/stripe (no sign-in). The raw body is checked against the
 * Stripe-Signature header; each event id is handled once (stripe_events); the payment row is locked; each use (purpose)
 * owns its money effect (riders/feeStripe.ts riderFeeUse; later the driver's monthly payment).
 */

type Payment = { [K in keyof StripePaymentsTable]: StripePaymentsTable[K] extends { __select__: infer S } ? S : StripePaymentsTable[K] };
export interface StripeUse {
  /** The PaymentIntent succeeded with the stored amount and currency. paidTwice: the debt was already settled. */
  succeeded(trx: Trx, payment: Payment, now: Date): Promise<{ paidTwice: boolean }>;
  /** The payment was refunded in full. */
  refunded(trx: Trx, payment: Payment, now: Date): Promise<void>;
}

export async function handleStripeEvent(trx: Trx, uses: Partial<Record<StripePurpose, StripeUse>>, event: StripeEvent, now: Date, log: (msg: string, data: Record<string, unknown>) => void = () => undefined): Promise<void> {
  const first = await trx.insertInto("stripe_events").values({ event_id: event.id, type: event.type, received_at: now }).onConflict((oc) => oc.column("event_id").doNothing()).returning("event_id").executeTakeFirst();
  if (!first) return; // a repeat: changes nothing
  const object = event.data?.object ?? {};
  const intentId = String(event.type.startsWith("charge.") ? object["payment_intent"] ?? "" : object["id"] ?? "");
  if (!intentId) return;
  const payment = (await trx.selectFrom("stripe_payments").selectAll().where("payment_intent_id", "=", intentId).forUpdate().executeTakeFirst()) as Payment | undefined;
  if (!payment) return;
  const use = uses[payment.purpose];
  const sameMoney = (amount: unknown) => Number(amount) === Number(payment.amount_minor) && String(object["currency"] ?? "").toUpperCase() === payment.currency;
  switch (event.type) {
    case "payment_intent.succeeded": {
      if (payment.status === "succeeded" || payment.status === "refund_pending" || payment.status === "refunded") return;
      if (!sameMoney(object["amount_received"] ?? object["amount"])) {
        log("stripe: succeeded amount or currency differs; nothing changed", { paymentIntentId: intentId });
        return;
      }
      const effect = use ? await use.succeeded(trx, payment, now) : { paidTwice: true };
      await trx.updateTable("stripe_payments").set({ status: "succeeded", paid_at: now, client_secret: null, paid_twice: effect.paidTwice }).where("payment_intent_id", "=", intentId).execute();
      return;
    }
    case "payment_intent.payment_failed":
      if (payment.status === "requires_payment" || payment.status === "processing") await trx.updateTable("stripe_payments").set({ status: "failed", client_secret: null }).where("payment_intent_id", "=", intentId).execute();
      return;
    case "payment_intent.processing":
      if (payment.status === "requires_payment") await trx.updateTable("stripe_payments").set({ status: "processing" }).where("payment_intent_id", "=", intentId).execute();
      return;
    case "payment_intent.canceled":
      if (payment.status === "requires_payment" || payment.status === "processing") await trx.updateTable("stripe_payments").set({ status: "canceled", client_secret: null }).where("payment_intent_id", "=", intentId).execute();
      return;
    case "charge.refunded": {
      if (payment.status !== "succeeded" && payment.status !== "refund_pending") return;
      if (!sameMoney(object["amount_refunded"])) return; // only a full refund counts
      await trx.updateTable("stripe_payments").set({ status: "refunded", refunded_at: now }).where("payment_intent_id", "=", intentId).execute();
      if (use) await use.refunded(trx, payment, now);
      return;
    }
    default:
      return;
  }
}

export async function stripeWebhookRoutes(app: FastifyInstance, deps: { db: Db; stripe: StripeApi | null; uses: Partial<Record<StripePurpose, StripeUse>>; clock?: () => Date }) {
  const now = deps.clock ?? (() => new Date());
  await app.register(async (scope) => {
    // The signature is over the exact bytes Stripe sent: this scope keeps the body as text.
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 512 * 1024 }, (_req, body, done) => done(null, body));
    scope.post(`${API_PREFIX}/webhooks/stripe`, async (request) => {
      const raw = typeof request.body === "string" ? request.body : "";
      const secret = deps.stripe?.webhookSecret ?? "";
      if (!deps.stripe) throw new ApiError("unavailable", "Card payment is not available now.", { reason: "payments_unavailable" });
      const header = request.headers["stripe-signature"];
      if (!verifyStripeSignature(raw, typeof header === "string" ? header : undefined, secret, now())) throw new ApiError("invalid_request", "The Stripe signature is not valid.", { reason: "bad_signature" });
      let event: StripeEvent;
      try {
        event = JSON.parse(raw) as StripeEvent;
      } catch {
        throw new ApiError("invalid_request", "The Stripe event is not valid.", { reason: "bad_signature" });
      }
      if (typeof event?.id !== "string" || typeof event.type !== "string") throw new ApiError("invalid_request", "The Stripe event is not valid.", { reason: "bad_signature" });
      await deps.db.transaction().execute((trx) => handleStripeEvent(trx, deps.uses, event, now(), (msg, data) => request.log.warn(data, msg)));
      return { received: true };
    });
  });
}
