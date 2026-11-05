import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { TEST_PHONES, seedTestPhones, testPhonesFor } from "../../src/auth/testPhones.js";
import { TEST_CODES_PER_MINUTE } from "../../src/auth/service.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Owner 2026-11-04 (load test): on STAGING a configured test number signs in with no resend wait and no hourly code
 * limit, under a cap of TEST_CODES_PER_MINUTE per number. Production keeps every OTP limit.
 */
let database: TestDatabase;
let staging: FastifyInstance;
let production: FastifyInstance;
const clock = { now: new Date("2026-11-04T10:00:00Z") };
const SECRET = "fast-test-signin".padEnd(48, "f");
let n = 0;

beforeAll(async () => {
  database = await freshDatabase();
  staging = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, clock: () => clock.now });
  production = await buildApp({ env: readEnv({ MOVERA_ENV: "production", DATABASE_URL: database.url, JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64") }), logger: false, db: database.db, clock: () => clock.now });
  await seedTestPhones(database.db, testPhonesFor(readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET })));
});
afterAll(async () => {
  await staging.close();
  await production.close();
  await database.drop();
});

const ask = (app: FastifyInstance, phone: string) =>
  app.inject({ method: "POST", url: "/api/v1/auth/otp/request", headers: { "content-type": "application/json", "idempotency-key": `fast-key-${String(++n).padStart(8, "0")}` }, payload: { phone, app: "rider" } });

describe("staging test numbers: no resend wait (owner 2026-11-04)", () => {
  it("asks again at once, past the hourly limit, with retryAfterSeconds 0 (fail-before: 429 otp_resend_too_soon)", async () => {
    const phone = TEST_PHONES[0]!;
    const first = await ask(staging, phone);
    expect(first.statusCode).toBe(200);
    expect(first.json().retryAfterSeconds).toBe(0);
    for (let i = 1; i < 12; i++) expect((await ask(staging, phone)).statusCode).toBe(200);
  });

  it("keeps a safety cap per number per minute", async () => {
    const phone = TEST_PHONES[1]!;
    for (let i = 0; i < TEST_CODES_PER_MINUTE; i++) expect((await ask(staging, phone)).statusCode).toBe(200);
    const over = await ask(staging, phone);
    expect(over.statusCode).toBe(429);
    expect(over.json().reason).toBe("otp_too_many");
    clock.now = new Date(clock.now.getTime() + 61_000);
    expect((await ask(staging, phone)).statusCode).toBe(200);
  });

  it("production is unchanged: test numbers are refused there, whatever env says", async () => {
    const res = await ask(production, TEST_PHONES[2]!);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("sign_in_restricted");
  });
});
