import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { isDatabaseBusy } from "../src/db/db.js";
import { registerLoadShedding } from "../src/http/shed.js";

/** Job 1 (stress H3, fix plan R22): back-pressure instead of an endless queue. */
describe("load shedding", () => {
  it("answers 503 server_busy with Retry-After while the pool queue is over the limit, and serves again after", async () => {
    let waiting = 500;
    const app = Fastify();
    app.get("/api/v1/x", async () => ({ ok: true }));
    const stop = registerLoadShedding(app, { maxPoolWaiting: 200, maxLoopDelayMs: 0, poolWaiting: () => waiting });
    const busy = await app.inject({ method: "GET", url: "/api/v1/x" });
    expect(busy.statusCode).toBe(503);
    expect(busy.headers["retry-after"]).toBe("2");
    expect(busy.json()).toMatchObject({ code: "unavailable", reason: "server_busy", retryable: true });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(404); // never shed (no route here)
    waiting = 0;
    expect((await app.inject({ method: "GET", url: "/api/v1/x" })).statusCode).toBe(200);
    stop();
    await app.close();
  });

  it("tells database overload apart from bugs", () => {
    expect(isDatabaseBusy(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDatabaseBusy(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }))).toBe(true);
    expect(isDatabaseBusy(Object.assign(new Error("lock timeout"), { code: "55P03" }))).toBe(true);
    expect(isDatabaseBusy(new Error("syntax error"))).toBe(false);
  });
});
