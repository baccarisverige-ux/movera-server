/* global setTimeout, clearTimeout, setImmediate */
// Clocks for the fake phones. realClock drives a live run; VirtualClock runs the same phone code in simulated time
// (the request-budget test: 30 phone-minutes in well under a second).

export const realClock = {
  now: () => Date.now(),
  at(t, fn) {
    return setTimeout(fn, Math.max(0, t - Date.now()));
  },
  cancel(h) {
    clearTimeout(h);
  },
};

export class VirtualClock {
  constructor(start = Date.UTC(2026, 10, 10, 8, 0, 0)) {
    this.t = start;
    this.queue = []; // binary heap of [time, seq, fn]
    this.seq = 0;
    this.cancelled = new Set();
  }
  now() {
    return this.t;
  }
  at(t, fn) {
    const id = ++this.seq;
    const item = [Math.max(t, this.t), id, fn];
    const q = this.queue;
    q.push(item);
    let i = q.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(q[p], q[i])) break;
      [q[p], q[i]] = [q[i], q[p]];
      i = p;
    }
    return id;
  }
  cancel(id) {
    this.cancelled.add(id);
  }
  pop() {
    const q = this.queue;
    const top = q[0];
    const last = q.pop();
    if (q.length) {
      q[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < q.length && less(q[l], q[m])) m = l;
        if (r < q.length && less(q[r], q[m])) m = r;
        if (m === i) break;
        [q[m], q[i]] = [q[i], q[m]];
        i = m;
      }
    }
    return top;
  }
  /** Runs every timer due until `until`, letting each callback's promise chain settle before the next. */
  async run(until) {
    while (this.queue.length && this.queue[0][0] <= until) {
      const [t, id, fn] = this.pop();
      if (this.cancelled.delete(id)) continue;
      this.t = t;
      fn();
      await new Promise((r) => setImmediate(r));
    }
    this.t = until;
  }
}
const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/** Seeded random numbers (mulberry32), so a run is repeatable. */
export function seededRandom(seed = 60) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An exponential wait with the given mean (ms): the gap between Poisson arrivals, or a random dwell time. */
export const expWait = (rng, meanMs) => -Math.log(1 - rng()) * meanMs;

/**
 * Open arrival model: new phones arrive as a Poisson process of `perMinute`, whatever the server does (no closed loop
 * waiting for answers). Calls onArrive(plannedTime) until stop() or `until`.
 */
export function poissonArrivals(clock, rng, perMinute, onArrive, until = Infinity) {
  let handle = null;
  let stopped = perMinute <= 0;
  const next = (from) => {
    const t = from + expWait(rng, 60_000 / perMinute);
    if (stopped || t > until) return;
    handle = clock.at(t, () => {
      onArrive(t);
      next(t);
    });
  };
  next(clock.now());
  return {
    stop() {
      stopped = true;
      if (handle !== null) clock.cancel(handle);
    },
  };
}
