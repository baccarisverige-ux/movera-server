import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import { busyOf, certainWait, newSearch, planRound, rank, searchEndSec, startMode, waitingSteps, type Candidate, type Control, type DispatchDoc, type Mode, type Ranked, type SearchState, type Then } from "../../src/dispatch/engine.js";

type Case = {
  id: string;
  control?: Control;
  localTime: string;
  waitingRequests: number;
  freeDrivers: number;
  categoryId: string;
  drivers: Array<Candidate & { freeFromSec?: number }>;
  offerAnswers?: Array<{ driverId: string; nth?: number; answer: "accept" | "decline"; afterSec: number }>;
  riderAnswers?: Array<{ stepId: string; atSec: number; answer: "wait" | "stop" }>;
  expect: unknown;
};
const fixture = contractJson<{ version: string; cases: Case[] }>("fixtures/dispatch.json");
const doc = contractJson<DispatchDoc>("fixtures/config/dispatch_document.json");

/**
 * Replays one search with the engine, the way the runtime drives it: plan a round from the drivers free at t, send
 * it, wait for the answers or the expiry, fire rider-waiting steps on time. A test-side world stands in for drivers.
 */
function simulate(c: Case) {
  const busy = busyOf(c.waitingRequests, c.freeDrivers);
  const mode = startMode(doc, c.control ?? { paused: false, mode: null }, busy, c.localTime);
  const waits = waitingSteps(doc).map((w) => ({ ...w }));
  const S = { end: searchEndSec(doc), outcome: null as null | [string, number, string | null], fired: [] as Array<{ id: string; kind: string; atSec: number }>, done: new Set<unknown>() };
  const answers = c.riderAnswers ?? [];
  const runUntil = (upto: number) => {
    while (S.outcome === null) {
      const fired = new Set(S.fired.map((f) => f.id));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous simulation items
      const items: Array<[number, number, any]> = [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous simulation items
        ...waits.filter((w) => !S.done.has(w.id)).map((w) => [w.atSec, 0, w] as [number, number, any]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous simulation items
        ...answers.filter((a) => fired.has(a.stepId) && !S.done.has(a)).map((a) => [a.atSec, 1, a] as [number, number, any]),
      ];
      if (items.length === 0) return;
      const [at, kind, it] = items.reduce((m, x) => (x[0] < m[0] || (x[0] === m[0] && x[1] < m[1]) ? x : m));
      if (at > upto || at > S.end) return;
      if (kind === 0) {
        S.done.add(it.id);
        S.fired.push({ id: it.id, kind: it.kind, atSec: at });
        if (it.kind === "busy") S.end = at;
      } else {
        S.done.add(it);
        if (it.answer === "stop") {
          S.outcome = ["cancelled_by_rider", at, null];
          S.end = at;
        } else {
          S.end += (waits.find((w) => w.id === it.stepId)!.extraMin ?? 0) * 60;
          for (const w of waits) if (w.kind === "busy" && !S.done.has(w.id)) w.atSec = Math.max(w.atSec, S.end);
        }
      }
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous simulation items
  const offers: any[] = [];
  const nth = new Map<string, number>();
  const sendOffer = (kind: "radar" | "exclusive", t: number, km: number, ids: string[], reason?: string) => {
    const exp = Math.min(t + doc[kind].seconds, S.end);
    offers.push({ atSec: t, kind, radiusKm: km, driverIds: ids, expiresAtSec: exp, ...(reason ? { reasonCode: reason } : {}) });
    let won: [number, string] | null = null;
    const declined = new Map<string, number>();
    for (const id of ids) {
      nth.set(id, (nth.get(id) ?? 0) + 1);
      for (const a of c.offerAnswers ?? []) {
        const at = t + a.afterSec;
        if (a.driverId === id && (a.nth ?? 1) === nth.get(id) && at < exp) {
          if (a.answer === "accept" && (won === null || at < won[0])) won = [at, id];
          if (a.answer === "decline") declined.set(id, at);
        }
      }
    }
    if (won) {
      runUntil(won[0]);
      if (S.outcome === null) S.outcome = ["accepted", won[0], won[1]];
      return won[0];
    }
    const next = declined.size === ids.length ? Math.max(...declined.values()) : exp;
    runUntil(next);
    return next;
  };
  let t = 0;
  let state = mode ? newSearch(mode) : null;
  while (state) {
    runUntil(t);
    if (S.outcome || t >= S.end) break;
    const available = c.drivers.filter((d) => (d.freeFromSec ?? 0) <= t);
    const planned = planRound(doc, state, rank(doc, available, c.categoryId));
    state = planned.state;
    if (planned.round.type === "wait") t += planned.round.seconds;
    else t = sendOffer(planned.round.kind, t, planned.round.radiusKm, planned.round.driverIds, planned.round.reasonCode);
  }
  runUntil(S.end);
  const [outcome, at, who] = S.outcome ?? ["expired", S.end, null];
  return { busy, mode, offers, searchSteps: S.fired, end: { atSec: at, outcome, ...(who ? { driverId: who } : {}) } };
}

describe("automatic dispatch (contract fixtures/dispatch.json)", () => {
  it("has the 8 timelines of contract v0.5.1", () => {
    expect(fixture.version).toBe("0.5.1");
    expect(fixture.cases).toHaveLength(8);
  });
  it.each(fixture.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    expect(simulate(c)).toEqual(c.expect);
  });
});

/**
 * B1.29 (S4-W1 Q89, owner "A) Yes": no behaviour change): the round facts (open offers, papers, driving limit, score,
 * blocks, category off) can only REMOVE drivers. certainWait plans on a superset of the real pool; when it answers
 * "wait", every subset (whatever the facts remove, in any order) must give exactly the same wait and state.
 */
describe("B1.29 certainWait", () => {
  it("B1.29: certainWait on a superset equals planRound on any subset", () => {
    let seed = 1291;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const thens: Then[] = ["widen", "exclusive", "widen_then_exclusive", "radar", "widen_then_radar"];
    let certain = 0;
    let checked = 0;
    for (let n = 0; n < 4000; n++) {
      const radarOn = rnd() < 0.6;
      const exclusiveOn = !radarOn || rnd() < 0.7;
      const d: DispatchDoc = {
        ...doc,
        radar: { ...doc.radar, on: radarOn, drivers: 1 + Math.floor(rnd() * 4), then: pick(thens) },
        exclusive: { ...doc.exclusive, on: exclusiveOn, drivers: 1 + Math.floor(rnd() * 3), then: pick(thens), ...(rnd() < 0.3 ? { reaskAfterSeconds: 20 } : {}) },
        radius: { ...doc.radius, steps: rnd() < 0.5 ? [3, 5, 8] : [2, 4] },
        ...(rnd() < 0.3 ? { neighbours: { on: true, zoneIds: ["Z002"], afterStep: 1 + Math.floor(rnd() * 3) } } : {}),
      };
      const modes: Mode[] = [...(radarOn ? (["radar"] as const) : []), ...(exclusiveOn ? (["exclusive"] as const) : [])];
      const ids = Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => `drv_${i}`);
      const superset: Ranked[] = ids.map((id) => ({
        id,
        km: Math.round(rnd() * 120) / 10,
        score: Math.floor(rnd() * 100),
        fav: false,
        near: rnd() < 0.1,
        riding: rnd() < 0.15,
        out: rnd() < 0.25,
        ...(rnd() < 0.2 ? { neighbour: true } : {}),
        ...(rnd() < 0.1 ? { bookedNext: true } : {}),
      }));
      const state: SearchState = {
        cur: pick(modes),
        step: Math.floor(rnd() * 4),
        tried: Math.floor(rnd() * 4),
        asked: ids.filter(() => rnd() < 0.5),
        switched: modes.filter(() => rnd() < 0.3),
        repeat: rnd() < 0.6,
        ...(rnd() < 0.3 ? { again: true } : {}),
        ...(rnd() < 0.3 ? { far: true } : {}),
      };
      const sure = certainWait(d, state, superset);
      if (sure === null) continue;
      certain++;
      expect(sure.round.type).toBe("wait");
      for (let k = 0; k < 6; k++) {
        const subset = superset.filter(() => rnd() < 0.5).sort(() => rnd() - 0.5);
        expect(planRound(d, state, subset)).toEqual(sure);
        checked++;
      }
    }
    // The property is only worth something if many states were really sure waits.
    expect(certain).toBeGreaterThan(200);
    expect(checked).toBe(certain * 6);
  });

  it("B1.29: a pending start, or Radar off with someone in the Exclusive ring, is never a sure wait", () => {
    const one: Ranked = { id: "drv_1", km: 1, score: 50, fav: false, near: false, riding: false, out: false };
    const offRadar: DispatchDoc = { ...doc, radar: { ...doc.radar, on: false }, exclusive: { ...doc.exclusive, on: true } };
    // Asked already, Radar off: today a wait that sets `again` — a subset without him waits WITHOUT `again`.
    expect(certainWait(offRadar, { ...newSearch("exclusive"), repeat: true, asked: ["drv_1"] }, [one])).toBeNull();
    expect(certainWait(doc, newSearch("exclusive", "byDistance"), [])).toBeNull();
    expect(certainWait(doc, newSearch("exclusive", "both"), [])).toBeNull();
    // Nobody in reach at all: the wait is sure.
    expect(certainWait(doc, { ...newSearch("radar"), repeat: true }, [])).toEqual(planRound(doc, { ...newSearch("radar"), repeat: true }, []));
  });
});
