import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { PHONE_WRONG_CODES_CEILING_FACTOR, TEST_CODE } from "../../src/auth/service.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { COUNTRY_LIMITS } from "../../src/config/countryLimits.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * S7 W2 Q118 (owner 2026-11-15 "Yes, phone + address"): wrong sign-in codes are locked per number AND address
 * (wrongCodesPerDay), and the number alone has a high ceiling, so guessing one number's code from many addresses stops.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-16T09:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "development", DATABASE_URL: database.url, JWT_SECRET: "q118".padEnd(48, "q") }), logger: false, db: database.db, clock: () => clock.now });
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

const post = (url: string, payload: unknown, remoteAddress: string) => app.inject({ method: "POST", url: `/api/v1${url}`, remoteAddress, headers: { "content-type": "application/json" }, payload: payload as object });

describe("Q118: wrong codes for one number from many addresses", () => {
  it("hits the number's ceiling; every address is then locked for that number, another number is not", async () => {
    const phone = TEST_PHONES[0]!;
    const perAddress = COUNTRY_LIMITS.defaults.wrongCodesPerDay;
    const ceiling = perAddress * PHONE_WRONG_CODES_CEILING_FACTOR;
    let wrong = 0;
    let last;
    // 4 wrong codes per code and address: no address comes near its own lock (15).
    for (let n = 0; wrong < ceiling; n++) {
      advance(400);
      const address = `203.0.115.${n}`;
      const challenge = (await post("/auth/otp/request", { phone, app: "rider" }, address)).json();
      expect(challenge.sessionId, `code ${n} after ${wrong} wrong`).toBeTypeOf("string");
      for (let i = 0; i < 4 && wrong < ceiling; i++, wrong++) {
        last = await post("/auth/otp/verify", { phone, sessionId: challenge.sessionId, code: "0000" }, address);
        if (wrong < ceiling - 1) expect(last.json().reason, `wrong code ${wrong}`).toBe("invalid_otp_code");
      }
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.json()).toMatchObject({ code: "rate_limited", reason: "otp_locked_today" });
    // A new address cannot ask for a code for this number any more.
    advance(400);
    const fresh = await post("/auth/otp/request", { phone, app: "rider" }, "198.51.100.250");
    expect(fresh.statusCode).toBe(429);
    expect(fresh.json()).toMatchObject({ reason: "otp_locked_today" });
    // Another number from one of the same addresses signs in.
    const other = (await post("/auth/otp/request", { phone: TEST_PHONES[1]!, app: "rider" }, "203.0.115.0")).json();
    expect((await post("/auth/otp/verify", { phone: TEST_PHONES[1]!, sessionId: other.sessionId, code: TEST_CODE }, "203.0.115.0")).statusCode).toBe(200);
    // The window passes: the number is free again.
    advance(25 * 3600);
    expect((await post("/auth/otp/request", { phone, app: "rider" }, "198.51.100.250")).statusCode).toBe(200);
  });
});
