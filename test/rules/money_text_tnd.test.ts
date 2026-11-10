import { describe, expect, it } from "vitest";
import { amountText as driverFee } from "../../src/notifications/driverTripPush.js";
import { amountText as walletText } from "../../src/riders/walletCredit.js";
import { PAY_TEXT, TIP_TEXT } from "../../src/trips/finish.js";
import { major } from "../../src/alerts/detector.js";
import { termsMoney } from "../../src/legal/waitingTerms.js";
import { localAmount, majorText } from "../../src/rules/money.js";

// TND has 3 decimals (CONTRACT.md §1 "Money"): 1500 millimes are 1.500 DT, never 15.
describe("money texts use the currency's own decimals (TND 3)", () => {
  it("driver cancel / no-show fee notice", () => {
    expect(driverFee(1500, "TND", "fr")).toBe("1.500 DT");
    expect(driverFee(2000, "TND", "en")).toBe("2 DT");
  });
  it("tip error texts", () => {
    expect(TIP_TEXT.choose([1000, 2500], "TND")).toBe("Choose one of the amounts: 1, 2.500 TND.");
    expect(TIP_TEXT.atMost(50000, "TND")).toBe("At most 50 TND.");
  });
  it("driver pay change error texts", () => {
    expect(PAY_TEXT.atMost(20000, "TND")).toBe("One change is at most 20 TND.");
    expect(PAY_TEXT.belowZero(5350, "TND")).toBe("The driver's pay on this trip is 5.350 TND; it cannot go below 0.");
  });
  it("wallet credit notice", () => {
    expect(walletText({ amountMinor: 5350, currency: "TND" }, "fr")).toBe("5.350 DT");
    expect(walletText({ amountMinor: 40, currency: "TND" }, "en")).toBe("0.040 DT");
  });
  it("alert desk amounts and waiting terms", () => {
    expect(major(5350, "TND")).toBe("5.350 DT");
    expect(termsMoney({ amountMinor: 500, currency: "TND" }, "fr")).toBe("0.500 DT");
  });
  it("helpers", () => {
    expect(majorText({ amountMinor: 5350, currency: "TND" })).toBe("5.350");
    expect(localAmount({ amountMinor: 5350, currency: "TND" }, "fr")).toBe("5.350");
  });
});

// v0.18.59 §81 (owner 2026-11-10): TND is written with a dot, 3 decimals, a space between thousands, in every language.
describe("TND written with a dot (contract §81)", () => {
  it("12350 minor is 12.350 DT in sv, fr and en", () => {
    for (const lang of ["sv", "fr", "en"] as const) {
      expect(walletText({ amountMinor: 12350, currency: "TND" }, lang)).toBe("12.350 DT");
      expect(localAmount({ amountMinor: 1250000 + 0, currency: "TND" }, lang)).toBe("1 250");
      expect(localAmount({ amountMinor: 1250500, currency: "TND" }, lang)).toBe("1 250.500");
      expect(termsMoney({ amountMinor: 12350, currency: "TND" }, lang)).toBe("12.350 DT");
    }
    expect(majorText({ amountMinor: 1250500, currency: "TND" })).toBe("1 250.500");
    expect(major(12350, "TND")).toBe("12.350 DT");
  });
});

describe("SEK and EUR texts are byte-identical to before", () => {
  it("every place", () => {
    expect(driverFee(4900, "SEK", "sv")).toBe("49 kr");
    expect(driverFee(4950, "SEK", "sv")).toBe("49,50 kr");
    expect(driverFee(250, "EUR", "fr")).toBe("2,50 €");
    expect(driverFee(250, "EUR", "en")).toBe("2.50 €");
    expect(TIP_TEXT.choose([2000, 5000], "SEK")).toBe("Choose one of the amounts: 20, 50 SEK.");
    expect(TIP_TEXT.atMost(50000, "SEK")).toBe("At most 500 SEK.");
    expect(PAY_TEXT.atMost(20000, "EUR")).toBe("One change is at most 200 EUR.");
    expect(PAY_TEXT.belowZero(12675, "SEK")).toBe("The driver's pay on this trip is 126.75 SEK; it cannot go below 0.");
    expect(walletText({ amountMinor: 12675, currency: "SEK" }, "sv")).toBe("126,75 kr");
    expect(walletText({ amountMinor: 10000, currency: "SEK" }, "sv")).toBe("100 kr");
    expect(walletText({ amountMinor: 250, currency: "EUR" }, "fr")).toBe("2,50 €");
    expect(major(12675, "SEK")).toBe("126.75 kr");
    expect(major(10000, "EUR")).toBe("100 €");
    expect(termsMoney({ amountMinor: 1226, currency: "SEK" }, "sv")).toBe("12,26 kr");
    expect(termsMoney({ amountMinor: 50, currency: "EUR" }, "en")).toBe("€0.50");
  });
});
