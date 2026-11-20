import { describe, expect, it } from "vitest";
import { cashDueSplit } from "../../src/trips/ride/finish.js";

/** v0.18.140 M3 (owner 2026-11-19 "Yes, build M2 + M3 (Rec.)"): the server's split of cashDue, never the phone's. */
const fee = (amountMinor: number, currency = "SEK") => ({ code: "outstanding_fee", amount: { amountMinor, currency } });
const base = (amountMinor: number, currency = "SEK") => ({ code: "base", amount: { amountMinor, currency } });

describe("cashDueSplit (completePreview.cashDueSplit)", () => {
  it("Sara: 215 kr ride + 35 kr earlier fee = 250 kr", () => {
    expect(cashDueSplit(25_000, [base(21_500), fee(3_500)])).toEqual({ rideMinor: 21_500, feeMinor: 3_500 });
  });
  it("no debt line: null", () => {
    expect(cashDueSplit(21_500, [base(21_500)])).toBeNull();
  });
  it("card / Apple Pay / wallet trip with a fee (cashDue 0): null", () => {
    expect(cashDueSplit(0, [base(21_500), fee(3_500)])).toBeNull();
  });
  it("a wallet part lowers cashDue: the fee is still whole while it fits, ride = the rest", () => {
    expect(cashDueSplit(20_000, [base(21_500), fee(3_500)])).toEqual({ rideMinor: 16_500, feeMinor: 3_500 });
  });
  it("fee bigger than cashDue: the fee part is cashDue, ride 0, sum still cashDue", () => {
    expect(cashDueSplit(2_000, [base(21_500), fee(3_500)])).toEqual({ rideMinor: 0, feeMinor: 2_000 });
  });
  it("TND, 3 decimals, string amounts from the stored lines", () => {
    const s = cashDueSplit(17_250, [base(12_000, "TND"), { code: "outstanding_fee", amount: { amountMinor: "5250" } }]);
    expect(s).toEqual({ rideMinor: 12_000, feeMinor: 5_250 });
    expect(s!.rideMinor + s!.feeMinor).toBe(17_250);
  });
});
