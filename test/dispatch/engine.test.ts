import { describe, expect, it } from "vitest";
import { contractJson } from "../../src/contract/contract.js";
import { busyOf, newSearch, planRound, rank, searchEndSec, startMode, waitingSteps, type Candidate, type Control, type DispatchDoc } from "../../src/dispatch/engine.js";

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
