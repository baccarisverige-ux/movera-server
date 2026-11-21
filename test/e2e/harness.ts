import type { CodeSmsSender } from "../../src/sms/elks.js";
import { ADMIN_EVENTS_CHANNEL } from "../../src/realtime/adminEvents.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { DISPATCH_EVENTS_CHANNEL } from "../../src/dispatch/feed.js";
import { pricingHandlers } from "../../src/pricing/surge.js";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { createAdmin, createSetupLink } from "../../src/admin/auth.js";
import type { AdminRole } from "../../src/admin/permissions.js";
import { buildApp } from "../../src/app.js";
import type { SmsProvider } from "../../src/sms/sms.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { CONFIG_CHANNEL } from "../../src/config/service.js";
import { OFFER_EVENTS_CHANNEL, TRIP_EVENTS_CHANNEL } from "../../src/db/tripLog.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { createDb, createPool, type Db } from "../../src/db/db.js";
import { readEnv } from "../../src/env.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import type { Router } from "../../src/maps/routing.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { prepareTestWeek } from "../../src/testWeek.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { INCIDENT_EVENTS_CHANNEL } from "../../src/safety/incidents.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * The Phase 3 simulation harness: one real server (buildApp + its own fresh Postgres database + the LISTEN/NOTIFY hub)
 * listening on a local port, prepared exactly like the staging server at start (prepareTestWeek: the test fleet,
 * three drivers, three riders, the sample settings in every open zone, the bootstrap admin). Riders, drivers and
 * admins talk to it over real HTTP and Server-Sent Events like the apps do. The server's clock is injected, and the
 * durable timers (offer expiry, search steps, search end, …) run when the simulation says time has passed.
 */

export const PLACES = {
  // Stockholm (Z001)
  sergels: { address: "Sergels torg", lat: 59.3326, lng: 18.0649 },
  medborgar: { address: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 },
  // About 200 m from Sergels torg.
  nearSergels: { lat: 59.3335, lng: 18.0655 },
  // About 1 km north of Sergels torg.
  odenplan: { lat: 59.3429, lng: 18.0498 },
  // Far out at sea: in no zone.
  atSea: { address: "Baltic Sea", lat: 58.5, lng: 20.5 },
};

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Res = { status: number; body: Json; headers: Headers };

export const BOOTSTRAP_EMAIL = "owner@movera.test";

/** poolMax: the server gets its own pool of this size (the test's own reads keep the default pool). */
/** env: extra server environment (e.g. a production-size write limit, B1.22). */
export type SimOptions = { router?: Router; osrmUrl?: string; now?: Date; poolMax?: number; env?: Record<string, string>; /** v0.18.101: a fake SMS company (none = "SMS not connected"). */ sms?: SmsProvider; /** v0.18.151: a fake sign-in SMS sender (the 46elks keys set). */ signInSms?: CodeSmsSender };

let keyCounter = 0;
export const newKey = (prefix = "e2e") => `${prefix}-key-${String(++keyCounter).padStart(12, "0")}-${process.pid}`;

export class Sim {
  readonly clock: { now: Date };
  database!: TestDatabase;
  /** The server's own small pool (SimOptions.poolMax), else none. */
  private serverDb: Db | undefined;
  app!: FastifyInstance;
  hub!: NotificationHub;
  /** The server settings this copy runs with (a second server copy in a rule-33 test uses the same ones). */
  env!: ReturnType<typeof readEnv>;
  worker!: TimerWorker;
  base!: string;
  /** What the server logged at start (prepareTestWeek). */
  readonly startLog: Array<{ data: Record<string, unknown>; message: string }> = [];
  readonly timerErrors: Array<{ data: object; message: string }> = [];
  /** One row per HTTP response (see Sim.start). */
  readonly timings: Array<{ route: string; status: number; ms: number }> = [];
  private readonly streams = new Set<Stream>();
  /** Signed-in driver apps: like the real app they send their position every 30 s while time passes. */
  readonly driverApps = new Set<Driver>();
  private lastFixes = 0;

  private constructor(now: Date) {
    this.clock = { now };
  }

  static async start(options: SimOptions = {}): Promise<Sim> {
    const sim = new Sim(options.now ?? new Date("2026-10-27T10:00:00Z"));
    sim.database = await freshDatabase();
    const db = sim.database.db;
    await seedTestPhones(db);
    const env = readEnv({
      MOVERA_ENV: "staging",
      DATABASE_URL: sim.database.url,
      // A fresh random signing key per run (never a literal in the code).
      JWT_SECRET: randomBytes(32).toString("hex"),
      SEED_TEST_ON_START: "true",
      ADMIN_BOOTSTRAP_EMAIL: BOOTSTRAP_EMAIL,
      ADMIN_PANEL_URL: "https://admin.example.test/live/",
      ...(options.osrmUrl ? { OSRM_URL: options.osrmUrl } : {}),
      ...options.env,
    });
    sim.env = env;
    await prepareTestWeek(db, env, { info: (data, message) => sim.startLog.push({ data, message }) }, { now: sim.clock.now });
    sim.hub = new NotificationHub(sim.database.url, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL, OFFER_EVENTS_CHANNEL, INCIDENT_EVENTS_CHANNEL, DISPATCH_EVENTS_CHANNEL, ADMIN_EVENTS_CHANNEL]);
    await sim.hub.start();
    if (options.poolMax !== undefined) sim.serverDb = createDb(createPool(sim.database.url, options.poolMax));
    sim.app = await buildApp({ env, logger: false, db: sim.serverDb ?? db, clock: () => sim.clock.now, hub: sim.hub, ...(options.router ? { router: options.router } : {}), ...(options.sms ? { sms: options.sms } : {}), ...(options.signInSms ? { signInSms: options.signInSms } : {}) });
    // Phase 7: every HTTP response's route, status and server time (Fastify's elapsedTime), for the timing budgets
    // (15_timing.test.ts). E2E_TIMING_OUT=<file> also appends them as JSON lines for the timing report.
    const timingOut = process.env.E2E_TIMING_OUT;
    sim.app.addHook("onResponse", async (request, reply) => {
      const row = { route: `${request.method} ${request.routeOptions.url ?? request.url.split("?")[0]}`, status: reply.statusCode, ms: reply.elapsedTime };
      sim.timings.push(row);
      if (timingOut) appendFileSync(timingOut, `${JSON.stringify(row)}\n`);
    });
    sim.worker = new TimerWorker(db, {
      handlers: { ...dispatchHandlers, ...rideHandlers, ...pricingHandlers },
      logger: { warn: () => undefined, error: (data, message) => sim.timerErrors.push({ data, message }) },
      clock: () => sim.clock.now,
    });
    await sim.app.listen({ host: "127.0.0.1", port: 0 });
    sim.base = `http://127.0.0.1:${(sim.app.server.address() as AddressInfo).port}/api/v1`;
    return sim;
  }

  async stop(): Promise<void> {
    for (const s of this.streams) s.close();
    await this.app.close();
    await this.hub.stop();
    await this.serverDb?.destroy();
    await this.database.drop();
  }

  get db() {
    return this.database.db;
  }

  /** Runs every timer that is due now (the server's worker does this every second). */
  async tick(): Promise<void> {
    await this.worker.runDue();
  }

  /** Time passes on the server's clock; the timers that came due run. */
  async advance(seconds: number): Promise<void> {
    const end = this.clock.now.getTime() + seconds * 1000;
    // In steps of at most 5 s, so timers fire in the order and at the moment they would on a real server.
    while (this.clock.now.getTime() < end) {
      this.clock.now = new Date(Math.min(end, this.clock.now.getTime() + 5000));
      if (this.clock.now.getTime() - this.lastFixes >= 30_000) {
        this.lastFixes = this.clock.now.getTime();
        for (const driver of this.driverApps) await driver.heartbeat();
      }
      await this.worker.runDue();
    }
  }

  async request(method: string, path: string, token: string | undefined, body?: unknown, options: { key?: string | null; headers?: Record<string, string> } = {}): Promise<Res> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      if (options.key !== null) headers["idempotency-key"] = options.key ?? newKey();
    }
    const res = await fetch(`${this.base}${path}`, { method, headers, ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Json) : {}, headers: res.headers };
  }

  /** Signs in on a test phone through the real code flow (the fixed test code). */
  async signIn(phone: string, appName: "rider" | "driver"): Promise<Session> {
    const challenge = await this.request("POST", "/auth/otp/request", undefined, { phone, app: appName }, { key: null });
    if (challenge.status !== 200 && challenge.status !== 201) throw new Error(`otp request ${challenge.status} ${JSON.stringify(challenge.body)}`);
    const verify = await this.request("POST", "/auth/otp/verify", undefined, { phone, sessionId: challenge.body["sessionId"], code: TEST_CODE }, { key: null });
    if (verify.status !== 200) throw new Error(`otp verify ${verify.status} ${JSON.stringify(verify.body)}`);
    return { accessToken: verify.body["accessToken"], refreshToken: verify.body["refreshToken"] };
  }

  async rider(index: 0 | 1 | 2): Promise<Rider> {
    const phone = TEST_PHONES[3 + index]!;
    const session = await this.signIn(phone, "rider");
    const rider = new Rider(this, phone, session);
    rider.id = (await rider.get("/rider/profile")).body["riderId"];
    return rider;
  }

  /** A test driver (0 is the fleet owner), signed in, online at `at` with a fresh fix. */
  async driver(index: 0 | 1 | 2, at: { lat: number; lng: number } | null = PLACES.nearSergels): Promise<Driver> {
    const phone = TEST_PHONES[index]!;
    const session = await this.signIn(phone, "driver");
    const driver = new Driver(this, phone, session);
    this.driverApps.add(driver);
    const profile = (await driver.get("/driver/profile")).body;
    driver.id = profile["driverId"];
    if (at !== null) {
      await driver.goOnline(at);
    }
    return driver;
  }

  /** The bootstrap Super admin, through the password link the server logged at start, then e-mail + password. */
  async owner(): Promise<Admin> {
    const entry = this.startLog.find((e) => e.message.startsWith("admin password link"));
    const link = entry?.data["setupLink"];
    if (typeof link !== "string") throw new Error("no admin password link at start");
    return this.adminFromLink(link, BOOTSTRAP_EMAIL);
  }

  /** Another admin of `role` (optionally limited to zones), made the way `admin create` makes one. */
  async admin(role: AdminRole, zoneIds?: string[]): Promise<Admin> {
    const email = `${role}.${newKey("adm")}@movera.test`.toLowerCase();
    const { adminId } = await createAdmin(this.db, { email, name: `${role} admin`, role, zoneIds: zoneIds ?? null }, this.clock.now);
    const link = await createSetupLink({ db: this.db, jwtSecret: "unused", panelUrl: "https://admin.example.test/live/", clock: () => this.clock.now }, adminId, "e2e");
    return this.adminFromLink(link.url, email);
  }

  private async adminFromLink(link: string, email: string): Promise<Admin> {
    const token = new URL(link).hash.replace("#token=", "");
    const password = "a long e2e test password";
    const setup = await this.request("POST", "/admin/auth/setup-password", undefined, { setupToken: token, password }, { key: null });
    if (setup.status !== 200) throw new Error(`setup ${setup.status} ${JSON.stringify(setup.body)}`);
    const signedIn = await this.request("POST", "/admin/auth/sign-in", undefined, { email, password }, { key: null });
    if (signedIn.status !== 200) throw new Error(`admin sign-in ${signedIn.status} ${JSON.stringify(signedIn.body)}`);
    const admin = new Admin(this, email, { accessToken: signedIn.body["accessToken"], refreshToken: signedIn.body["refreshToken"] });
    admin.id = (await admin.get("/admin/auth/me")).body["adminId"];
    return admin;
  }

  /** Opens a Server-Sent Events stream the way the apps do (Accept: text/event-stream, optional Last-Event-ID). */
  async stream(path: string, token: string, lastEventId?: string): Promise<Stream> {
    const stream = new Stream(`${this.base}${path}`, token);
    this.streams.add(stream);
    await stream.open(lastEventId);
    return stream;
  }

  /**
   * Publishes a changed copy of a zone's live settings document as a Super admin would (Admin › Config). v0.8.0:
   * `scope` "SE" style (two capitals) is a country's standard or country_rules (?country=).
   */
  async publish(admin: Admin, doc: "pricing" | "dispatch" | "rider_app_config" | "driver_app_config" | "country_rules", scope: string, change: (document: Json) => Json, first?: Json, removeKeys?: string[]): Promise<Json> {
    const at = /^[A-Z]{2}$/.test(scope) ? { country: scope } : { zoneId: scope };
    const query = "country" in at ? `country=${at.country}` : `zoneId=${at.zoneId}`;
    const draft = await admin.get(`/admin/config/${doc}?${query}`);
    if (draft.status !== 200 && !(draft.status === 404 && first)) throw new Error(`read ${doc}: ${draft.status} ${JSON.stringify(draft.body)}`);
    const start = draft.status === 200 ? { version: draft.body["version"], document: draft.body["document"] } : { version: 1, document: first };
    const put = await admin.put(`/admin/config/${doc}`, { expectedVersion: start.version, ...at, document: change(structuredClone(start.document)), ...(removeKeys ? { removeKeys } : {}) });
    if (put.status !== 200) throw new Error(`put ${doc}: ${put.status} ${JSON.stringify(put.body)}`);
    const published = await admin.post(`/admin/config/${doc}/publish`, { expectedVersion: put.body["version"], ...at });
    if (published.status !== 200) throw new Error(`publish ${doc}: ${published.status} ${JSON.stringify(published.body)}`);
    return published.body;
  }
}

export type Session = { accessToken: string; refreshToken: string };

class Actor {
  id = "";
  constructor(
    readonly sim: Sim,
    readonly login: string,
    public session: Session,
  ) {}
  get token() {
    return this.session.accessToken;
  }
  protected refreshPath = "/auth/refresh";
  /** Like the apps: an expired access token is refreshed once and the call is sent again (same Idempotency-Key). */
  async send(method: string, path: string, body?: unknown, key?: string): Promise<Res> {
    const options = { key: key ?? (method === "GET" ? null : newKey()) };
    const res = await this.sim.request(method, path, this.token, body, options);
    if (res.status !== 401 || res.body["reason"] !== "token_expired") return res;
    const refreshed = await this.sim.request("POST", this.refreshPath, undefined, { refreshToken: this.session.refreshToken }, { key: null });
    if (refreshed.status !== 200) return res;
    this.session = { accessToken: refreshed.body["accessToken"], refreshToken: refreshed.body["refreshToken"] };
    return this.sim.request(method, path, this.token, body, options);
  }
  get(path: string) {
    return this.send("GET", path);
  }
  post(path: string, body?: unknown, key?: string) {
    return this.send("POST", path, body, key);
  }
  put(path: string, body?: unknown) {
    return this.send("PUT", path, body);
  }
  /** The trip as this app sees it now. */
  async trip(tripId: string): Promise<Json> {
    const res = await this.get(`/trips/${tripId}`);
    if (res.status !== 200) throw new Error(`trip ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
  /** A trip command with the version this app last saw (the apps always send expectedVersion). */
  async command(tripId: string, path: string, body: Json = {}, key?: string): Promise<Res> {
    const version = body["expectedVersion"] ?? (await this.trip(tripId))["version"];
    return this.post(`/trips/${tripId}/${path}`, { ...body, expectedVersion: version }, key);
  }
  events(tripId: string, lastEventId?: string) {
    return this.sim.stream(`/trips/${tripId}/events`, this.token, lastEventId);
  }
}

export class Rider extends Actor {
  async quote(body: Json = {}): Promise<Res> {
    return this.post("/quotes", { pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], ...body });
  }
  /** Quote → request, as the rider app books a live ride. */
  async book(options: { categoryId?: string; pickup?: Json; dropoff?: Json; key?: string } = {}): Promise<{ tripId: string; quote: Json; trip: Json; res: Res }> {
    const categoryId = options.categoryId ?? "economy";
    const pickup = options.pickup ?? PLACES.sergels;
    const dropoff = options.dropoff ?? PLACES.medborgar;
    const quotes = await this.quote({ pickup, dropoff, categoryIds: [categoryId] });
    if (quotes.status !== 201) throw new Error(`quote ${quotes.status} ${JSON.stringify(quotes.body)}`);
    const quote = quotes.body["quotes"][0];
    const res = await this.post("/trips", { quoteId: quote.quoteId, categoryId, pickup, dropoff, stops: [], kind: "live", paymentMethod: "cash" }, options.key);
    if (res.status !== 201) throw new Error(`request ${res.status} ${JSON.stringify(res.body)}`);
    return { tripId: res.body["tripId"], quote, trip: res.body, res };
  }
}

export class Driver extends Actor {
  private fixAt = 0;
  /** Where the car is (the last fix sent); null before the first. */
  position: { lat: number; lng: number } | null = null;
  /** The app's periodic fix at the car's current place. */
  async heartbeat(): Promise<void> {
    if (this.position !== null) await this.post("/driver/location", { fixes: [this.fix(this.position)] });
  }
  async goOnline(at: { lat: number; lng: number }): Promise<void> {
    const profile = (await this.get("/driver/profile")).body;
    const res = await this.post("/driver/availability", { expectedVersion: profile["version"], onlineStatus: "online", location: this.fix(at) });
    if (res.status !== 200) throw new Error(`online ${res.status} ${JSON.stringify(res.body)}`);
  }
  /** A GPS fix from the driver app; each is measured at least a second after the last (only a newer fix counts). */
  fix(at: { lat: number; lng: number }) {
    this.position = { lat: at.lat, lng: at.lng };
    const t = Math.max(this.sim.clock.now.getTime(), this.fixAt + 1000);
    this.fixAt = t;
    return { lat: at.lat, lng: at.lng, accuracy: 5, measuredAt: new Date(t).toISOString() };
  }
  async moveTo(at: { lat: number; lng: number }): Promise<void> {
    const res = await this.post("/driver/location", { fixes: [this.fix(at)] });
    if (res.status !== 200) throw new Error(`location ${res.status} ${JSON.stringify(res.body)}`);
  }
  async offers(): Promise<Json[]> {
    return (await this.get("/driver/offers")).body["items"] ?? [];
  }
  async offerFor(tripId: string): Promise<Json | undefined> {
    return (await this.offers()).find((o) => o["tripId"] === tripId);
  }
  accept(offer: Json) {
    return this.post(`/offers/${offer["offerId"]}/accept`, { expectedVersion: offer["version"] });
  }
  decline(offer: Json) {
    return this.post(`/offers/${offer["offerId"]}/decline`, { expectedVersion: offer["version"], reasonCode: "too_far" });
  }
  offerFeed(lastEventId?: string) {
    return this.sim.stream("/driver/offers/stream", this.token, lastEventId);
  }
}

export class Admin extends Actor {
  protected override refreshPath = "/admin/auth/refresh";
  tripCommand(tripId: string, path: string, body: Json, key?: string) {
    return this.post(`/admin/trips/${tripId}/${path}`, body, key);
  }
}

export type SseEvent = { id: string; data: Json };

/** A minimal EventSource: keeps every event, remembers the last id, can drop and resume like a phone losing signal. */
export class Stream {
  readonly events: SseEvent[] = [];
  readonly comments: string[] = [];
  status = 0;
  ended = false;
  lastEventId: string | undefined;
  private req: http.ClientRequest | undefined;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  open(lastEventId?: string): Promise<void> {
    this.ended = false;
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "text/event-stream" };
      if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
      const req = http.get(this.url, { headers }, (res) => {
        this.status = res.statusCode ?? 0;
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let at;
          while ((at = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            if (block.startsWith(":")) this.comments.push(block.slice(1).trim());
            else {
              const id = /^id: (.*)$/m.exec(block)?.[1] ?? "";
              const data = /^data: (.*)$/m.exec(block)?.[1];
              if (data) {
                this.events.push({ id, data: JSON.parse(data) as Json });
                this.lastEventId = id;
              }
            }
          }
        });
        res.on("end", () => (this.ended = true));
        res.on("error", () => (this.ended = true));
        resolve();
      });
      this.req = req;
      req.on("error", (error) => (this.ended || this.status !== 0 ? undefined : reject(error)));
    });
  }

  close(): void {
    this.req?.destroy();
    this.ended = true;
  }

  /** Signal lost, then back: reconnects with the last id it saw, as EventSource does. */
  async reconnect(): Promise<void> {
    this.close();
    await this.open(this.lastEventId);
  }

  /** Waits (real time) until an event matching `match` has arrived. */
  async waitFor(match: (e: SseEvent) => boolean, ms = 4000): Promise<SseEvent> {
    const end = Date.now() + ms;
    for (;;) {
      const found = this.events.find(match);
      if (found) return found;
      if (Date.now() > end) throw new Error(`no matching event; got ${JSON.stringify(this.events.map((e) => [e.id, e.data["kind"], e.data["projection"]?.["status"] ?? e.data["offer"]?.["status"]]))}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  /** Waits until a trip_projection with this status arrived; answers its projection. */
  async reach(status: string, ms?: number): Promise<Json> {
    return (await this.waitFor((e) => e.data["projection"]?.["status"] === status, ms)).data["projection"];
  }
}

/** Waits (real time) until `check` holds. */
export async function until(check: () => boolean | Promise<boolean>, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return check();
}

/** A stand-in for Movera's OSRM: answers /route/v1/driving/… with a fixed route, or fails on demand. */
export async function fakeOsrm(route: { distance: number; duration: number }): Promise<{ url: string; calls: string[]; set: (r: { distance: number; duration: number } | "down") => void; close: () => Promise<void> }> {
  let current: { distance: number; duration: number } | "down" = route;
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url ?? "");
    if (current === "down" || !req.url?.startsWith("/route/v1/driving/")) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "Unavailable" }));
      return;
    }
    const coordinates = req.url.split("/route/v1/driving/")[1]!.split("?")[0]!.split(";").map((p) => p.split(",").map(Number));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "Ok", routes: [{ distance: current.distance, duration: current.duration, geometry: { type: "LineString", coordinates } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    set: (r) => (current = r),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The rider books; the timers send the offers; the (first of the) `drivers` that got an offer accepts it. */
/**
 * v0.18.39 §63: a live ride's search never ends by itself any more (owner N2); the way a trip expires is a booked ride
 * with no driver at pickup + noDriverStopAfterMin (P17). Books one 40 min ahead and lets time pass until it expired.
 */
export async function expiredBookedRide(sim: Sim, rider: Rider): Promise<string> {
  const at = new Date(sim.clock.now.getTime() + 40 * 60_000).toISOString();
  const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at })).body["quotes"][0];
  const res = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
  if (res.status !== 201) throw new Error(`booked ${res.status} ${JSON.stringify(res.body)}`);
  await sim.advance((Date.parse(at) - sim.clock.now.getTime()) / 1000 + 16 * 60);
  return res.body["tripId"];
}

export async function bookAndAccept(sim: Sim, rider: Rider, drivers: Driver | Driver[], options: Parameters<Rider["book"]>[0] = {}): Promise<{ tripId: string; quote: Json; accepted: Json; driver: Driver }> {
  const { tripId, quote } = await rider.book(options);
  await sim.tick();
  for (const driver of Array.isArray(drivers) ? drivers : [drivers]) {
    const offer = await driver.offerFor(tripId);
    if (!offer) continue;
    const res = await driver.accept(offer);
    if (res.status !== 200) throw new Error(`accept ${res.status} ${JSON.stringify(res.body)}`);
    return { tripId, quote, accepted: res.body, driver };
  }
  throw new Error(`none of the drivers got an offer for ${tripId}`);
}

/** Drives an accepted trip through the given steps (the driver app's buttons), moving the car where it must be. */
export async function drive(driver: Driver, tripId: string, until: "driver_to_pickup" | "arrived" | "rider_onboard" | "in_trip", pickup: { lat: number; lng: number } = PLACES.sergels): Promise<Json> {
  const steps = [["head-to-pickup", "driver_to_pickup"], ["arrive", "arrived"], ["board", "rider_onboard"], ["start", "in_trip"]] as const;
  let last: Json = await driver.trip(tripId);
  // Steps already taken are skipped, so a test can drive on from where the trip is.
  const done = steps.findIndex(([, status]) => status === last["status"]);
  for (const [path, status] of steps.slice(done + 1)) {
    if (path === "arrive") await driver.moveTo(pickup);
    const res = await driver.command(tripId, path);
    if (res.status !== 200) throw new Error(`${path} ${res.status} ${JSON.stringify(res.body)}`);
    last = res.body;
    if (status === until) break;
  }
  return last;
}
