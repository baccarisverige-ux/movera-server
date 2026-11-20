import { z } from "zod";
import type { Principal } from "../auth/guard.js";
import { adminCoversZone } from "../auth/guard.js";
import { audit } from "../admin/audit.js";
import { liveDocument, standardKey } from "../config/service.js";
import type { Executor, Trx } from "../db/db.js";
import { ApiError } from "../http/errors.js";
import { OPEN_STATUSES, STRIPE_CURRENCIES, type StripeApi, type StripePaymentsTable } from "../payments/stripe.js";
import type { StripeUse } from "../payments/stripeWebhook.js";
import { riderDebt } from "./debt.js";
import { settleFeePaid } from "./feeMarkPaid.js";

/**
 * Contract v0.18.141 `stripeFees` (DRAFT, Stripe TEST mode; owner 2026-11-20 "So we use stripe"): the rider pays an owed
 * cancel or no-show fee in the app. Rides stay paid in the car.
 *
 * MONEY rules kept here:
 *   - the amount is the server's only: min(the fee, her debt now in its currency); the phone never sends an amount;
 *   - the fee becomes paid only from a signed Stripe webhook whose amount and currency equal the stored PaymentIntent,
 *     with the same effect as the admin's Mark as paid (settleFeePaid), once (stripe_events + the fee's own status);
 *   - money that arrives for a fee already settled another way takes nothing more off: the payment is marked paidTwice
 *     for the admin to refund;
 *   - a refund gives the money back and never puts the fee back in her debt.
 */

type Row = { [K in keyof StripePaymentsTable]: StripePaymentsTable[K] extends { __select__: infer S } ? S : StripePaymentsTable[K] };
type Money = { amountMinor: number; currency: string };

/** CountryRules.riderFeeStripe of the country standard (a zone's own value is ignored); off unless enabled is true. */
export async function riderFeeStripeOn(ex: Executor, country: string | null | undefined): Promise<boolean> {
  if (!country) return false;
  const doc = await liveDocument<{ riderFeeStripe?: { enabled?: unknown } }>(ex, "country_rules", standardKey(country));
  return doc?.document?.riderFeeStripe?.enabled === true;
}

export function feePaymentView(row: Row, withSecret: { publishableKey: string } | null) {
  return {
    tripId: row.ref_id,
    paymentIntentId: row.payment_intent_id,
    amount: { amountMinor: Number(row.amount_minor), currency: row.currency },
    status: row.status,
    ...(withSecret && row.status === "requires_payment" && row.client_secret ? { clientSecret: row.client_secret, publishableKey: withSecret.publishableKey } : {}),
    createdAt: row.created_at.toISOString(),
    ...(row.paid_at ? { paidAt: row.paid_at.toISOString() } : {}),
    ...(row.refunded_at ? { refundedAt: row.refunded_at.toISOString() } : {}),
    ...(row.paid_twice ? { paidTwice: true } : {}),
  };
}

const tripCountry = async (ex: Executor, tripId: string) =>
  (await ex.selectFrom("trips").innerJoin("zones", "zones.zone_id", "trips.zone_id").select(["trips.zone_id", "trips.cancellation", "zones.country"]).where("trips.trip_id", "=", tripId).executeTakeFirst()) ?? null;

/** POST /rider/fees/{tripId}/pay: one open PaymentIntent per fee, for the server's amount. */
export async function startFeePayment(trx: Trx, stripe: StripeApi, riderId: string, tripId: string, now: Date) {
  const fee = await trx.selectFrom("rider_fees").selectAll().where("trip_id", "=", tripId).where("rider_id", "=", riderId).forUpdate().executeTakeFirst();
  if (!fee || fee.status !== "owed") throw new ApiError("invalid_transition", "There is no fee to pay for this trip.", { reason: "fee_not_owed" });
  const amountMinor = Math.min(Number(fee.amount_minor), await riderDebt(trx, riderId, fee.currency));
  if (amountMinor <= 0) throw new ApiError("invalid_transition", "There is no fee to pay for this trip.", { reason: "fee_not_owed" });
  const trip = await tripCountry(trx, tripId);
  if (!(await riderFeeStripeOn(trx, trip?.country))) throw new ApiError("conflict", "Card payment of fees is off here.", { reason: "stripe_off" });
  if (!STRIPE_CURRENCIES.has(fee.currency)) throw new ApiError("conflict", "Card payment is not used for this currency.", { reason: "currency_not_supported" });
  const mine = await trx.selectFrom("stripe_payments").selectAll().where("purpose", "=", "rider_fee").where("ref_id", "=", tripId).forUpdate().execute();
  const open = mine.find((p) => OPEN_STATUSES.includes(p.status));
  if (open && Number(open.amount_minor) === amountMinor && open.currency === fee.currency) return feePaymentView(open as Row, stripe);
  if (open) {
    await stripe.cancelPaymentIntent(open.payment_intent_id);
    await trx.updateTable("stripe_payments").set({ status: "canceled", client_secret: null }).where("payment_intent_id", "=", open.payment_intent_id).execute();
  }
  const pi = await stripe.createPaymentIntent({
    amountMinor,
    currency: fee.currency,
    metadata: { purpose: "rider_fee", riderId, tripId },
    idempotencyKey: `rider_fee:${tripId}:${amountMinor}:${mine.length}`,
  });
  if (pi.amountMinor !== amountMinor || pi.currency !== fee.currency) throw new ApiError("unavailable", "The card payment service answered a different amount.", { reason: "payments_unavailable" });
  const row = await trx
    .insertInto("stripe_payments")
    .values({ payment_intent_id: pi.id, purpose: "rider_fee", subject_id: riderId, ref_id: tripId, currency: fee.currency, amount_minor: amountMinor, status: "requires_payment", client_secret: pi.clientSecret, refund_id: null, created_at: now, paid_at: null, refunded_at: null })
    .returningAll()
    .executeTakeFirstOrThrow();
  return feePaymentView(row as Row, stripe);
}

/** The webhook's money effect for purpose rider_fee (payments/stripeWebhook.ts calls it under the payment row lock). */
export const riderFeeUse: StripeUse = {
  async succeeded(trx, payment, now) {
    const rider = await trx.selectFrom("riders").select(["rider_id", "version"]).where("rider_id", "=", payment.subject_id).forUpdate().executeTakeFirst();
    const fee = await trx.selectFrom("rider_fees").selectAll().where("trip_id", "=", payment.ref_id).where("rider_id", "=", payment.subject_id).forUpdate().executeTakeFirst();
    if (!rider || !fee || fee.status !== "owed" || fee.currency !== payment.currency) return { paidTwice: true };
    const trip = await tripCountry(trx, payment.ref_id);
    await settleFeePaid(trx, fee, trip?.cancellation ?? null, rider.version, now);
    await audit(trx, { adminId: null, action: "rider.fee_paid_stripe", targetType: "rider", targetId: rider.rider_id, zoneId: trip?.zone_id ?? null, detail: { tripId: payment.ref_id, paymentIntentId: payment.payment_intent_id, amountMinor: Number(payment.amount_minor), currency: payment.currency }, at: now });
    return { paidTwice: false };
  },
  async refunded(trx, payment) {
    // The money went back; the fee is not owed again (contract stripeFees.refund). A payment that came twice leaves the fee as it was.
    if (payment.paid_twice) return;
    await trx.updateTable("rider_fees").set({ status: "refunded" }).where("trip_id", "=", payment.ref_id).where("rider_id", "=", payment.subject_id).where("status", "=", "paid").execute();
  },
};

export const StripeRefundBody = z.object({ reason: z.string().max(300).optional().default("") });

/** POST /admin/riders/{riderId}/fees/{tripId}/stripe-refund: the full amount of the fee's succeeded payment. */
export async function refundFeePayment(trx: Trx, stripe: StripeApi, who: Principal, riderId: string, tripId: string, body: { reason: string }, now: Date) {
  const reason = body.reason.trim();
  if (!reason) throw new ApiError("invalid_request", "Write why the fee is refunded.", { reason: "reason_required" });
  const trip = await trx.selectFrom("trips").select(["zone_id"]).where("trip_id", "=", tripId).where("rider_id", "=", riderId).executeTakeFirst();
  if (trip && !adminCoversZone(who, trip.zone_id)) throw new ApiError("forbidden", "This trip is outside your zones.", { reason: "zone_out_of_scope" });
  const paid = trip ? await trx.selectFrom("stripe_payments").selectAll().where("purpose", "=", "rider_fee").where("ref_id", "=", tripId).where("subject_id", "=", riderId).where("status", "=", "succeeded").orderBy("created_at", "desc").forUpdate().executeTakeFirst() : undefined;
  if (!paid) throw new ApiError("invalid_transition", "No card payment of this fee to refund.", { reason: "no_stripe_payment" });
  const refund = await stripe.refund({ paymentIntentId: paid.payment_intent_id, idempotencyKey: `refund:${paid.payment_intent_id}` });
  const row = await trx.updateTable("stripe_payments").set({ status: "refund_pending", refund_id: refund.id }).where("payment_intent_id", "=", paid.payment_intent_id).returningAll().executeTakeFirstOrThrow();
  await audit(trx, { adminId: who.subjectId, action: "rider.fee_stripe_refund", targetType: "rider", targetId: riderId, zoneId: trip!.zone_id, detail: { tripId, paymentIntentId: paid.payment_intent_id, amountMinor: Number(paid.amount_minor), currency: paid.currency, reason }, at: now });
  return feePaymentView(row as Row, null);
}

/** GET /admin/riders/{riderId}/fee-payments: newest first, never the client secret. */
export async function listFeePayments(ex: Executor, riderId: string) {
  const rows = await ex.selectFrom("stripe_payments").selectAll().where("purpose", "=", "rider_fee").where("subject_id", "=", riderId).orderBy("created_at", "desc").limit(200).execute();
  return { items: rows.map((r) => feePaymentView(r as Row, null)) };
}

/**
 * Rider.feesPayableByCard: her owed fees she can pay in the app now, oldest first; the amounts never add up to more
 * than her debt of the currency (each takes at most what is left of it).
 */
export async function feesPayableByCard(ex: Executor, riderId: string): Promise<Array<{ tripId: string; amount: Money }>> {
  const fees = await ex.selectFrom("rider_fees").innerJoin("trips", "trips.trip_id", "rider_fees.trip_id").innerJoin("zones", "zones.zone_id", "trips.zone_id")
    .select(["rider_fees.trip_id", "rider_fees.currency", "rider_fees.amount_minor", "zones.country"])
    .where("rider_fees.rider_id", "=", riderId).where("rider_fees.status", "=", "owed").orderBy("rider_fees.created_at").orderBy("rider_fees.trip_id").limit(50).execute();
  const left = new Map<string, number>();
  const on = new Map<string, boolean>();
  const out: Array<{ tripId: string; amount: Money }> = [];
  for (const f of fees) {
    if (!STRIPE_CURRENCIES.has(f.currency)) continue;
    if (!on.has(f.country)) on.set(f.country, await riderFeeStripeOn(ex, f.country));
    if (!left.has(f.currency)) left.set(f.currency, await riderDebt(ex, riderId, f.currency));
    const amountMinor = Math.min(Number(f.amount_minor), left.get(f.currency)!);
    left.set(f.currency, left.get(f.currency)! - amountMinor);
    if (on.get(f.country) && amountMinor > 0) out.push({ tripId: f.trip_id, amount: { amountMinor, currency: f.currency } });
  }
  return out;
}
