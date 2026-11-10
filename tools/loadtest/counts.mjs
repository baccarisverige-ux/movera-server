// Measured request counts per app and phone state, compared with the cadence table (global plan step 60 proof:
// "G0 counts = request budgets within 10 %"). A count is filed under the state the phone was in when it SENT.
import { CADENCES, REACTIONS, budgetPerMinute } from "./cadences.mjs";

const quantile = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

export class Counter {
  constructor() {
    this.requests = new Map(); // app|state|id → n
    this.stayMs = new Map(); // app|state → ms
    this.events = new Map(); // app|state|kind → n
    this.status = {};
    this.errors = {}; // app id → status, for every answer that is not 2xx
    this.lagMs = []; // planned send time → actual send (does the TOOL keep up?)
    this.latencyMs = []; // planned send time → answer (open model: includes the tool's own delay)
    this.extra = {}; // refreshes, sign-outs, failed steps …
  }
  request(app, state, id, { status, lagMs = 0, latencyMs = 0, reason } = {}) {
    const k = `${app}|${state}|${id}`;
    this.requests.set(k, (this.requests.get(k) ?? 0) + 1);
    this.status[status] = (this.status[status] ?? 0) + 1;
    if (!(status >= 200 && status < 300)) {
      const e = `${app} ${id} → ${status}${reason ? ` ${reason}` : ""}`;
      this.errors[e] = (this.errors[e] ?? 0) + 1;
    }
    if (this.lagMs.length < 200_000) this.lagMs.push(lagMs);
    if (this.latencyMs.length < 200_000) this.latencyMs.push(latencyMs);
  }
  stay(app, state, ms) {
    const k = `${app}|${state}`;
    this.stayMs.set(k, (this.stayMs.get(k) ?? 0) + ms);
  }
  event(app, state, kind) {
    const k = `${app}|${state}|${kind}`;
    this.events.set(k, (this.events.get(k) ?? 0) + 1);
  }
  bump(name, n = 1) {
    this.extra[name] = (this.extra[name] ?? 0) + n;
  }

  /**
   * Per app and state: phone-minutes, measured requests per phone-minute for every timer entry, the budget from the
   * cadence table and the deviation. A state is gated when it has at least `minPhoneMinutes`.
   */
  report({ tolerance = 0.1, minPhoneMinutes = 5 } = {}) {
    const states = {};
    let pass = true;
    let gated = 0;
    for (const [app, table] of Object.entries(CADENCES)) {
      for (const state of Object.keys(table)) {
        const minutes = (this.stayMs.get(`${app}|${state}`) ?? 0) / 60_000;
        const budget = budgetPerMinute(app, state);
        const endpoints = {};
        let stateOk = true;
        for (const [id, perMin] of Object.entries(budget)) {
          const n = this.requests.get(`${app}|${state}|${id}`) ?? 0;
          const measured = minutes > 0 ? n / minutes : 0;
          const deviation = perMin > 0 ? (measured - perMin) / perMin : 0;
          const within = Math.abs(deviation) <= tolerance;
          if (!within) stateOk = false;
          endpoints[id] = { count: n, perMinute: round2(measured), budgetPerMinute: round2(perMin), deviationPct: round1(deviation * 100), within };
        }
        const isGated = minutes >= minPhoneMinutes;
        if (isGated) {
          gated++;
          if (!stateOk) pass = false;
        }
        const totalBudget = Object.values(budget).reduce((s, x) => s + x, 0);
        const totalMeasured = Object.keys(budget).reduce((s, id) => s + (this.requests.get(`${app}|${state}|${id}`) ?? 0), 0);
        states[`${app}.${state}`] = { phoneMinutes: round2(minutes), gated: isGated, within: stateOk, budgetPerMinute: round2(totalBudget), perMinute: round2(minutes > 0 ? totalMeasured / minutes : 0), endpoints };
      }
    }
    // Event reactions: requests per event (the app's 2 GETs per hint). The driver hint is capped at one per 2 s.
    const reactions = {};
    for (const [app, kinds] of Object.entries(REACTIONS)) {
      for (const [kind, rule] of Object.entries(kinds)) {
        let events = 0;
        for (const [k, n] of this.events) if (k.startsWith(`${app}|`) && k.endsWith(`|${kind}`)) events += n;
        let sent = 0;
        for (const [k, n] of this.requests) if (k.startsWith(`${app}|`) && k.split("|")[2].startsWith("reaction ")) sent += n;
        reactions[`${app}.${kind}`] = { events, requests: sent, perEvent: events ? round2(sent / events) : null, budgetPerEvent: rule.perEvent, capSeconds: rule.minGapSeconds };
      }
    }
    // Everything else the phones sent (on-enter reads, bookings, accepts, trip steps, refresh) per app and state.
    const other = {};
    for (const [k, n] of this.requests) {
      const [app, state, id] = k.split("|");
      if (budgetPerMinute(app, state)[id] !== undefined || id.startsWith("reaction ")) continue;
      (other[`${app}.${state}`] ??= {})[id] = n;
    }
    return {
      pass: pass && gated > 0,
      tolerancePct: tolerance * 100,
      minPhoneMinutes,
      gatedStates: gated,
      states,
      reactions,
      other,
      status: this.status,
      errors: this.errors,
      toolLagMs: { p50: quantile(this.lagMs, 50), p95: quantile(this.lagMs, 95), max: quantile(this.lagMs, 100) },
      latencyFromPlannedMs: { p50: quantile(this.latencyMs, 50), p95: quantile(this.latencyMs, 95) },
      extra: this.extra,
    };
  }
}
const round2 = (x) => Math.round(x * 100) / 100;
const round1 = (x) => Math.round(x * 10) / 10;

/** One line per gated state, for the console. */
export function summaryLines(report) {
  const lines = [];
  for (const [name, s] of Object.entries(report.states)) {
    if (s.phoneMinutes === 0) continue;
    const worst = Object.values(s.endpoints).reduce((m, e) => Math.max(m, Math.abs(e.deviationPct)), 0);
    lines.push(`${name.padEnd(20)} ${String(s.phoneMinutes).padStart(8)} phone-min  ${String(s.perMinute).padStart(6)} req/min  budget ${String(s.budgetPerMinute).padStart(6)}  worst ${worst}%  ${s.gated ? (s.within ? "OK" : "OUT") : "(too short to gate)"}`);
  }
  return lines;
}
