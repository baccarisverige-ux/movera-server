import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { findCauses } from "../../src/alerts/detector.js";
import { readEnv, startupWarnings } from "../../src/env.js";
import { stripeFromEnv, stripeKeyStatus, stripeSignatureHeader } from "../../src/payments/stripe.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Contract v0.18.136 stripeFees.keys + stripeFees.status (DRAFT; owner 2026-11-21 "Yes, build live mode now
 * (Recommended)"): one Stripe mode at a time from the key prefixes; production takes live keys only, staging test keys
 * only; a mix or a wrong mode for the server = Stripe off + a system_health alert; the admin reads the mode; a webhook
 * event of the other mode is refused. Every key here is an obviously fake value: no real Stripe call is ever made.
 */

const LIVE = { STRIPE_SECRET_KEY: "sk_live_FAKE_not_a_real_key", STRIPE_PUBLISHABLE_KEY: "pk_live_FAKE_not_a_real_key", STRIPE_WEBHOOK_SECRET: "whsec_FAKE_live_endpoint" };
const TEST = { STRIPE_SECRET_KEY: "sk_test_FAKE_not_a_real_key", STRIPE_PUBLISHABLE_KEY: "pk_test_FAKE_not_a_real_key", STRIPE_WEBHOOK_SECRET: "whsec_FAKE_test_endpoint" };
const SECRET = "stripe-live-mode-test-jwt-secret-at-least-32-chars";
const DOC_KEY = Buffer.alloc(32, 7).toString("base64");
const clock = { now: new Date("2026-11-21T10:00:00.000Z") };
const stripeAlerts = async (db: TestDatabase) => (await findCauses(db.db, clock.now)).filter((c) => c.key.startsWith("system_health:stripe_keys:"));

describe("stripeKeyStatus: one mode at a time, production = live, staging = test", () => {
  it("live keys in production → live (Stripe on with the live publishable key)", () => {
    expect(stripeKeyStatus({ MOVERA_ENV: "production", ...LIVE })).toEqual({ mode: "live" });
    const api = stripeFromEnv({ MOVERA_ENV: "production", ...LIVE });
    expect(api?.mode).toBe("live");
    expect(api?.publishableKey).toBe(LIVE.STRIPE_PUBLISHABLE_KEY);
  });

  it("test keys in production → off (test_keys_in_production)", () => {
    expect(stripeKeyStatus({ MOVERA_ENV: "production", ...TEST })).toEqual({ mode: "off", reason: "test_keys_in_production" });
    expect(stripeFromEnv({ MOVERA_ENV: "production", ...TEST })).toBeNull();
  });

  it("test keys on staging and development → test; live keys there → off (live_keys_outside_production)", () => {
    expect(stripeKeyStatus({ MOVERA_ENV: "staging", ...TEST })).toEqual({ mode: "test" });
    expect(stripeFromEnv({ MOVERA_ENV: "staging", ...TEST })?.mode).toBe("test");
    expect(stripeKeyStatus({ MOVERA_ENV: "development", ...TEST })).toEqual({ mode: "test" });
    expect(stripeKeyStatus({ MOVERA_ENV: "staging", ...LIVE })).toEqual({ mode: "off", reason: "live_keys_outside_production" });
    expect(stripeKeyStatus({ MOVERA_ENV: "development", ...LIVE })).toEqual({ mode: "off", reason: "live_keys_outside_production" });
    expect(stripeFromEnv({ MOVERA_ENV: "staging", ...LIVE })).toBeNull();
  });

  it("a mix of test and live keys → off (mixed_keys) on every server; a restricted key counts as a mix", () => {
    for (const env of ["production", "staging"] as const) {
      expect(stripeKeyStatus({ MOVERA_ENV: env, ...TEST, STRIPE_PUBLISHABLE_KEY: LIVE.STRIPE_PUBLISHABLE_KEY })).toEqual({ mode: "off", reason: "mixed_keys" });
      expect(stripeKeyStatus({ MOVERA_ENV: env, ...LIVE, STRIPE_PUBLISHABLE_KEY: TEST.STRIPE_PUBLISHABLE_KEY })).toEqual({ mode: "off", reason: "mixed_keys" });
      expect(stripeKeyStatus({ MOVERA_ENV: env, ...LIVE, STRIPE_SECRET_KEY: "rk_live_FAKE_restricted" })).toEqual({ mode: "off", reason: "mixed_keys" });
      expect(stripeFromEnv({ MOVERA_ENV: env, ...TEST, STRIPE_PUBLISHABLE_KEY: LIVE.STRIPE_PUBLISHABLE_KEY })).toBeNull();
    }
  });

  it("no keys → off (no_keys); one or two of three → keys_incomplete; a webhook secret that is not whsec_ → bad_webhook_secret", () => {
    expect(stripeKeyStatus({ MOVERA_ENV: "production" })).toEqual({ mode: "off", reason: "no_keys" });
    expect(stripeKeyStatus({ MOVERA_ENV: "production", STRIPE_SECRET_KEY: LIVE.STRIPE_SECRET_KEY })).toEqual({ mode: "off", reason: "keys_incomplete" });
    expect(stripeKeyStatus({ MOVERA_ENV: "production", ...LIVE, STRIPE_WEBHOOK_SECRET: undefined })).toEqual({ mode: "off", reason: "keys_incomplete" });
    expect(stripeKeyStatus({ MOVERA_ENV: "production", ...LIVE, STRIPE_WEBHOOK_SECRET: "FAKE_not_whsec" })).toEqual({ mode: "off", reason: "bad_webhook_secret" });
    expect(stripeFromEnv({ MOVERA_ENV: "production", ...LIVE, STRIPE_WEBHOOK_SECRET: "FAKE_not_whsec" })).toBeNull();
  });

  it("a start-up warning names the reason of a setup mistake, never a key", () => {
    const env = readEnv({ MOVERA_ENV: "production", DATABASE_URL: "postgres://unused@localhost/x", JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: DOC_KEY, ...TEST });
    const lines = startupWarnings(env).filter((l) => l.includes("Stripe"));
    expect(lines).toEqual([expect.stringContaining("test_keys_in_production")]);
    expect(lines.join(" ")).not.toContain("FAKE");
    expect(startupWarnings(readEnv({ MOVERA_ENV: "production", DATABASE_URL: "postgres://unused@localhost/x", JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: DOC_KEY })).some((l) => l.includes("Stripe"))).toBe(false);
  });
});

describe("the server with its env keys: admin status, health alert, webhook mode", () => {
  let database: TestDatabase;
  let app: FastifyInstance | undefined;
  beforeAll(async () => {
    database = await freshDatabase();
  });
  afterAll(async () => {
    await app?.close();
    await database.drop();
  });
  const start = async (env: Record<string, string>) => {
    await app?.close();
    app = await buildApp({ env: readEnv({ DATABASE_URL: database.url, JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: DOC_KEY, ...env }), logger: false, db: database.db, clock: () => clock.now });
    return app;
  };
  const status = async (a: FastifyInstance) => {
    const finance = (await adminSession(a, database.db, "finance", { now: clock.now })).headers;
    return a.inject({ method: "GET", url: "/api/v1/admin/payments/stripe-status", headers: finance });
  };
  let ev = 0;
  const hook = (a: FastifyInstance, livemode: boolean | undefined, secret: string) => {
    const body = JSON.stringify({ id: `evt_live_${++ev}`, type: "payment_intent.succeeded", ...(livemode === undefined ? {} : { livemode }), data: { object: { id: "pi_unknown", amount: 100, currency: "sek" } } });
    return a.inject({ method: "POST", url: "/api/v1/webhooks/stripe", headers: { "content-type": "application/json", "stripe-signature": stripeSignatureHeader(body, secret, clock.now) }, payload: body });
  };

  it("production with live keys: admin sees Live, no alert; a live event signed with the live secret is taken", async () => {
    const a = await start({ MOVERA_ENV: "production", ...LIVE });
    const res = await status(a);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "live" });
    expect(res.body).not.toContain("FAKE");
    expect(await stripeAlerts(database)).toEqual([]);
    expect((await hook(a, true, LIVE.STRIPE_WEBHOOK_SECRET)).statusCode).toBe(200);
  });

  it("webhook: another secret (the test endpoint's) is refused 400 bad_signature; a test event on the live server 400 wrong_mode", async () => {
    const a = app!;
    const wrong = await hook(a, true, TEST.STRIPE_WEBHOOK_SECRET);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ reason: "bad_signature" });
    const testEvent = await hook(a, false, LIVE.STRIPE_WEBHOOK_SECRET);
    expect(testEvent.statusCode).toBe(400);
    expect(testEvent.json()).toMatchObject({ reason: "wrong_mode" });
    const noMode = await hook(a, undefined, LIVE.STRIPE_WEBHOOK_SECRET);
    expect(noMode.json()).toMatchObject({ reason: "wrong_mode" });
    expect(await database.db.selectFrom("stripe_events").select("event_id").where("event_id", "in", [`evt_live_${ev}`, `evt_live_${ev - 1}`]).execute()).toEqual([]);
  });

  it("production with test keys: Stripe off (503 on the webhook), admin sees off test_keys_in_production, one system_health alert per country book", async () => {
    const a = await start({ MOVERA_ENV: "production", ...TEST });
    expect((await status(a)).json()).toEqual({ mode: "off", reason: "test_keys_in_production" });
    expect((await hook(a, false, TEST.STRIPE_WEBHOOK_SECRET)).json()).toMatchObject({ reason: "payments_unavailable" });
    const alerts = await stripeAlerts(database);
    const countries = [...new Set((await database.db.selectFrom("zones").select("country").execute()).map((z) => z.country))];
    expect(alerts.map((c) => c.country).sort()).toEqual(countries.sort());
    expect(alerts[0]).toMatchObject({ kind: "system_health", zoneId: null, title: { t: "Card payments are off: Stripe test keys on the production server", a: [] }, detail: { t: "Fix the Stripe keys in the server settings and restart the server", a: [] } });
  });

  it("mixed keys: off (mixed_keys) + alert; live keys on staging: off (live_keys_outside_production) + alert", async () => {
    let a = await start({ MOVERA_ENV: "production", ...TEST, STRIPE_PUBLISHABLE_KEY: LIVE.STRIPE_PUBLISHABLE_KEY });
    expect((await status(a)).json()).toEqual({ mode: "off", reason: "mixed_keys" });
    expect((await stripeAlerts(database))[0]?.title.t).toBe("Card payments are off: the server has a mix of Stripe test and live keys");
    a = await start({ MOVERA_ENV: "staging", ...LIVE });
    expect((await status(a)).json()).toEqual({ mode: "off", reason: "live_keys_outside_production" });
    expect((await stripeAlerts(database))[0]?.title.t).toBe("Card payments are off: Stripe live keys on a test server");
  });

  it("staging with test keys: Test, no alert; no keys at all: off no_keys and no alert (the normal off)", async () => {
    let a = await start({ MOVERA_ENV: "staging", ...TEST });
    expect((await status(a)).json()).toEqual({ mode: "test" });
    expect(await stripeAlerts(database)).toEqual([]);
    expect((await hook(a, false, TEST.STRIPE_WEBHOOK_SECRET)).statusCode).toBe(200);
    expect((await hook(a, true, TEST.STRIPE_WEBHOOK_SECRET)).json()).toMatchObject({ reason: "wrong_mode" });
    a = await start({ MOVERA_ENV: "staging" });
    expect((await status(a)).json()).toEqual({ mode: "off", reason: "no_keys" });
    expect(await stripeAlerts(database)).toEqual([]);
  });

  it("the status needs finance.read (a support admin is 403)", async () => {
    const support = (await adminSession(app!, database.db, "support", { now: clock.now })).headers;
    expect((await app!.inject({ method: "GET", url: "/api/v1/admin/payments/stripe-status", headers: support })).statusCode).toBe(403);
  });
});
