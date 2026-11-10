import { describe, expect, it } from "vitest";
import { amountText } from "../../src/trips/finish.js";

// Notification texts (receipt resend, driver pay changed) use the currency's own decimals: SEK/EUR 2, TND 3.
describe("amountText", () => {
  it("TND keeps 3 decimals", () => {
    expect(amountText({ amountMinor: 5350, currency: "TND" }, "fr")).toBe("5,350 TND");
    expect(amountText({ amountMinor: 1000, currency: "TND" }, "fr")).toBe("1 TND");
    expect(amountText({ amountMinor: 40, currency: "TND" }, "en")).toBe("0.040 TND");
  });
  it("SEK and EUR are unchanged", () => {
    expect(amountText({ amountMinor: 12675, currency: "SEK" }, "sv")).toBe("126,75 kr");
    expect(amountText({ amountMinor: 10000, currency: "SEK" }, "sv")).toBe("100 kr");
    expect(amountText({ amountMinor: 250, currency: "EUR" }, "fr")).toBe("2,50 €");
  });
});
