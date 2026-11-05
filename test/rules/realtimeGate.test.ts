import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import {
  AFTER_TERMINAL_KINDS,
  DEFAULT_SEEN_LIMIT,
  RealtimeGate,
  TERMINAL_STATUSES,
  type Disposition,
} from "../../src/rules/realtimeGate.js";

type EventCase = {
  id: string;
  events: { eventId: string; tripId: string; sequence: number; kind: string; status?: string; expect: Disposition }[];
};

const fixture = contractJson<{ version: string; cases: EventCase[] }>("fixtures/events.json");

describe("fixtures/events.json", () => {
  it("has cases to replay", () => {
    expect(fixture.cases.length).toBe(6);
    expect(fixture.cases.reduce((n, c) => n + c.events.length, 0), "events replayed").toBe(19);
  });

  for (const c of fixture.cases) {
    it(`case ${c.id}`, () => {
      const gate = new RealtimeGate();
      c.events.forEach((e, i) => {
        expect(gate.admit(e), `events.json ${c.id} [${i}] ${e.eventId} seq ${e.sequence} ${e.kind}`).toBe(e.expect);
      });
    });
  }
});

describe("contract data", () => {
  it("reads afterTerminal kinds and terminal statuses from contract.json", () => {
    expect([...AFTER_TERMINAL_KINDS].sort()).toEqual(["call_answered", "call_ended", "call_missed", "call_ringing", "call_signal", "message", "payment_updated", "rating_updated"]);
    expect(TERMINAL_STATUSES.has("completed")).toBe(true);
    expect(TERMINAL_STATUSES.has("cancelled_by_rider")).toBe(true);
    expect(TERMINAL_STATUSES.has("in_trip")).toBe(false);
  });
});

describe("RealtimeGate details the fixtures do not cover", () => {
  const ev = (eventId: string, sequence: number, kind = "location", status?: string) =>
    status === undefined ? { eventId, tripId: "T", sequence, kind } : { eventId, tripId: "T", sequence, kind, status };

  it("records the id and sequence of a blocked event, as reference_check.py does", () => {
    const gate = new RealtimeGate();
    expect(gate.admit(ev("a", 1, "trip_projection", "completed"))).toBe("accepted");
    expect(gate.terminal).toBe(true);
    expect(gate.admit(ev("b", 2))).toBe("blocked_after_terminal");
    expect(gate.lastSequence).toBe(2);
    expect(gate.admit(ev("b", 9, "message"))).toBe("duplicate");
    expect(gate.admit(ev("c", 2, "message"))).toBe("duplicate");
    expect(gate.admit(ev("d", 3, "message"))).toBe("accepted");
  });

  it("skipping exactly one sequence is a gap (boundary of last + 1)", () => {
    const gate = new RealtimeGate();
    expect(gate.admit(ev("a", 1))).toBe("accepted");
    expect(gate.admit(ev("b", 3))).toBe("accepted_with_gap");
    expect(gate.admit(ev("c", 4))).toBe("accepted");
  });

  it("does not flag a gap on the first event, and flags one after terminal too", () => {
    const gate = new RealtimeGate();
    expect(gate.admit(ev("a", 5, "trip_projection", "no_show"))).toBe("accepted");
    expect(gate.admit(ev("b", 8, "payment_updated"))).toBe("accepted_with_gap");
  });

  it("does not record invalid or duplicate events", () => {
    const gate = new RealtimeGate();
    expect(gate.admit({ eventId: "x", tripId: "", sequence: 1, kind: "location" })).toBe("invalid");
    expect(gate.admit(ev("x", 1))).toBe("accepted");
    expect(gate.admit(ev("y", 1))).toBe("duplicate");
    expect(gate.admit(ev("y", 2))).toBe("accepted");
  });

  it("a terminal status on a blocked event does not change anything", () => {
    const gate = new RealtimeGate();
    expect(gate.admit(ev("a", 1, "trip_projection", "in_trip"))).toBe("accepted");
    expect(gate.terminal).toBe(false);
    expect(gate.admit(ev("b", 2, "trip_projection", "completed"))).toBe("accepted");
    expect(gate.admit(ev("c", 3, "trip_projection", "cancelled_by_admin"))).toBe("blocked_after_terminal");
  });

  it("forgets the oldest event id beyond its limit", () => {
    expect(DEFAULT_SEEN_LIMIT).toBe(512);
    expect(() => new RealtimeGate(0)).toThrow(RangeError);
    const gate = new RealtimeGate(2);
    gate.admit(ev("a", 1));
    gate.admit(ev("b", 2));
    gate.admit(ev("c", 3));
    // "a" was dropped, so only its new sequence decides; "b" is still remembered.
    expect(gate.admit(ev("b", 10))).toBe("duplicate");
    expect(gate.admit(ev("a", 4))).toBe("accepted");
  });
});
