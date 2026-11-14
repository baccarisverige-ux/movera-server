import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { isDatabaseBusy } from "../src/db/db.js";
import { contract } from "../src/contract/contract.js";
import { POLL_READ_ROUTES, registerLoadShedding, sheddable } from "../src/http/shed.js";

/** Job 1 (stress H3, fix plan R22): back-pressure instead of an endless queue. */
describe("load shedding", () => {
  it("answers 503 server_busy with Retry-After while the pool queue is over the limit, and serves again after", async () => {
    let waiting = 500;
    const app = Fastify();
    app.get("/api/v1/admin/trips", async () => ({ ok: true }));
    for (const [m, u] of [["POST", "/api/v1/safety/sos"], ["POST", "/api/v1/offers/ofr_1/accept"], ["POST", "/api/v1/trips/trp_1/complete"], ["POST", "/api/v1/driver/location"], ["GET", "/api/v1/driver/offers/stream"], ["GET", "/api/v1/admin/events"]] as const) app.route({ method: m, url: u, handler: async () => ({ ok: true }) });
    const stop = registerLoadShedding(app, { maxPoolWaiting: 200, maxLoopDelayMs: 0, poolWaiting: () => waiting });
    const busy = await app.inject({ method: "GET", url: "/api/v1/admin/trips" });
    expect(busy.statusCode).toBe(503);
    expect(busy.headers["retry-after"]).toBe("2");
    expect(busy.json()).toMatchObject({ code: "unavailable", reason: "server_busy", retryable: true });
    // Supervisor P4: SOS, accept, trip changes, GPS and streams are never refused, however busy.
    for (const [m, u] of [["POST", "/api/v1/safety/sos"], ["POST", "/api/v1/offers/ofr_1/accept"], ["POST", "/api/v1/trips/trp_1/complete"], ["POST", "/api/v1/driver/location"], ["GET", "/api/v1/driver/offers/stream"], ["GET", "/api/v1/admin/events"]] as const) {
      expect((await app.inject({ method: m, url: u })).statusCode, u).toBe(200);
    }
    waiting = 0;
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/trips" })).statusCode).toBe(200);
    stop();
    await app.close();
  });

  it("B1.24 (owner W1 Q84): the admin safety reads are never shed; every other admin read still is", async () => {
    const waiting = 500;
    const app = Fastify();
    const safety = [
      "/api/v1/admin/incidents",
      "/api/v1/admin/incidents/:incidentId",
      "/api/v1/admin/incidents/:incidentId/emergency-contacts",
      "/api/v1/admin/ride-checks",
      "/api/v1/admin/alerts/book",
      "/api/v1/admin/trips/:tripId",
    ];
    for (const url of [...safety, "/api/v1/admin/trips", "/api/v1/admin/trips/:tripId/receipt", "/api/v1/admin/incidents/settings", "/api/v1/admin/drivers/:driverId"]) app.get(url, async () => ({ ok: true }));
    const stop = registerLoadShedding(app, { maxPoolWaiting: 200, maxLoopDelayMs: 0, poolWaiting: () => waiting });
    // Matched on the route pattern: real ids and a query string still count as the safety read.
    for (const url of ["/api/v1/admin/incidents?status=open", "/api/v1/admin/incidents/inc_1", "/api/v1/admin/incidents/inc_1/emergency-contacts", "/api/v1/admin/ride-checks?limit=50", "/api/v1/admin/alerts/book", "/api/v1/admin/trips/trp_1"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    }
    for (const url of ["/api/v1/admin/trips", "/api/v1/admin/trips/trp_1/receipt", "/api/v1/admin/incidents/settings", "/api/v1/admin/drivers/drv_1"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(503);
    }
    // An unknown admin path (no route) is still shed, so it cannot pass as a safety read.
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/incidents/inc_1/x" })).statusCode).toBe(503);
    expect(sheddable("GET", "/api/v1/admin/incidents")).toBe(false);
    expect(sheddable("GET", "/api/v1/admin/incidents/inc_1", "/api/v1/admin/incidents/:incidentId")).toBe(false);
    expect(sheddable("GET", "/api/v1/admin/trips")).toBe(true);
    stop();
    await app.close();
  });

  it("tells database overload apart from bugs", () => {
    expect(isDatabaseBusy(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDatabaseBusy(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }))).toBe(true);
    expect(isDatabaseBusy(Object.assign(new Error("lock timeout"), { code: "55P03" }))).toBe(true);
    expect(isDatabaseBusy(new Error("syntax error"))).toBe(false);
  });

  it("E5: a deadlock (40P01) or serialization failure (40001) is busy (503 server_busy), a unique violation is not", () => {
    expect(isDatabaseBusy(Object.assign(new Error("deadlock detected"), { code: "40P01" }))).toBe(true);
    expect(isDatabaseBusy(Object.assign(new Error("could not serialize access"), { code: "40001" }))).toBe(true);
    expect(isDatabaseBusy(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
  });

  it("G34 S2 (v0.18.83 fastDispatch.shedPolls, owner \"Yes, 7 checks\"): the 7 repeat phone checks are shed; /rider/trips/active, GPS, accept, trip steps, SOS never", async () => {
    const shedPolls = (contract.fastDispatch as { shedPolls: { routes: string[] } }).shedPolls;
    // The server's list is the contract's list, matched on the route pattern ({tripId} = :tripId).
    const fromContract = shedPolls.routes.map((r) => r.replace(/^(\w+) /, "$1 /api/v1").replace(/\{(\w+)\}/g, ":$1")).sort();
    expect([...POLL_READ_ROUTES].sort()).toEqual(fromContract);
    expect(POLL_READ_ROUTES.size).toBe(7);
    expect(POLL_READ_ROUTES.has("GET /api/v1/rider/trips/active")).toBe(false);

    const app = Fastify();
    const shed = ["/driver/airport-queue", "/driver/surge-map", "/notifications", "/driver/reminders", "/driver/onboarding/settings", "/rider/trips", "/trips/:tripId/messages"];
    const neverGet = ["/rider/trips/active", "/driver/profile", "/trips/:tripId", "/trips/:tripId/messages/options", "/rider/trips/:tripId/driver-photo", "/driver/offers/stream", "/trips/:tripId/events"];
    const neverPost = ["/driver/location", "/offers/:offerId/accept", "/trips/:tripId/arrive", "/trips/:tripId/start", "/trips/:tripId/complete", "/rider/trips/:tripId/cancel", "/rider/trips/:tripId/sos", "/driver/trips/:tripId/sos", "/trips/:tripId/messages"];
    for (const r of [...shed, ...neverGet]) app.get(`/api/v1${r}`, async () => ({ ok: true }));
    for (const r of neverPost) app.post(`/api/v1${r}`, async () => ({ ok: true }));
    let waiting = 500;
    const stop = registerLoadShedding(app, { maxPoolWaiting: 200, maxLoopDelayMs: 0, poolWaiting: () => waiting });
    const real = (r: string) => `/api/v1${r.replace(":tripId", "trp_1").replace(":offerId", "ofr_1")}`;
    for (const r of shed) {
      const res = await app.inject({ method: "GET", url: `${real(r)}?limit=20` });
      expect(res.statusCode, r).toBe(503);
      expect(res.headers["retry-after"], r).toBe("2");
      expect(res.json(), r).toMatchObject({ code: "unavailable", reason: "server_busy" });
    }
    for (const r of neverGet) expect((await app.inject({ method: "GET", url: real(r) })).statusCode, r).toBe(200);
    for (const r of neverPost) expect((await app.inject({ method: "POST", url: real(r) })).statusCode, `POST ${r}`).toBe(200);
    // Not busy: the 7 checks are served as before.
    waiting = 0;
    for (const r of shed) expect((await app.inject({ method: "GET", url: real(r) })).statusCode, r).toBe(200);
    // Without a matched route pattern the poll list is never used (an unknown path is not shed as a poll).
    expect(sheddable("GET", "/api/v1/driver/surge-map")).toBe(false);
    stop();
    await app.close();
  });
});
