import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { owedByDriver } from "../../src/drivers/owes.js";
import { payReference } from "../../src/drivers/payRequest.js";
import { seedDriver } from "../../src/drivers/service.js";
import { stripeSignatureHeader, type StripeApi } from "../../src/payments/stripe.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * DRAFT contract.json#driverPayRequest.stripe (owner 2026-11-20 "Stripe is used for exactly TWO things: ... (2) the
 * DRIVER paying his monthly invoice to Movera"): the Pay Movera button pays by Stripe for the server's owed; the signed
 * webhook records it as "Driver paid Movera" (at most what he owes then; the rest flagged). Fails before: no route.
 */
const HOOK = "whsec_test_only_not_a_real_secret";
let database: TestDatabase;
let app: FastifyInstance;
const DAY1 = new Date("2026-11-01T09:30:00.000Z");
const clock = { now: new Date(DAY1) };
const SEK = (amountMinor: number) => ({ amountMinor, currency: "SEK" });
const sample = (name: string) => JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/${name}.json`, "utf8"));
let ali: { id: string; headers: Record<string, string> };
let made: Array<{ amountMinor: number; currency: string; idempotencyKey: string; metadata: Record<string, string> }> = [];
let canceled: string[] = [];
let k = 0;
let e = 0;
const fake: StripeApi = {
  publishableKey: "pk_test_fake",
  webhookSecret: HOOK,
  async createPaymentIntent(input) { made.push(input); const id = `pi_drv_${++k}`; return { id, clientSecret: `${id}_secret_x`, amountMinor: input.amountMinor, currency: input.currency, status: "requires_payment_method" }; },
  async cancelPaymentIntent(id) { canceled.push(id); },
  async refund({ paymentIntentId }) { return { id: `re_${paymentIntentId}` }; },
};

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock, { stripe: fake });
  for (const doc of ["driver_app_config", "rider_app_config"]) {
    await database.db.insertInto("config_live").values({ doc: doc as never, zone_id: "Z001", version: 1, document: JSON.stringify(sample(doc)), published_at: clock.now, published_by: null }).execute();
  }
  const d = await database.db.transaction().execute((trx) => seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Ali", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "PAY002", categoryIds: ["economy"], zoneIds: ["Z001"] }, clock.now));
  await database.db.updateTable("drivers").set({ country: "SE" }).where("driver_id", "=", d.driverId).execute();
  ali = { id: d.driverId, headers: {} };
});
afterAll(async () => {
  await app.close();
  await database.drop();
});
beforeEach(async () => {
  made = []; canceled = [];
  for (const t of ["stripe_events", "stripe_payments", "earnings_entries", "payouts"] as const) await database.db.deleteFrom(t).execute();
  await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").execute();
  await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-SE", version: 1, document: JSON.stringify({ country: "SE", currency: "SEK", driverPayRequest: { enabled: true, dayOfMonth: 1, payLink: "https://pay.sumup.com/b2c/MOVERA1", minAmount: SEK(1000) } }), published_at: clock.now, published_by: null }).execute();
  ali.headers = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
});

/** He collected 349 kr cash, earned 325,16 kr: he owes Movera 23,84 kr. */
async function owes(amountMinor: number) {
  await database.db.insertInto("earnings_entries").values({ entry_id: `ern_ps${++e}`, driver_id: ali.id, trip_id: null, kind: "trip" as never, currency: "SEK", amount_minor: 10000, gross_minor: null, commission_minor: null, cash_minor: 10000 + amountMinor, at: clock.now, payout_id: null }).execute();
}
const owed = async () => (await owedByDriver(database.db, [ali.id], "SEK")).get(ali.id) ?? 0;
const pay = () => call(app, "POST", "/driver/pay-movera/pay", ali.headers, {});
async function hook(type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({ id: `evt_d${++e}`, type, data: { object } });
  return app.inject({ method: "POST", url: "/api/v1/webhooks/stripe", headers: { "content-type": "application/json", "stripe-signature": stripeSignatureHeader(body, HOOK, clock.now) }, payload: body });
}
const succeeded = (id: string, amount: number) => ({ id, object: "payment_intent", amount, amount_received: amount, currency: "sek" });

describe("driver monthly payment by Stripe", () => {
  it("GET /driver/pay-movera says stripe: true; the pay call makes one PaymentIntent for what he owes now (the app sends no amount)", async () => {
    await owes(2384);
    expect((await call(app, "GET", "/driver/pay-movera", ali.headers)).json()).toMatchObject({ enabled: true, stripe: true, owedToMovera: SEK(2384) });
    const first = await pay();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ amount: SEK(2384), status: "requires_payment", clientSecret: expect.stringMatching(/_secret_x$/), publishableKey: "pk_test_fake" });
    expect(made).toEqual([{ amountMinor: 2384, currency: "SEK", idempotencyKey: `driver_invoice:${payReference(ali.id, "2026-11")}:2384:0`, metadata: { purpose: "driver_invoice", driverId: ali.id, reference: payReference(ali.id, "2026-11") } }]);
    expect((await pay()).json().paymentIntentId).toBe(first.json().paymentIntentId);
    expect(made).toHaveLength(1);
  });

  it("the webhook records it as Driver paid Movera: owed 0, a paid_to_movera entry, audit driver.paid_movera_stripe; a repeat changes nothing", async () => {
    await owes(2384);
    const pi = (await pay()).json().paymentIntentId;
    await hook("payment_intent.succeeded", succeeded(pi, 2384));
    await hook("payment_intent.succeeded", succeeded(pi, 2384));
    expect(await owed()).toBe(0);
    const paid = await database.db.selectFrom("earnings_entries").select(["kind", "amount_minor"]).where("driver_id", "=", ali.id).where("kind", "=", "paid_to_movera").execute();
    expect(paid.map((p) => Number(p.amount_minor))).toEqual([2384]);
    expect(await database.db.selectFrom("admin_audit").select("action").where("action", "=", "driver.paid_movera_stripe").execute()).toHaveLength(1);
  });

  it("paid by hand first: the card money takes nothing off and is flagged paidTwice with overpaid; part paid: only the rest is flagged", async () => {
    await owes(2384);
    const pi = (await pay()).json().paymentIntentId;
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    expect((await call(app, "POST", `/admin/drivers/${ali.id}/paid-movera`, admin, { expectedOwed: SEK(2384), amount: SEK(1000), reason: "Swish" })).statusCode).toBe(200);
    await hook("payment_intent.succeeded", succeeded(pi, 2384));
    expect(await owed()).toBe(0);
    const row = await database.db.selectFrom("stripe_payments").selectAll().where("payment_intent_id", "=", pi).executeTakeFirstOrThrow();
    expect(row.paid_twice).toBe(true);
    expect(Number(row.overpaid_minor)).toBe(1000);
  });

  it("refusals: off in the country 409 pay_request_off; nothing owed 409 nothing_owed; no Stripe call", async () => {
    expect((await pay()).json()).toMatchObject({ reason: "nothing_owed" });
    await database.db.updateTable("config_live").set({ document: JSON.stringify({ country: "SE", currency: "SEK" }) }).where("doc", "=", "country_rules").execute();
    await owes(2384);
    expect((await pay()).json()).toMatchObject({ reason: "pay_request_off" });
    expect((await call(app, "GET", "/driver/pay-movera", ali.headers)).json()).toMatchObject({ stripe: false });
    expect(made).toHaveLength(0);
  });
  it("review 0e00ad48: owed changes between taps: the old intent is canceled after commit; a processing one is kept (409); a late success on the canceled one takes at most what is owed", async () => {
    await owes(2384);
    const first = (await pay()).json().paymentIntentId;
    await owes(1000);
    const second = (await pay()).json();
    expect(second.amount).toEqual(SEK(3384));
    expect(canceled).toEqual([first]);
    await hook("payment_intent.processing", { id: second.paymentIntentId, object: "payment_intent", amount: 3384, currency: "sek" });
    await owes(500);
    expect((await pay()).json()).toMatchObject({ reason: "payment_processing" });
    // The canceled first intent still succeeds at Stripe: recorded, at most what he owes, never twice.
    await hook("payment_intent.succeeded", succeeded(first, 2384));
    expect(await owed()).toBe(3884 - 2384);
    await hook("payment_intent.succeeded", succeeded(second.paymentIntentId, 3384));
    expect(await owed()).toBe(0);
    const row = await database.db.selectFrom("stripe_payments").selectAll().where("payment_intent_id", "=", second.paymentIntentId).executeTakeFirstOrThrow();
    expect(Number(row.overpaid_minor)).toBe(3384 - 1500);
  });

  it("owner 2026-11-20: Stripe replaces the SumUp link: switched on with no link, the request is on and the app pays by Stripe; a link stays hidden", async () => {
    const admin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
    const draft = (await call(app, "GET", "/admin/config/country_rules?country=SE", admin)).json();
    const doc = { version: 1, publishedAt: clock.now.toISOString(), country: "SE", currency: "SEK", tips: [], raiseSteps: [], driverBonus: {}, driverPayRequest: { enabled: true, dayOfMonth: 1, payLink: "", minAmount: SEK(1000) } };
    const saved = await call(app, "PUT", "/admin/config/country_rules", admin, { expectedVersion: draft.version ?? 1, country: "SE", document: doc });
    expect(saved.json().reason).not.toBe("pay_request_needs_link");
    await database.db.updateTable("config_live").set({ document: JSON.stringify({ country: "SE", currency: "SEK", driverPayRequest: { enabled: true, dayOfMonth: 1, payLink: "", minAmount: SEK(1000) } }) }).where("doc", "=", "country_rules").execute();
    await owes(2384);
    const view = (await call(app, "GET", "/driver/pay-movera", ali.headers)).json();
    expect(view).toMatchObject({ enabled: true, stripe: true });
    expect(view.payLink).toBeUndefined();
    expect((await pay()).json()).toMatchObject({ amount: SEK(2384), status: "requires_payment" });
    // A link stored as legacy is not sent while Stripe is on.
    await database.db.updateTable("config_live").set({ document: JSON.stringify({ country: "SE", currency: "SEK", driverPayRequest: { enabled: true, dayOfMonth: 1, payLink: "https://pay.sumup.com/b2c/MOVERA1", minAmount: SEK(1000) } }) }).where("doc", "=", "country_rules").execute();
    expect((await call(app, "GET", "/driver/pay-movera", ali.headers)).json().payLink).toBeUndefined();
  });

});
