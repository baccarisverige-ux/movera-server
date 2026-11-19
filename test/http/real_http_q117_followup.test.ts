import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { signAccessToken } from "../../src/auth/jwt.js";
import { startSession } from "../../src/auth/service.js";
import { readEnv } from "../../src/env.js";
import { SIGN_IN_CEILING_FACTOR } from "../../src/http/rateLimit.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * S7 W2 Q117 / Q118 follow-up SF-1 + SF-2 (contract v0.18.132 rateLimit.key) over a real listening port, as
 * test/http/real_http_post.test.ts does (the 2026-11-17 outage passed every app.inject() test): the app is built as
 * main.ts builds it (load-shedding hooks included), every call is a real socket with a streamed JSON body, and each
 * must be answered within ANSWER_MS. SF-1: a bearer token on the sign-in / refresh calls does not skip the phone or
 * session + address key or the ceilings. SF-2: a body that cannot be read counts against the address at 1 x.
 */
const ANSWER_MS = 3000;
const SECRET = "q".repeat(40);
const BUDGET = 2;
const CEILING = BUDGET * SIGN_IN_CEILING_FACTOR;

type Answer = {
  status: number;
  body: string;
  ms: number;
  retryAfter: string | undefined;
};

function call(
  base: string,
  path: string,
  ip: string,
  body: string,
  bearer?: string,
): Promise<Answer> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "x-forwarded-for": ip,
    };
    if (bearer !== undefined) headers["authorization"] = `Bearer ${bearer}`;
    const req = httpRequest(
      `${base}/api/v1${path}`,
      { method: "POST", agent: false, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          clearTimeout(timer);
          const retry = res.headers["retry-after"];
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            ms: Date.now() - started,
            retryAfter: Array.isArray(retry) ? retry[0] : retry,
          });
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`POST ${path}: no answer in ${ANSWER_MS} ms`));
    }, ANSWER_MS);
    // A server that answers before the whole (too large) body is sent may close the socket under the writer.
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ECONNRESET") return;
      clearTimeout(timer);
      reject(error);
    });
    req.end(body);
  });
}

const live = (sub: string) =>
  signAccessToken(
    { sub, actor: "rider", sid: `s-${sub}`, zones: ["Z001"] },
    SECRET,
    900,
    new Date(),
  );
const expired = (sub: string) =>
  signAccessToken(
    { sub, actor: "rider", sid: `s-${sub}`, zones: ["Z001"] },
    SECRET,
    900,
    new Date(Date.now() - 960_000),
  );
const phone = (n: number) => `+4672${String(1_000_000 + n)}`;
const json = (value: unknown) => JSON.stringify(value);

describe("Q117 follow-up SF-1 + SF-2 over real HTTP (production, load shedding on)", () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;

  beforeAll(async () => {
    database = await freshDatabase();
    const env = readEnv({
      MOVERA_ENV: "production",
      DATABASE_URL: database.url,
      JWT_SECRET: SECRET,
      DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64"),
      MIGRATE_ON_START: "false",
      TRUST_PROXY_HOPS: "1",
      RATE_LIMIT_WRITES_PER_ADDRESS_PER_MINUTE: String(BUDGET),
      RATE_LIMIT_WRITES_PER_USER_PER_MINUTE: "1000",
    });
    app = await buildApp({
      env,
      logger: false,
      db: database.db,
      shed: {
        maxPoolWaiting: env.SHED_POOL_WAITING,
        maxLoopDelayMs: env.SHED_LOOP_DELAY_MS,
        poolWaiting: () => database.pool.waitingCount,
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  const run = async (n: number, send: (i: number) => Promise<Answer>) => {
    const answers: Answer[] = [];
    for (let i = 0; i < n; i++) answers.push(await send(i));
    for (const answer of answers) expect(answer.ms).toBeLessThan(ANSWER_MS);
    return answers;
  };

  it("SF-1: a valid token on the code call is keyed by phone + address (429 after the address budget)", async () => {
    const codes = (
      await run(BUDGET + 1, (i) =>
        call(
          base,
          "/auth/otp/request",
          "198.51.100.10",
          json({ phone: phone(1), app: "rider" }),
          live(`R-rh-${i}`),
        ),
      )
    ).map((a) => a.status);
    expect(codes.slice(0, BUDGET)).not.toContain(429);
    expect(codes[BUDGET]).toBe(429);
  });

  it("SF-1: an expired token on the code check is keyed by phone + address", async () => {
    const answers = await run(BUDGET + 1, (i) =>
      call(
        base,
        "/auth/otp/verify",
        "198.51.100.11",
        json({ phone: phone(2), sessionId: "none", code: "0000" }),
        expired(`R-rhx-${i}`),
      ),
    );
    expect(answers.slice(0, BUDGET).map((a) => a.status)).not.toContain(429);
    expect(answers[BUDGET]!.status).toBe(429);
    expect(JSON.parse(answers[BUDGET]!.body)).toMatchObject({
      code: "rate_limited",
      reason: "too_many_requests",
    });
    expect(Number(answers[BUDGET]!.retryAfter)).toBeGreaterThan(0);
  });

  it("SF-1: one token from many addresses still hits the phone ceiling", async () => {
    const token = live("R-rh-ceiling");
    const codes = (
      await run(CEILING + 1, (n) =>
        call(
          base,
          "/auth/otp/verify",
          `203.0.116.${n}`,
          json({ phone: phone(3), sessionId: "none", code: "0000" }),
          token,
        ),
      )
    ).map((a) => a.status);
    expect(codes.slice(0, CEILING)).not.toContain(429);
    expect(codes[CEILING]).toBe(429);
  });

  it("SF-1: refresh with a valid token is keyed by the refresh token's session + address", async () => {
    let refreshToken = await database.db
      .transaction()
      .execute(
        async (trx) =>
          (
            await startSession(
              trx,
              { jwtSecret: SECRET },
              { actor: "rider", subjectId: "R-rh-refresh", zones: [] },
              {},
              new Date(),
            )
          ).refreshToken,
      );
    for (let i = 0; i < BUDGET; i++) {
      const answer = await call(
        base,
        "/auth/refresh",
        "198.51.100.12",
        json({ refreshToken }),
        live(`R-rh-r${i}`),
      );
      expect(answer.status, answer.body).toBe(200);
      refreshToken = (JSON.parse(answer.body) as { refreshToken: string })
        .refreshToken;
    }
    expect(
      (
        await call(
          base,
          "/auth/refresh",
          "198.51.100.12",
          json({ refreshToken }),
          live("R-rh-rlast"),
        )
      ).status,
    ).toBe(429);
  });

  it("SF-2: bad JSON on the code call is 400 within the address budget, then 429 on the same address key", async () => {
    const answers = await run(BUDGET + 1, () =>
      call(base, "/auth/otp/request", "198.51.100.13", "{not json"),
    );
    expect(answers.map((a) => a.status)).toEqual([
      ...Array<number>(BUDGET).fill(400),
      429,
    ]);
    expect(Number(answers[BUDGET]!.retryAfter)).toBeGreaterThan(0);
    // Same key as a body without a phone; a phone on that address keeps its own budget.
    expect(
      (
        await call(
          base,
          "/auth/otp/request",
          "198.51.100.13",
          json({ app: "rider" }),
        )
      ).status,
    ).toBe(429);
    expect(
      (
        await call(
          base,
          "/auth/otp/request",
          "198.51.100.13",
          json({ phone: phone(4), app: "rider" }),
        )
      ).status,
    ).not.toBe(429);
  });

  it("SF-2: bad JSON on refresh with a token counts on the address too", async () => {
    const answers = await run(BUDGET + 1, (i) =>
      call(base, "/auth/refresh", "198.51.100.14", "{", live(`R-rh-b${i}`)),
    );
    expect(answers.map((a) => a.status)).toEqual([
      ...Array<number>(BUDGET).fill(400),
      429,
    ]);
  });

  it("SF-2: a body over 1 MB on admin refresh is answered and counts (400 body_too_large, then 429)", async () => {
    const big = json({ refreshToken: "x".repeat(1024 * 1024 + 10) });
    const answers = await run(BUDGET + 1, () =>
      call(base, "/admin/auth/refresh", "198.51.100.15", big),
    );
    expect(answers.map((a) => a.status)).toEqual([400, 400, 429]);
    expect(
      answers.map((a) => (JSON.parse(a.body) as { reason: string }).reason),
    ).toEqual(["body_too_large", "body_too_large", "too_many_requests"]);
  });

  it("other writes on the same addresses are still answered (no hang)", async () => {
    const answer = await call(
      base,
      "/driver/location",
      "198.51.100.16",
      json({ lat: 59.3, lng: 18.0 }),
    );
    expect(answer.status).toBe(401);
  });
});

describe("contract v0.18.132 rateLimit.key states SF-1 + SF-2", () => {
  it("names the token-not-read rule and the unreadable-body count, and keeps the v0.18.119 text", () => {
    const rl = (
      JSON.parse(
        readFileSync(
          new URL("../../contracts/contract.json", import.meta.url),
          "utf8",
        ),
      ) as { rateLimit: Record<string, string> }
    ).rateLimit;
    expect(rl["key"]).toContain(
      "a valid or expired token is not read on these four calls",
    );
    expect(rl["key"]).toContain(
      "counts against the client address at the address budget: over it, 429 rate_limited instead of the 400",
    );
    expect(rl["keyBefore0_18_132"]).toContain(
      "Without a token, POST /auth/otp/request",
    );
  });
});
