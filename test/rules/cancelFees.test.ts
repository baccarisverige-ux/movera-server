import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import { cancelFee, isFreeCancel, percentOfFareHalfUp, type CancelFeeInput, type FeeRule } from "../../src/rules/cancelFees.js";
import type { Money } from "../../src/rules/money.js";

type CancelFeeCase = {
  id: string;
  kind: "live" | "reservation";
  rule: FeeRule;
  fare: Money;
  minutesSinceAccept?: number;
  minutesBeforePickup?: number;
  fee: Money;
};

const fixture = contractJson<{ version: string; note: string; cases: CancelFeeCase[] }>("fixtures/cancel_fees.json");

function inputOf(c: CancelFeeCase): CancelFeeInput {
  const { kind, rule, fare, minutesSinceAccept, minutesBeforePickup } = c;
  return { kind, rule, fare, minutesSinceAccept, minutesBeforePickup };
}

describe("fixtures/cancel_fees.json", () => {
  it("has the 8 cases of contract v0.5.0", () => {
    expect(fixture.cases.length).toBe(8);
    expect(new Set(fixture.cases.map((c) => c.id)).size).toBe(fixture.cases.length);
  });

  it("every case gives the expected fee (amount and currency)", () => {
    let replayed = 0;
    for (const c of fixture.cases) {
      expect(cancelFee(inputOf(c)), `cancel_fees.json ${c.id}`).toEqual(c.fee);
      replayed += 1;
    }
    expect(replayed).toBe(fixture.cases.length);
  });

  it("does not change the fixture input", () => {
    for (const c of fixture.cases) {
      const before = JSON.stringify(c);
      cancelFee(inputOf(c));
      expect(JSON.stringify(c), `cancel_fees.json ${c.id}`).toBe(before);
    }
  });
});

const sek = (amountMinor: number): Money => ({ amountMinor, currency: "SEK" });
const percent = (value: number, min: Money | null = null, max: Money | null = null, freeMin = 0): FeeRule => ({
  freeMin,
  type: "percent",
  value,
  min,
  max,
});
const liveFee = (rule: FeeRule, fare: number, minutesSinceAccept = 1): number =>
  cancelFee({ kind: "live", rule, fare: sek(fare), minutesSinceAccept }).amountMinor;

// Expected values below were computed with the reference_check.py cancel_fees expression, not with this engine.
describe("percent rounding (half-up to a whole minor unit)", () => {
  const cases: [id: string, fare: number, value: number, fee: number][] = [
    ["50% of 1 = 0.5", 1, 50, 1],
    ["5% of 10 = 0.5", 10, 5, 1],
    ["5% of 30 = 1.5", 30, 5, 2],
    ["15% of 10 = 1.5", 10, 15, 2],
    ["25% of 42002 = 10500.5", 42002, 25, 10501],
    ["5% of 9 = 0.45", 9, 5, 0],
    ["15% of 12343 = 1851.45", 12343, 15, 1851],
    ["15% of 12345 = 1851.75", 12345, 15, 1852],
    ["15% of 12347 = 1852.05", 12347, 15, 1852],
    ["12.5% of 4 = 0.5", 4, 12.5, 1],
    ["12.5% of 12345 = 1543.125", 12345, 12.5, 1543],
    ["0% of 50000", 50000, 0, 0],
    ["100% of 50000", 50000, 100, 50000],
    ["15% of 0", 0, 15, 0],
  ];
  it.each(cases)("%s", (id, fare, value, fee) => {
    expect(liveFee(percent(value), fare), id).toBe(fee);
    expect(percentOfFareHalfUp(fare, value), id).toBe(fee);
  });

  it("throws when the numerator is too large to compute exactly", () => {
    expect(() => percentOfFareHalfUp(Number.MAX_SAFE_INTEGER, 100)).toThrow(RangeError);
    expect(() => percentOfFareHalfUp(12.5, 10)).toThrow(RangeError);
    expect(() => percentOfFareHalfUp(1000, Number.NaN)).toThrow(RangeError);
  });
});

describe("min / max clamping", () => {
  const both = percent(10, sek(5000), sek(15000));
  const cases: [id: string, rule: FeeRule, fare: number, fee: number][] = [
    ["below min is raised to min", both, 30000, 5000],
    ["exactly min", both, 50000, 5000],
    ["between min and max is unchanged", both, 100000, 10000],
    ["exactly max", both, 150000, 15000],
    ["above max is lowered to max", both, 300000, 15000],
    ["min only, above min", percent(10, sek(5000), null), 300000, 30000],
    ["min only, raised", percent(10, sek(5000), null), 1000, 5000],
    ["max only, below max", percent(10, null, sek(15000)), 1000, 100],
    ["max only, lowered", percent(10, null, sek(15000)), 300000, 15000],
    ["fixed raised to min", { freeMin: 0, type: "fixed", value: 1000, min: sek(2000), max: null }, 99999, 2000],
    ["fixed lowered to max", { freeMin: 0, type: "fixed", value: 9000, min: null, max: sek(6000) }, 99999, 6000],
    ["min above max: max wins (min first, then max)", percent(10, sek(9000), sek(6000)), 1000, 6000],
  ];
  it.each(cases)("%s", (id, rule, fare, fee) => {
    expect(liveFee(rule, fare), id).toBe(fee);
  });

  it("does not apply min inside the free window", () => {
    expect(liveFee(percent(10, sek(5000), sek(15000), 3), 1000, 2), "live free").toBe(0);
    const reservation = cancelFee({
      kind: "reservation",
      rule: percent(10, sek(5000), sek(15000), 60),
      fare: sek(1000),
      minutesBeforePickup: 60,
    });
    expect(reservation, "reservation free").toEqual(sek(0));
  });

  it("throws when min or max is in another currency than the fare", () => {
    const rule = percent(10, { amountMinor: 5000, currency: "EUR" }, null);
    expect(() => cancelFee({ kind: "live", rule, fare: sek(1000), minutesSinceAccept: 5 })).toThrow(RangeError);
  });
});

describe("free window boundaries", () => {
  const cases: [id: string, input: CancelFeeInput, free: boolean][] = [
    ["live at freeMin is charged", { kind: "live", rule: percent(10, null, null, 3), fare: sek(1000), minutesSinceAccept: 3 }, false],
    ["live below freeMin is free", { kind: "live", rule: percent(10, null, null, 3), fare: sek(1000), minutesSinceAccept: 2 }, true],
    ["live 2.99 min with freeMin 3 is free", { kind: "live", rule: percent(10, null, null, 3), fare: sek(1000), minutesSinceAccept: 2.99 }, true],
    ["live freeMin 0 is never free", { kind: "live", rule: percent(10, null, null, 0), fare: sek(1000), minutesSinceAccept: 0 }, false],
    ["reservation at freeMin is free", { kind: "reservation", rule: percent(10, null, null, 60), fare: sek(1000), minutesBeforePickup: 60 }, true],
    ["reservation below freeMin is charged", { kind: "reservation", rule: percent(10, null, null, 60), fare: sek(1000), minutesBeforePickup: 59 }, false],
    ["reservation 59.5 min with freeMin 60 is charged", { kind: "reservation", rule: percent(10, null, null, 60), fare: sek(1000), minutesBeforePickup: 59.5 }, false],
    ["reservation freeMin 0 at pickup is free", { kind: "reservation", rule: percent(10, null, null, 0), fare: sek(1000), minutesBeforePickup: 0 }, true],
  ];
  it.each(cases)("%s", (id, input, free) => {
    expect(isFreeCancel(input), id).toBe(free);
    expect(cancelFee(input), id).toEqual(sek(free ? 0 : 100));
  });
});

describe("input checks", () => {
  const rule = percent(10, null, null, 3);

  it("throws when the minutes the kind needs are missing", () => {
    expect(() => cancelFee({ kind: "live", rule, fare: sek(1000) })).toThrow(RangeError);
    expect(() => cancelFee({ kind: "live", rule, fare: sek(1000), minutesBeforePickup: 10 })).toThrow(RangeError);
    expect(() => cancelFee({ kind: "reservation", rule, fare: sek(1000) })).toThrow(RangeError);
    expect(() => cancelFee({ kind: "reservation", rule, fare: sek(1000), minutesSinceAccept: 10 })).toThrow(RangeError);
    expect(() => cancelFee({ kind: "live", rule, fare: sek(1000), minutesSinceAccept: Number.NaN })).toThrow(RangeError);
  });

  it("ignores the minutes of the other kind", () => {
    const input: CancelFeeInput = { kind: "live", rule, fare: sek(1000), minutesSinceAccept: 5, minutesBeforePickup: 999 };
    expect(cancelFee(input)).toEqual(sek(100));
  });

  it("throws for a fixed value that is not whole minor units", () => {
    const fixed: FeeRule = { freeMin: 0, type: "fixed", value: 45.5, min: null, max: null };
    expect(() => cancelFee({ kind: "live", rule: fixed, fare: sek(1000), minutesSinceAccept: 1 })).toThrow(RangeError);
  });

  it("throws for a fare that is not a Money", () => {
    const fare = { amountMinor: 10.5, currency: "SEK" } as Money;
    expect(() => cancelFee({ kind: "live", rule, fare, minutesSinceAccept: 5 })).toThrow(TypeError);
  });

  it("returns the fare's currency", () => {
    const fare: Money = { amountMinor: 12345, currency: "EUR" };
    expect(cancelFee({ kind: "live", rule, fare, minutesSinceAccept: 5 })).toEqual({ amountMinor: 1235, currency: "EUR" });
    expect(cancelFee({ kind: "live", rule, fare, minutesSinceAccept: 1 })).toEqual({ amountMinor: 0, currency: "EUR" });
  });
});
