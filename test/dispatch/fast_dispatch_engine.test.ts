import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import { newSearch, planRound, rank, type DispatchDoc, type SearchState } from "../../src/dispatch/engine.js";

/** Job 1 (owner Q1 2026-11-04 YES, BL M6-e, fix plan R26): drivers who said no are asked again in a later round. */
const base = contractJson<DispatchDoc>("fixtures/config/dispatch_document.json");
const exclusiveOnly: DispatchDoc = { ...base, radar: { ...base.radar, on: false }, exclusive: { ...base.exclusive, on: true, then: "widen" } };
const drivers = rank(exclusiveOnly, [{ driverId: "d1", km: 0.5 }, { driverId: "d2", km: 1.0 }], "economy");

describe("re-asking decliners (R26)", () => {
  it("with Radar off, after every driver in range said no, one wait, then the best one is asked again", () => {
    let state: SearchState = newSearch("exclusive");
    const kinds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { state: next, round } = planRound(exclusiveOnly, state, drivers);
      state = next;
      kinds.push(round.type === "offer" ? `${round.kind}:${round.driverIds.join(",")}` : "wait");
    }
    // d1 and d2 each asked once, then a wait, then d1 again (a new cycle) — before Job 1 it was "wait" for ever.
    const firstWait = kinds.indexOf("wait");
    expect(kinds.slice(0, firstWait).sort()).toEqual(["exclusive:d1", "exclusive:d2"]);
    expect(kinds[firstWait + 1]).toBe("exclusive:d1");
    expect(kinds.filter((k) => k === "exclusive:d1").length).toBeGreaterThanOrEqual(2);
  });

  it("with Radar on, nothing changes: decliners see the trip again as Radar", () => {
    let state: SearchState = newSearch("exclusive");
    const doc: DispatchDoc = { ...base, radar: { ...base.radar, on: true } };
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { state: next, round } = planRound(doc, state, rank(doc, [{ driverId: "d1", km: 0.5 }], "economy"));
      state = next;
      seen.push(round.type === "offer" ? round.kind : "wait");
    }
    expect(seen.filter((k) => k === "exclusive").length).toBe(1);
    expect(seen).toContain("radar");
  });
});
