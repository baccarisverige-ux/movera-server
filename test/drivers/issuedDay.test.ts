import { describe, expect, it } from "vitest";
import { issuedDayInFuture } from "../../src/documents/service.js";

/** Doc dates (2026-11-24): the issue day is compared with today in the document's country, winter and summer. */
describe("issuedDayInFuture", () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  it("Stockholm winter (UTC+1): 00:30 local is already the new day", () => {
    const now = new Date("2026-11-23T23:30:00Z");
    expect(issuedDayInFuture(day("2026-11-24"), now, "SE")).toBe(false);
    expect(issuedDayInFuture(day("2026-11-25"), now, "SE")).toBe(true);
  });
  it("Stockholm summer (UTC+2): 01:30 local is already the new day; 23:59 local is not", () => {
    expect(issuedDayInFuture(day("2026-07-02"), new Date("2026-07-01T23:30:00Z"), "SE")).toBe(false);
    expect(issuedDayInFuture(day("2026-07-02"), new Date("2026-07-01T21:59:00Z"), "SE")).toBe(true);
  });
  it("Tunis (UTC+1, no summer time) and Paris summer", () => {
    expect(issuedDayInFuture(day("2026-07-02"), new Date("2026-07-01T23:30:00Z"), "TN")).toBe(false);
    expect(issuedDayInFuture(day("2026-07-02"), new Date("2026-07-01T22:30:00Z"), "TN")).toBe(true);
    expect(issuedDayInFuture(day("2026-07-02"), new Date("2026-07-01T22:30:00Z"), "FR")).toBe(false);
  });
  it("an unknown country falls back to Stockholm", () => {
    expect(issuedDayInFuture(day("2026-11-24"), new Date("2026-11-23T23:30:00Z"), null)).toBe(false);
  });
});
