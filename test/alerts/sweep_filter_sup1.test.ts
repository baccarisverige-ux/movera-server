import { describe, expect, it } from "vitest";
import { docHorizonDays, payoutFloorMinor } from "../../src/alerts/detector.js";
import { AlertSettings } from "../../src/alerts/kinds.js";

/**
 * Sup1 P10 (G34 proof 2026-11-13: each alert sweep sent every document and every pending payout to Node): the SQL
 * keeps only rows that can reach a level under ANY country's settings or the contract defaults.
 */
const ctxOf = (books: Record<string, Record<string, unknown>>) => ({ settings: new Map(Object.entries(books).map(([c, doc]) => [c, new AlertSettings(doc)])) }) as unknown as Parameters<typeof docHorizonDays>[0];

describe("alert sweep SQL filters", () => {
  it("defaults: documents within 31 days, payouts from 8,000 major units (in the smallest minor unit)", () => {
    expect(docHorizonDays(ctxOf({}))).toBe(31);
    expect(payoutFloorMinor(ctxOf({}))).toBe(800_000);
  });
  it("the widest country wins (a 90-day warning reads 91 days; a 500-kr limit reads from 50,000 minor)", () => {
    const ctx = ctxOf({ FR: { kinds: { doc_expiring: { limits: { info: 90 } }, payout_big: { limits: { important: 500 } } } } });
    expect(docHorizonDays(ctx)).toBe(91);
    expect(payoutFloorMinor(ctx)).toBe(50_000);
  });
  it("never wider than the old fixed 400-day window; a kind turned off everywhere reads nothing", () => {
    expect(docHorizonDays(ctxOf({ SE: { kinds: { doc_expiring: { limits: { info: 9999 } } } } }))).toBe(400);
    const off = { kinds: { doc_expiring: { on: false }, payout_big: { on: false } } };
    // The contract defaults (no settings document) still count, so "off" in every saved country is not "off" for a country with none.
    expect(docHorizonDays(ctxOf({ SE: off, FR: off, TN: off }))).toBe(31);
  });
  it("supervisor: a negative limit reads from the currency with the most decimals; a limit bigint cannot read never stops the sweep", () => {
    // TN -365 (the admin panel's lowest limit): a -100 DT payout (-100,000 minor) reaches it, so the floor is -365,000, not -36,500.
    expect(payoutFloorMinor(ctxOf({ TN: { kinds: { payout_big: { limits: { info: -365 } } } } }))).toBe(-365_000);
    // A raw API value: -1e17 x 1,000 is below bigint; read every row (as main did) instead of a SQL error.
    expect(payoutFloorMinor(ctxOf({ SE: { kinds: { payout_big: { limits: { info: -1e17 } } } } }))).toBe(-(2n ** 63n));
  });
});
