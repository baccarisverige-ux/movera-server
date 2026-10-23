import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import { SURGE, surgeAt, validateSchedule, type SurgeSchedule } from "../../src/rules/surge.js";

type SurgeCase = { at: string; multiplier: number | null };

const fixture = contractJson<{ version: string; schedule: SurgeSchedule; cases: SurgeCase[] }>("fixtures/surge.json");

// surge.json cases have no `id`, so a case is named by its place in the list and its time.
const caseName = (i: number, c: SurgeCase): string => `surge.json case #${i} (at ${c.at})`;

/** A schedule from 17:00 to 19:00 on the fixture day with the given points. */
function schedule(points: [number, number][], extra: Partial<SurgeSchedule> = {}): SurgeSchedule {
  return {
    startAt: "2026-10-23T17:00:00Z",
    endAt: "2026-10-23T19:00:00Z",
    stepMinutes: 5,
    cap: 3.0,
    points: points.map(([atMin, multiplier]) => ({ atMin, multiplier })),
    ...extra,
  };
}

/** The fixture day at 17:00 plus `minute` minutes and `second` seconds. */
function at(minute: number, second = 0): string {
  const hh = String(17 + Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(minute % 60).padStart(2, "0");
  return `2026-10-23T${hh}:${mm}:${String(second).padStart(2, "0")}Z`;
}

describe("surgeAt replays fixtures/surge.json (CONTRACT.md §3.4)", () => {
  it("has cases", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it.each(fixture.cases.map((c, i) => [caseName(i, c), c] as const))("%s", (name, c) => {
    expect(surgeAt(fixture.schedule, c.at), name).toBe(c.multiplier);
  });

  it("gives the same answers for a Date as for its string", () => {
    fixture.cases.forEach((c, i) => {
      expect(surgeAt(fixture.schedule, new Date(c.at)), caseName(i, c)).toBe(c.multiplier);
    });
  });

  it("the fixture schedule is valid", () => {
    expect(validateSchedule(fixture.schedule)).toEqual([]);
  });
});

// Every expected value below was computed by reference_check.py `surge_at` on the same schedule and time.
describe("surgeAt matches reference_check.py beyond the fixture", () => {
  const cases: [string, SurgeSchedule, string, number | null][] = [
    // Floating point: as doubles these lines land just below x.x5, so the reference rounds DOWN where exact decimal
    // maths would round up, or the other way round if (minute - a) / span were computed first.
    ["drift: 1.2→1.4 over 20 at 15 is 1.3499999999999999", schedule([[0, 1.2], [20, 1.4]]), at(15), 1.3],
    ["drift: same step at 19:59", schedule([[0, 1.2], [20, 1.4]]), at(19, 59), 1.3],
    ["order: 1.4→2.8 over 20 at 15", schedule([[0, 1.4], [20, 2.8]]), at(15), 2.5],
    ["order: 1.9→2.8 over 10 at 5", schedule([[0, 1.9], [10, 2.8]]), at(5), 2.4],
    ["order: 2.4→1.0 over 20 at 15", schedule([[0, 2.4], [20, 1.0]]), at(15), 1.3],
    ["exact tie 1.25 rounds up", schedule([[0, 1.0], [20, 1.5]]), at(10), 1.3],
    ["double just below x.x5 still rounds up: 1.15", schedule([[0, 1.15], [20, 1.15]]), at(0), 1.2],
    ["double just below x.x5 still rounds up: 1.45", schedule([[0, 1.45], [20, 1.45]]), at(0), 1.5],
    ["double just below x.x5 still rounds up: 2.15", schedule([[0, 2.15], [20, 2.15]]), at(0), 2.2],
    // Clamping to [1.0, cap].
    ["above the cap is the cap", schedule([[0, 2.0], [20, 4.0]]), at(15), 3.0],
    ["cap 2.5", schedule([[0, 2.0], [20, 4.0]], { cap: 2.5 }), at(10), 2.5],
    ["below 1.0 is 1.0", schedule([[0, 0.5], [20, 0.9]]), at(10), 1.0],
    // Shape of the curve.
    ["two points on one minute: at the minute, the line before", schedule([[0, 1.5], [20, 1.5], [20, 2.0], [60, 2.0]]), at(20), 1.5],
    ["two points on one minute: after it, the line after", schedule([[0, 1.5], [20, 1.5], [20, 2.0], [60, 2.0]]), at(25), 2.0],
    ["after the last point holds the last multiplier", schedule([[0, 1.5], [30, 2.0]]), at(90), 2.0],
    ["before the first point holds the first multiplier", schedule([[10, 1.8], [30, 1.2]]), at(5), 1.8],
    ["unsorted points are walked as given", schedule([[0, 1.5], [40, 2.0], [20, 1.0]]), at(30), 1.9],
    ["whole-number multipliers", schedule([[0, 1], [20, 2]], { cap: 3 }), at(5), 1.3],
    // Steps.
    ["stepMinutes 1", schedule([[0, 1.0], [10, 2.0]], { stepMinutes: 1 }), at(7, 30), 1.7],
    ["stepMinutes 15, last second of a step", schedule([[0, 1.0], [60, 2.5]], { stepMinutes: 15 }), at(44, 59), 1.8],
    ["stepMinutes 7", schedule([[0, 1.0], [70, 2.4]], { stepMinutes: 7 }), at(20), 1.3],
    ["last second before endAt", schedule([[0, 1.0], [120, 2.2]]), at(119, 59), 2.2],
    ["endAt itself is null", schedule([[0, 1.0], [120, 2.2]]), at(120), null],
  ];

  it.each(cases)("%s", (name, s, time, expected) => {
    expect(surgeAt(s, time), name).toBe(expected);
  });
});

describe("surgeAt times and errors", () => {
  const s = fixture.schedule;

  it("accepts fractions of a second without moving across startAt or endAt", () => {
    expect(surgeAt(s, "2026-10-23T16:59:59.999999999Z"), "just before startAt").toBe(null);
    expect(surgeAt(s, "2026-10-23T17:00:00.000Z"), "startAt with a fraction").toBe(1.5);
    expect(surgeAt(s, "2026-10-23T17:04:59.999Z"), "last moment of the first step").toBe(1.5);
    expect(surgeAt(s, "2026-10-23T17:59:59.999999999Z"), "just before endAt").toBe(1.0);
    expect(surgeAt({ ...s, startAt: "2026-10-23T17:00:00.5Z" }, "2026-10-23T17:00:00.4Z"), "sub-second start").toBe(null);
  });

  it.each([
    "2026-10-23 17:05:00Z",
    "2026-10-23T17:05:00+00:00",
    "2026-10-23T17:05:00",
    "2026-10-23t17:05:00z",
    "2026-02-30T17:05:00Z",
    "2026-13-01T17:05:00Z",
    "2026-10-23T24:00:00Z",
    "2026-10-23T17:05:60Z",
    "0000-10-23T17:05:00Z",
    "",
  ])("throws a RangeError for the time %j", (bad) => {
    expect(() => surgeAt(s, bad), bad).toThrow(RangeError);
  });

  it("throws for an invalid Date and for a bad startAt or endAt", () => {
    expect(() => surgeAt(s, new Date(Number.NaN))).toThrow(RangeError);
    expect(() => surgeAt({ ...s, startAt: "soon" }, "2026-10-23T17:05:00Z")).toThrow(RangeError);
    expect(() => surgeAt({ ...s, endAt: "later" }, "2026-10-23T17:05:00Z")).toThrow(RangeError);
  });

  it("reads 29 February only in leap years", () => {
    const leap = schedule([[0, 1.5], [60, 1.5]], { startAt: "2028-02-29T00:00:00Z", endAt: "2028-03-01T00:00:00Z" });
    expect(surgeAt(leap, "2028-02-29T12:00:00Z")).toBe(1.5);
    expect(() => surgeAt(leap, "2027-02-29T12:00:00Z")).toThrow(RangeError);
  });

  it("fails on a broken schedule only inside its window, as the reference does", () => {
    const noPoints = { ...s, points: [] };
    expect(surgeAt(noPoints, "2026-10-23T16:00:00Z")).toBe(null);
    expect(() => surgeAt(noPoints, "2026-10-23T17:05:00Z")).toThrow(RangeError);
    expect(() => surgeAt({ ...s, stepMinutes: 0 }, "2026-10-23T17:05:00Z")).toThrow(RangeError);
    expect(() => surgeAt({ ...s, stepMinutes: 2.5 }, "2026-10-23T17:05:00Z")).toThrow(RangeError);
  });

  it("is null for every time when endAt is not after startAt", () => {
    const backwards = { ...s, startAt: s.endAt, endAt: s.startAt };
    expect(surgeAt(backwards, "2026-10-23T17:30:00Z")).toBe(null);
    expect(surgeAt({ ...s, endAt: s.startAt }, s.startAt)).toBe(null);
  });
});

describe("validateSchedule (contract.json#surge, OpenAPI SurgeSchedule)", () => {
  it("reads its limits from contract.json#surge", () => {
    expect(SURGE).toEqual({ stepMinutes: 5, minMultiplier: 1.0, roundTo: 0.1, minPoints: 2, capDefault: 3.0 });
  });

  it("accepts a flat manual surge (two points, same multiplier) and a jump (two points on one minute)", () => {
    expect(validateSchedule(schedule([[0, 2.0], [120, 2.0]]))).toEqual([]);
    expect(validateSchedule(schedule([[0, 1.5], [20, 1.5], [20, 2.0], [120, 2.0]]))).toEqual([]);
    expect(validateSchedule(schedule([[0, 1.0], [120, 3.0]]))).toEqual([]);
  });

  const cases: [string, SurgeSchedule, string[]][] = [
    ["no points", schedule([]), ["points: needs at least 2 points, has 0"]],
    ["one point", schedule([[0, 1.5]]), ["points: needs at least 2 points, has 1"]],
    ["first point not at 0", schedule([[5, 1.5], [60, 1.2]]), ["points[0].atMin must be 0, is 5"]],
    [
      "points not sorted",
      schedule([[0, 1.5], [40, 2.0], [20, 1.0]]),
      ["points must be sorted by atMin: points[2].atMin 20 comes after 40"],
    ],
    ["atMin not whole", schedule([[0, 1.5], [7.5, 2.0]]), ["points[1].atMin must be a whole number of minutes, is 7.5"]],
    ["multiplier below 1.0", schedule([[0, 0.9], [60, 1.2]]), ["points[0].multiplier 0.9 is below the minimum 1"]],
    ["multiplier above cap", schedule([[0, 1.5], [60, 3.5]]), ["points[1].multiplier 3.5 is above the cap 3"]],
    [
      "multiplier above a lower cap",
      schedule([[0, 2.0], [60, 2.6]], { cap: 2.5 }),
      ["points[1].multiplier 2.6 is above the cap 2.5"],
    ],
    ["multiplier NaN", schedule([[0, Number.NaN], [60, 1.2]]), ["points[0].multiplier NaN is below the minimum 1"]],
    [
      "cap below 1.0",
      schedule([[0, 1.0], [60, 1.0]], { cap: 0.5 }),
      ["points[0].multiplier 1 is above the cap 0.5", "points[1].multiplier 1 is above the cap 0.5", "cap 0.5 is below the minimum 1"],
    ],
    ["stepMinutes 0", schedule([[0, 1.5], [60, 1.2]], { stepMinutes: 0 }), ["stepMinutes must be a whole number of at least 1, is 0"]],
    [
      "stepMinutes 2.5",
      schedule([[0, 1.5], [60, 1.2]], { stepMinutes: 2.5 }),
      ["stepMinutes must be a whole number of at least 1, is 2.5"],
    ],
    [
      "endAt equal to startAt",
      schedule([[0, 1.5], [60, 1.2]], { endAt: "2026-10-23T17:00:00Z" }),
      ["endAt 2026-10-23T17:00:00Z must be after startAt 2026-10-23T17:00:00Z"],
    ],
    [
      "endAt before startAt",
      schedule([[0, 1.5], [60, 1.2]], { endAt: "2026-10-23T16:00:00Z" }),
      ["endAt 2026-10-23T16:00:00Z must be after startAt 2026-10-23T17:00:00Z"],
    ],
    [
      "unreadable times",
      schedule([[0, 1.5], [60, 1.2]], { startAt: "tomorrow", endAt: "2026-10-23T18:00:00+01:00" }),
      ["startAt is not an RFC 3339 UTC time: tomorrow", "endAt is not an RFC 3339 UTC time: 2026-10-23T18:00:00+01:00"],
    ],
    [
      "several problems at once",
      schedule([[10, 0.8]], { cap: 3.0, endAt: "2026-10-23T17:00:00Z" }),
      [
        "points: needs at least 2 points, has 1",
        "points[0].atMin must be 0, is 10",
        "points[0].multiplier 0.8 is below the minimum 1",
        "endAt 2026-10-23T17:00:00Z must be after startAt 2026-10-23T17:00:00Z",
      ],
    ],
  ];

  it.each(cases)("%s", (name, s, expected) => {
    expect(validateSchedule(s), name).toEqual(expected);
  });
});
