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

/**
 * Wrong codes for `phone` from many addresses (`net`.0, `net`.1, ...; 4 per code, so no address nears its own lock of
 * wrongCodesPerDay) until the number's ceiling is reached. Returns the last answer and the code it was sent on: that
 * code is still open (4 of 5 tries used).
 */
async function fillCeiling(phone: string, net: string) {
  const ceiling = COUNTRY_LIMITS.defaults.wrongCodesPerDay * PHONE_WRONG_CODES_CEILING_FACTOR;
  let wrong = 0;
  let last;
  let challenge: { sessionId: string } = { sessionId: "" };
  let address = "";
  for (let n = 0; wrong < ceiling; n++) {
    advance(400);
    address = `${net}.${n}`;
    challenge = (await post("/auth/otp/request", { phone, app: "rider" }, address)).json();
    expect(challenge.sessionId, `code ${n} after ${wrong} wrong`).toBeTypeOf("string");
    for (let i = 0; i < 4 && wrong < ceiling; i++, wrong++) {
      last = await post("/auth/otp/verify", { phone, sessionId: challenge.sessionId, code: "0000" }, address);
      if (wrong < ceiling - 1) expect(last.json().reason, `wrong code ${wrong}`).toBe("invalid_otp_code");
    }
  }
  return { last: last!, sessionId: challenge.sessionId, address };
}

describe("Q118: wrong codes for one number from many addresses", () => {
  it("hits the number's ceiling; every address is then locked for that number, another number is not", async () => {
    const phone = TEST_PHONES[0]!;
    const { last } = await fillCeiling(phone, "203.0.115");
    expect(last.statusCode).toBe(429);
    expect(last.json()).toMatchObject({ code: "rate_limited", reason: "otp_locked_today" });
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

  it("at the ceiling, the RIGHT code on a code still open is refused too (supervisor MF-1 a, mutant M1d)", async () => {
    const phone = TEST_PHONES[2]!;
    const { last, sessionId, address } = await fillCeiling(phone, "203.0.116");
    expect(last.json()).toMatchObject({ reason: "otp_locked_today" });
    // The code is open (4 of 5 tries) and this address is far under its own lock: only the number's ceiling refuses it.
    const right = await post("/auth/otp/verify", { phone, sessionId, code: TEST_CODE }, address);
    expect(right.statusCode, right.body).toBe(429);
    expect(right.json()).toMatchObject({ code: "rate_limited", reason: "otp_locked_today" });
    expect(Number(right.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("an admin unlock lifts the number's lock for every address at once (supervisor SF-4)", async () => {
    const phone = TEST_PHONES[3]!;
    expect((await fillCeiling(phone, "203.0.117")).last.json()).toMatchObject({ reason: "otp_locked_today" });
    advance(400);
    expect((await post("/auth/otp/request", { phone, app: "rider" }, "198.51.100.251")).json()).toMatchObject({ reason: "otp_locked_today" });
    const { adminSession } = await import("../support/admin.js");
    const sup = await adminSession(app, database.db, "super", { now: clock.now });
    const unlock = await app.inject({ method: "POST", url: "/api/v1/admin/auth/sign-in-locks/unlock", remoteAddress: "198.51.100.9", headers: { ...sup.headers, "content-type": "application/json" }, payload: { phone } });
    expect(unlock.statusCode, unlock.body).toBe(200);
    expect(unlock.json().lifted).toBeGreaterThan(0);
    // Well inside the 24 h window, a new address (and one of the guessing ones) signs in with the right code.
    for (const address of ["198.51.100.251", "203.0.117.0"]) {
      advance(400);
      const challenge = await post("/auth/otp/request", { phone, app: "rider" }, address);
      expect(challenge.statusCode, `${address}: ${challenge.body}`).toBe(200);
      expect((await post("/auth/otp/verify", { phone, sessionId: challenge.json().sessionId, code: TEST_CODE }, address)).statusCode, address).toBe(200);
    }
  });
});
