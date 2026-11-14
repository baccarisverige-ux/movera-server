import { describe, expect, it } from "vitest";
import { DRIVER_REFUND_NOTICE, driverRefundText } from "../../src/notifications/refundDriverNotice.js";
import { moneyShown } from "../../src/rules/money.js";

/**
 * v0.18.91 job A7 (contract.json#finish.refund.driverNotice; owner 2026-11-02 "taken from the driver's NEXT payout (driver
 * sees why)", Rules decisions/driver-g8.md:95-98): the driver's notice when an admin refund is taken from his earnings.
 */
describe("moneyShown follows moneyDisplay (v0.18.89 wholeAmounts: decimals always)", () => {
  it("SEK / EUR with a comma, TND with a dot and 3 decimals, whole amounts keep their decimals", () => {
    expect(moneyShown({ amountMinor: 6500, currency: "SEK" })).toBe("65,00 kr");
    expect(moneyShown({ amountMinor: 12675, currency: "SEK" })).toBe("126,75 kr");
    expect(moneyShown({ amountMinor: 100000, currency: "SEK" })).toBe("1 000,00 kr");
    expect(moneyShown({ amountMinor: 800, currency: "EUR" })).toBe("8,00 €");
    expect(moneyShown({ amountMinor: 741, currency: "EUR" })).toBe("7,41 €");
    expect(moneyShown({ amountMinor: 5000, currency: "TND" })).toBe("5.000 DT");
    expect(moneyShown({ amountMinor: 12350, currency: "TND" })).toBe("12.350 DT");
    expect(moneyShown({ amountMinor: 1250000, currency: "TND" })).toBe("1 250.000 DT");
  });
});

describe("driver_refund_taken texts (sv / fr / en)", () => {
  it("kind and deep link are the contract's", () => {
    expect(DRIVER_REFUND_NOTICE.kind).toBe("driver_refund_taken");
    expect(DRIVER_REFUND_NOTICE.deepLink).toBe("movera-driver://trips/{tripId}");
  });
  it("says how much (his share, with decimals) and why (the admin's reason)", () => {
    expect(driverRefundText("en", { amountMinor: 6500, currency: "SEK" }, " Wrong route ")).toEqual({
      title: "Deduction from your payout",
      body: "65,00 kr is taken from your next payout: the rider got money back for the trip. Reason: Wrong route",
    });
    expect(driverRefundText("sv", { amountMinor: 6500, currency: "SEK" }, "Fel väg")).toEqual({
      title: "Avdrag från din utbetalning",
      body: "65,00 kr dras från din nästa utbetalning: resenären fick pengar tillbaka för resan. Orsak: Fel väg",
    });
    expect(driverRefundText("fr", { amountMinor: 800, currency: "EUR" }, "Détour")).toEqual({
      title: "Retenue sur votre versement",
      body: "8,00 € sera retenu sur votre prochain versement : le passager a été remboursé pour la course. Motif : Détour",
    });
    expect(driverRefundText("fr", { amountMinor: 5000, currency: "TND" }, "Détour").body.startsWith("5.000 DT sera retenu")).toBe(true);
  });
  it("a reason over 200 characters is cut with …", () => {
    const body = driverRefundText("en", { amountMinor: 100, currency: "EUR" }, "x".repeat(250)).body;
    expect(body.endsWith(`Reason: ${"x".repeat(200)}…`)).toBe(true);
  });
});
