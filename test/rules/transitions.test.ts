import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import {
  ACTORS,
  DRIVER_ASSIGNED,
  RATING_RULES,
  RIDER_ONBOARD,
  TERMINAL,
  TRANSITIONS,
  TRIP_KINDS,
  TRIP_STATUSES,
  findTransition,
  isActor,
  isTerminal,
  isTripKind,
  mayRate,
  nextStatus,
  type Actor,
  type TripKind,
  type TripStatus,
} from "../../src/rules/transitions.js";

const INVALID = "invalid_transition";

type Step = [command: string, actor: string, expect: string];
type Scenario = { id: string; kind: string; steps: Step[]; rating?: Record<string, string> };
const { scenarios } = contractJson<{ scenarios: Scenario[] }>("fixtures/scenarios.json");

type RawContract = {
  tripStatus: { values: string[]; terminal: string[]; driverAssigned: string[]; riderOnboard: string[] };
  actors: string[];
  transitions: Array<{ command: string; actor: string; from: string[]; to: string; when?: string }>;
  ratingAllowed: { rules: Array<{ rater: string; status: string; command?: string }> };
};
const raw = contractJson<RawContract>("contract.json");

/** Every (command, actor) pair the table knows. */
const COMMANDS = [...new Map(TRANSITIONS.map((row) => [`${row.command}/${row.actor}`, row] as const)).values()].map(
  (row) => ({ command: row.command, actor: row.actor }),
);

/**
 * Replays one scenario exactly like contracts/reference_check.py: start at "draft", apply each step, a step that
 * expects invalid_transition must return null and keep the status, ended_by is the last command that moved the
 * trip; then check each rating expectation. Returns the number of fixture cases checked.
 */
function replay(s: Scenario): number {
  expect(isTripKind(s.kind), `${s.id}: unknown kind ${s.kind}`).toBe(true);
  const kind = s.kind as TripKind;
  let status: TripStatus = "draft";
  let endedBy: string | null = null;
  let checked = 0;

  for (const [i, [command, who, expected]] of s.steps.entries()) {
    const where = `${s.id} step ${i + 1}: ${command} (${who}) from ${status}`;
    expect(isActor(who), `${where}: unknown actor`).toBe(true);
    const before = status;
    const next = nextStatus(status, command, who as Actor, kind);
    expect(findTransition(status, command, who as Actor, kind)?.to ?? null, where).toBe(next);
    expect(next ?? INVALID, where).toBe(expected);
    if (next !== null) {
      status = next;
      endedBy = command;
    }
    if (expected === INVALID) {
      expect(next, where).toBeNull();
      expect(status, `${where}: status must not change`).toBe(before);
    }
    checked++;
  }

  for (const [rater, expected] of Object.entries(s.rating ?? {})) {
    const where = `${s.id} rating by ${rater} after ${status} (ended by ${endedBy})`;
    expect(isActor(rater), `${where}: unknown rater`).toBe(true);
    const got = isTerminal(status) && mayRate(rater as Actor, status, endedBy) ? "allowed" : INVALID;
    expect(got, where).toBe(expected);
    checked++;
  }
  return checked;
}

describe("fixtures/scenarios.json (contract §3, #transitions, #ratingAllowed)", () => {
  it("has scenarios to replay", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const s of scenarios) {
    it(s.id, () => {
      expect(replay(s), s.id).toBe(s.steps.length + Object.keys(s.rating ?? {}).length);
    });
  }

  it("replays every step and rating case", () => {
    const total = scenarios.reduce((n, s) => n + s.steps.length + Object.keys(s.rating ?? {}).length, 0);
    expect(scenarios.reduce((n, s) => n + replay(s), 0)).toBe(total);
  });
});

describe("contract.json#tripStatus and #actors", () => {
  it("TRIP_STATUSES and ACTORS are the contract lists, in order", () => {
    expect([...TRIP_STATUSES]).toEqual(raw.tripStatus.values);
    expect([...ACTORS]).toEqual(raw.actors);
  });

  it("TERMINAL, DRIVER_ASSIGNED and RIDER_ONBOARD are the contract lists", () => {
    expect([...TERMINAL]).toEqual(raw.tripStatus.terminal);
    expect([...DRIVER_ASSIGNED]).toEqual(raw.tripStatus.driverAssigned);
    expect([...RIDER_ONBOARD]).toEqual(raw.tripStatus.riderOnboard);
  });

  it("the status groups fit together", () => {
    for (const s of RIDER_ONBOARD) expect(DRIVER_ASSIGNED.has(s), `riderOnboard ${s} not in driverAssigned`).toBe(true);
    for (const s of DRIVER_ASSIGNED) expect(TERMINAL.has(s), `driverAssigned ${s} is terminal`).toBe(false);
    for (const s of TRIP_STATUSES) expect(isTerminal(s), s).toBe(raw.tripStatus.terminal.includes(s));
  });
});

describe("contract.json#transitions sanity", () => {
  it("every status named in a transition row or rating rule exists in tripStatus.values", () => {
    const named = [
      ...raw.transitions.flatMap((row, i) => [...row.from, row.to].map((s) => ({ s, where: `transitions[${i}] ${row.command}` }))),
      ...raw.ratingAllowed.rules.map((rule, i) => ({ s: rule.status, where: `ratingAllowed.rules[${i}]` })),
    ];
    for (const { s, where } of named) expect(raw.tripStatus.values, `${where}: ${s}`).toContain(s);
  });

  it("every actor in a transition row or rating rule exists in actors, and every when is a trip kind", () => {
    for (const [i, row] of raw.transitions.entries()) {
      expect(raw.actors, `transitions[${i}] ${row.command}`).toContain(row.actor);
      if (row.when !== undefined) expect(TRIP_KINDS, `transitions[${i}] ${row.command}`).toContain(row.when);
    }
    for (const [i, rule] of raw.ratingAllowed.rules.entries()) expect(raw.actors, `ratingAllowed.rules[${i}]`).toContain(rule.rater);
  });

  it("the parsed table is the contract table, row for row, and is frozen", () => {
    expect(TRANSITIONS.map((r) => [r.command, r.actor, [...r.from], r.to, r.when ?? null])).toEqual(
      raw.transitions.map((r) => [r.command, r.actor, r.from, r.to, r.when ?? null]),
    );
    expect(RATING_RULES.map((r) => [r.rater, r.status, r.command ?? null])).toEqual(
      raw.ratingAllowed.rules.map((r) => [r.rater, r.status, r.command ?? null]),
    );
    expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    expect(TRANSITIONS.every((r) => Object.isFrozen(r) && Object.isFrozen(r.from))).toBe(true);
  });

  it("terminal statuses have no outgoing row (actual list, so a contract change is noticed)", () => {
    const outgoing = TRANSITIONS.flatMap((row) =>
      row.from.filter((s) => TERMINAL.has(s)).map((s) => `${row.command} (${row.actor}) from ${s}`),
    );
    expect(outgoing).toEqual([]);
  });

  it("no command moves a terminal trip, for any actor or kind", () => {
    for (const s of TERMINAL)
      for (const { command, actor } of COMMANDS)
        for (const kind of TRIP_KINDS) expect(nextStatus(s, command, actor, kind), `${command} (${actor}) ${kind} from ${s}`).toBeNull();
  });

  it("the statuses with no way out are exactly the terminal ones", () => {
    const deadEnds = TRIP_STATUSES.filter((s) => !TRANSITIONS.some((row) => row.from.includes(s)));
    expect(deadEnds).toEqual([...TERMINAL]);
  });

  it("no two rows match the same input (actual list; first match would decide)", () => {
    const overlaps: string[] = [];
    for (const s of TRIP_STATUSES)
      for (const kind of TRIP_KINDS)
        for (const { command, actor } of COMMANDS) {
          const rows = TRANSITIONS.flatMap((row, i) =>
            row.command === command && row.actor === actor && row.from.includes(s) && (row.when ?? kind) === kind ? [i] : [],
          );
          if (rows.length > 1) overlaps.push(`${command} (${actor}) ${kind} from ${s}: rows ${rows.join(", ")}`);
        }
    expect(overlaps).toEqual([]);
  });

  it("a row with when applies to that trip kind only", () => {
    for (const [i, row] of TRANSITIONS.entries()) {
      if (row.when === undefined) continue;
      const other = row.when === "live" ? "scheduled" : "live";
      for (const s of row.from) {
        expect(findTransition(s, row.command, row.actor, row.when), `row ${i} ${row.when} from ${s}`).toBe(row);
        expect(findTransition(s, row.command, row.actor, other), `row ${i} ${other} from ${s}`).not.toBe(row);
      }
    }
  });

  it("§3.1 lock: admin assign is invalid once a driver holds the trip or it is over", () => {
    for (const s of [...DRIVER_ASSIGNED, ...TERMINAL])
      for (const kind of TRIP_KINDS) expect(nextStatus(s, "assign", "admin", kind), `assign (admin) ${kind} from ${s}`).toBeNull();
  });

  it("unknown commands and wrong actors are invalid", () => {
    expect(nextStatus("draft", "teleport", "system", "live")).toBeNull();
    expect(nextStatus("draft", "quote", "rider", "live")).toBeNull();
  });
});

describe("mayRate (contract.json#ratingAllowed)", () => {
  it("follows the rules", () => {
    expect(mayRate("rider", "completed", "complete")).toBe(true);
    expect(mayRate("driver", "completed", "complete")).toBe(true);
    expect(mayRate("rider", "cancelled_by_rider", "end_early")).toBe(true);
    // v0.18.50 §72 (L5, owner G8 Q1): the driver rates a trip the rider ended early.
    expect(mayRate("driver", "cancelled_by_rider", "end_early")).toBe(true);
    expect(mayRate("rider", "cancelled_by_rider", "cancel")).toBe(false);
    expect(mayRate("rider", "cancelled_by_rider", null)).toBe(false);
    expect(mayRate("admin", "completed", "complete")).toBe(false);
  });

  it("a rule without command matches any ending command", () => {
    expect(mayRate("rider", "completed", "anything")).toBe(true);
    expect(mayRate("rider", "completed", null)).toBe(true);
  });

  it("is false for every non-terminal status", () => {
    for (const s of TRIP_STATUSES.filter((x) => !TERMINAL.has(x)))
      for (const rater of ACTORS)
        for (const { command } of COMMANDS) expect(mayRate(rater, s, command), `${rater} after ${s} by ${command}`).toBe(false);
  });
});
