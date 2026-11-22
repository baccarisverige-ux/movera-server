import { audit } from "../admin/audit.js";
import { recordPaidToMovera } from "../admin/driversOwing.js";
import type { Trx } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { OPEN_STATUSES, STRIPE_CURRENCIES, type StripeApi, type StripePaymentsTable } from "../payments/stripe.js";
import type { StripeUse } from "../payments/stripeWebhook.js";
import { owedByDriver } from "./owes.js";
import { countryHome, localMonthDay, payReference, payRequestSettingOf } from "./payRequest.js";

/**
 * DRAFT (contract.json#driverPayRequest.stripe; owner 2026-11-20 "Stripe is used for exactly TWO things: ... (2) the
 * DRIVER paying his monthly invoice to Movera"; Stripe test or live keys, stripeFees.keys): the Pay Movera screen's button pays by Stripe.
 *
 * MONEY rules kept here:
 *   - the amount is the server's owed now (drivers/owes.ts, the same number as the admin owing list); the app sends none;
 *   - the money counts only from the signed webhook, with the same effect as the admin's "Driver paid Movera"
 *     (recordPaidToMovera), at most what he owes at that moment; the rest is paidTwice (overpaid) for the admin;
 *   - lock order: the driver row first, then the payment rows (as the webhook: lockSubject, then the payment).
 */

type Row = { [K in keyof StripePaymentsTable]: StripePaymentsTable[K] extends { __select__: infer S } ? S : StripePaymentsTable[K] };

const lockDriver = async (trx: Trx, driverId: string) => {
  await trx.selectFrom("drivers").select("driver_id").where("driver_id", "=", driverId).forUpdate().executeTakeFirst();
};

export function driverPaymentView(row: Row, withSecret: { publishableKey: string } | null) {
  return {
    paymentIntentId: row.payment_intent_id,
    amount: { amountMinor: Number(row.amount_minor), currency: row.currency },
    status: row.status,
    ...(withSecret && row.status === "requires_payment" && row.client_secret ? { clientSecret: row.client_secret, publishableKey: withSecret.publishableKey } : {}),
    createdAt: row.created_at.toISOString(),
  };
}

/** Whether the app shows the Stripe button (DriverPayMovera.stripe): request on, Stripe set, SEK/EUR. */
export const driverStripeOn = (stripe: StripeApi | null | undefined, enabled: boolean, currency: string) => Boolean(stripe) && enabled && STRIPE_CURRENCIES.has(currency);

/** POST /driver/pay-movera/pay: one open PaymentIntent per driver and month, for what he owes now. */
export async function startDriverPayment(trx: Trx, stripe: StripeApi, driverId: string, now: Date, toCancel: string[]) {
  await lockDriver(trx, driverId);
  const driver = await trx.selectFrom("drivers").select(["country"]).where("driver_id", "=", driverId).executeTakeFirst();
  const home = driver?.country ? await countryHome(trx, driver.country) : null;
  if (!driver?.country || home === null) throw new ApiError("not_found", "No country yet.", { reason: "no_country" });
  const setting = await payRequestSettingOf(trx, driver.country, home.currency);
  if (!setting.enabled) throw new ApiError("conflict", "Paying Movera in the app is off here.", { reason: "pay_request_off" });
  if (!STRIPE_CURRENCIES.has(home.currency)) throw new ApiError("conflict", "Card payment is not used for this currency.", { reason: "currency_not_supported" });
  const ref = payReference(driverId, localMonthDay(now, home.timeZone).month);
  const mine = await trx.selectFrom("stripe_payments").selectAll().where("purpose", "=", "driver_invoice").where("ref_id", "=", ref).forUpdate().execute();
  const amountMinor = (await owedByDriver(trx, [driverId], home.currency)).get(driverId) ?? 0;
  const open = mine.find((p) => OPEN_STATUSES.includes(p.status));
  if (amountMinor <= 0) {
    if (open) {
      toCancel.push(open.payment_intent_id);
      await trx.updateTable("stripe_payments").set({ status: "canceled", client_secret: null }).where("payment_intent_id", "=", open.payment_intent_id).execute();
    }
    throw new ApiError("conflict", "You owe Movera nothing now.", { reason: "nothing_owed" });
  }
  if (open && Number(open.amount_minor) === amountMinor && open.currency === home.currency) return driverPaymentView(open as Row, stripe);
  // Review of 0e00ad48 (1): a payment Stripe is still processing is never canceled and replaced.
  if (open?.status === "processing") throw new ApiError("conflict", "Your last payment is still being processed.", { reason: "payment_processing" });
  if (open) {
    toCancel.push(open.payment_intent_id);
    await trx.updateTable("stripe_payments").set({ status: "canceled", client_secret: null }).where("payment_intent_id", "=", open.payment_intent_id).execute();
  }
  const pi = await stripe.createPaymentIntent({ amountMinor, currency: home.currency, metadata: { purpose: "driver_invoice", driverId, reference: ref }, idempotencyKey: `driver_invoice:${ref}:${amountMinor}:${mine.length}` });
  if (pi.amountMinor !== amountMinor || pi.currency !== home.currency) throw new ApiError("unavailable", "The card payment service answered a different amount.", { reason: "payments_unavailable" });
  const row = await trx
    .insertInto("stripe_payments")
    .values({ payment_intent_id: pi.id, purpose: "driver_invoice", subject_id: driverId, ref_id: ref, currency: home.currency, amount_minor: amountMinor, status: "requires_payment", client_secret: pi.clientSecret, refund_id: null, created_at: now, paid_at: null, refunded_at: null })
    .returningAll()
    .executeTakeFirstOrThrow();
  return driverPaymentView(row as Row, stripe);
}

/** The webhook's money effect for purpose driver_invoice: "Driver paid Movera", at most what he owes now. */
export const driverInvoiceUse: StripeUse = {
  lockSubject: lockDriver,
  async succeeded(trx, payment, now) {
    const amount = Number(payment.amount_minor);
    const driver = await trx.selectFrom("drivers").select(["driver_id", "zone_ids"]).where("driver_id", "=", payment.subject_id).executeTakeFirst();
    if (!driver) {
      // Review (3): money for a driver row that is gone: all of it flagged for the admin.
      console.warn(JSON.stringify({ msg: "stripe: succeeded for a missing driver; flagged paidTwice", paymentIntentId: payment.payment_intent_id }));
      return { overpaidMinor: amount };
    }
    const owedBefore = (await owedByDriver(trx, [driver.driver_id], payment.currency)).get(driver.driver_id) ?? 0;
    const take = Math.max(0, Math.min(amount, owedBefore));
    if (take > 0) {
      await recordPaidToMovera(trx, { adminId: null, driverId: driver.driver_id, zone: driver.zone_ids[0] ?? null, currency: payment.currency, amountMinor: take, owedBefore, reason: `Stripe ${payment.payment_intent_id}`, action: "driver.paid_movera_stripe" }, now);
    }
    return { overpaidMinor: amount - take };
  },
  async refunded(trx, payment, now) {
    // A refund (Stripe dashboard) gives the money back; what it paid stays recorded: the admin corrects it by hand.
    await audit(trx, { adminId: null, action: "driver.paid_movera_stripe_refunded", targetType: "driver", targetId: payment.subject_id, zoneId: null, detail: { paymentIntentId: payment.payment_intent_id, amountMinor: Number(payment.amount_minor), currency: payment.currency }, at: now });
  },
};

