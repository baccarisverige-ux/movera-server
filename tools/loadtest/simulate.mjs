// The fake phones in SIMULATED time against a small fake server (global plan step 60 proof, Rule 35 test). Same phone
// code as a live run (phones.mjs); only the clock and the transport differ. It answers what the phones need (tokens
// that expire, refresh, quotes, bookings, a simple dispatch, offers on the offer stream, trip steps, trip events and the
// rider_trip_changed hint for every trip event — including one per GPS fix of the driver on the trip, as the server
// does, drivers/service.ts:376-378 + realtime/streams.ts:128-133).
import { Counter } from "./counts.mjs";
import { VirtualClock, poissonArrivals, seededRandom } from "./clock.mjs";
import { Auth, DriverPhone, RiderPhone } from "./phones.mjs";
import { parseZoneShare, zoneForIndex } from "./zones.mjs";

class FakeServer {
  constructor(clock, rng, { accessTtlSeconds, noDriverShare }) {
    Object.assign(this, { clock, rng, accessTtlSeconds, noDriverShare });
    this.streams = new Map(); // path → Set(onEvent)
    this.refresh = new Map(); // refresh token → subject
    this.trips = new Map();
    this.offers = new Map();
    this.drivers = new Map(); // subject → phone (to find a free one)
    this.n = 0;
    this.refreshCalls = 0;
  }
  token(subject, ttlSeconds) {
    return `acc.${subject}.${++this.n}.${Math.round(this.clock.now() + ttlSeconds * 1000)}`;
  }
  session(subject, ttlSeconds) {
    const refresh = `ref.${subject}.${++this.n}`;
    this.refresh.set(refresh, subject);
    return { access: this.token(subject, ttlSeconds), refresh };
  }
  who(token) {
    const m = /^acc\.([^.]+)\.\d+\.(\d+)$/.exec(token ?? "");
    return m && Number(m[2]) > this.clock.now() ? m[1] : null;
  }
  emit(path, event) {
    for (const fn of this.streams.get(path) ?? []) fn(event);
  }
  tripEvent(trip, kind) {
    trip.version++;
    const e = { kind, tripId: trip.id, version: trip.version, projection: { status: trip.status } };
    this.emit(`/trips/${trip.id}/events`, e);
    this.emit(`config:${trip.rider}`, { kind: "rider_trip_changed", tripId: trip.id });
  }
  dispatch(trip) {
    if (trip.status !== "searching") return;
    if (trip.never) return; // no driver in reach: the search runs until the rider gives up
    const free = [...this.drivers.values()].filter((d) => d.state === "online_idle" && !d.busy && !trip.declined.has(d.subject));
    if (!free.length) return void this.clock.at(this.clock.now() + 5_000, () => this.dispatch(trip));
    const d = free[Math.floor(this.rng() * free.length)];
    const offer = { offerId: `ofr${++this.n}`, tripId: trip.id, version: 1, tripVersion: trip.version, pickup: trip.pickup, dropoff: trip.dropoff, driver: d.subject };
    this.offers.set(offer.offerId, offer);
    this.clock.at(this.clock.now() + 1_500, () => this.emit(`offers:${d.subject}`, { kind: "offer_created", offer }));
  }
  async request(method, path, body, token) {
    const ok = (json = {}) => ({ status: 200, json });
    if (path === "/auth/refresh") {
      this.refreshCalls++;
      const subject = this.refresh.get(body?.refreshToken);
      if (!subject) return { status: 401, json: { code: "unauthenticated" } };
      this.refresh.delete(body.refreshToken);
      const next = `ref.${subject}.${++this.n}`;
      this.refresh.set(next, subject);
      return ok({ accessToken: this.token(subject, 900), refreshToken: next, expiresIn: 900 });
    }
    const subject = this.who(token);
    if (!subject) return { status: 401, json: { code: "unauthenticated" } };
    const [base] = path.split("?");
    if (base === "/rider/nearby-vehicles") return ok({ items: [], refreshSeconds: 5, radiusMeters: 3000 });
    if (base === "/quotes") return ok({ quotes: [{ quoteId: `qt${++this.n}`, categoryId: "economy" }] });
    if (method === "POST" && base === "/trips") {
      const trip = { id: `trp${++this.n}`, rider: subject, status: "searching", version: 1, pickup: body.pickup, dropoff: body.dropoff, declined: new Set(), never: this.rng() < this.noDriverShare };
      this.trips.set(trip.id, trip);
      this.clock.at(this.clock.now() + 1_000, () => this.dispatch(trip));
      return ok({ tripId: trip.id, version: trip.version, status: trip.status });
    }
    let m = /^\/offers\/([^/]+)\/(accept|decline)$/.exec(base);
    if (m) {
      const offer = this.offers.get(m[1]);
      const trip = offer && this.trips.get(offer.tripId);
      if (!trip || trip.status !== "searching") return { status: 409, json: { code: "conflict" } };
      if (m[2] === "decline") {
        trip.declined.add(subject);
        this.clock.at(this.clock.now() + 1_000, () => this.dispatch(trip));
        return ok({});
      }
      trip.driver = subject;
      trip.status = "driver_to_pickup";
      this.tripEvent(trip, "trip_projection");
      return ok({ version: trip.version });
    }
    m = /^\/trips\/([^/]+)\/(arrive|board|start|complete|cancel)$/.exec(base);
    if (m) {
      const trip = this.trips.get(m[1]);
      if (!trip) return { status: 404, json: {} };
      const to = { arrive: "arrived", board: "rider_onboard", start: "in_trip", complete: "completed", cancel: "cancelled_by_rider" }[m[2]];
      trip.status = to;
      this.tripEvent(trip, "trip_projection");
      return ok({ version: trip.version });
    }
    if (base === "/driver/location") {
      const trip = [...this.trips.values()].find((t) => t.driver === subject && ["driver_to_pickup", "arrived", "rider_onboard", "in_trip"].includes(t.status));
      if (trip) this.tripEvent(trip, "location");
      return ok({});
    }
    return ok({});
  }
  stream(path, auth, onEvent) {
    const subject = this.who(auth.access) ?? auth.subject;
    const key = path === "/rider/config/stream" ? `config:${subject}` : path === "/driver/offers/stream" ? `offers:${subject}` : path;
    const set = this.streams.get(key) ?? new Set();
    this.streams.set(key, set);
    set.add(onEvent);
    return { close: () => set.delete(onEvent) };
  }
}

/**
 * Runs riders arriving by Poisson rate + a fixed driver population for `minutes` of simulated time and returns the
 * counter's report (measured requests per state vs the cadence table) plus what the run did.
 */
export async function runVirtual({ minutes = 60, riderArrivalsPerMinute = 6, drivers = 150, driverOfflineShare = 0.2, zoneShare, seed = 60, accessTtlSeconds = 120, noDriverShare = 0.25, riderDwell, driverDwell } = {}) {
  const clock = new VirtualClock();
  const rng = seededRandom(seed);
  const counter = new Counter();
  const server = new FakeServer(clock, rng, { accessTtlSeconds, noDriverShare });
  const shares = parseZoneShare(zoneShare);
  const zones = { rider: {}, driver: {} };
  const end = clock.now() + minutes * 60_000;
  const make = (Kind, app, i, n, extra) => {
    const zone = zoneForIndex(shares, i, n);
    zones[app][zone.zoneId] = (zones[app][zone.zoneId] ?? 0) + 1;
    const subject = `${app[0]}${i}`;
    // the first token expires early (a random part of accessTtlSeconds), so every phone goes through a real refresh
    const s = server.session(subject, Math.max(1, Math.round(accessTtlSeconds * (0.2 + 0.8 * rng()))));
    const auth = new Auth({ access: s.access, refresh: s.refresh, transport: server, counter, app });
    auth.subject = subject;
    const phone = new Kind({ clock, rng, counter, transport: server, auth, zone, ...extra });
    phone.subject = subject;
    return phone;
  };
  for (let i = 0; i < drivers; i++) {
    const d = make(DriverPhone, "driver", i, drivers, { dwell: driverDwell });
    server.drivers.set(d.subject, d);
    clock.at(clock.now() + rng() * 10_000, () => d.start(rng() >= driverOfflineShare));
  }
  let arrived = 0;
  const expected = riderArrivalsPerMinute * minutes;
  const riders = [];
  poissonArrivals(clock, rng, riderArrivalsPerMinute, () => {
    const r = make(RiderPhone, "rider", arrived++, Math.max(1, expected), { dwell: riderDwell });
    riders.push(r);
    r.start();
  }, end);
  await clock.run(end);
  for (const p of [...riders, ...server.drivers.values()]) p.leave();
  return { report: counter.report(), arrivals: arrived, expectedArrivals: expected, zones, refreshCalls: server.refreshCalls };
}
