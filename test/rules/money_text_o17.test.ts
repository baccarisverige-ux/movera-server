import { describe, expect, it } from "vitest";
import { amountText as driverFee } from "../../src/notifications/driverTripPush.js";
import { amountText as walletText } from "../../src/riders/walletCredit.js";
import { amountText as finishText, PAY_TEXT, TIP_TEXT } from "../../src/trips/finish.js";
import { refundNoticeBody } from "../../src/admin/trips.js";
import { major } from "../../src/alerts/detector.js";

/**
 * BQ-O17 (owner 2026-11-14 "whole amounts keep their decimals: 35,00 kr and 5.000 DT", contract v0.18.89
 * moneyDisplay.wholeAmounts): the older server notice, push, alert and error texts show the currency's decimals,
 * in the format of the currency, not of the language — 65,00 kr, 8,00 €, 5.000 DT (moneyText, P89S #230).
 * The bonus / refund / cash error texts are checked over HTTP: test/admin/review_admin.test.ts R3/R4, test/e2e/09_admin.test.ts.
 */
const SEK = (amountMinor: number) => ({ amountMinor, currency: "SEK" as const });
const EUR = (amountMinor: number) => ({ amountMinor, currency: "EUR" as const });
const TND = (amountMinor: number) => ({ amountMinor, currency: "TND" as const });

describe("BQ-O17 SEK: whole kronor keep ,00", () => {
  it("rider refund notice", () => {
    expect(refundNoticeBody(SEK(6500), "sv")).toBe("Du får tillbaka 65,00 kr för din resa.");
    expect(refundNoticeBody(SEK(290000), "en")).toBe("You get 2 900,00 kr back for your trip.");
    expect(refundNoticeBody(SEK(12675), "sv")).toBe("Du får tillbaka 126,75 kr för din resa.");
  });
  it("driver trip push fee, wallet credit, receipt / pay change", () => {
    for (const lang of ["sv", "fr", "en"] as const) {
      expect(driverFee(6500, "SEK", lang)).toBe("65,00 kr");
      expect(walletText(SEK(290000), lang)).toBe("2 900,00 kr");
      expect(finishText(SEK(10000), lang)).toBe("100,00 kr");
    }
    expect(driverFee(4950, "SEK", "en")).toBe("49,50 kr");
  });
  it("alert titles and error texts", () => {
    expect(major(25000, "SEK")).toBe("250,00 kr");
    expect(TIP_TEXT.choose([2000, 5000], "SEK")).toBe("Choose one of the amounts: 20,00 kr, 50,00 kr.");
    expect(TIP_TEXT.atMost(50000, "SEK")).toBe("At most 500,00 kr.");
    expect(PAY_TEXT.atMost(20000, "SEK")).toBe("One change is at most 200,00 kr.");
    expect(PAY_TEXT.belowZero(12675, "SEK")).toBe("The driver's pay on this trip is 126,75 kr; it cannot go below 0.");
  });
});

describe("BQ-O17 EUR: whole euros keep ,00", () => {
  it("rider refund notice", () => {
    expect(refundNoticeBody(EUR(800), "fr")).toBe("Vous êtes remboursé de 8,00 € pour votre course.");
    expect(refundNoticeBody(EUR(250), "en")).toBe("You get 2,50 € back for your trip.");
  });
  it("driver trip push fee, wallet credit, receipt / pay change", () => {
    for (const lang of ["sv", "fr", "en"] as const) {
      expect(driverFee(800, "EUR", lang)).toBe("8,00 €");
      expect(walletText(EUR(10000), lang)).toBe("100,00 €");
      expect(finishText(EUR(800), lang)).toBe("8,00 €");
    }
  });
  it("alert titles and error texts", () => {
    expect(major(10000, "EUR")).toBe("100,00 €");
    expect(TIP_TEXT.atMost(3000, "EUR")).toBe("At most 30,00 €.");
    expect(PAY_TEXT.atMost(20000, "EUR")).toBe("One change is at most 200,00 €.");
  });
});

describe("BQ-O17 TND (3 decimals, dot in every language): whole dinars keep .000", () => {
  it("rider refund notice", () => {
    expect(refundNoticeBody(TND(5000), "fr")).toBe("Vous êtes remboursé de 5.000 DT pour votre course.");
    expect(refundNoticeBody(TND(1250500), "en")).toBe("You get 1 250.500 DT back for your trip.");
  });
  it("driver trip push fee, wallet credit, receipt / pay change", () => {
    for (const lang of ["sv", "fr", "en"] as const) {
      expect(driverFee(2000, "TND", lang)).toBe("2.000 DT");
      expect(walletText(TND(5000), lang)).toBe("5.000 DT");
      expect(finishText(TND(1000), lang)).toBe("1.000 DT");
      expect(finishText(TND(1250000), lang)).toBe("1 250.000 DT");
    }
    expect(walletText(TND(40), "en")).toBe("0.040 DT");
  });
  it("alert titles and error texts", () => {
    expect(major(5000, "TND")).toBe("5.000 DT");
    expect(TIP_TEXT.choose([1000, 2500], "TND")).toBe("Choose one of the amounts: 1.000 DT, 2.500 DT.");
    expect(TIP_TEXT.atMost(50000, "TND")).toBe("At most 50.000 DT.");
    expect(PAY_TEXT.atMost(20000, "TND")).toBe("One change is at most 20.000 DT.");
    expect(PAY_TEXT.belowZero(5350, "TND")).toBe("The driver's pay on this trip is 5.350 DT; it cannot go below 0.");
  });
});
