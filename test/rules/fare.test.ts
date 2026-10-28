import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import { FareError, priceFare, type FareInput, type PricingDocument } from "../../src/rules/fare.js";
import { Frac } from "../../src/rules/fraction.js";

type Case = { id: string; note: string; overrides?: Record<string, unknown>; input: FareInput; expect: Record<string, unknown> };
const fixture = contractJson<{ version: string; cases: Case[] }>("fixtures/fares.json");
const doc = contractJson<PricingDocument>("fixtures/config/pricing_document.json");

function merge(a: unknown, b: unknown): unknown {
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  }
  return b;
}

describe("fares (contract fixtures/fares.json)", () => {
  it("has the 23 cases of contract v0.7.1", () => {
    expect(fixture.version).toBe("0.7.1");
    expect(fixture.cases).toHaveLength(23);
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    if (typeof c.expect["error"] === "string") {
      let reason: string | undefined;
      try {
        priceFare(merge(doc, c.overrides ?? {}) as PricingDocument, c.input);
      } catch (error) {
        reason = error instanceof FareError ? error.reason : String(error);
      }
      expect(reason).toBe(c.expect["error"]);
      return;
    }
    // The fixture names the earlier trip on its outstanding_fee line; the engine takes it as an input.
    const source = (c.expect["fareLines"] as Array<{ code: string; sourceTripId?: string }>).find((l) => l.code === "outstanding_fee")?.sourceTripId;
    const fare = priceFare(merge(doc, c.overrides ?? {}) as PricingDocument, { ...c.input, ...(source ? { outstandingSourceTripId: source } : {}) });
    const { surgeMultiplier: _m, ...got } = fare;
    void _m;
    expect(got).toEqual(c.expect);
    expect(fare.fareLines.reduce((s, l) => s + l.amount.amountMinor, 0)).toBe(fare.total.amountMinor);
  });

  it("a switched-off or unknown category cannot be priced", () => {
    const off = merge(doc, { categories: { pet: { enabled: false } } }) as PricingDocument;
    expect(() => priceFare(off, { categoryId: "pet", km: 1, minutes: 1, kind: "live" })).toThrow(FareError);
    expect(() => priceFare(doc, { categoryId: "rocket", km: 1, minutes: 1, kind: "live" })).toThrow(FareError);
  });
});

describe("exact fractions", () => {
  it("decimals are exact and half-up goes toward +∞", () => {
    expect(Frac.dec(0.1).add(Frac.dec(0.2)).cmp(Frac.dec("0.3"))).toBe(0);
    expect(Frac.of(5, 2).halfUp()).toBe(3n);
    expect(Frac.of(-5, 2).halfUp()).toBe(-2n);
    expect(Frac.of(-7, 3).halfUp()).toBe(-2n);
    expect(Frac.dec(1e-7).cmp(Frac.of(1, 10_000_000))).toBe(0);
  });
});
