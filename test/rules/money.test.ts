import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import {
  CURRENCIES,
  CURRENCY_CODES,
  add,
  compare,
  exponentOf,
  halfUp,
  isMoney,
  money,
  roundToStep,
  subtract,
  toMajorString,
  type CurrencyCode,
  type Money,
} from "../../src/rules/money.js";

type MoneyFixture = {
  version: string;
  cases: { money: Money; major: string }[];
  invalid: unknown[];
};

const fixture = contractJson<MoneyFixture>("fixtures/money.json");
// fixtures/money.json cases carry no id, so the id is the position plus the money itself.
const caseId = (i: number, m: Money) => `money.json cases[${i}] ${m.amountMinor} ${m.currency}`;

describe("fixtures/money.json", () => {
  it("has cases and invalid entries to replay", () => {
    expect(fixture.cases.length).toBe(6);
    expect(fixture.invalid.length).toBe(4);
  });

  it("every case is valid Money and formats to the expected major string", () => {
    fixture.cases.forEach((c, i) => {
      const id = caseId(i, c.money);
      expect(isMoney(c.money), `${id}: isMoney`).toBe(true);
      expect(toMajorString(c.money), `${id}: major`).toBe(c.major);
      const built = money(c.money.amountMinor, c.money.currency);
      expect(built, `${id}: money() round trip`).toEqual(c.money);
      expect(toMajorString(built), `${id}: major via money()`).toBe(c.major);
    });
  });

  it("rejects every invalid entry", () => {
    fixture.invalid.forEach((v, i) => {
      expect(isMoney(v), `money.json invalid[${i}] ${JSON.stringify(v)}`).toBe(false);
    });
  });

  it("money() throws for the invalid entries that carry both fields", () => {
    expect(() => money(12.5, "SEK"), "invalid[0] amountMinor 12.5").toThrow(RangeError);
    expect(() => money(100, "sek" as CurrencyCode), "invalid[1] currency sek").toThrow(RangeError);
  });
});

describe("CURRENCIES", () => {
  it("matches contract.json#currencies exactly", () => {
    const fromContract = contractJson<{ currencies: unknown }>("contract.json").currencies;
    expect(CURRENCIES).toEqual(fromContract);
    expect([...CURRENCY_CODES].sort()).toEqual(Object.keys(CURRENCIES).sort());
  });

  it("exponentOf gives the ISO 4217 exponent", () => {
    expect(exponentOf("SEK")).toBe(2);
    expect(exponentOf("EUR")).toBe(2);
    expect(exponentOf("TND")).toBe(3);
    expect(() => exponentOf("USD" as CurrencyCode)).toThrow(RangeError);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(CURRENCIES)).toBe(true);
    expect(Object.isFrozen(CURRENCIES.SEK)).toBe(true);
  });
});

describe("isMoney", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 100],
    ["a display string", "126,75 kr"],
    ["an array", [100, "SEK"]],
    ["string amountMinor", { amountMinor: "100", currency: "SEK" }],
    ["NaN", { amountMinor: Number.NaN, currency: "SEK" }],
    ["Infinity", { amountMinor: Number.POSITIVE_INFINITY, currency: "SEK" }],
    ["2^53 (not safe)", { amountMinor: 2 ** 53, currency: "SEK" }],
    ["unknown currency", { amountMinor: 100, currency: "USD" }],
    ["missing amountMinor", { currency: "SEK" }],
    ["inherited key as currency", { amountMinor: 100, currency: "toString" }],
  ])("rejects %s", (_label, value) => {
    expect(isMoney(value)).toBe(false);
  });

  it("accepts negative amounts and the largest safe integer", () => {
    expect(isMoney({ amountMinor: -1, currency: "EUR" })).toBe(true);
    expect(isMoney({ amountMinor: Number.MAX_SAFE_INTEGER, currency: "TND" })).toBe(true);
  });
});

describe("toMajorString", () => {
  it("pads the fraction to the exponent and keeps the sign", () => {
    expect(toMajorString(money(5, "SEK"))).toBe("0.05");
    expect(toMajorString(money(-5, "SEK"))).toBe("-0.05");
    expect(toMajorString(money(7, "TND"))).toBe("0.007");
    expect(toMajorString(money(-12345, "TND"))).toBe("-12.345");
    expect(toMajorString(money(Number.MAX_SAFE_INTEGER, "SEK"))).toBe("90071992547409.91");
  });

  it("throws for a value that is not Money", () => {
    expect(() => toMajorString({ amountMinor: 1.5, currency: "SEK" })).toThrow(TypeError);
  });
});

describe("money()", () => {
  it("throws on non-integers and unsafe integers", () => {
    expect(() => money(Number.NaN, "SEK")).toThrow(RangeError);
    expect(() => money(Number.POSITIVE_INFINITY, "SEK")).toThrow(RangeError);
    expect(() => money(2 ** 53, "SEK")).toThrow(RangeError);
    expect(() => money(0.1, "EUR")).toThrow(RangeError);
  });
});

describe("add / subtract / compare", () => {
  const a = money(12675, "SEK");
  const b = money(4500, "SEK");

  it("works within one currency", () => {
    expect(add(a, b)).toEqual(money(17175, "SEK"));
    expect(subtract(b, a)).toEqual(money(-8175, "SEK"));
    expect(compare(a, b)).toBe(1);
    expect(compare(b, a)).toBe(-1);
    expect(compare(a, money(12675, "SEK"))).toBe(0);
  });

  it("throws on currency mismatch", () => {
    const eur = money(335, "EUR");
    const tnd = money(12500, "TND");
    expect(() => add(a, eur)).toThrow(/currency mismatch/);
    expect(() => subtract(eur, tnd)).toThrow(/currency mismatch/);
    expect(() => compare(tnd, a)).toThrow(/currency mismatch/);
  });

  it("throws when the result leaves the safe integer range", () => {
    expect(() => add(money(Number.MAX_SAFE_INTEGER, "SEK"), money(1, "SEK"))).toThrow(RangeError);
    expect(() => subtract(money(-Number.MAX_SAFE_INTEGER, "SEK"), money(1, "SEK"))).toThrow(RangeError);
  });

  it("does not change its inputs", () => {
    add(a, b);
    expect(a).toEqual({ amountMinor: 12675, currency: "SEK" });
    expect(b).toEqual({ amountMinor: 4500, currency: "SEK" });
  });
});

describe("halfUp (reference_check.py _half_up)", () => {
  it.each([
    [2.5, 3],
    [-2.5, -2],
    [0.49999, 0],
    [0.5, 1],
    [-0.5, 0],
    [1.5, 2],
    [-1.5, -1],
    [-0.49999, 0],
    [-0.7, -1],
    [2.4999999999999996, 2],
    // Float quirk shared with Python: 0.49999999999999994 + 0.5 is exactly 1.0 in binary64.
    [0.49999999999999994, 1],
    [0, 0],
    [7, 7],
    [-7, -7],
  ])("halfUp(%s) = %s", (x, expected) => {
    expect(halfUp(x)).toBe(expected);
  });

  it("throws for NaN and infinities, like math.floor in Python", () => {
    expect(() => halfUp(Number.NaN)).toThrow(RangeError);
    expect(() => halfUp(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => halfUp(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("roundToStep", () => {
  it.each([
    [12675, 50, 12700],
    [12624, 50, 12600],
    [12625, 50, 12650],
    [12650, 50, 12650],
    [0, 100, 0],
    [49, 100, 0],
    [50, 100, 100],
    [-25, 10, -20],
    [-26, 10, -30],
    [-25, 50, 0],
    [-50, 100, 0],
    [-51, 100, -100],
    [12345, 1, 12345],
  ])("roundToStep(%s, %s) = %s", (amount, step, expected) => {
    expect(roundToStep(amount, step)).toBe(expected);
  });

  it("stays exact near the safe-integer limits (review finding)", () => {
    expect(roundToStep(-9007199254740991, 3)).toBe(-9007199254740990);
    expect(roundToStep(-9007199254740991, 5)).toBe(-9007199254740990);
    expect(roundToStep(3325109224507100, 9007199254740763)).toBe(0);
    expect(roundToStep(9007199254740990, 9007199254740991)).toBe(9007199254740991);
    for (const [amount, step] of [[-9007199254740991, 7], [9007199254740991, 9], [-9007199254740000, 1000003]] as const) {
      const exact = ((BigInt(amount) * 2n + BigInt(step)) / (2n * BigInt(step)) - (((BigInt(amount) * 2n + BigInt(step)) % (2n * BigInt(step))) < 0n ? 1n : 0n)) * BigInt(step);
      expect(roundToStep(amount, step), `${amount} step ${step}`).toBe(Number(exact));
    }
  });

  it("agrees with halfUp(amount / step) * step", () => {
    for (let amount = -1000; amount <= 1000; amount += 7) {
      for (const step of [1, 2, 5, 10, 25, 50, 100, 1000]) {
        expect(roundToStep(amount, step), `${amount} step ${step}`).toBe(halfUp(amount / step) * step || 0);
      }
    }
  });

  it("never returns -0", () => {
    expect(Object.is(roundToStep(-0, 10), 0)).toBe(true);
    expect(Object.is(roundToStep(-4, 10), 0)).toBe(true);
  });

  it("throws on bad input", () => {
    expect(() => roundToStep(1.5, 10)).toThrow(RangeError);
    expect(() => roundToStep(100, 0)).toThrow(RangeError);
    expect(() => roundToStep(100, -10)).toThrow(RangeError);
    expect(() => roundToStep(100, 2.5)).toThrow(RangeError);
    // 9007199254740991 rounds up to 9007199254741000, beyond the safe integer range.
    expect(() => roundToStep(Number.MAX_SAFE_INTEGER, 100)).toThrow(RangeError);
  });
});
