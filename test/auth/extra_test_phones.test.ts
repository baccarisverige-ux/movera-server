import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { MAX_EXTRA_TEST_PHONES, TEST_PHONES, parseExtraTestPhones, seedTestPhones, testPhonesFor } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/** Big test (owner 2026-11-03 "add even 100 numbers"): the staging server takes extra test numbers from its environment. */

const SECRET = "extra-test-phones-".padEnd(48, "x");
const staging = (extra?: string) => readEnv({ MOVERA_ENV: "staging", DATABASE_URL: "postgres://unused@localhost/x", JWT_SECRET: SECRET, ...(extra === undefined ? {} : { MOVERA_EXTRA_TEST_PHONES: extra }) });

describe("MOVERA_EXTRA_TEST_PHONES", () => {
  it("reads numbers and ranges (both ends included), in order, without repeats", () => {
    expect(parseExtraTestPhones("+46701740611-+46701740613, +33639980001,+46701740612")).toEqual(["+46701740611", "+46701740612", "+46701740613", "+33639980001"]);
    expect(parseExtraTestPhones(undefined)).toEqual([]);
    expect(parseExtraTestPhones(" , ")).toEqual([]);
    expect(staging("+46701740611-+46701740660,+46846500400-+46846500449,+33639980001-+33639980100").MOVERA_EXTRA_TEST_PHONES).toHaveLength(200);
  });

  it("refuses a wrong entry with what is wrong, so a bad deploy never starts", () => {
    expect(() => parseExtraTestPhones("0701740611")).toThrow(/not a number like/);
    expect(() => parseExtraTestPhones("+46701740620-+46701740611")).toThrow(/first number is after the last/);
    expect(() => parseExtraTestPhones("+4670174061-+46701740699")).toThrow(/same number of digits/);
    expect(() => parseExtraTestPhones("+46700000000-+46709999999")).toThrow(new RegExp(`more than ${MAX_EXTRA_TEST_PHONES}`));
    expect(() => staging("+46701740611-oops")).toThrow(/MOVERA_EXTRA_TEST_PHONES/);
  });

  it("is refused in production", () => {
    expect(() => readEnv({ MOVERA_ENV: "production", DATABASE_URL: "postgres://unused@localhost/x", JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64"), MOVERA_EXTRA_TEST_PHONES: "+46701740611" })).toThrow(/MOVERA_EXTRA_TEST_PHONES/);
  });

  it("start seeds the six plus the extra numbers outside production, none in production", () => {
    expect(testPhonesFor(staging("+46701740611-+46701740612"))).toEqual([...TEST_PHONES, "+46701740611", "+46701740612"]);
    expect(testPhonesFor(staging())).toEqual([...TEST_PHONES]);
    expect(testPhonesFor({ MOVERA_ENV: "production", MOVERA_EXTRA_TEST_PHONES: ["+46701740611"] })).toEqual([]);
  });
});

describe("signing in with an extra number", () => {
  let database: TestDatabase;
  let app: FastifyInstance;
  const extra = "+46701740611,+33639980001";

  beforeAll(async () => {
    database = await freshDatabase();
    app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db });
  });
  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { "content-type": "application/json" }, payload });

  it("is refused before it is seeded and works in both apps with the fixed code after", async () => {
    expect((await post("/auth/otp/request", { phone: "+33639980001", app: "driver" })).statusCode).toBe(403);
    await seedTestPhones(database.db, testPhonesFor(staging(extra)));
    for (const [phone, appName] of [["+33639980001", "driver"], ["+46701740611", "rider"]] as const) {
      const challenge = await post("/auth/otp/request", { phone, app: appName });
      expect(challenge.statusCode).toBe(200);
      const verify = await post("/auth/otp/verify", { phone, sessionId: challenge.json().sessionId, code: TEST_CODE });
      expect(verify.statusCode).toBe(200);
      expect(verify.json().actor).toBe(appName);
    }
  });
});
