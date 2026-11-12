import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { isDatabaseBusy } from "../src/db/db.js";
import { registerLoadShedding, sheddable } from "../src/http/shed.js";

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
});
