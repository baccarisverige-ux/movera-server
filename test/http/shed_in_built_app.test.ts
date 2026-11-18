import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * #268 post-mortem (Rules audits/impact/live-outage-2026-11-17-*.md): the load-shedding hooks (http/shed.ts) used to be
 * added only by main.ts after buildApp, so no inject() test ran them and #268 passed CI while every live POST got no
 * answer. buildApp now registers them itself, so EVERY test app has them. This file proves both: the hooks are in the
 * built app, and a POST with a body through the real routes and the real hooks (Q118 write limit first, shed last) is
 * answered over a real socket (inject() never marks the request destroyed, so it cannot show this). With the old
 * `request.raw.destroyed` check back in shed.ts these POSTs get no answer and this file fails. The app gets NO shed
 * option here: the defaults every test app now has must already carry the hook.
 */
const SECRET = "q".repeat(40);
const ANSWER_MS = 3000;

/** One real HTTP POST with a JSON body; rejects when no full answer came within ANSWER_MS. */
function post(base: string, path: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.setTimeout(ANSWER_MS, () => {
      req.destroy();
      reject(new Error(`POST ${path}: no answer in ${ANSWER_MS} ms`));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("the built app carries the production load-shedding hooks", () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let plain: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let waiting = 0;

  beforeAll(async () => {
    database = await freshDatabase();
    const env = readEnv({ MOVERA_ENV: "production", DATABASE_URL: database.url, JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64"), MIGRATE_ON_START: "false", TRUST_PROXY_HOPS: "1" });
    app = await buildApp({ env, logger: false, db: database.db, shed: { maxPoolWaiting: 200, maxLoopDelayMs: 0, poolWaiting: () => waiting } });
    // As every other test app: buildApp without a shed option (limits off, gone-client hooks on).
    plain = await buildApp({ env, logger: false, db: database.db });
    await plain.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(plain.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    await plain.close();
    await database.drop();
  });

  it("sheds an admin list while the pool queue is over the limit (the hooks are registered by buildApp)", async () => {
    waiting = 500;
    const busy = await app.inject({ method: "GET", url: "/api/v1/admin/trips" });
    waiting = 0;
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toMatchObject({ reason: "server_busy" });
  });

  it.each([
    ["/api/v1/auth/refresh", { refreshToken: "x" }, [400, 401]],
    ["/api/v1/auth/otp/request", { phone: "+46700000000" }, [200, 202, 400, 403, 422, 429]],
    ["/api/v1/telemetry/logs", { entries: [] }, [200, 202, 204, 400, 401]],
    ["/api/v1/driver/location", { lat: 59.3, lng: 18.0 }, [400, 401]],
  ] as const)("POST %s with a body is answered over a real socket through every hook", async (url, payload, statuses) => {
    const status = await post(base, url, JSON.stringify(payload));
    expect(statuses as readonly number[]).toContain(status);
  });
});
