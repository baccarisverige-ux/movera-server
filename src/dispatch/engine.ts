import { contract } from "../contract/contract.js";

/**
 * Automatic dispatch decisions (contract v0.5.1 §3.6, contract.json#dispatch), as the admin panel's rules
 * describe them (modeNow, rankDrivers, simulate) with owner decisions 10 and 22–24. Pure: no clock, no database.
 * The runtime (dispatch/runtime.ts) feeds it the drivers available at each moment; the tests replay every
 * timeline of fixtures/dispatch.json through the same functions.
 */

export type Mode = "radar" | "exclusive";
export type Then = "widen" | "exclusive" | "widen_then_exclusive" | "radar" | "widen_then_radar";

export type StartChoice = "auto" | "radar" | "exclusive" | "both" | "byDistance";

export type DispatchDoc = {
  zoneId: string;
  timeZone: string;
  radar: { on: boolean; drivers: number; seconds: number; then: Then; steps?: number[] };
  exclusive: { on: boolean; drivers: number; seconds: number; then: Then; steps?: number[] };
  /** v0.18.9 (owner 2026-11-01, rule 16): which offer goes out first; missing = auto (choose decides, as before). */
  start?: { mode: StartChoice; nearKm?: number };
  /** v0.18.9: farthest pickup (km, missing = widest step) and longest pickup ETA (min, 0 / missing = off). */
  limits?: { maxPickupKm?: number; maxPickupEtaMin?: number };
  /** v0.18.11: drivers of these zones are candidates too from search step afterStep (1-based, missing = last step). */
  neighbours?: { on: boolean; zoneIds: string[]; afterStep?: number };
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
  return startOf(doc, control, busy, localTime)?.mode ?? null;
}

/**
 * v0.18.9: the start of a search. `pending` = "both" or "byDistance" is decided on the first round, when the drivers
 * are known (planRound). Paused, a forced mode and an on time rule still win over start.mode.
 */
export function startOf(doc: DispatchDoc, control: Control, busy: number, localTime: string): { mode: Mode; pending?: "both" | "byDistance" } | null {
  if (control.paused) return null;
  if (control.mode) return { mode: control.mode };
  const timed = timeRule(doc, localTime);
  if (timed) return { mode: timed };
  const choice = doc.start?.mode ?? "auto";
  if ((choice === "radar" || choice === "exclusive") && doc[choice].on) return { mode: choice };
  if ((choice === "both" || choice === "byDistance") && doc.radar.on && doc.exclusive.on) return { mode: "exclusive", pending: choice };
  const mode = chooseMode(doc, busy);
  return mode ? { mode } : null;
}

function timeRule(doc: DispatchDoc, localTime: string): Mode | null {
  const now = minutes(localTime);
  const timed = doc.choose.times.find((r) => {
    if (!r.on || !doc[r.mode].on) return false;
    const a = minutes(r.from);
    const b = minutes(r.to);
    return a < b ? a <= now && now < b : now >= a || now < b;
  });
  return timed ? timed.mode : null;
}

function chooseMode(doc: DispatchDoc, busy: number): Mode | null {
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
  /** v0.18.11: a driver of a neighbour zone (doc.neighbours), asked only from neighbours.afterStep. */
  neighbour?: boolean;
};

export type Ranked = { id: string; km: number; score: number; fav: boolean; near: boolean; riding: boolean; out: boolean; neighbour?: boolean };

/** v0.18.9: a mode's own search steps (radar.steps / exclusive.steps), else the shared radius.steps. */
export function stepsOf(doc: DispatchDoc, mode: Mode): number[] {
  const own = doc[mode].steps;
  return own && own.length ? own : doc.radius.steps;
}

/** Number of search steps: the longest list of a mode that is on. */
function stepCount(doc: DispatchDoc): number {
  return Math.max(doc.radar.on ? stepsOf(doc, "radar").length : 0, doc.exclusive.on ? stepsOf(doc, "exclusive").length : 0, 1);
}

const kmAt = (doc: DispatchDoc, mode: Mode, step: number) => {
  const steps = stepsOf(doc, mode);
  return steps[Math.min(step, steps.length - 1)]!;
};

/** The farthest pickup any offer may go to: limits.maxPickupKm, else the widest step of the modes. */
function maxPickupKm(doc: DispatchDoc): number {
  const widest = Math.max(...stepsOf(doc, "radar"), ...stepsOf(doc, "exclusive"));
  const limit = doc.limits?.maxPickupKm;
  return typeof limit === "number" && limit > 0 ? Math.min(limit, widest) : widest;
}

/**
 * Admin Add money (owner rule 16): the farthest pickup an immediate send of `mode` may go to — the widest of the
 * mode's own steps (radar.steps / exclusive.steps, else radius.steps), capped by limits.maxPickupKm and by
 * limits.maxPickupEtaMin (km at the dispatch's pickup speed, same approximation as rank).
 */
export function addMoneyReachKm(doc: DispatchDoc | null | undefined, mode: Mode): number {
  if (!doc) return 5;
  const steps = stepsOf(doc, mode) ?? [];
  let km = steps.length ? Math.max(...steps) : 5;
  const limit = doc.limits?.maxPickupKm;
  if (typeof limit === "number" && limit > 0) km = Math.min(km, limit);
  const eta = doc.limits?.maxPickupEtaMin;
  if (typeof eta === "number" && eta > 0) km = Math.min(km, (eta * DISPATCH.score.pickupKmh) / 60);
  return km;
}

/** rankDrivers: score high to low, then km, then driverId. `out` = may not take this trip at all. */
export function rank(doc: DispatchDoc, candidates: Candidate[], categoryId: string): Ranked[] {
  const sc = DISPATCH.score;
  const fb = DISPATCH.fallbacks;
  const weights = new Map(doc.factors.filter((f) => f.on).map((f) => [f.id, f.weight]));
  const wsum = [...weights.values()].reduce((a, b) => a + b, 0) || 1;
  const maxKm = maxPickupKm(doc);
  const maxEta = doc.limits?.maxPickupEtaMin ?? 0;
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
    const out = (!!f && !near) || !(d.categoryIds ?? [categoryId]).includes(categoryId) || km > maxKm || (maxEta > 0 && eta > maxEta);
    return { id: d.driverId, km, score, fav: fav && !!weights.get("favourite"), near, riding: !!f, out, ...(d.neighbour ? { neighbour: true } : {}) };
  });
  return rows.sort((a, b) => b.score - a.score || a.km - b.km || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function inRange(doc: DispatchDoc, ranked: Ranked[], mode: Mode, km: number, step = Number.MAX_SAFE_INTEGER): Ranked[] {
  const n = doc.neighbours;
  const neighboursFrom = n?.on ? Math.max(1, n.afterStep ?? stepCount(doc)) - 1 : Number.MAX_SAFE_INTEGER;
  return ranked.filter((r) => !r.out && r.km <= km && (!r.neighbour || step >= neighboursFrom) && (!r.riding || (mode === "exclusive" && doc.finishing.exclusive && doc.exclusiveWhileDriving.on)));
}

/** Where a search is in its steps (stored per trip by the runtime). */
export type SearchState = { cur: Mode; step: number; tried: number; asked: string[]; switched: Mode[]; repeat: boolean; pending?: "both" | "byDistance" };

export function newSearch(mode: Mode, pending?: "both" | "byDistance"): SearchState {
  return { cur: mode, step: 0, tried: 0, asked: [], switched: [], repeat: false, ...(pending ? { pending } : {}) };
}

export type Round =
  | { type: "offer"; kind: Mode; radiusKm: number; driverIds: string[]; reasonCode?: string; alsoRadar?: { radiusKm: number; driverIds: string[] } }
  | { type: "wait"; seconds: number };

const reasonFor = (r: Ranked, ring: Ranked[]) => (r.fav ? "favourite" : r.near ? "finishing-nearby" : r === ring[0] ? "best-match" : "nearby");

/**
 * The next round from the drivers available now (`ranked`). Moves through the steps (`then`) until there is an
 * offer to send, or, once the steps are used up, an offer or a wait (owner decision 22). Returns the new state.
 */
export function planRound(doc: DispatchDoc, input: SearchState, ranked: Ranked[]): { state: SearchState; round: Round } {
  const s: SearchState = { ...input, asked: [...input.asked], switched: [...input.switched] };
  const last = stepCount(doc) - 1;
  const pending = s.pending;
  delete s.pending;
  if (pending === "byDistance") {
    // v0.18.9: the NEAREST eligible not-yet-asked driver (smallest km, not the top score) within start.nearKm →
    // Exclusive first, else Radar first.
    const nearKm = doc.start?.nearKm ?? 2;
    const nearest = inRange(doc, ranked, "exclusive", kmAt(doc, "exclusive", 0), 0)
      .filter((r) => !s.asked.includes(r.id))
      .reduce<Ranked | undefined>((m, r) => (!m || r.km < m.km ? r : m), undefined);
    s.cur = nearest && nearest.km <= nearKm ? "exclusive" : "radar";
  } else if (pending === "both") {
    // v0.18.9: Exclusive to the best driver and, at the same moment, Radar to the next radar.drivers (best left out).
    const exKm = kmAt(doc, "exclusive", 0);
    const ex = inRange(doc, ranked, "exclusive", exKm, 0);
    const best = ex.find((r) => !s.asked.includes(r.id));
    if (best) {
      const rKm = kmAt(doc, "radar", 0);
      const shown = inRange(doc, ranked, "radar", rKm, 0).filter((r) => r.id !== best.id).slice(0, doc.radar.drivers);
      s.asked.push(best.id);
      s.tried = 1;
      s.cur = "exclusive";
      const round: Round = { type: "offer", kind: "exclusive", radiusKm: exKm, driverIds: [best.id], reasonCode: reasonFor(best, ex) };
      if (shown.length) round.alsoRadar = { radiusKm: rKm, driverIds: shown.map((r) => r.id) };
      return { state: s, round };
    }
    s.cur = "radar";
  }
  for (let guard = 0; guard < 1000; guard++) {
    if (s.repeat) {
      const ex = inRange(doc, ranked, "exclusive", kmAt(doc, "exclusive", last));
      const next = ex.find((r) => !s.asked.includes(r.id));
      const rKm = kmAt(doc, "radar", last);
      const shown = inRange(doc, ranked, "radar", rKm).slice(0, doc.radar.drivers);
      if (doc.exclusive.on && next) {
        s.asked.push(next.id);
        return { state: s, round: { type: "offer", kind: "exclusive", radiusKm: kmAt(doc, "exclusive", last), driverIds: [next.id], reasonCode: reasonFor(next, ex) } };
      }
      if (doc.radar.on && shown.length) return { state: s, round: { type: "offer", kind: "radar", radiusKm: rKm, driverIds: shown.map((r) => r.id) } };
      return { state: s, round: { type: "wait", seconds: doc.radar.on ? doc.radar.seconds : doc.exclusive.seconds } };
    }
    const km = kmAt(doc, s.cur, s.step);
    const ring = inRange(doc, ranked, s.cur, km, s.step);
    const widest = s.step >= last;
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
