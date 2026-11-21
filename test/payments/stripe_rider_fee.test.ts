import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { KEPT_KEYS } from "../../src/config/keptKeys.js";
import { KEPT_ON_RESTORE } from "../../src/config/service.js";
import { readEnv } from "../../src/env.js";
import { stripeFromEnv, stripeSignatureHeader, verifyStripeSignature, type StripeApi } from "../../src/payments/stripe.js";
import { feeIntoWallet } from "../../src/riders/debt.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertTrip } from "../support/seed.js";
import { call, signIn, WORLD_JWT_SECRET, fixedRouter } from "../support/world.js";

/**
 * Contract v0.18.136 `stripeFees` (DRAFT, Stripe test-mode fake here; owner 2026-11-20 "So we use stripe"): Sara pays her owed
 * 65 kr cancel fee with Stripe in the app. The server makes a PaymentIntent for the server's amount; only a signed
 * webhook marks the fee paid (as Mark as paid), once; a refund gives the money back. Fails on main: no routes.
 */

const HOOK = "whsec_test_only_not_a_real_secret";
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-20T10:00:00.000Z") };
const SEK = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
let sara: { id: string; headers: Record<string, string> };
let made: Array<{ amountMinor: number; currency: string; idempotencyKey: string; metadata: Record<string, string> }> = [];
let canceled: string[] = [];
let refunds: string[] = [];
let refundAmounts: Array<number | undefined> = [];
let n = 0;
const fake: StripeApi = {
  publishableKey: "pk_test_fake",
  webhookSecret: HOOK,
  async createPaymentIntent(input) {
    made.push(input);
    const id = `pi_fake_${++n}`;
    return { id, clientSecret: `${id}_secret_x`, amountMinor: input.amountMinor, currency: input.currency, status: "requires_payment_method" };
  },
  async cancelPaymentIntent(id) { canceled.push(id); },
  async refund({ paymentIntentId, amountMinor }) { refunds.push(paymentIntentId); refundAmounts.push(amountMinor); return { id: `re_${paymentIntentId}` }; },
};

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  for (const doc of ["driver_app_config", "rider_app_config", "pricing"]) {
    const file = doc === "pricing" ? "pricing_document" : doc;
    await database.db.insertInto("config_live").values({ doc: doc as never, zone_id: "Z001", version: 1, document: JSON.stringify(sample(file)), published_at: clock.now, published_by: null }).execute();
  }
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: WORLD_JWT_SECRET }), logger: false, db: database.db, clock: () => clock.now, router: fixedRouter, stripe: fake });
  const headers = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  sara = { id: (await call(app, "GET", "/rider/profile", headers)).json().riderId, headers };
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  made = []; canceled = []; refunds = []; refundAmounts = [];
  for (const t of ["stripe_events", "stripe_payments", "wallet_entries", "rider_wallets", "rider_fees"] as const) await database.db.deleteFrom(t).execute();
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
  await on(true);
});

async function on(enabled: boolean) {
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
  await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-SE", version: 1, document: JSON.stringify({ country: "SE", currency: "SEK", riderFeeStripe: { enabled } }), published_at: clock.now, published_by: null }).execute();
}
async function owedFee(amountMinor: number, at = clock.now): Promise<string> {
  const tripId = await insertTrip(database.db, sara.id, { status: "cancelled_by_rider" });
  await database.db.updateTable("trips").set({ zone_id: "Z001", cancellation: JSON.stringify({ fee: SEK(amountMinor), feeStatus: "owed" }) }).where("trip_id", "=", tripId).execute();
  await database.db.transaction().execute(async (trx) => {
    await trx.insertInto("rider_fees").values({ trip_id: tripId, rider_id: sara.id, kind: "cancel", currency: "SEK", amount_minor: amountMinor, status: "owed", created_at: at }).execute();
    await feeIntoWallet(trx, { tripId, riderId: sara.id, amount: SEK(amountMinor), at }, at);
  });
  return tripId;
}
const pay = (tripId: string) => call(app, "POST", `/rider/fees/${tripId}/pay`, sara.headers, {});
const profile = async () => (await call(app, "GET", "/rider/profile", sara.headers)).json();
let ev = 0;
async function hook(type: string, object: Record<string, unknown>, opts: { id?: string; secret?: string; at?: Date } = {}) {
  // Live mode (stripeFees.webhook): the fake is a test-mode client, so its events are test events (livemode false).
  const body = JSON.stringify({ id: opts.id ?? `evt_${++ev}`, type, livemode: false, data: { object } });
  return app.inject({ method: "POST", url: "/api/v1/webhooks/stripe", headers: { "content-type": "application/json", "stripe-signature": stripeSignatureHeader(body, opts.secret ?? HOOK, opts.at ?? clock.now) }, payload: body });
}
const succeeded = (id: string, amount = 6500, currency = "sek") => ({ id, object: "payment_intent", amount, amount_received: amount, currency });

describe("POST /rider/fees/{tripId}/pay: a PaymentIntent for the server's amount", () => {
  it("Sara owes 65 kr: one PaymentIntent of 6500 SEK, the client secret + publishable key; a second call returns the same one", async () => {
    const tripId = await owedFee(6500);
    expect((await profile()).feesPayableByCard).toEqual([{ tripId, amount: SEK(6500) }]);
    const first = await pay(tripId);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ tripId, paymentIntentId: expect.stringMatching(/^pi_fake_/), amount: SEK(6500), status: "requires_payment", clientSecret: expect.stringMatching(/_secret_x$/), publishableKey: "pk_test_fake" });
    expect(made).toEqual([{ amountMinor: 6500, currency: "SEK", idempotencyKey: `rider_fee:${tripId}:6500:0`, metadata: { purpose: "rider_fee", riderId: sara.id, tripId } }]);
    expect((await pay(tripId)).json().paymentIntentId).toBe(first.json().paymentIntentId);
    expect(made).toHaveLength(1);
  });

  it("the amount is min(fee, debt): wallet credit that paid part of it lowers the charge; a changed amount cancels the old intent", async () => {
    const tripId = await owedFee(6500);
    const firstId = (await pay(tripId)).json().paymentIntentId;
    await database.db.updateTable("rider_wallets").set({ balance_minor: -4000 }).where("rider_id", "=", sara.id).execute();
    const again = (await pay(tripId)).json();
    expect(again.amount).toEqual(SEK(4000));
    expect(canceled).toEqual([firstId]);
  });

  it("refusals: off in the country 409 stripe_off; no owed fee 409 fee_not_owed; another rider's fee 409 fee_not_owed", async () => {
    const tripId = await owedFee(6500);
    await on(false);
    expect((await pay(tripId)).json()).toMatchObject({ reason: "stripe_off" });
    await on(true);
    expect((await pay("trp_nothing")).json()).toMatchObject({ reason: "fee_not_found" });
    const other = (await signIn(app, TEST_PHONES[2]!, "rider")).headers;
    expect((await call(app, "POST", `/rider/fees/${tripId}/pay`, other, {})).json()).toMatchObject({ reason: "fee_not_found" });
    expect(made).toHaveLength(0);
  });
});

describe("POST /webhooks/stripe: signed, once, the server's amount only", () => {
  it("succeeded: the fee becomes paid exactly as Mark as paid (debt 0, outstanding gone, feeStatus paid); a repeat changes nothing", async () => {
    const tripId = await owedFee(6500);
    const pi = (await pay(tripId)).json().paymentIntentId;
    expect((await hook("payment_intent.succeeded", succeeded(pi), { id: "evt_same" })).statusCode).toBe(200);
    const p = await profile();
    expect(p.outstanding).toBeNull();
    expect(p.outstandingByCurrency).toEqual([]);
    expect(p.feesPayableByCard).toBeUndefined();
    expect((await database.db.selectFrom("rider_fees").select("status").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).status).toBe("paid");
    const trip = await database.db.selectFrom("trips").select("cancellation").where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect((trip.cancellation as { feeStatus: string }).feeStatus).toBe("paid");
    const entries = async () => (await database.db.selectFrom("wallet_entries").select(["kind", "amount_minor"]).where("rider_id", "=", sara.id).orderBy("at").execute()).map((e) => [e.kind, Number(e.amount_minor)]);
    expect(await entries()).toEqual([["fee", -6500], ["adjustment", 6500]]);
    expect((await hook("payment_intent.succeeded", succeeded(pi), { id: "evt_same" })).statusCode).toBe(200);
    expect((await hook("payment_intent.succeeded", succeeded(pi))).statusCode).toBe(200);
    expect(await entries()).toEqual([["fee", -6500], ["adjustment", 6500]]);
  });

  it("a bad, old or missing signature is 400 bad_signature and changes nothing", async () => {
    const tripId = await owedFee(6500);
    const pi = (await pay(tripId)).json().paymentIntentId;
    expect((await hook("payment_intent.succeeded", succeeded(pi), { secret: "whsec_wrong" })).json()).toMatchObject({ reason: "bad_signature" });
    expect((await hook("payment_intent.succeeded", succeeded(pi), { at: new Date(clock.now.getTime() - 301_000) })).json()).toMatchObject({ reason: "bad_signature" });
    const none = await app.inject({ method: "POST", url: "/api/v1/webhooks/stripe", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(none.statusCode).toBe(400);
    expect((await profile()).outstandingByCurrency).toEqual([SEK(6500)]);
  });

  it("an amount or currency that differs from the stored PaymentIntent changes no fee", async () => {
    const tripId = await owedFee(6500);
    const pi = (await pay(tripId)).json().paymentIntentId;
    await hook("payment_intent.succeeded", succeeded(pi, 100));
    await hook("payment_intent.succeeded", succeeded(pi, 6500, "eur"));
    expect((await profile()).outstandingByCurrency).toEqual([SEK(6500)]);
  });

  it("paid twice: the fee was marked paid by hand first, the Stripe money takes nothing more off and is flagged for refund", async () => {
    const tripId = await owedFee(6500);
    const pi = (await pay(tripId)).json().paymentIntentId;
    const finance = (await adminSession(app, database.db, "finance", { now: clock.now })).headers;
    expect((await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/mark-paid`, finance, { reason: "Paid by Swish" })).statusCode).toBe(200);
    await hook("payment_intent.succeeded", succeeded(pi));
    const list = (await call(app, "GET", `/admin/riders/${sara.id}/fee-payments`, finance)).json();
    expect(list.items).toEqual([expect.objectContaining({ paymentIntentId: pi, status: "succeeded", paidTwice: true, amount: SEK(6500) })]);
    expect(list.items[0].clientSecret).toBeUndefined();
    const entries = await database.db.selectFrom("wallet_entries").select(["kind", "amount_minor"]).where("rider_id", "=", sara.id).execute();
    expect(entries.map((e) => Number(e.amount_minor)).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("admin refund: refund_pending, then refunded by the webhook; the fee is not owed again", async () => {
    const tripId = await owedFee(6500);
    const pi = (await pay(tripId)).json().paymentIntentId;
    await hook("payment_intent.succeeded", succeeded(pi));
    const finance = (await adminSession(app, database.db, "finance", { now: clock.now })).headers;
    expect((await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/stripe-refund`, finance, {})).json()).toMatchObject({ reason: "reason_required" });
    const r = await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/stripe-refund`, finance, { reason: "Fee was wrong" });
    expect(r.json()).toMatchObject({ status: "refund_pending" });
    expect(refunds).toEqual([pi]);
    await hook("charge.refunded", { id: "ch_1", object: "charge", payment_intent: pi, amount_refunded: 6500, currency: "sek" });
    expect((await call(app, "GET", `/admin/riders/${sara.id}/fee-payments`, finance)).json().items[0]).toMatchObject({ status: "refunded" });
    expect((await database.db.selectFrom("rider_fees").select("status").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).status).toBe("refunded");
    expect((await profile()).outstandingByCurrency).toEqual([]);
    expect((await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/stripe-refund`, finance, { reason: "again" })).json()).toMatchObject({ reason: "no_stripe_payment" });
  });
});

describe("keys, setting and signature", () => {
  it("test keys turn Stripe on on staging; none or live keys there = off (503 payments_unavailable); live mode: stripe_live_mode.test.ts", () => {
    expect(stripeFromEnv({ MOVERA_ENV: "staging" })).toBeNull();
    expect(stripeFromEnv({ MOVERA_ENV: "staging", STRIPE_SECRET_KEY: "sk_live_x", STRIPE_PUBLISHABLE_KEY: "pk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })).toBeNull();
    expect(stripeFromEnv({ MOVERA_ENV: "staging", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PUBLISHABLE_KEY: "pk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })?.publishableKey).toBe("pk_test_x");
  });

  it("verifyStripeSignature: right secret and time only", () => {
    const body = '{"id":"evt"}';
    expect(verifyStripeSignature(body, stripeSignatureHeader(body, HOOK, clock.now), HOOK, clock.now)).toBe(true);
    expect(verifyStripeSignature(body + " ", stripeSignatureHeader(body, HOOK, clock.now), HOOK, clock.now)).toBe(false);
    expect(verifyStripeSignature(body, undefined, HOOK, clock.now)).toBe(false);
  });

  it("PUT country_rules: riderFeeStripe must be { enabled: boolean } (400 rider_fee_stripe_invalid); a kept key, kept by Restore", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const r = sample("rider_app_config"), d = sample("driver_app_config");
    const doc = (riderFeeStripe: unknown) => ({ version: 1, publishedAt: clock.now.toISOString(), country: "SE", currency: "SEK", tips: r.tips ?? [], raiseSteps: r.raiseSteps ?? [], driverBonus: d.driverBonus ?? {}, riderFeeStripe });
    const bad = await call(app, "PUT", "/admin/config/country_rules", admin, { expectedVersion: 1, country: "SE", document: doc({ enabled: "yes" }) });
    expect(bad.json()).toMatchObject({ reason: "rider_fee_stripe_invalid" });
    expect(KEPT_KEYS.country_rules).toContain("riderFeeStripe");
    expect(KEPT_ON_RESTORE.country_rules).toContain("riderFeeStripe");
  });
});

describe("money review of 05bb3ac (NO-GO fixes)", () => {
  const finance = async () => (await adminSession(app, database.db, "finance", { now: clock.now })).headers;
  const payments = async () => (await call(app, "GET", `/admin/riders/${sara.id}/fee-payments`, await finance())).json().items as Array<Record<string, unknown>>;
  const walletSum = async () => (await database.db.selectFrom("wallet_entries").select("amount_minor").where("rider_id", "=", sara.id).execute()).reduce((a, e) => a + Number(e.amount_minor), 0);
  const feeStatus = async (tripId: string) => (await database.db.selectFrom("rider_fees").select("status").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).status;

  it("(1) fee 100, wallet credit leaves debt 50, card 100: 50 settles the fee, the other 50 is paidTwice (overpaid) to refund", async () => {
    const tripId = await owedFee(10000);
    const pi = (await pay(tripId)).json().paymentIntentId;
    await database.db.insertInto("wallet_entries").values({ entry_id: "wlt_credit_review", rider_id: sara.id, kind: "adjustment", currency: "SEK", amount_minor: 5000, trip_id: null, at: clock.now }).execute();
    await database.db.updateTable("rider_wallets").set({ balance_minor: -5000 }).where("rider_id", "=", sara.id).execute();
    await hook("payment_intent.succeeded", succeeded(pi, 10000));
    expect(await feeStatus(tripId)).toBe("paid");
    expect(await walletSum()).toBe(0);
    expect((await payments())[0]).toMatchObject({ paymentIntentId: pi, status: "succeeded", paidTwice: true, overpaid: SEK(5000) });
  });

  it("(4)(8) a fee marked paid by hand cancels its open intent (no secret); money that still arrives is paidTwice for all of it", async () => {
    const tripId = await owedFee(6500);
    const pi = (await pay(tripId)).json().paymentIntentId;
    expect((await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/mark-paid`, await finance(), { reason: "Swish" })).statusCode).toBe(200);
    expect((await payments())[0]).toMatchObject({ paymentIntentId: pi, status: "canceled" });
    expect((await database.db.selectFrom("stripe_payments").select("client_secret").executeTakeFirstOrThrow()).client_secret).toBeNull();
    expect((await pay(tripId)).json()).toMatchObject({ reason: "fee_not_owed" });
    await hook("payment_intent.succeeded", succeeded(pi));
    expect((await payments())[0]).toMatchObject({ status: "succeeded", paidTwice: true, overpaid: SEK(6500) });
    expect(await walletSum()).toBe(0);
  });

  it("(2)(8) a failed intent that then succeeds after a second one paid: paidTwice; the refund takes the paidTwice one first; the fee stays paid", async () => {
    const tripId = await owedFee(6500);
    const pi1 = (await pay(tripId)).json().paymentIntentId;
    await hook("payment_intent.payment_failed", { id: pi1, object: "payment_intent", amount: 6500, currency: "sek" });
    const pi2 = (await pay(tripId)).json().paymentIntentId;
    expect(pi2).not.toBe(pi1);
    await hook("payment_intent.succeeded", succeeded(pi2));
    await hook("payment_intent.succeeded", succeeded(pi1));
    const byId = Object.fromEntries((await payments()).map((p) => [p["paymentIntentId"], p]));
    expect(byId[pi1]).toMatchObject({ status: "succeeded", paidTwice: true });
    expect(byId[pi2]).toMatchObject({ status: "succeeded" });
    expect(byId[pi2]!["paidTwice"]).toBeUndefined();
    expect(await walletSum()).toBe(0);
    const h = await finance();
    expect((await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/stripe-refund`, h, { reason: "Paid twice" })).json()).toMatchObject({ paymentIntentId: pi1, status: "refund_pending" });
    await hook("charge.refunded", { id: "ch_r", object: "charge", payment_intent: pi1, amount_refunded: 6500, currency: "sek" });
    expect(await feeStatus(tripId)).toBe("paid");
    // (8) a repeated admin refund takes the other payment, never the same one twice.
    expect((await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/stripe-refund`, h, { reason: "Wrong fee" })).json()).toMatchObject({ paymentIntentId: pi2 });
    expect((await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/stripe-refund`, h, { reason: "again" })).json()).toMatchObject({ reason: "no_stripe_payment" });
    expect(refunds).toEqual([pi1, pi2]);
  });

  it("(7) a succeeded event with another amount leaves amountMismatch for the admin; the fee stays owed", async () => {
    const tripId = await owedFee(6500);
    const pi = (await pay(tripId)).json().paymentIntentId;
    await hook("payment_intent.succeeded", succeeded(pi, 100));
    expect((await payments())[0]).toMatchObject({ paymentIntentId: pi, status: "requires_payment", amountMismatch: true });
    expect(await feeStatus(tripId)).toBe("owed");
  });

  it("(8) concurrent webhooks (same and different event ids) and pay calls: the fee is paid once", async () => {
    const tripId = await owedFee(6500);
    const pi = (await pay(tripId)).json().paymentIntentId;
    await Promise.all([hook("payment_intent.succeeded", succeeded(pi), { id: "evt_dup" }), hook("payment_intent.succeeded", succeeded(pi), { id: "evt_dup" }), hook("payment_intent.succeeded", succeeded(pi)), pay(tripId), pay(tripId)]);
    expect(await feeStatus(tripId)).toBe("paid");
    expect(await walletSum()).toBe(0);
    const adj = await database.db.selectFrom("wallet_entries").select("kind").where("rider_id", "=", sara.id).where("kind", "=", "adjustment").execute();
    expect(adj).toHaveLength(1);
    expect((await payments()).filter((p) => p["status"] === "succeeded")).toHaveLength(1);
  });

  it("(6) the pay answer (client secret) is not kept in the Idempotency-Key store", async () => {
    const tripId = await owedFee(6500);
    const secret = (await pay(tripId)).json().clientSecret as string;
    const rows = await database.db.selectFrom("idempotency_keys").selectAll().execute();
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("(5) Stripe's charge_already_refunded counts as a done refund", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ error: { code: "charge_already_refunded" } }), { status: 400 })) as unknown as typeof fetch;
    const api = stripeFromEnv({ MOVERA_ENV: "staging", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PUBLISHABLE_KEY: "pk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }, fetcher)!;
    expect(await api.refund({ paymentIntentId: "pi_x", idempotencyKey: "refund:pi_x" })).toEqual({ id: "already_refunded" });
    const other = (async () => new Response(JSON.stringify({ error: { code: "other" } }), { status: 400 })) as unknown as typeof fetch;
    await expect(stripeFromEnv({ MOVERA_ENV: "staging", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PUBLISHABLE_KEY: "pk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }, other)!.refund({ paymentIntentId: "pi_x", idempotencyKey: "k" })).rejects.toThrow();
  });
  it("MUST 1 (review 5e606be5): fee 1000 with debt 600, card 600, a new fee 500: the debt drops by 600 only; the fee stays owed for 400", async () => {
    const t1 = await owedFee(10000);
    await database.db.insertInto("wallet_entries").values({ entry_id: "wlt_credit_m1", rider_id: sara.id, kind: "adjustment", currency: "SEK", amount_minor: 4000, trip_id: null, at: clock.now }).execute();
    await database.db.updateTable("rider_wallets").set({ balance_minor: -6000 }).where("rider_id", "=", sara.id).execute();
    const first = (await pay(t1)).json();
    expect(first.amount).toEqual(SEK(6000));
    const t2 = await owedFee(5000);
    await hook("payment_intent.succeeded", succeeded(first.paymentIntentId, 6000));
    // No money lost: the debt drops by exactly the card money that is not flagged for refund, never by more.
    const row = (await payments()).find((p) => p["paymentIntentId"] === first.paymentIntentId)!;
    const over = (row["overpaid"] as { amountMinor: number } | undefined)?.amountMinor ?? 0;
    expect(await walletSum()).toBe(-(6000 + 5000) + (6000 - over));
    expect(await feeStatus(t2)).toBe("owed");
    // The first fee never takes more card money than its 1000 − 600 left.
    if ((await feeStatus(t1)) === "owed") expect((await pay(t1)).json().amount.amountMinor).toBeLessThanOrEqual(4000);
  });

  it("(4) reverse no-show of a fee paid by card: the card payment is flagged for a card refund; no money into the wallet too", async () => {
    const tripId = await owedFee(6500);
    await database.db.updateTable("trips").set({ status: "no_show" }).where("trip_id", "=", tripId).execute();
    const pi = (await pay(tripId)).json().paymentIntentId;
    await hook("payment_intent.succeeded", succeeded(pi));
    expect(await walletSum()).toBe(0);
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const version = (await database.db.selectFrom("trips").select("version").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).version;
    expect((await call(app, "POST", `/admin/trips/${tripId}/reverse-no-show`, admin, { expectedVersion: version, reason: "Wrong no-show" })).statusCode).toBe(200);
    expect(await walletSum()).toBe(0);
    expect((await payments())[0]).toMatchObject({ paymentIntentId: pi, paidTwice: true, overpaid: SEK(6500) });
  });

  it("(5) a repeat refund while the first is pending is 409 no_stripe_payment; a canceled-then-succeeded intent after a new one paid is paidTwice", async () => {
    const tripId = await owedFee(6500);
    const pi1 = (await pay(tripId)).json().paymentIntentId;
    await hook("payment_intent.canceled", { id: pi1, object: "payment_intent", amount: 6500, currency: "sek" });
    const pi2 = (await pay(tripId)).json().paymentIntentId;
    await hook("payment_intent.succeeded", succeeded(pi2));
    await hook("payment_intent.succeeded", succeeded(pi1));
    expect(await walletSum()).toBe(0);
    const h = await finance();
    await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/stripe-refund`, h, { reason: "Paid twice" });
    await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/stripe-refund`, h, { reason: "Wrong" });
    const again = await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/stripe-refund`, h, { reason: "again" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ reason: "no_stripe_payment" });
    expect(refunds).toEqual([pi1, pi2]);
  });

  it("(5) interleaved: two pay calls and the webhook of the first intent at once, then a webhook for any second intent: one fee paid, debt 0", async () => {
    const tripId = await owedFee(6500);
    const pi = (await pay(tripId)).json().paymentIntentId;
    const [a, b] = await Promise.all([pay(tripId), hook("payment_intent.succeeded", succeeded(pi)), pay(tripId)]);
    for (const r of [a, b]) expect([200, 409]).toContain(r.statusCode);
    for (const p of await payments()) if (p["paymentIntentId"] !== pi) await hook("payment_intent.succeeded", succeeded(String(p["paymentIntentId"])));
    expect(await feeStatus(tripId)).toBe("paid");
    expect(await walletSum()).toBe(0);
  });

  it("review 0203ebb8 MUST 1: a partly overpaid payment is refunded only by its overpaid part; the fee stays paid", async () => {
    const tripId = await owedFee(10000);
    const pi = (await pay(tripId)).json().paymentIntentId;
    await database.db.insertInto("wallet_entries").values({ entry_id: "wlt_credit_p1", rider_id: sara.id, kind: "adjustment", currency: "SEK", amount_minor: 5000, trip_id: null, at: clock.now }).execute();
    await database.db.updateTable("rider_wallets").set({ balance_minor: -5000 }).where("rider_id", "=", sara.id).execute();
    await hook("payment_intent.succeeded", succeeded(pi, 10000));
    const r = await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/stripe-refund`, await finance(), { reason: "Overpaid" });
    expect(r.json()).toMatchObject({ status: "refund_pending" });
    expect(refundAmounts).toEqual([5000]);
    await hook("charge.refunded", { id: "ch_p", object: "charge", payment_intent: pi, amount_refunded: 5000, currency: "sek" });
    expect((await payments())[0]).toMatchObject({ status: "refunded" });
    expect(await feeStatus(tripId)).toBe("paid");
    expect(await walletSum()).toBe(0);
  });

  it("review 0203ebb8 SHOULD: waiving a fee a card part-paid flags that card money for a card refund", async () => {
    const tripId = await owedFee(10000);
    // A card payment of 60 kr already took 60 kr off this fee (part paid; the fee stays owed for 40 kr).
    await database.db.insertInto("stripe_payments").values({ payment_intent_id: "pi_part", purpose: "rider_fee", subject_id: sara.id, ref_id: tripId, currency: "SEK", amount_minor: 6000, status: "succeeded", client_secret: null, refund_id: null, created_at: clock.now, paid_at: clock.now, refunded_at: null }).execute();
    await database.db.insertInto("wallet_entries").values({ entry_id: "wlt_card_w1", rider_id: sara.id, kind: "adjustment", currency: "SEK", amount_minor: 6000, trip_id: tripId, at: clock.now }).execute();
    await database.db.updateTable("rider_wallets").set({ balance_minor: -4000 }).where("rider_id", "=", sara.id).execute();
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const version = (await database.db.selectFrom("trips").select("version").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).version;
    expect((await call(app, "POST", `/admin/trips/${tripId}/adjust`, admin, { expectedVersion: version, waiveCancelFee: true, reason: "emergency" })).statusCode).toBe(200);
    expect(await feeStatus(tripId)).toBe("waived");
    expect(await walletSum()).toBe(0);
    expect((await payments())[0]).toMatchObject({ paymentIntentId: "pi_part", paidTwice: true, overpaid: SEK(6000) });
  });

  it("review 0203ebb8 MUST 2: a waive and the webhook at the same time both finish (one lock order, no deadlock)", async () => {
    const tripId = await owedFee(6500);
    const pi = (await pay(tripId)).json().paymentIntentId;
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const version = (await database.db.selectFrom("trips").select("version").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).version;
    const [w, h] = await Promise.all([call(app, "POST", `/admin/trips/${tripId}/adjust`, admin, { expectedVersion: version, waiveCancelFee: true, reason: "emergency" }), hook("payment_intent.succeeded", succeeded(pi))]);
    expect(h.statusCode).toBe(200);
    expect([200, 409]).toContain(w.statusCode);
    if (w.statusCode === 409) expect(w.json().reason).toBe("no_fee_to_waive");
    expect(await walletSum()).toBe(0);
    const row = (await payments())[0]!;
    // Either the card paid it (waive refused) or it was waived and the card money is flagged for refund.
    if (w.statusCode === 200) expect(row).toMatchObject({ paidTwice: true });
  });

  it("review 2c918ac6: reverse no-show after a part refund: the settled card part goes to the wallet; the refund key carries the amount", async () => {
    const tripId = await owedFee(10000);
    await database.db.updateTable("trips").set({ status: "no_show" }).where("trip_id", "=", tripId).execute();
    const pi = (await pay(tripId)).json().paymentIntentId;
    await database.db.insertInto("wallet_entries").values({ entry_id: "wlt_credit_r2", rider_id: sara.id, kind: "adjustment", currency: "SEK", amount_minor: 5000, trip_id: null, at: clock.now }).execute();
    await database.db.updateTable("rider_wallets").set({ balance_minor: -5000 }).where("rider_id", "=", sara.id).execute();
    await hook("payment_intent.succeeded", succeeded(pi, 10000));
    expect(await feeStatus(tripId)).toBe("paid");
    const keys: string[] = [];
    const orig = fake.refund;
    fake.refund = async (input) => { keys.push(input.idempotencyKey); return orig(input); };
    try {
      await call(app, "POST", `/admin/riders/${sara.id}/fees/${tripId}/stripe-refund`, await finance(), { reason: "Overpaid" });
    } finally {
      fake.refund = orig;
    }
    expect(keys).toEqual([`refund:${pi}:5000`]);
    await hook("charge.refunded", { id: "ch_r2", object: "charge", payment_intent: pi, amount_refunded: 5000, currency: "sek" });
    const before = await walletSum();
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const version = (await database.db.selectFrom("trips").select("version").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).version;
    expect((await call(app, "POST", `/admin/trips/${tripId}/reverse-no-show`, admin, { expectedVersion: version, reason: "Wrong no-show" })).statusCode).toBe(200);
    // The whole fee goes back to the wallet (the card part that settled it was never refunded).
    expect((await walletSum()) - before).toBe(10000);
  });

  it("review b118efdd: a processing intent is kept when the amount changes (409 payment_processing)", async () => {
    const tripId = await owedFee(6500);
    const pi = (await pay(tripId)).json().paymentIntentId;
    await hook("payment_intent.processing", { id: pi, object: "payment_intent", amount: 6500, currency: "sek" });
    await database.db.updateTable("rider_wallets").set({ balance_minor: -4000 }).where("rider_id", "=", sara.id).execute();
    expect((await pay(tripId)).json()).toMatchObject({ reason: "payment_processing" });
    expect(canceled).toEqual([]);
  });

});
