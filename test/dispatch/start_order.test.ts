import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import { newSearch, planRound, rank, startMode, startOf, stepsOf, type Candidate, type DispatchDoc } from "../../src/dispatch/engine.js";

/** v0.18.9 (owner 2026-11-01, rule 16): per-zone start / order / distances. Defaults keep the behaviour before. */
const base = contractJson<DispatchDoc>("fixtures/config/dispatch_document.json");
const zones: Array<[string, DispatchDoc]> = [
  ["SE", base],
  ["FR", { ...base, zoneId: "FR-PAR", timeZone: "Europe/Paris" }],
];
const free = { paused: false, mode: null };
const drivers = (...km: number[]): Candidate[] => km.map((k, i) => ({ driverId: `D${i + 1}`, km: k, rating: 4.7 - i * 0.01 }));
const with_ = (doc: DispatchDoc, extra: Partial<DispatchDoc>): DispatchDoc => ({ ...doc, ...extra });

describe.each(zones)("dispatch start & order (%s)", (_country, doc) => {
  it("missing start = auto as before (calm → exclusive, busy → radar)", () => {
    expect(startMode(doc, free, 0.5, "12:00")).toBe("exclusive");
    expect(startMode(doc, free, 2, "12:00")).toBe("radar");
    expect(startOf(with_(doc, { start: { mode: "auto" } }), free, 2, "12:00")).toEqual({ mode: "radar" });
  });

  it("start radar / exclusive picks that mode even when busy says otherwise; control and time rules still win", () => {
    expect(startMode(with_(doc, { start: { mode: "exclusive" } }), free, 5, "12:00")).toBe("exclusive");
    expect(startMode(with_(doc, { start: { mode: "radar" } }), free, 0.1, "12:00")).toBe("radar");
    expect(startMode(with_(doc, { start: { mode: "radar" } }), { paused: false, mode: "exclusive" }, 0.1, "12:00")).toBe("exclusive");
    const timed = with_(doc, { start: { mode: "exclusive" }, choose: { ...doc.choose, times: [{ id: "t1", on: true, from: "22:00", to: "04:00", mode: "radar" }] } });
    expect(startMode(timed, free, 0.1, "23:00")).toBe("radar");
    expect(startMode(timed, free, 0.1, "12:00")).toBe("exclusive");
    expect(startOf(with_(doc, { start: { mode: "both" } }), { paused: true, mode: null }, 0, "12:00")).toBeNull();
  });

  it("byDistance: nearest within nearKm → Exclusive first, else Radar first", () => {
    const d = with_(doc, { start: { mode: "byDistance", nearKm: 2 } });
    const s = startOf(d, free, 0, "12:00")!;
    expect(s.pending).toBe("byDistance");
    const near = planRound(d, newSearch(s.mode, s.pending), rank(d, drivers(1.5, 2.5), "economy"));
    expect(near.round).toMatchObject({ type: "offer", kind: "exclusive", driverIds: ["D1"] });
    const far = planRound(d, newSearch(s.mode, s.pending), rank(d, drivers(2.6, 2.9), "economy"));
    expect(far.round).toMatchObject({ type: "offer", kind: "radar", driverIds: ["D1", "D2"] });
  });

  it("both: Exclusive to the best and Radar to the next radar.drivers at once (best left out)", () => {
    const d = with_(doc, { start: { mode: "both" }, radar: { ...doc.radar, drivers: 2 } });
    const s = startOf(d, free, 0, "12:00")!;
    const { round, state } = planRound(d, newSearch(s.mode, s.pending), rank(d, drivers(1, 1.5, 2, 2.5), "economy"));
    expect(round).toMatchObject({ type: "offer", kind: "exclusive", driverIds: ["D1"], alsoRadar: { radiusKm: 3, driverIds: ["D2", "D3"] } });
    expect(state).toMatchObject({ cur: "exclusive", asked: ["D1"], tried: 1 });
    expect(state.pending).toBeUndefined();
    // Both needs both modes on: with Radar off it starts as auto would.
    expect(startOf(with_(d, { radar: { ...d.radar, on: false } }), free, 0, "12:00")).toEqual({ mode: "exclusive" });
  });

  it("per-mode steps: exclusive.steps used by Exclusive, missing → radius.steps", () => {
    const d = with_(doc, { start: { mode: "exclusive" }, exclusive: { ...doc.exclusive, steps: [1, 2] } });
    expect(stepsOf(d, "exclusive")).toEqual([1, 2]);
    expect(stepsOf(d, "radar")).toEqual(doc.radius.steps);
    const r = planRound(d, newSearch("exclusive"), rank(d, drivers(1.8), "economy"));
    // Step 1 (1 km) has nobody: widen to 2 km and offer.
    expect(r.round).toMatchObject({ kind: "exclusive", radiusKm: 2, driverIds: ["D1"] });
  });

  it("limits: maxPickupKm and maxPickupEtaMin keep far drivers out; 0 = off", () => {
    const d = with_(doc, { limits: { maxPickupKm: 4, maxPickupEtaMin: 0 } });
    expect(rank(d, drivers(3.5, 4.5), "economy").map((r) => r.out)).toEqual([false, true]);
    const eta = with_(doc, { limits: { maxPickupEtaMin: 5 } });
    // 24 km/h: 2 km = 5 min, 2.4 km = 6 min.
    expect(rank(eta, drivers(2, 2.4), "economy").map((r) => r.out)).toEqual([false, true]);
  });

  it("neighbours: drivers of neighbour zones only from afterStep", () => {
    const d = with_(doc, { start: { mode: "radar" }, neighbours: { on: true, zoneIds: ["Z002"], afterStep: 2 } });
    const pool: Candidate[] = [{ driverId: "N1", km: 1, neighbour: true }, { driverId: "D1", km: 4 }];
    const r1 = planRound(d, newSearch("radar"), rank(d, pool, "economy"));
    // Step 1 (3 km): the neighbour is not asked yet and nobody of the zone is in range; step 2 (5 km): both.
    expect(r1.round).toMatchObject({ kind: "radar", radiusKm: 5 });
    expect((r1.round as { driverIds: string[] }).driverIds.sort()).toEqual(["D1", "N1"]);
    const off = with_(d, { neighbours: { on: false, zoneIds: ["Z002"] } });
    expect(planRound(off, newSearch("radar"), rank(off, pool, "economy")).round).toMatchObject({ kind: "radar", radiusKm: 5, driverIds: ["D1"] });
  });
});
