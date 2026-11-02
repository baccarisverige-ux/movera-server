import { describe, expect, it } from "vitest";
import { headingSettingsOf, headingView, isFreeCancel, nextHeading, type HeadingState } from "../../src/trips/headingCheck.js";

/**
 * Owner G5-8 (decisions/driver-g5.md item 8 + notes; contract v0.18.13 pickupWaiting.headingCheck): "heading to pickup"
 * = in each 30 s check the driver got at least 80 % (admin per zone) as much closer as normal road speed allowed;
 * not heading for 2 min in a row → free rider cancel. Replaces the old fixed 400 m/min × 50 % check made once.
 */
const t0 = new Date("2026-11-02T12:00:00Z");
const at = (s: number) => new Date(t0.getTime() + s * 1000);
const SE = headingSettingsOf(null);
// A French zone that asks for more: 90 %, 3 minutes.
const FR = headingSettingsOf({ headingCheck: { headingPct: 90, notHeadingMinutes: 3 } });
const speed = 10; // m/s on this route (36 km/h)
const start = (): HeadingState => nextHeading(null, { now: t0, settings: SE, meters: 5000, speedMps: speed, atPickup: false });

describe("heading to pickup = 80 % of what normal road speed allows (G5-8)", () => {
  it("defaults: on, 80 %, 2 min, reassign on; bad admin values fall back", () => {
    expect(SE).toEqual({ on: true, headingPct: 80, notHeadingMinutes: 2, reassign: true });
    expect(headingSettingsOf({ headingCheck: { headingPct: 20, notHeadingMinutes: 0 } })).toMatchObject({ headingPct: 80, notHeadingMinutes: 2 });
  });

  it("30 s at 85 % of road speed is heading; at 70 % it is not (the old 50 % rule would have charged it)", () => {
    expect(nextHeading(start(), { now: at(30), settings: SE, meters: 5000 - 255, speedMps: speed, atPickup: false }).heading).toBe(true);
    expect(nextHeading(start(), { now: at(30), settings: SE, meters: 5000 - 210, speedMps: speed, atPickup: false }).heading).toBe(false);
    // Paris at 90 %: 85 % is not enough.
    expect(nextHeading(start(), { now: at(30), settings: FR, meters: 5000 - 255, speedMps: speed, atPickup: false }).heading).toBe(false);
  });

  it("a long pickup is fair: only what the road allows in the time counts, capped by the distance left", () => {
    const near = nextHeading(null, { now: t0, settings: SE, meters: 100 + 301, speedMps: speed, atPickup: false });
    // 401 m left, 300 m possible in 30 s: 240 m of progress is enough.
    expect(nextHeading(near, { now: at(30), settings: SE, meters: 401 - 240, speedMps: speed, atPickup: false }).heading).toBe(true);
  });

  it("no position is no proof; within the arrive radius counts as heading", () => {
    expect(nextHeading(start(), { now: at(30), settings: SE, meters: null, speedMps: null, atPickup: false }).heading).toBe(false);
    expect(nextHeading(start(), { now: at(30), settings: SE, meters: 5000, speedMps: speed, atPickup: true }).heading).toBe(true);
  });

  it("free cancel only after notHeadingMinutes in a row (checked every 30 s, the whole wait); heading again starts over", () => {
    let s = start();
    for (let i = 1; i <= 4; i++) s = nextHeading(s, { now: at(30 * i), settings: SE, meters: 5000, speedMps: speed, atPickup: false });
    expect(s.notHeadingSince).toBe(at(30).toISOString());
    expect(isFreeCancel(s, SE, at(120))).toBe(false);
    s = nextHeading(s, { now: at(150), settings: SE, meters: 5000, speedMps: speed, atPickup: false });
    expect(isFreeCancel(s, SE, at(150))).toBe(true);
    expect(headingView({ status: "driver_to_pickup", heading_check: s }, at(150))).toEqual({ heading: false, checkedAt: at(150).toISOString(), notHeadingSince: at(30).toISOString(), freeCancel: true });
    // Paris: 3 minutes.
    expect(isFreeCancel(s, FR, at(150))).toBe(false);
    const again = nextHeading(s, { now: at(180), settings: SE, meters: 5000 - 300, speedMps: speed, atPickup: false });
    expect(again.heading).toBe(true);
    expect(isFreeCancel(again, SE, at(180))).toBe(false);
    expect(headingView({ status: "arrived", heading_check: again }, at(180))).toBeNull();
  });
});
