import { contractJson } from "../contract/contract.js";

/**
 * Surge schedule, CONTRACT.md §3.4 and contract.json#surge: an admin surge curve over time. Points
 * `{ atMin, multiplier }` from minute 0, straight lines between them, read in `stepMinutes` steps, rounded half-up
 * to 0.1 and kept within [1.0, cap]. Cases: fixtures/surge.json.
 *
 * The maths mirrors reference_check.py `surge_at` / `_value_at` exactly, including where it uses floats.
 */

type SurgeRules = {
  stepMinutes: number;
  minMultiplier: number;
  roundTo: number;
  minPoints: number;
  capDefault: number;
};

/** The fixed numbers of contract.json#surge: default step, lowest multiplier, rounding step, fewest points, default cap. */
export const SURGE: Readonly<SurgeRules> = (() => {
  const s = contractJson<{ surge: SurgeRules }>("contract.json").surge;
  return Object.freeze({
    stepMinutes: s.stepMinutes,
    minMultiplier: s.minMultiplier,
    roundTo: s.roundTo,
    minPoints: s.minPoints,
    capDefault: s.capDefault,
  });
})();

// roundTo is 0.1, so this is 10. In doubles 1 / 0.1 is exactly 10 and 10 * 0.1 is exactly 1, so rounding with
// "× 10, + 0.5, floor, ÷ 10" below is the same arithmetic as the reference's `math.floor(v * 10 + 0.5) / 10`.
const ROUND_STEPS = Math.round(1 / SURGE.roundTo);
if (ROUND_STEPS * SURGE.roundTo !== 1) {
  throw new Error(`contract.json#surge.roundTo ${SURGE.roundTo} is not 1/n; surge rounding needs a new look`);
}

/** One point of the curve, OpenAPI `SurgePoint`: minutes from startAt, and the multiplier there. */
export type SurgePoint = { atMin: number; multiplier: number };

/**
 * A surge curve over time, OpenAPI `SurgeSchedule` (CONTRACT.md §3.4). Only the fields the maths needs are
 * required; the ids are carried when the caller has them.
 */
export type SurgeSchedule = {
  scheduleId?: string;
  zoneId?: string;
  categoryIds?: string[];
  startAt: string;
  endAt: string;
  stepMinutes: number;
  cap: number;
  points: SurgePoint[];
};

// RFC 3339 instant in UTC with a literal Z, the OpenAPI `Timestamp` pattern (CONTRACT.md "Time").
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const NS_PER_MS = 1_000_000n;
const NS_PER_MINUTE = 60_000_000_000n;

function isLeapYear(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function daysInMonth(y: number, month: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/**
 * Whole nanoseconds since 1970-01-01T00:00:00Z, or null when `at` is not a valid RFC 3339 UTC instant.
 * Nanoseconds (as a bigint) so a fraction of a second never moves a time across startAt or endAt.
 * Rejects what Python's `datetime` rejects: year 0, month 13, 30 February, second 60.
 */
function epochNs(at: string | Date): bigint | null {
  if (at instanceof Date) {
    const ms = at.getTime();
    return Number.isFinite(ms) ? BigInt(ms) * NS_PER_MS : null;
  }
  const m = TIMESTAMP.exec(at);
  if (!m) return null;
  const field = (i: number): number => Number(m[i] ?? Number.NaN);
  const [y, month, day, hour, minute, second] = [field(1), field(2), field(3), field(4), field(5), field(6)];
  if (y < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(y, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  // setUTCFullYear, not Date.UTC: Date.UTC reads the years 0 to 99 as 1900 to 1999.
  const date = new Date(0);
  date.setUTCFullYear(y, month - 1, day);
  const ms = date.getTime() + ((hour * 60 + minute) * 60 + second) * 1000;
  return BigInt(ms) * NS_PER_MS + BigInt((m[7] ?? "").padEnd(9, "0"));
}

function parseInstant(at: string | Date, what: string): bigint {
  const ns = epochNs(at);
  if (ns === null) throw new RangeError(`${what} is not an RFC 3339 UTC time: ${String(at)}`);
  return ns;
}

/**
 * The curve's value at `minute`, reference_check.py `_value_at` (CONTRACT.md §3.4 "straight lines between them"):
 * the first multiplier up to the first point; on the line from a to b between two points; b's multiplier when the
 * two points share a minute (span ≤ 0); the last multiplier after the last point. Points are walked in the given
 * order, as the reference does; it does not sort them.
 */
function valueAt(points: readonly SurgePoint[], minute: number): number {
  const first = points[0];
  if (first === undefined) throw new RangeError("surge schedule has no points");
  if (minute <= first.atMin) return first.multiplier;
  let a = first;
  for (const b of points.slice(1)) {
    if (minute <= b.atMin) {
      const span = b.atMin - a.atMin;
      // Same operations in the same order as the reference: a + ((b - a) × (minute - a.atMin)) / span.
      // Doing (minute - a.atMin) / span first gives a different double for some curves (see the test).
      return span <= 0 ? b.multiplier : a.multiplier + ((b.multiplier - a.multiplier) * (minute - a.atMin)) / span;
    }
    a = b;
  }
  return a.multiplier;
}

/**
 * The surge multiplier in force at `at`, CONTRACT.md §3.4 and contract.json#surge.valueAt; same result as
 * reference_check.py `surge_at` for every fixture case.
 *
 * Returns null before `startAt` and from `endAt` on. Otherwise: minute = whole minutes since startAt (rounded
 * down); slot = minute rounded down to a multiple of stepMinutes; the curve's value at that slot, rounded half-up
 * to 0.1, at least 1.0 and at most `cap`.
 *
 * Throws a RangeError when a time is not an RFC 3339 UTC instant, and, inside the window only (as the reference
 * fails only there), when the schedule has no points or stepMinutes is not a whole number of at least 1.
 * Fractions of a second are accepted (the OpenAPI `Timestamp` allows them; the Python reference does not).
 */
export function surgeAt(schedule: SurgeSchedule, at: string | Date): number | null {
  const start = parseInstant(schedule.startAt, "startAt");
  const end = parseInstant(schedule.endAt, "endAt");
  const now = parseInstant(at, "at");
  if (now < start || now >= end) return null;

  const step = schedule.stepMinutes;
  if (!Number.isInteger(step) || step < 1) {
    throw new RangeError(`stepMinutes must be a whole number of at least 1, is ${step}`);
  }
  // now >= start, so bigint division (which drops the remainder) is the same as Python's floor `// 60`.
  const minute = Number((now - start) / NS_PER_MINUTE);
  const slot = minute - (minute % step); // = floor(minute / step) × step, in exact integer arithmetic
  const value = valueAt(schedule.points, slot);

  // Floating point: Python floats and JS numbers are both IEEE-754 doubles and every step here (×, +, floor, ÷) is
  // correctly rounded in both, so the same operations in the same order give the same bits as the reference's
  // `math.floor(v * 10 + 0.5) / 10`. That is not always decimal half-up: the line from 1.2 to 1.4 at 15 of 20
  // minutes is 1.3499999999999999 as a double, so the reference (and this) gives 1.3, not 1.4. Keep it this way.
  const rounded = Math.floor(value * ROUND_STEPS + 0.5) / ROUND_STEPS;
  // Python's min(cap, max(1.0, rounded)), written out so the tie and NaN behaviour is the same.
  const atLeastMin = rounded > SURGE.minMultiplier ? rounded : SURGE.minMultiplier;
  return atLeastMin < schedule.cap ? atLeastMin : schedule.cap;
}

/**
 * Problems that make a schedule unacceptable, CONTRACT.md §3.4 ("points above the cap are 400 invalid_request"),
 * contract.json#surge (minPoints, minMultiplier) and OpenAPI `SurgeSchedule` / `SurgePoint`. An empty list means
 * the schedule is fine. Checks: at least minPoints points; the first point at minute 0; points sorted by atMin
 * (two points may share a minute, which makes a jump); every atMin a whole number; every multiplier at least
 * minMultiplier and at most cap; cap at least minMultiplier; stepMinutes a whole number of at least 1; startAt and
 * endAt valid RFC 3339 UTC times with endAt after startAt.
 */
export function validateSchedule(schedule: SurgeSchedule): string[] {
  const problems: string[] = [];
  const { points, cap, stepMinutes } = schedule;

  if (points.length < SURGE.minPoints) {
    problems.push(`points: needs at least ${SURGE.minPoints} points, has ${points.length}`);
  }
  const first = points[0];
  if (first !== undefined && first.atMin !== 0) {
    problems.push(`points[0].atMin must be 0, is ${first.atMin}`);
  }
  points.forEach((p, i) => {
    if (!Number.isInteger(p.atMin)) problems.push(`points[${i}].atMin must be a whole number of minutes, is ${p.atMin}`);
    const prev = points[i - 1];
    if (prev !== undefined && !(p.atMin >= prev.atMin)) {
      problems.push(`points must be sorted by atMin: points[${i}].atMin ${p.atMin} comes after ${prev.atMin}`);
    }
    if (!(p.multiplier >= SURGE.minMultiplier)) {
      problems.push(`points[${i}].multiplier ${p.multiplier} is below the minimum ${SURGE.minMultiplier}`);
    } else if (!(p.multiplier <= cap)) {
      problems.push(`points[${i}].multiplier ${p.multiplier} is above the cap ${cap}`);
    }
  });
  if (!(cap >= SURGE.minMultiplier)) {
    problems.push(`cap ${cap} is below the minimum ${SURGE.minMultiplier}`);
  }
  if (!Number.isInteger(stepMinutes) || stepMinutes < 1) {
    problems.push(`stepMinutes must be a whole number of at least 1, is ${stepMinutes}`);
  }

  const start = epochNs(schedule.startAt);
  const end = epochNs(schedule.endAt);
  if (start === null) problems.push(`startAt is not an RFC 3339 UTC time: ${schedule.startAt}`);
  if (end === null) problems.push(`endAt is not an RFC 3339 UTC time: ${schedule.endAt}`);
  if (start !== null && end !== null && end <= start) {
    problems.push(`endAt ${schedule.endAt} must be after startAt ${schedule.startAt}`);
  }
  return problems;
}
