import { describe, expect, it } from "vitest";
import { readEnv } from "../../src/env.js";
import { paymentOptionsOf, SERVER_PAYMENT_METHODS, supportedPaymentMethods } from "../../src/trips/finish.js";

/**
 * Live clean-up 1, audit 2026-11-02 M5 (contract v0.18.13, contract.json#finish.paymentMethods.serverSupport): the
 * admin's per-zone switches decide; the host's env can no longer narrow them. The only override is the emergency
 * kill-switch PAYMENT_METHODS_PAUSED.
 */
const base = { MOVERA_ENV: "development" };

describe("payment methods: admin wins, env only as a kill-switch (audit M5)", () => {
  it("the old PAYMENT_METHODS env list is not read any more", () => {
    const env = readEnv({ ...base, PAYMENT_METHODS: "" }) as unknown as Record<string, unknown>;
    expect(env["PAYMENT_METHODS"]).toBeUndefined();
    expect(supportedPaymentMethods(readEnv(base).PAYMENT_METHODS_PAUSED)).toEqual([...SERVER_PAYMENT_METHODS]);
  });

  it("an admin's cash switch is available unless paused; a paused method is coming_soon, never silently off (SE + FR docs)", () => {
    const normal = supportedPaymentMethods(readEnv(base).PAYMENT_METHODS_PAUSED);
    expect(paymentOptionsOf({ paymentMethods: ["cash", "card"] }, normal)).toEqual([{ method: "cash", status: "available" }, { method: "card", status: "coming_soon" }]);
    // Checker 2: cash can never be paused (ignored, with a warning); another method can.
    const warnings: string[] = [];
    const paused = supportedPaymentMethods(readEnv({ ...base, PAYMENT_METHODS_PAUSED: "cash,card" }).PAYMENT_METHODS_PAUSED, (m) => warnings.push(m));
    expect(paused).toEqual(["cash"]);
    expect(warnings).toHaveLength(1);
    expect(paymentOptionsOf({ paymentMethods: ["cash"] }, paused)).toEqual([{ method: "cash", status: "available" }]);
    expect(supportedPaymentMethods(["card"], (m) => warnings.push(m))).toEqual(["cash"]);
    expect(warnings).toHaveLength(1);
    // A method the admin turned off stays unlisted whatever the server takes.
    expect(paymentOptionsOf({ paymentMethods: ["card"] }, normal)).toEqual([{ method: "card", status: "coming_soon" }]);
  });
});
