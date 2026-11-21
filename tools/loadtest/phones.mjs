// Fake rider and driver phones (global plan step 60, T1 part 2). Each phone is a small state machine that sends what
// the real app sends in that state, at the app's cadence (cadences.mjs), reacts to stream events like the app, and
// refreshes its access token like the app (a 401 → one POST /auth/refresh → the request again; apps: rider
// lib/core/api/api_client.dart:235, driver lib/core/api/api_client.dart:87-99). Clock and transport are injected, so the
// same code runs live (phone-load.mjs) and in simulated time (simulate.mjs, the request-budget test). The cadence table
// is per phone (option `cadence`, default the "old" table; LOADTEST_CADENCE=real picks the S4e table, cadences.mjs).
import { CADENCE_TABLES } from "./cadences.mjs";
import { expWait } from "./clock.mjs";
import { near } from "./zones.mjs";

/** Access + refresh token of one phone. One refresh at a time; a lost answer is sent again at once (contract §71). */
export class Auth {
  static keys = 0;
  constructor({ access, refresh, transport, counter, app }) {
    Object.assign(this, { access, refresh, transport, counter, app, inflight: null, dead: false });
  }
  async call(method, path, body, onSent) {
    const key = method === "GET" ? undefined : `load-${this.app}-${String(++Auth.keys).padStart(8, "0")}-${Math.floor(Math.random() * 1e9)}`; // 16–128 chars
    let r = await this.transport.request(method, path, body, this.access, key);
    onSent?.(r);
    if (r.status === 401 && !this.dead) {
      if (await this.refreshOnce()) {
        r = await this.transport.request(method, path, body, this.access, key);
        onSent?.(r);
        if (r.status === 401) this.counter.bump(`${this.app}.false401AfterRefresh`);
      }
    }
    return r;
  }
  refreshOnce() {
    this.inflight ??= (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await this.transport.request("POST", "/auth/refresh", { refreshToken: this.refresh }, null);
        this.counter.bump(`${this.app}.refresh`);
        if (r.status === 200 && r.json?.accessToken) {
          this.access = r.json.accessToken;
          this.refresh = r.json.refreshToken ?? this.refresh;
          return true;
        }
        if (r.status !== 0 && r.status < 500) break; // 400 / 401 / 403: the session is over (the app signs out)
        this.counter.bump(`${this.app}.refreshLostAnswer`);
      }
      this.dead = true;
      this.counter.bump(`${this.app}.signedOut`);
      return false;
    })().finally(() => (this.inflight = null));
    return this.inflight;
  }
}

const timerKey = (e) => e.timer ?? e.id;

/** What both phones share: state, timers that survive a state change when the next state has the same entry. */
class Phone {
  constructor(app, o) {
    Object.assign(this, { app, ...o });
    this.table = o.cadence ?? CADENCE_TABLES.old;
    this.state = null;
    this.since = 0;
    this.timers = new Map(); // entry id → { handle, every }
    this.streams = new Map(); // name → { close }
    this.lastReaction = new Map(); // reaction kind → last time (each hint has its own gap)
    this.gone = false;
    this.zone = o.zone;
    this.pos = near(o.zone, o.rng);
  }
  get ctx() {
    return { lat: this.pos.lat, lng: this.pos.lng, tripId: this.tripId, toLat: this.target?.lat ?? this.pos.lat, toLng: this.target?.lng ?? this.pos.lng };
  }
  enter(state) {
    if (this.gone) return;
    const now = this.clock.now();
    if (this.state) this.counter.stay(this.app, this.state, now - this.since);
    this.state = state;
    this.since = now;
    const entries = state ? (this.table.cadences[this.app][state] ?? []) : [];
    const keep = new Set(entries.map(timerKey));
    for (const [key, t] of this.timers) {
      if (keep.has(key)) continue;
      this.clock.cancel(t.handle);
      this.timers.delete(key);
    }
    for (const e of entries) if (!this.timers.has(timerKey(e))) this.startTimer(e, now);
    for (const e of this.table.onEnter[this.app][state] ?? []) void this.send(e.id, e.method, typeof e.path === "function" ? e.path(this.ctx) : e.path, this.bodyFor(e));
    this.onEnter?.(state);
  }
  /** App Timer.periodic: the first tick one period after start. Planned times stay on the grid (open model). */
  startTimer(first, from) {
    const key = timerKey(first);
    const t = { handle: null, every: first.every };
    this.timers.set(key, t);
    const tick = (planned) => {
      t.handle = this.clock.at(planned, () => {
        if (this.gone || this.timers.get(key) !== t) return;
        // the request of the CURRENT state for this timer (one app timer, its branch follows the screen)
        const entry = (this.table.cadences[this.app][this.state] ?? []).find((e) => timerKey(e) === key) ?? first;
        // the app's timer runs, but a tick asks only while the entry's condition holds (e.g. near an airport)
        const paths = entry.when && !entry.when(this) ? [] : (entry.batch ?? [entry.path(this.ctx)]);
        for (const p of paths)
          void this.send(entry.id, entry.method, p, entry.body ? this.bodyFor(entry) : undefined, planned).then((r) => {
            const d = entry.dynamic;
            const v = r?.json?.[d?.field];
            if (d && typeof v === "number") t.every = Math.min(d.max, Math.max(d.min, v));
          });
        tick(planned + t.every * 1000);
      });
    };
    tick(first.immediate ? from : from + t.every * 1000);
  }
  /** Sends one request, filed under the state at send time; latency counts from the planned time. */
  async send(id, method, path, body, planned = this.clock.now()) {
    const state = this.state;
    const sentAt = this.clock.now();
    let tries = 0;
    const r = await this.auth.call(method, path, body, () => tries++ && this.counter.bump(`${this.app}.retriedAfterRefresh`));
    // the retry after a refresh is the same request: counted once, under its id, with the final answer
    this.counter.request(this.app, state, id, { status: r.status, lagMs: sentAt - planned, latencyMs: this.clock.now() - planned, reason: r.status >= 400 ? `${r.json?.reason ?? r.json?.code ?? ""} ${String(r.json?.message ?? "").slice(0, 80)}`.trim() : undefined });
    return r;
  }
  bodyFor(e) {
    if (e.body === "location") return { fixes: [{ lat: this.pos.lat, lng: this.pos.lng, accuracy: 5, measuredAt: new Date(this.clock.now()).toISOString() }] };
    return undefined;
  }
  openStream(name, path, onEvent) {
    this.streams.get(name)?.close();
    this.streams.set(name, this.transport.stream(path, this.auth, (e) => !this.gone && onEvent(e)));
  }
  closeStream(name) {
    this.streams.get(name)?.close();
    this.streams.delete(name);
  }
  react(kind) {
    const rule = this.table.reactions[this.app][kind];
    if (!rule || this.gone) return;
    if (rule.when && !rule.when(this)) return;
    this.counter.event(this.app, this.state, kind);
    const now = this.clock.now();
    if (rule.minGapSeconds && now - (this.lastReaction.get(kind) ?? 0) < rule.minGapSeconds * 1000) return;
    this.lastReaction.set(kind, now);
    for (const q of rule.requests(this.state, this)) void this.send(q.id, q.method, q.path);
  }
  later(meanMs, fn) {
    const h = this.clock.at(this.clock.now() + expWait(this.rng, meanMs), () => !this.gone && fn());
    return h;
  }
  leave() {
    if (this.gone) return;
    this.enter(null);
    this.gone = true;
    for (const name of [...this.streams.keys()]) this.closeStream(name);
    this.onLeave?.();
  }
}

const RIDE_STATE = {
  requested: "finding", searching: "finding", offered: "finding",
  accepted: "waiting", driver_to_pickup: "waiting", arrived: "arrived",
  rider_onboard: "in_trip", in_trip: "in_trip", approaching_dropoff: "in_trip", completed: "receipt",
};

/**
 * Rider: Home → Choose ride (quote) → book → Finding (Finding after 3 min) → Waiting → Arrived → In trip → Receipt →
 * leaves (open model: the phone goes away; new riders keep arriving). The ride states follow the trip stream's
 * projection.status, as the app's realtime client does. A search longer than `abandonMs` is cancelled by the rider.
 */
export class RiderPhone extends Phone {
  constructor(o) {
    super("rider", o);
    this.dwell = { home: 120_000, choose: 60_000, receipt: 60_000, abandonMs: 600_000, ...(o.dwell ?? {}) };
  }
  start() {
    this.openStream("config", "/rider/config/stream", (e) => Object.hasOwn(this.table.reactions.rider, e.kind) && this.react(e.kind));
    for (const e of this.table.onEnter.rider.signed_in) void this.send(e.id, e.method, e.path);
    this.enter("home");
    this.later(this.dwell.home, () => this.choose());
  }
  async choose() {
    this.enter("choose");
    this.pickup = { address: "Load pickup", ...near(this.zone, this.rng, 0.015) };
    this.dropoff = { address: "Load dropoff", ...near(this.zone, this.rng, 0.03) };
    const body = { pickup: this.pickup, dropoff: this.dropoff, stops: [], categoryIds: ["economy"] };
    const q = await this.send("POST /quotes", "POST", "/quotes", body);
    this.quote = q?.json?.quotes?.[0];
    this.later(this.dwell.choose, () => this.book());
  }
  async book() {
    if (!this.quote) {
      this.counter.bump("rider.noQuote");
      return this.leave();
    }
    const body = { quoteId: this.quote.quoteId, categoryId: this.quote.categoryId ?? "economy", pickup: this.pickup, dropoff: this.dropoff, stops: [], kind: "live", paymentMethod: "cash" };
    const t = await this.send("POST /trips", "POST", "/trips", body);
    if (!t?.json?.tripId) {
      this.counter.bump("rider.bookFailed");
      return this.leave();
    }
    this.tripId = t.json.tripId;
    this.version = t.json.version;
    this.counter.bump("rider.booked");
    this.onBooked?.(this.tripId, this);
    this.enter("finding");
    this.searchStart = this.clock.now();
    this.lateTimer = this.clock.at(this.searchStart + 180_000, () => this.state === "finding" && this.enter("finding_late"));
    this.abandonTimer = this.clock.at(this.searchStart + this.dwell.abandonMs, () => (this.state === "finding" || this.state === "finding_late") && this.cancel());
    this.openStream("trip", `/trips/${this.tripId}/events`, (e) => this.onTripEvent(e));
  }
  onTripEvent(e) {
    if (typeof e.version === "number") this.version = e.version;
    const status = e.projection?.status;
    if (!status) return;
    const next = RIDE_STATE[status];
    if (!next) {
      // cancelled / no-show / expired / failed: the ride ends, the rider leaves
      this.counter.bump(`rider.ended.${status}`);
      return this.leave();
    }
    if (next === this.state || (next === "finding" && this.state === "finding_late")) return;
    this.enter(next);
    if (next === "receipt") {
      this.counter.bump("rider.completed");
      this.later(this.dwell.receipt, () => this.leave());
    }
  }
  async cancel() {
    this.counter.bump("rider.abandonedSearch");
    await this.send("POST /trips/{id}/cancel", "POST", `/trips/${this.tripId}/cancel`, { expectedVersion: this.version ?? 1, reasonCode: "plans_changed" });
    this.leave();
  }
  onLeave() {
    for (const h of [this.lateTimer, this.abandonTimer]) if (h != null) this.clock.cancel(h);
  }
}

/**
 * Driver: offline with Home open, or online idle → offer on the offer stream → accept (share `acceptShare`, after a
 * think time) or decline → to pickup → at pickup → on trip → complete → online idle again. Trip steps use the version
 * from the trip stream; the car moves to the pickup and the drop-off before arrive / complete.
 */
export class DriverPhone extends Phone {
  constructor(o) {
    super("driver", o);
    this.dwell = { think: 3_000, toPickup: 240_000, atPickup: 60_000, onTrip: 600_000, acceptShare: 0.85, ...(o.dwell ?? {}) };
  }
  start(online) {
    this.openStream("config", "/driver/config/stream", (e) => Object.hasOwn(this.table.reactions.driver, e.kind) && this.react(e.kind));
    for (const e of this.table.onEnter.driver.signed_in) void this.send(e.id, e.method, e.path);
    if (!online) return this.enter("offline_home");
    this.openStream("offers", "/driver/offers/stream", (e) => e.kind === "offer_created" && e.offer && this.onOffer(e.offer));
    this.enter("online_idle");
  }
  onOffer(offer) {
    if (this.state !== "online_idle" || this.busy) return;
    this.busy = true;
    this.counter.bump("driver.offersSeen");
    this.later(this.dwell.think, async () => {
      if (this.rng() >= this.dwell.acceptShare) {
        await this.send("POST /offers/{id}/decline", "POST", `/offers/${offer.offerId}/decline`, { expectedVersion: offer.version, reasonCode: "too_far" });
        this.busy = false;
        return;
      }
      const a = await this.send("POST /offers/{id}/accept", "POST", `/offers/${offer.offerId}/accept`, { expectedVersion: offer.version });
      if (a?.status !== 200) {
        this.counter.bump("driver.acceptRefused");
        this.busy = false;
        return;
      }
      this.counter.bump("driver.accepted");
      this.tripId = offer.tripId;
      this.version = a.json?.version ?? a.json?.trip?.version ?? offer.tripVersion;
      this.target = offer.pickup ?? this.pos;
      this.dropoff = offer.dropoff;
      this.enter("to_pickup");
      this.openStream("trip", `/trips/${this.tripId}/events`, (e) => typeof e.version === "number" && (this.version = Math.max(this.version ?? 0, e.version)));
      // the trip screen moves an accepted trip to "driver to pickup" (live_trip_commands.dart:251-261)
      if (!(await this.command("head-to-pickup"))) this.counter.bump("driver.stepFailed.head-to-pickup");
      this.later(this.dwell.toPickup, () => this.step("arrive", "at_pickup", this.dwell.atPickup));
    });
  }
  async command(verb) {
    const body = { expectedVersion: this.version ?? 1, location: { lat: this.pos.lat, lng: this.pos.lng, accuracy: 5 } };
    const r = await this.send(`POST /trips/{id}/${verb}`, "POST", `/trips/${this.tripId}/${verb}`, body);
    if (typeof r?.json?.version === "number") this.version = r.json.version;
    if (r?.status === 409 && typeof r.json?.currentVersion === "number") this.version = r.json.currentVersion;
    return r?.status === 200;
  }
  async step(verb, nextState, dwellMs) {
    if (this.target) this.pos = { lat: this.target.lat, lng: this.target.lng };
    const ok = (await this.command(verb)) || (await this.command(verb));
    if (!ok) {
      this.counter.bump(`driver.stepFailed.${verb}`);
      return this.free();
    }
    this.enter(nextState);
    if (nextState === "at_pickup") {
      this.later(dwellMs, async () => {
        if (!(await this.command("board"))) this.counter.bump("driver.stepFailed.board");
        this.target = this.dropoff ?? near(this.zone, this.rng, 0.03);
        await this.step("start", "on_trip", this.dwell.onTrip);
      });
    } else if (nextState === "on_trip") {
      this.later(dwellMs, async () => {
        this.pos = { lat: this.target.lat, lng: this.target.lng };
        if (await this.command("complete")) this.counter.bump("driver.completed");
        else this.counter.bump("driver.stepFailed.complete");
        this.free();
      });
    }
  }
  free() {
    this.closeStream("trip");
    this.tripId = undefined;
    this.target = undefined;
    this.busy = false;
    this.enter("online_idle");
  }
}
