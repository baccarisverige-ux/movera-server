import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkerConfig, TRIP_LANE_KINDS } from "../../src/jobs/workerConfig.js";
import { EstimateRouter } from "../../src/maps/routing.js";
import { TIMER } from "../../src/reservations/timerKinds.js";
import { TRIP_ETA } from "../../src/trips/eta.js";

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
});
