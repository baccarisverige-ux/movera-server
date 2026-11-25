import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { FakeCodeSms, setSmsSignIn } from "../support/smsSignIn.js";

/**
 * Contract v0.18.133 (contract.json#smsSignIn) over a REAL listening port with node's own HTTP client (lesson of the
 * live outage 2026-11-17, server #268: app.inject() tests passed while every real POST hung). The sign-in POSTs now do
 * more work between the body and the answer (the SMS is handed to the SMS company before the answer), so each call
 * here must be fully answered within ANSWER_MS: with a quick SMS company, a slow one, a failing one, and as the real
 * main.ts with the two keys set (the country switch off: no SMS can go out, and 46elks is never called).
 */
const ANSWER_MS = 3000;
const SECRET = "h".repeat(40);
type Answer = { status: number; body: string; ms: number; headers: Record<string, unknown> };

function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const started = Date.now();
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, agent: false, headers: { ...(text !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - started, headers: res.headers });
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
    req.end(text);
  });
}
const json = (answer: Answer) => JSON.parse(answer.body) as Record<string, unknown>;
let n = 0;
const real = () => `+4670174${String(8000 + ++n)}`;

describe.each(["staging", "production"] as const)("real HTTP sign-in with SMS codes (MOVERA_ENV=%s)", (mode) => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  const sms = new FakeCodeSms();

  beforeAll(async () => {
    database = await freshDatabase();
    await seedTestPhones(database.db);
    await setSmsSignIn(database.db, "SE", { enabled: true });
    const env = readEnv({ MOVERA_ENV: mode, DATABASE_URL: database.url, JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64"), MIGRATE_ON_START: "false", TRUST_PROXY_HOPS: "1" });
    // As main.ts: the live load-shedding limits, registered by buildApp itself.
    app = await buildApp({ env, logger: false, db: database.db, signInSms: sms, shed: { maxPoolWaiting: env.SHED_POOL_WAITING, maxLoopDelayMs: env.SHED_LOOP_DELAY_MS, poolWaiting: () => database.pool.waitingCount } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  it("a real number: the code request and the code check are answered, and the code signs in", async () => {
    const phone = real();
    const asked = await call(base, "POST", "/api/v1/auth/otp/request", { phone, app: "rider", locale: "sv" });
    expect(asked.status, asked.body).toBe(200);
    expect(asked.ms).toBeLessThan(ANSWER_MS);
    expect(sms.sent.at(-1)?.to).toBe(phone);
    // Owner 2026-11-19 "6 digits (Rec.)": the answer tells the app the length, and the SMS code has it.
    expect(json(asked).codeLength).toBe(6);
    expect(sms.lastCode()).toMatch(/^[0-9]{6}$/);
    const wrong = await call(base, "POST", "/api/v1/auth/otp/verify", { phone, sessionId: json(asked).sessionId, code: sms.lastCode() === "000000" ? "000001" : "000000" });
    expect(wrong.status).toBe(400);
    const short = await call(base, "POST", "/api/v1/auth/otp/verify", { phone, sessionId: json(asked).sessionId, code: sms.lastCode().slice(0, 4) });
    expect(short.status).toBe(400);
    expect(json(short).reason).toBe("invalid_otp_code");
    const checked = await call(base, "POST", "/api/v1/auth/otp/verify", { phone, sessionId: json(asked).sessionId, code: sms.lastCode() });
    expect(checked.status, checked.body).toBe(200);
    expect(json(checked).accessToken).toBeTypeOf("string");
    expect(checked.ms).toBeLessThan(ANSWER_MS);
  });

  it("a slow SMS company: the answer still comes (after the company answered)", async () => {
    sms.delayMs = 700;
    try {
      const asked = await call(base, "POST", "/api/v1/auth/otp/request", { phone: real(), app: "driver" });
      expect(asked.status, asked.body).toBe(200);
      expect(asked.ms).toBeGreaterThanOrEqual(650);
      expect(asked.ms).toBeLessThan(ANSWER_MS);
    } finally {
      sms.delayMs = 0;
    }
  });

  it("a failing SMS company: 503 sms_not_sent with Retry-After, answered", async () => {
    sms.next = { accepted: false, status: 500 };
    try {
      const asked = await call(base, "POST", "/api/v1/auth/otp/request", { phone: real(), app: "rider" });
      expect(asked.status).toBe(503);
      expect(json(asked)).toMatchObject({ code: "unavailable", reason: "sms_not_sent", retryable: true });
      expect(asked.headers["retry-after"]).toBe("30");
    } finally {
      sms.next = { accepted: true };
    }
  });

  it("a number of a country that is off, and a number outside the served countries: 403 sign_in_restricted, answered", async () => {
    // v0.18.157 (smsSignIn.otherCountries, owner 2026-11-24): in the RIDER app such numbers get a code by default
    // (sms_other_countries.test.ts); the DRIVER app keeps the served countries only.
    for (const phone of ["+33639980001", "+4790000002"]) {
      const asked = await call(base, "POST", "/api/v1/auth/otp/request", { phone, app: "driver" });
      expect(asked.status, phone).toBe(403);
      expect(json(asked).reason).toBe("sign_in_restricted");
    }
  });

  it(mode === "staging" ? "a test number still signs in with the test code and gets no SMS" : "production has no test numbers: a test-list number is a real number", async () => {
    const before = sms.sent.length;
    const phone = TEST_PHONES[5]!;
    const asked = await call(base, "POST", "/api/v1/auth/otp/request", { phone, app: "rider" });
    expect(asked.status, asked.body).toBe(200);
    if (mode === "staging") {
      // The test server as it is today: 4 digits, said in the answer; no SMS.
      expect(json(asked).codeLength).toBe(4);
      expect(sms.sent.length).toBe(before);
      const checked = await call(base, "POST", "/api/v1/auth/otp/verify", { phone, sessionId: json(asked).sessionId, code: TEST_CODE });
      expect(checked.status, checked.body).toBe(200);
    } else {
      expect(json(asked).codeLength).toBe(6);
      expect(sms.sent.length).toBe(before + 1);
      const checked = await call(base, "POST", "/api/v1/auth/otp/verify", { phone, sessionId: json(asked).sessionId, code: TEST_CODE });
      expect(checked.status).toBe(400);
    }
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

// The whole start-up as deployed (src/main.ts), in its own process, with the two keys SET (dummy values) and every
// country switch off (the default): exactly the state right after the owner pastes the keys on Render. Nothing may
// change: a test number signs in, a real number is refused, and no call to 46elks is possible (no switch is on).
describe.each([
  ["both keys set", { ELKS_API_USERNAME: "u-dummy-not-a-real-key", ELKS_API_PASSWORD: "p-dummy-not-a-real-key" }],
  ["only one key set (a half-done paste)", { ELKS_API_USERNAME: "u-dummy-not-a-real-key" }],
  ["no key", {}],
] as const)("the real main.ts, %s, country switch off", (_name, keys) => {
  let database: TestDatabase;
  let server: ChildProcess;
  let base: string;
  let output = "";

  beforeAll(async () => {
    database = await freshDatabase();
    await seedTestPhones(database.db);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../src/main.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { PATH: process.env.PATH ?? "", MOVERA_ENV: "staging", HOST: "127.0.0.1", PORT: String(port), DATABASE_URL: database.url, JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64"), MIGRATE_ON_START: "false", LOG_LEVEL: "warn", ...keys },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-8000);
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
  }, 60_000);
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

  it("starts, /healthz is ok, a test number signs in, a real number is still refused", async () => {
    expect((await call(base, "GET", "/healthz")).status).toBe(200);
    const phone = TEST_PHONES[0]!;
    const asked = await call(base, "POST", "/api/v1/auth/otp/request", { phone, app: "rider" });
    expect(asked.status, asked.body).toBe(200);
    // With or without the keys the test numbers keep the 4-digit test code.
    expect(json(asked).codeLength).toBe(4);
    expect(TEST_CODE).toHaveLength(4);
    const checked = await call(base, "POST", "/api/v1/auth/otp/verify", { phone, sessionId: json(asked).sessionId, code: TEST_CODE });
    expect(checked.status, checked.body).toBe(200);
    const refused = await call(base, "POST", "/api/v1/auth/otp/request", { phone: "+46701748999", app: "rider" });
    expect(refused.status).toBe(403);
    expect(json(refused).reason).toBe("sign_in_restricted");
    // The key values never reach the log; a half-done paste is one warning that names the variable.
    expect(output).not.toContain("dummy-not-a-real-key");
    expect(output.includes("Only one of ELKS_API_USERNAME and ELKS_API_PASSWORD is set")).toBe(Object.keys(keys).length === 1);
  });
});
