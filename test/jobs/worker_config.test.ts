import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkerConfig, HOUSEKEEPING_LANE_KINDS, TRIP_LANE_KINDS } from "../../src/jobs/workerConfig.js";
import type { TimerLane } from "../../src/jobs/timers.js";
import { HOUSEKEEPING_KINDS } from "../../src/jobs/housekeeping.js";
import { NIGHTLY, SWEEP_IDEMPOTENCY_KEYS } from "../../src/jobs/maintenance.js";
import { PAYOUT_CLOSE, PAYOUT_DRIVER } from "../../src/jobs/payouts.js";
import { ALERT_SWEEP } from "../../src/alerts/detector.js";
import { INCIDENT_ESCALATE } from "../../src/safety/incidents.js";
import { EstimateRouter } from "../../src/maps/routing.js";
import { TIMER } from "../../src/reservations/timerKinds.js";
import { TRIP_ETA } from "../../src/trips/eta.js";
import { readEnv } from "../../src/env.js";

/** S08 A1/A2: every timer kind the code schedules has a handler; trip kinds only on the trip lane. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function scheduledKinds(): Set<string> {
  const files = sources("src").map((path) => readFileSync(path, "utf8"));
  const all = files.join("\n");
  const constants = new Map<string, string>();
  for (const m of all.matchAll(/(?:export )?const ([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*"([a-z0-9_]+)"/g)) constants.set(m[1]!, m[2]!);
  const kinds = new Set<string>();
  const unresolved: string[] = [];
  for (const m of all.matchAll(/(?:scheduleTimer|insertInto\("timers"\))[\s\S]{0,120}?kind:\s*([^,}\s]+)/g)) {
    const expr = m[1]!;
    if (expr === "timer.kind" || expr === "string;") continue;
    const literal = /^"([a-z0-9_]+)"$/.exec(expr);
    const member = /^TIMER\.(\w+)$/.exec(expr);
    const value = literal ? literal[1] : member ? (TIMER as Record<string, string>)[member[1]!] : constants.get(expr);
    if (value === undefined) unresolved.push(expr);
    else kinds.add(value);
  }
  expect(unresolved).toEqual([]);
  return kinds;
}

describe("buildWorkerConfig", () => {
  const { handlers, lanes } = buildWorkerConfig(new EstimateRouter(), { timerLanes: 4, dispatchLanes: 1 });

  it("has a handler for every timer kind the code can schedule", () => {
    const kinds = scheduledKinds();
    expect(kinds.size).toBeGreaterThan(30);
    expect([...kinds].filter((kind) => handlers[kind] === undefined)).toEqual([]);
    for (const kind of Object.values(TIMER)) expect(handlers[kind]).toBeTypeOf("function");
  });

  it("keeps trip kinds on the trip lane only", () => {
    const tripLanes = lanes.filter((lane) => lane.kinds !== undefined && TRIP_LANE_KINDS.every((kind) => lane.kinds!.includes(kind)));
    expect(tripLanes).toHaveLength(1);
    for (const lane of lanes) {
      if (lane === tripLanes[0]) continue;
      if (lane.kinds !== undefined) expect(lane.kinds.filter((kind) => TRIP_LANE_KINDS.includes(kind))).toEqual([]);
      else expect(TRIP_LANE_KINDS.every((kind) => lane.exclude?.includes(kind))).toBe(true);
    }
    for (const kind of TRIP_LANE_KINDS) expect(handlers[kind]).toBeTypeOf("function");
  });

  it("uses the real-router trip_eta handler, with its prepare", () => {
    expect(handlers[TRIP_ETA]?.prepare).toBeTypeOf("function");
  });

  // B1.7 (owner W1 Q71): housekeeping on its own lane; SOS escalation and the alert sweep on lanes it never uses.
  const takes = (lane: TimerLane, kind: string) => (lane.kinds !== undefined ? lane.kinds.includes(kind) : !(lane.exclude ?? []).includes(kind));
  it("B1.7: housekeeping (13 jobs, hourly sweep, nightly run, S4 0.14a payout timer + driver steps) runs only on the housekeeping lane", () => {
    // v0.18.116 §94: + cleanup_trip_shares (share-my-trip rows after 30 days).
    expect(HOUSEKEEPING_KINDS).toHaveLength(13);
    expect([...HOUSEKEEPING_LANE_KINDS].sort()).toEqual([...HOUSEKEEPING_KINDS, SWEEP_IDEMPOTENCY_KEYS, NIGHTLY, PAYOUT_CLOSE, PAYOUT_DRIVER].sort());
    const housekeeping = lanes.filter((lane) => lane.name === "housekeeping");
    expect(housekeeping).toHaveLength(1);
    for (const kind of HOUSEKEEPING_LANE_KINDS) {
      expect(handlers[kind]).toBeTypeOf("function");
      expect(lanes.filter((lane) => takes(lane, kind))).toEqual(housekeeping);
    }
  });
  it("B1.7: incident_escalate, alert_sweep and every booked-ride timer run on a lane that never takes housekeeping", () => {
    for (const kind of [INCIDENT_ESCALATE, ALERT_SWEEP, ...Object.values(TIMER)]) {
      const own = lanes.filter((lane) => takes(lane, kind));
      expect(own.length).toBeGreaterThanOrEqual(1);
      for (const lane of own) expect(HOUSEKEEPING_LANE_KINDS.filter((hk) => takes(lane, hk))).toEqual([]);
    }
  });
  it("B1.7: every kind with a handler is taken by some lane; HOUSEKEEPING_LANES sets the housekeeping lane count", () => {
    for (const kind of Object.keys(handlers)) expect(lanes.some((lane) => takes(lane, kind))).toBe(true);
    const wide = buildWorkerConfig(new EstimateRouter(), { timerLanes: 4, dispatchLanes: 1, housekeepingLanes: 3 }).lanes;
    expect(wide.filter((lane) => lane.name === "housekeeping")).toHaveLength(3);
    // Today's other lanes are unchanged: 1 dispatch + 1 trip + 2 general.
    expect(lanes).toHaveLength(5);
    expect(lanes.filter((lane) => lane.exclude !== undefined)).toHaveLength(2);
  });
  it("G34 S3 (v0.18.83 fastDispatch.lateAlarm): TRIP_LANES defaults to 1 and sets the per-trip lane count; no other lane takes those kinds", () => {
    expect(readEnv({ MOVERA_ENV: "development" }).TRIP_LANES).toBe(1);
    for (const kind of TRIP_LANE_KINDS) expect(lanes.filter((lane) => takes(lane, kind))).toHaveLength(1);
    const three = buildWorkerConfig(new EstimateRouter(), { timerLanes: 4, dispatchLanes: 1, tripLanes: 3 }).lanes;
    for (const kind of TRIP_LANE_KINDS) expect(three.filter((lane) => takes(lane, kind))).toHaveLength(3);
    // The other lanes are unchanged: 1 dispatch + 3 trip + 2 general + 1 housekeeping.
    expect(three).toHaveLength(7);
  });
});
