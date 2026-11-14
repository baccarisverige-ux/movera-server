import { describe, expect, it } from "vitest";
import { confirmedBy, type CountingFix } from "../../src/trips/ride/fixConfirm.js";

/**
 * Job C9 round 2 (contract.json#autoArrive.confirm, supervisor M1): one GPS fix never decides. Pure cases for the rule:
 * 2 counting fixes in a row at least 5 s apart on the same side; arrivals also at most 15 km/h.
 */
const T0 = Date.parse("2026-11-14T10:00:00Z");
/** A fix `s` seconds after T0, `m` metres along a straight road from the pickup (lat only), speed when given. */
const f = (s: number, m: number, speedMps: number | null = null): CountingFix => ({ measuredAt: new Date(T0 + s * 1000), meters: Math.abs(m), speedMps, lat: m / 111_195, lng: 0 });
const newestFirst = (...fixes: CountingFix[]) => [...fixes].sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime());
const rule = { fixes: 2, minGapSeconds: 5, maxArriveSpeedKmh: 15, windowSeconds: 60 };
const apart = (a: CountingFix, b: CountingFix) => Math.abs(a.lat - b.lat) * 111_195;
const within = (x: CountingFix) => x.meters <= 100;
const beyond = (x: CountingFix) => x.meters > 200;

describe("fixConfirm.confirmedBy", () => {
  it("one fix alone never decides", () => {
    expect(confirmedBy([f(0, 20)], within, rule, true, apart)).toBeNull();
    expect(confirmedBy(newestFirst(f(0, 400), f(5, 20)), within, rule, true, apart)).toBeNull();
  });
  it("two standing fixes 5 s apart confirm; the moment is the earlier one", () => {
    expect(confirmedBy(newestFirst(f(0, 30), f(5, 32)), within, rule, true, apart)?.measuredAt).toEqual(new Date(T0));
  });
  it("less than 5 s apart is not enough yet", () => {
    expect(confirmedBy(newestFirst(f(0, 30), f(3, 30)), within, rule, true, apart)).toBeNull();
  });
  it("a fix on the other side in between breaks the run (jitter at the border)", () => {
    expect(confirmedBy(newestFirst(f(0, 95), f(3, 105), f(6, 95)), within, rule, true, apart)).toBeNull();
    expect(confirmedBy(newestFirst(f(0, 210), f(5, 190), f(10, 210)), beyond, rule, false, apart)).toBeNull();
  });
  it("too fast: a speed over 15 km/h on a fix, or 120 m in 5 s between the two", () => {
    expect(confirmedBy(newestFirst(f(0, 30, 13.9), f(5, 30, 1)), within, rule, true, apart)).toBeNull();
    expect(confirmedBy(newestFirst(f(0, -60), f(5, 60)), within, rule, true, apart)).toBeNull();
    // Leaving has no speed check.
    expect(confirmedBy(newestFirst(f(0, 300, 14), f(5, 380, 14)), beyond, rule, false, apart)?.measuredAt).toEqual(new Date(T0));
  });
  it("the earlier fix must be inside the position age window", () => {
    expect(confirmedBy(newestFirst(f(0, 30), f(70, 30)), within, rule, true, apart)).toBeNull();
  });
});
