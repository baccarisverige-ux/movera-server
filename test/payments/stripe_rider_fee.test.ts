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
 * Contract v0.18.141 `stripeFees` (DRAFT, Stripe TEST mode; owner 2026-11-20 "So we use stripe"): Sara pays her owed
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
  async refund({ paymentIntentId }) { refunds.push(paymentIntentId); return { id: `re_${paymentIntentId}` }; },
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
  made = []; canceled = []; refunds = [];
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
  const body = JSON.stringify({ id: opts.id ?? `evt_${++ev}`, type, data: { object } });
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
    expect((await pay("trp_nothing")).json()).toMatchObject({ reason: "fee_not_owed" });
    const other = (await signIn(app, TEST_PHONES[2]!, "rider")).headers;
    expect((await call(app, "POST", `/rider/fees/${tripId}/pay`, other, {})).json()).toMatchObject({ reason: "fee_not_owed" });
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
  it("only test keys turn Stripe on; none or live keys = off (503 payments_unavailable)", () => {
    expect(stripeFromEnv({})).toBeNull();
    expect(stripeFromEnv({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_PUBLISHABLE_KEY: "pk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })).toBeNull();
    expect(stripeFromEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PUBLISHABLE_KEY: "pk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })?.publishableKey).toBe("pk_test_x");
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
