import { describe, expect, it } from "vitest";
import { currencySymbol, localAmount, majorText, moneyShown, moneyText } from "../../src/rules/money.js";
import { amountText as receiptText } from "../../src/trips/finish.js";
import { amountText as walletText } from "../../src/riders/walletCredit.js";
import { amountText as driverFee } from "../../src/notifications/driverTripPush.js";
import { termsMoney } from "../../src/legal/waitingTerms.js";
import { major } from "../../src/alerts/detector.js";
import { refundNoticeBody } from "../../src/admin/trips.js";
import { routeChangePushBody } from "../../src/trips/routeChange.js";

/**
 * Price format (owner 2026-11-14: "make sure rider and driver app show correct prices every where", "Check all apps";
 * audit price-display-2026-11-14 gaps 10, 14, 15; contract.json#moneyDisplay v0.18.59 §81): the format follows the
 * currency, never the language. SEK and EUR: 2 decimals with a comma; TND: 3 decimals with a dot and a space between
 * thousands. Whole amounts keep their decimals ("35,00 kr", "5.000 DT"). Server texts show the currency symbol.
 */
const LANGS = ["sv", "fr", "en"] as const;

describe("moneyText: one money text per currency", () => {
  it("SEK: comma, 2 decimals, whole amounts keep them", () => {
    for (const lang of LANGS) {
      expect(moneyText({ amountMinor: 12675, currency: "SEK" })).toBe("126,75 kr");
      expect(receiptText({ amountMinor: 12675, currency: "SEK" }, lang)).toBe("126,75 kr");
      expect(receiptText({ amountMinor: 3500, currency: "SEK" }, lang)).toBe("35,00 kr");
    }
    expect(moneyText({ amountMinor: 0, currency: "SEK" })).toBe("0,00 kr");
    // A space between thousands, as the admin and the rider app write it.
    expect(moneyText({ amountMinor: 290000, currency: "SEK" })).toBe("2 900,00 kr");
    expect(moneyText({ amountMinor: -290000, currency: "EUR" })).toBe("-2 900,00 €");
  });
  it("EUR: comma, 2 decimals, in English too", () => {
    for (const lang of LANGS) {
      expect(walletText({ amountMinor: 741, currency: "EUR" }, lang)).toBe("7,41 €");
      expect(walletText({ amountMinor: 800, currency: "EUR" }, lang)).toBe("8,00 €");
    }
  });
  it("TND: dot, 3 decimals, whole amounts keep them", () => {
    for (const lang of LANGS) {
      expect(driverFee(5000, "TND", lang)).toBe("5.000 DT");
      expect(driverFee(12350, "TND", lang)).toBe("12.350 DT");
      expect(walletText({ amountMinor: 1250000, currency: "TND" }, lang)).toBe("1 250.000 DT");
    }
  });
  it("majorText and localAmount follow the currency, not the language", () => {
    expect(majorText({ amountMinor: 12675, currency: "SEK" })).toBe("126,75");
    expect(majorText({ amountMinor: 2000, currency: "SEK" })).toBe("20,00");
    expect(majorText({ amountMinor: 1000, currency: "TND" })).toBe("1.000");
    for (const lang of LANGS) {
      expect(localAmount({ amountMinor: 12675, currency: "SEK" }, lang)).toBe("126,75");
      expect(localAmount({ amountMinor: 250, currency: "EUR" }, lang)).toBe("2,50");
      expect(localAmount({ amountMinor: 1250000, currency: "TND" }, lang)).toBe("1 250.000");
    }
  });
  it("the alert desk amounts", () => {
    expect(major(12675, "SEK")).toBe("126,75 kr");
    expect(major(10000, "EUR")).toBe("100,00 €");
    expect(major(5000, "TND")).toBe("5.000 DT");
  });
});

describe("the rider refund push and the driver route-change push use the shared money text", () => {
  it("refund: 12.350 DT, not 12,350 TND", () => {
    expect(refundNoticeBody({ amountMinor: 12350, currency: "TND" }, "fr")).toBe("Vous êtes remboursé de 12.350 DT pour votre course.");
    expect(refundNoticeBody({ amountMinor: 5000, currency: "SEK" }, "sv")).toBe("Du får tillbaka 50,00 kr för din resa.");
    expect(refundNoticeBody({ amountMinor: 250, currency: "EUR" }, "en")).toBe("You get 2,50 € back for your trip.");
  });
  it("route change: the driver's new earnings", () => {
    expect(routeChangePushBody("fr", 30, { amountMinor: 12350, currency: "TND" })).toBe("Répondez dans les 30 s : 12.350 DT");
    expect(routeChangePushBody("sv", 30, { amountMinor: 15900, currency: "SEK" })).toBe("Svara inom 30 s: 159,00 kr");
    expect(routeChangePushBody("en", 30, { amountMinor: 1275, currency: "EUR" })).toBe("Answer within 30 s: 12,75 €");
  });
});

describe("the legal Terms money", () => {
  it("follows the currency in every language, whole amounts keep their decimals", () => {
    for (const lang of LANGS) {
      expect(termsMoney({ amountMinor: 1349, currency: "SEK" }, lang)).toBe("13,49 kr");
      expect(termsMoney({ amountMinor: 6500, currency: "SEK" }, lang)).toBe("65,00 kr");
      expect(termsMoney({ amountMinor: 55, currency: "EUR" }, lang)).toBe("0,55 €");
      expect(termsMoney({ amountMinor: 275, currency: "TND" }, lang)).toBe("0.275 DT");
      expect(termsMoney({ amountMinor: 5000, currency: "TND" }, lang)).toBe("5.000 DT");
    }
  });
});

describe("coverage: money text edges (P89S + A7 one formatter)", () => {
  it("an unknown currency code is written as the code", () => {
    expect(currencySymbol("USD")).toBe("USD");
  });
  it("negative amounts keep the sign and the thousands space", () => {
    expect(moneyText({ amountMinor: -290000, currency: "SEK" })).toBe("-2 900,00 kr");
    expect(moneyText({ amountMinor: -1250500, currency: "TND" })).toBe("-1 250.500 DT");
  });
  it("moneyShown (A7) is the same text as moneyText", () => {
    for (const m of [{ amountMinor: 6500, currency: "SEK" }, { amountMinor: 800, currency: "EUR" }, { amountMinor: 5000, currency: "TND" }]) {
      expect(moneyShown(m)).toBe(moneyText(m));
    }
  });
});
