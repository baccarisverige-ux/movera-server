import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readEnv } from "../../src/env.js";
import { registerLoadShedding } from "../../src/http/shed.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Live outage 2026-11-17 (server #268, Rules audits/impact/live-outage-2026-11-17-post-268.md): after the deploy every
 * POST on the live server got no answer (25 s), every GET did; app.inject() tests all passed. inject() hands the
 * server a ready request; a real socket delivers the body as a stream. So these calls go over a real listening port
 * with node's own HTTP client, with a JSON body, and each must be answered within ANSWER_MS.
 *
 * Cause: main.ts adds the load-shedding hooks (http/shed.ts) after buildApp. Its preHandler hook dropped a call
 * (no answer) when `request.raw.destroyed` was true, and node marks a request destroyed one tick after its body was
 * read to the end. While it was the only preHandler hook it ran in the same tick as the end of the body and saw
 * false; #268 put the write limit's async preHandler hook in front of it, so it ran a tick later and saw true.
 * So the app is started here the way main.ts starts it (hooks added after buildApp), and once as the real main.ts.
 */
const ANSWER_MS = 3000;
const SECRET = "p".repeat(40);

type Answer = { status: number; body: string; ms: number };

/** One real HTTP call; rejects when no full answer came within ANSWER_MS. */
function call(base: string, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<Answer> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, agent: false, headers: { ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - started });
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`${method} ${path}: no answer in ${ANSWER_MS} ms`));
    }, ANSWER_MS);
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(body);
  });
}

const POSTS = [
  ["refresh with an unknown token", "/api/v1/auth/refresh", JSON.stringify({ refreshToken: "not-a-real-token" }), {}, [401]],
  ["admin refresh with an unknown token", "/api/v1/admin/auth/refresh", JSON.stringify({ refreshToken: "not-a-real-token" }), {}, [401]],
  ["sign-in start (code request)", "/api/v1/auth/otp/request", JSON.stringify({ phone: "+46700000001", role: "rider" }), {}, [200, 202, 400, 422, 429]],
  ["sign-in code check", "/api/v1/auth/otp/verify", JSON.stringify({ phone: "+46700000001", code: "000000", role: "rider" }), {}, [400, 401, 422, 429]],
  ["driver location without a sign-in", "/api/v1/driver/location", JSON.stringify({ lat: 59.3, lng: 18.0 }), {}, [401]],
  ["driver location with a bad token", "/api/v1/driver/location", JSON.stringify({ lat: 59.3, lng: 18.0 }), { authorization: "Bearer nope" }, [401]],
  ["telemetry logs", "/api/v1/telemetry/logs", "{}", {}, [400, 401, 422]],
  ["push device without a sign-in", "/api/v1/push/devices", JSON.stringify({ token: "t", platform: "android" }), {}, [401]],
  ["sign-out with an empty JSON body", "/api/v1/auth/sign-out", "", { "content-type": "application/json" }, [200, 204, 400, 401]],
  ["bad JSON on refresh", "/api/v1/auth/refresh", "{", {}, [400]],
] as const;

// Staging is what the live test server runs (render.yaml); production counts the sign-in calls too (Q118).
describe.each(["staging", "production"] as const)("real HTTP POSTs are answered (MOVERA_ENV=%s)", (mode) => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;

  beforeAll(async () => {
    database = await freshDatabase();
    const env = readEnv({ MOVERA_ENV: mode, DATABASE_URL: database.url, JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64"), MIGRATE_ON_START: "false", TRUST_PROXY_HOPS: "1" });
    app = await buildApp({ env, logger: false, db: database.db });
    // As main.ts: the load-shedding hooks are added after the app was built.
    const stop = registerLoadShedding(app, { maxPoolWaiting: env.SHED_POOL_WAITING, maxLoopDelayMs: env.SHED_LOOP_DELAY_MS, poolWaiting: () => database.pool.waitingCount });
    app.addHook("onClose", async () => stop());
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  it("a GET is answered (the server is up)", async () => {
    expect((await call(base, "GET", "/healthz")).status).toBe(200);
  });

  it.each(POSTS)("POST %s", async (_name, path, body, headers, statuses) => {
    const answer = await call(base, "POST", path, body, headers);
    expect(statuses, `${path} answered ${answer.status} ${answer.body}`).toContain(answer.status);
    expect(answer.ms).toBeLessThan(ANSWER_MS);
  });
});

/** A free port on this machine (the real main.ts takes PORT, never 0). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

// The whole start-up as deployed (src/main.ts: pool, hub, timers, load shedding, listen), in its own process.
describe("real HTTP POSTs are answered by the real main.ts", () => {
  let database: TestDatabase;
  let server: ChildProcess;
  let base: string;
  let output = "";

  beforeAll(async () => {
    database = await freshDatabase();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../src/main.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { PATH: process.env.PATH ?? "", MOVERA_ENV: "staging", HOST: "127.0.0.1", PORT: String(port), DATABASE_URL: database.url, JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64"), MIGRATE_ON_START: "false", TRUST_PROXY_HOPS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4000);
    };
    server.stdout?.on("data", keep);
    server.stderr?.on("data", keep);
    const deadline = Date.now() + 50_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`main.ts stopped (${server.exitCode}): ${output}`);
      const up = await call(base, "GET", "/readyz").then((answer) => answer.status === 200, () => false);
      if (up) break;
      if (Date.now() > deadline) throw new Error(`main.ts did not start: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
  afterAll(async () => {
    if (server !== undefined && server.exitCode === null) {
      const gone = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      const killer = setTimeout(() => server.kill("SIGKILL"), 10_000);
      await gone;
      clearTimeout(killer);
    }
    await database?.drop();
  });

  it.each(POSTS)("POST %s", async (_name, path, body, headers, statuses) => {
    const answer = await call(base, "POST", path, body, headers);
    expect(statuses, `${path} answered ${answer.status} ${answer.body}`).toContain(answer.status);
    expect(answer.ms).toBeLessThan(ANSWER_MS);
  });
});
