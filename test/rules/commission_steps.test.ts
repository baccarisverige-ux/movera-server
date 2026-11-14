import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import { ApiError } from "../../src/http/errors.js";
import { checkDocument, type Zone } from "../../src/config/service.js";
import { priceFare, type CategoryPricing, type PricingDocument } from "../../src/rules/fare.js";
import { Frac } from "../../src/rules/fraction.js";
import { commissionStepsProblem, driverRidePart, type CommissionStep } from "../../src/rules/commissionSteps.js";

/**
 * J5b server (contract v0.18.86 + v0.18.88, contract.json#commissionSteps; owner 2026-11-13 ~20:48 UTC "Yes, like this
 * (Rec.)", ~21:40 "Yes, warn (Rec.)"; owner 2026-11-14 ~03:40 UTC: the fixed-step cap is a silent code guard).
 * Replays EVERY validate and pick case of fixtures/commission_steps.json, through the shared function, through the fare
 * (priceFare, in the case's own currency: TND with 3 decimals, SEK, EUR) and through the admin save check (checkDocument,
 * in a SEK zone and a TND zone). The 4 fares.json commission_steps_* cases run in test/rules/fare.test.ts.
 */

type Expect = "ok" | { step: number | null; problem: string };
type ValidateCase = { id: string; steps: unknown; expect: Expect };
type PickCase = {
  id: string;
  commissionPct: number;
  steps: CommissionStep[];
  commissionBase: { amountMinor: number; currency: string; exact?: string };
  expect: { step: number | null; driverRidePart: number; commission: number | string };
};
type WarnCase = { id: string; currency: string; steps: CommissionStep[] };
const fixture = contractJson<{ validate: ValidateCase[]; pick: PickCase[]; warn: WarnCase[] }>("fixtures/commission_steps.json");
const sek = contractJson<PricingDocument & Record<string, unknown>>("fixtures/config/pricing_document.json");

const exactBase = (c: PickCase) => Frac.dec(c.commissionBase.exact ?? String(c.commissionBase.amountMinor));
/** Movera's commission on the ride part (base − driver ride part), exact; the fixture writes an integer, or a decimal string for an exact base. */
const commissionOf = (base: Frac, driver: bigint): Frac => base.sub(Frac.of(driver));
const sameAmount = (got: Frac, want: number | string) => got.cmp(Frac.dec(String(want))) === 0;

/** A one-category pricing document whose commission base is exactly the case's base: only a per-km price of 1 minor unit. */
function baseOnlyDoc(currency: string, cat: Partial<CategoryPricing>): PricingDocument {
  const m = (amountMinor: number) => ({ amountMinor, currency });
  const economy: CategoryPricing = {
    enabled: true,
    base: m(0),
    perKm: m(1),
    perMin: m(0),
    minimum: m(0),
    maximum: null,
    appFeePct: 0,
    commissionPct: 20,
    extraStopFee: m(0),
    stopWaitPerMin: m(0),
    waiting: { freeWaitMin: 5, perMin: m(0), noShowAfterMin: 5, noShowFee: m(0) },
    riderPickupFee: { live: null, reservation: null },
    ...cat,
  };
  return { zoneId: "Z", currency, priceStep: m(1), categories: { economy }, fees: { airportPickup: m(0), airportDropoff: m(0), reservationFee: m(0) }, fixedRoutes: [], surge: {} };
}

/** The contract's sample pricing document moved to another zone and currency (every money's currency swapped). */
function inCurrency(zoneId: string, currency: string, country: string, timeZone: string): Record<string, unknown> {
  const swapped = JSON.parse(JSON.stringify(sek).replaceAll('"currency":"SEK"', `"currency":"${currency}"`)) as Record<string, unknown>;
  return { ...swapped, zoneId, country, timeZone };
}
const ZONES: Array<[string, Zone, Record<string, unknown>]> = [
  ["SEK", { zoneId: "Z001", name: "Stockholm", country: "SE", currency: "SEK", timeZone: "Europe/Stockholm", kind: "operating", open: true, center: { lat: 59.33, lng: 18.06 } }, sek],
  ["TND", { zoneId: "TN-TC", name: "Greater Tunis", country: "TN", currency: "TND", timeZone: "Africa/Tunis", kind: "operating", open: true, center: { lat: 36.785, lng: 10.085 } }, inCurrency("TN-TC", "TND", "TN", "Africa/Tunis")],
];
const withSteps = (doc: Record<string, unknown>, steps: unknown) => {
  const copy = JSON.parse(JSON.stringify(doc)) as { categories: Record<string, Record<string, unknown>> };
  copy.categories["economy"]!["commissionSteps"] = steps;
  return copy;
};
const refusal = (run: () => void): { status: number; code: string; reason?: string; details?: string[] } | null => {
  try {
    run();
    return null;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, code: error.code, ...(error.options.reason ? { reason: error.options.reason } : {}), ...(error.options.details ? { details: error.options.details } : {}) };
  }
};
const detailsOf = (e: Exclude<Expect, "ok">) => [...(e.step === null ? [] : [`step:${e.step}`]), `problem:${e.problem}`];

describe("J5b commission steps: fixtures/commission_steps.json", () => {
  it("has every case of contract v0.18.86 (18 validate, 13 pick, 8 warn)", () => {
    expect(fixture.validate).toHaveLength(18);
    expect(fixture.pick).toHaveLength(13);
    expect(fixture.warn).toHaveLength(8);
  });

  it.each(fixture.validate.map((c) => [c.id, c] as const))("validate %s", (_id, c) => {
    expect(commissionStepsProblem(c.steps)).toEqual(c.expect === "ok" ? null : c.expect);
  });

  it.each(fixture.pick.map((c) => [c.id, c] as const))("pick %s (shared function)", (_id, c) => {
    const base = exactBase(c);
    const got = driverRidePart(base, { commissionPct: c.commissionPct, commissionSteps: c.steps });
    expect({ step: got.step, driverRidePart: Number(got.driverRidePart) }).toEqual({ step: c.expect.step, driverRidePart: c.expect.driverRidePart });
    expect(sameAmount(commissionOf(base, got.driverRidePart), c.expect.commission), `commission ${String(c.expect.commission)}`).toBe(true);
  });

  it.each(fixture.pick.map((c) => [`${c.id} (${c.commissionBase.currency})`, c] as const))("pick %s through the fare: driverEarnings = the step's driver ride part", (_id, c) => {
    const doc = baseOnlyDoc(c.commissionBase.currency, { commissionPct: c.commissionPct, commissionSteps: c.steps });
    const base = exactBase(c);
    const fare = priceFare(doc, { categoryId: "economy", km: Number(c.commissionBase.exact ?? c.commissionBase.amountMinor), minutes: 0, kind: "live" });
    expect(fare.total).toEqual({ amountMinor: Number(base.halfUp()), currency: c.commissionBase.currency });
    expect(fare.driverEarnings).toEqual({ amountMinor: c.expect.driverRidePart, currency: c.commissionBase.currency });
    expect(fare.moveraShare.amountMinor).toBe(fare.total.amountMinor - c.expect.driverRidePart);
    expect(sameAmount(commissionOf(base, BigInt(fare.driverEarnings.amountMinor)), c.expect.commission), `commission ${String(c.expect.commission)}`).toBe(true);
  });

  it("no steps (absent, null or []) prices exactly like commissionPct", () => {
    for (const steps of [undefined, null, []]) {
      const doc = baseOnlyDoc("SEK", steps === undefined ? {} : { commissionSteps: steps });
      expect(priceFare(doc, { categoryId: "economy", km: 19700, minutes: 0, kind: "live" }).driverEarnings.amountMinor).toBe(15760);
    }
  });
});

describe("J5b: the fixed-step cap is a silent guard (owner 2026-11-14 ~03:40 UTC)", () => {
  it.each([
    ["TND", 1000, [{ upToMinor: 5000, amountMinor: 1000 }, { upToMinor: null, pct: 20 }]],
    ["SEK", 6000, [{ upToMinor: 10000, amountMinor: 6000 }, { upToMinor: null, pct: 20 }]],
    ["TND", 999999, [{ upToMinor: null, amountMinor: 999999 }]],
  ] as Array<[string, number, CommissionStep[]]>)("%s fixed %s: the commission is never above the base, the driver never below 0", (currency, fixed, steps) => {
    for (const minor of [0, 1, 2, 799, 800, 999, 1000, 1001, 4999, 5000, 5001, 6000, 9999]) {
      const base = Frac.of(minor);
      const { driverRidePart: part } = driverRidePart(base, { commissionPct: 20, commissionSteps: steps });
      expect(part >= 0n).toBe(true);
      expect(base.sub(Frac.of(part)).cmp(base) <= 0).toBe(true);
      if (minor <= (steps[0]!.upToMinor ?? Infinity)) expect(Number(part)).toBe(Math.max(0, minor - fixed));
      const fare = priceFare(baseOnlyDoc(currency, { commissionSteps: steps }), { categoryId: "economy", km: minor, minutes: 0, kind: "live" });
      expect(fare.driverEarnings.amountMinor).toBeGreaterThanOrEqual(0);
      expect(fare.driverEarnings.amountMinor).toBeLessThanOrEqual(fare.total.amountMinor);
    }
  });
  it("a capped trip keeps its waiting: the waiting stays 100 % the driver's", () => {
    const doc = baseOnlyDoc("TND", { commissionSteps: [{ upToMinor: 5000, amountMinor: 1000 }, { upToMinor: null, pct: 20 }], waiting: { freeWaitMin: 0, perMin: { amountMinor: 250, currency: "TND" }, noShowAfterMin: 5, noShowFee: { amountMinor: 0, currency: "TND" } } });
    const fare = priceFare(doc, { categoryId: "economy", km: 800, minutes: 0, kind: "live", waitingChargedSeconds: 120 });
    expect(fare.total.amountMinor).toBe(1300);
    expect(fare.driverEarnings.amountMinor).toBe(500);
  });
});

describe.each(ZONES)("J5b admin save check in a %s zone (400 invalid_request, reason commission_steps_invalid, before the schema)", (_currency, zone, doc) => {
  it("the zone's sample document with no steps is valid", () => {
    expect(refusal(() => checkDocument("pricing", zone, doc))).toBeNull();
  });
  it.each(fixture.validate.map((c) => [c.id, c] as const))("validate %s", (_id, c) => {
    const got = refusal(() => checkDocument("pricing", zone, withSteps(doc, c.steps)));
    if (c.expect === "ok") expect(got).toBeNull();
    else expect(got).toEqual({ status: 400, code: "invalid_request", reason: "commission_steps_invalid", details: detailsOf(c.expect) });
  });
  it.each(fixture.warn.map((c) => [c.id, c] as const))("warn %s is advisory: the server saves it", (_id, c) => {
    expect(refusal(() => checkDocument("pricing", zone, withSteps(doc, c.steps)))).toBeNull();
  });
  it("the steps check runs before the schema check (an extra key alone is invalid_document; with a bad step it is commission_steps_invalid)", () => {
    expect(refusal(() => checkDocument("pricing", zone, withSteps(doc, [{ upToMinor: null, pct: 20, extra: 1 }])))).toMatchObject({ reason: "invalid_document" });
    expect(refusal(() => checkDocument("pricing", zone, { ...withSteps(doc, [{ upToMinor: null, pct: 61 }]), unknownTopLevel: true }))).toMatchObject({ reason: "commission_steps_invalid", details: ["step:0", "problem:pct_out_of_range"] });
    expect(refusal(() => checkDocument("pricing", zone, withSteps(doc, [{ upToMinor: 5000, amountMinor: 1000 }])))).toMatchObject({ reason: "commission_steps_invalid", details: ["step:0", "problem:last_not_above"] });
  });
  it("every car type is checked; the first bad one is named in the message", () => {
    const copy = withSteps(doc, [{ upToMinor: null, pct: 18 }]) as { categories: Record<string, Record<string, unknown>> };
    copy.categories["premium"]!["commissionSteps"] = [{ upToMinor: null, pct: 18 }, { upToMinor: null, pct: 20 }];
    const error = (() => {
      try {
        checkDocument("pricing", zone, copy);
      } catch (e) {
        return e as ApiError;
      }
      return null;
    })();
    expect(error?.options).toMatchObject({ reason: "commission_steps_invalid", details: ["step:0", "problem:above_not_last"] });
    expect(error?.message).toContain("premium");
  });
});
