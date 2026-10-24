import { contract } from "../contract/contract.js";

/**
 * Automatic dispatch decisions (contract v0.5.1 §3.6, contract.json#dispatch), as the admin panel's rules
 * describe them (modeNow, rankDrivers, simulate) with owner decisions 10 and 22–24. Pure: no clock, no database.
 * The runtime (dispatch/runtime.ts) feeds it the drivers available at each moment; the tests replay every
 * timeline of fixtures/dispatch.json through the same functions.
 */

export type Mode = "radar" | "exclusive";
export type Then = "widen" | "exclusive" | "widen_then_exclusive" | "radar" | "widen_then_radar";

export type DispatchDoc = {
  zoneId: string;
  timeZone: string;
  radar: { on: boolean; drivers: number; seconds: number; then: Then };
  exclusive: { on: boolean; drivers: number; seconds: number; then: Then };
  choose: { how: "auto" | "manual"; radarAbove: number; main: Mode; backup?: string; times: Array<{ id: string; on: boolean; from: string; to: string; mode: Mode }> };
  radius: { steps: number[]; maxWaitMin: number };
  factors: Array<{ id: string; on: boolean; weight: number }>;
  finishing: { exclusive: boolean; withinMin: number; withinKm: number };
  favourite: { on: boolean; maxKm: number };
  exclusiveWhileDriving: { on: boolean; count: number };
  waiting: Array<{ id: string; kind: string; on: boolean; afterMin: number; message: string; extraMin?: number | null }>;
};

export type Control = { paused: boolean; mode: Mode | null };

type Constants = {
  score: { etaFullMin: number; ratingFloor: number; ratingSpan: number; cancelZeroPct: number; idleFullMin: number; pickupKmh: number; roadFactor: number };
  fallbacks: { rating: number; acceptancePct: number; cancelPct: number };
  skippedWaitingKinds: string[];
};
export const DISPATCH = (contract as unknown as { dispatch: Constants }).dispatch;

const halfUp = (x: number) => Math.floor(x + 0.5);
export const round1 = (x: number) => Math.floor(x * 10 + 0.5) / 10;

/** km between two points as the admin panel measures it: equirectangular × 111.32 × roadFactor, to 0.1 km. */
export function dispatchKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = b.lat - a.lat;
  return round1(Math.sqrt(x * x + y * y) * 111.32 * DISPATCH.score.roadFactor);
}

export function busyOf(waitingRequests: number, freeDrivers: number): number {
  return round1(waitingRequests / Math.max(1, freeDrivers));
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The mode a search starts in, or null when the zone is paused or no mode is on. */
export function startMode(doc: DispatchDoc, control: Control, busy: number, localTime: string): Mode | null {
  if (control.paused) return null;
  if (control.mode) return control.mode;
  const now = minutes(localTime);
  const timed = doc.choose.times.find((r) => {
    if (!r.on || !doc[r.mode].on) return false;
    const a = minutes(r.from);
    const b = minutes(r.to);
    return a < b ? a <= now && now < b : now >= a || now < b;
  });
  if (timed) return timed.mode;
  if (doc.choose.how === "auto" && doc.radar.on && doc.exclusive.on) return busy >= doc.choose.radarAbove ? "radar" : "exclusive";
  if (doc[doc.choose.main].on) return doc.choose.main;
  return doc.radar.on ? "radar" : doc.exclusive.on ? "exclusive" : null;
}

export type Candidate = {
  driverId: string;
  /** dispatchKm to the pickup (for a driver finishing a ride: from their drop-off). */
  km: number;
  rating?: number;
  acceptancePct?: number;
  cancelPct?: number;
  idleMin?: number;
  favourite?: boolean;
  finishing?: { inMin: number; dropKm: number };
  categoryIds?: string[];
};

export type Ranked = { id: string; km: number; score: number; fav: boolean; near: boolean; riding: boolean; out: boolean };

/** rankDrivers: score high to low, then km, then driverId. `out` = may not take this trip at all. */
export function rank(doc: DispatchDoc, candidates: Candidate[], categoryId: string): Ranked[] {
  const sc = DISPATCH.score;
  const fb = DISPATCH.fallbacks;
  const weights = new Map(doc.factors.filter((f) => f.on).map((f) => [f.id, f.weight]));
  const wsum = [...weights.values()].reduce((a, b) => a + b, 0) || 1;
  const steps = doc.radius.steps;
  const rows = candidates.map((d) => {
    const f = d.finishing;
    const near = !!f && doc.finishing.exclusive && weights.has("finishing") && f.inMin <= doc.finishing.withinMin && f.dropKm <= doc.finishing.withinKm;
    const km = f ? f.dropKm : d.km;
    const eta = Math.max(1, halfUp((km / sc.pickupKmh) * 60) + (f ? f.inMin : 0));
    const fav = !!d.favourite && doc.favourite.on && km <= doc.favourite.maxKm;
    const ratios: Record<string, number | null> = {
      eta: 1 - eta / sc.etaFullMin,
      rating: ((d.rating ?? fb.rating) - sc.ratingFloor) / sc.ratingSpan,
      acceptance: (d.acceptancePct ?? fb.acceptancePct) / 100,
      cancel: 1 - (d.cancelPct ?? fb.cancelPct) / sc.cancelZeroPct,
      idle: (d.idleMin ?? 0) / sc.idleFullMin,
      finishing: near ? 1 : null,
      favourite: fav ? 1 : null,
    };
    let score = 0;
    for (const [k, w] of weights) {
      const r = ratios[k];
      if (w && r !== null && r !== undefined) score += halfUp((w / wsum) * 100 * Math.max(0, Math.min(1, r)));
    }
    const out = (!!f && !near) || !(d.categoryIds ?? [categoryId]).includes(categoryId) || km > steps[steps.length - 1]!;
    return { id: d.driverId, km, score, fav: fav && !!weights.get("favourite"), near, riding: !!f, out };
  });
  return rows.sort((a, b) => b.score - a.score || a.km - b.km || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function inRange(doc: DispatchDoc, ranked: Ranked[], mode: Mode, km: number): Ranked[] {
  return ranked.filter((r) => !r.out && r.km <= km && (!r.riding || (mode === "exclusive" && doc.finishing.exclusive && doc.exclusiveWhileDriving.on)));
}

/** Where a search is in its steps (stored per trip by the runtime). */
export type SearchState = { cur: Mode; step: number; tried: number; asked: string[]; switched: Mode[]; repeat: boolean };

export function newSearch(mode: Mode): SearchState {
  return { cur: mode, step: 0, tried: 0, asked: [], switched: [], repeat: false };
}

export type Round =
  | { type: "offer"; kind: Mode; radiusKm: number; driverIds: string[]; reasonCode?: string }
  | { type: "wait"; seconds: number };

const reasonFor = (r: Ranked, ring: Ranked[]) => (r.fav ? "favourite" : r.near ? "finishing-nearby" : r === ring[0] ? "best-match" : "nearby");

/**
 * The next round from the drivers available now (`ranked`). Moves through the steps (`then`) until there is an
 * offer to send, or, once the steps are used up, an offer or a wait (owner decision 22). Returns the new state.
 */
export function planRound(doc: DispatchDoc, input: SearchState, ranked: Ranked[]): { state: SearchState; round: Round } {
  const s: SearchState = { ...input, asked: [...input.asked], switched: [...input.switched] };
  const steps = doc.radius.steps;
  for (let guard = 0; guard < 1000; guard++) {
    if (s.repeat) {
      const km = steps[steps.length - 1]!;
      const ex = inRange(doc, ranked, "exclusive", km);
      const next = ex.find((r) => !s.asked.includes(r.id));
      const shown = inRange(doc, ranked, "radar", km).slice(0, doc.radar.drivers);
      if (doc.exclusive.on && next) {
        s.asked.push(next.id);
        return { state: s, round: { type: "offer", kind: "exclusive", radiusKm: km, driverIds: [next.id], reasonCode: reasonFor(next, ex) } };
      }
      if (doc.radar.on && shown.length) return { state: s, round: { type: "offer", kind: "radar", radiusKm: km, driverIds: shown.map((r) => r.id) } };
      return { state: s, round: { type: "wait", seconds: doc.radar.on ? doc.radar.seconds : doc.exclusive.seconds } };
    }
    const km = steps[s.step]!;
    const ring = inRange(doc, ranked, s.cur, km);
    const widest = s.step === steps.length - 1;
    if (s.cur === "radar") {
      const shown = ring.slice(0, doc.radar.drivers);
      const then = doc.radar.then;
      if ((then === "widen" || then === "widen_then_exclusive") && !widest) s.step += 1;
      else if ((then === "exclusive" || then === "widen_then_exclusive") && doc.exclusive.on && !s.switched.includes("exclusive")) {
        s.switched.push("exclusive");
        s.cur = "exclusive";
        s.tried = 0;
      } else if (!widest) s.step += 1;
      else s.repeat = true;
      if (shown.length) return { state: s, round: { type: "offer", kind: "radar", radiusKm: km, driverIds: shown.map((r) => r.id) } };
      continue;
    }
    const next = ring.find((r) => !s.asked.includes(r.id));
    if (next && s.tried < doc.exclusive.drivers) {
      s.asked.push(next.id);
      s.tried += 1;
      return { state: s, round: { type: "offer", kind: "exclusive", radiusKm: km, driverIds: [next.id], reasonCode: reasonFor(next, ring) } };
    }
    const then = doc.exclusive.then;
    if ((then === "widen" || then === "widen_then_radar") && !widest) {
      s.step += 1;
      s.tried = 0;
    } else if ((then === "radar" || then === "widen_then_radar") && doc.radar.on && !s.switched.includes("radar")) {
      s.switched.push("radar");
      s.cur = "radar";
    } else if (!widest) {
      s.step += 1;
      s.tried = 0;
    } else s.repeat = true;
  }
  throw new Error("dispatch plan did not settle");
}

/** The rider-waiting steps that count (on, not skipped in the test week), by time from search start. */
export function waitingSteps(doc: DispatchDoc) {
  return doc.waiting
    .filter((w) => w.on && !DISPATCH.skippedWaitingKinds.includes(w.kind))
    .map((w) => ({ ...w, atSec: w.afterMin * 60 }))
    .sort((a, b) => a.afterMin - b.afterMin);
}

/** Search end in seconds from start: the first of maxWaitMin and the first busy step. */
export function searchEndSec(doc: DispatchDoc): number {
  return Math.min(doc.radius.maxWaitMin * 60, ...waitingSteps(doc).filter((w) => w.kind === "busy").map((w) => w.atSec));
}
