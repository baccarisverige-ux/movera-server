import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { seedTestPhones, TEST_PHONES } from "../../src/auth/testPhones.js";
import { seedDriver } from "../../src/drivers/service.js";
import { readEnv } from "../../src/env.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * Contract v0.18.139 over a REAL listening port (as test/http/real_http_post.test.ts: app.inject() hands the server a
 * ready request, a real socket does not): the driver signs in with real HTTP calls and reads his wallet numbers —
 * GET /driver/earnings with moveraBalance and GET /driver/pay-movera — as the driver app does. Example Ali: 349,00 kr
 * cash in the car, own pay 325,16 kr → he owes Movera 23,84 kr. Fails on main: no moveraBalance, no route (404).
 */
const ANSWER_MS = 5000;
const SECRET = "w".repeat(40);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads the JSON answers field by field
type Json = any;

function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, agent: false, headers: { ...(text !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
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

describe("driver wallet numbers over real HTTP (v0.18.139)", () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  let driverId: string;
  let auth: Record<string, string>;
  const SEK = (amountMinor: number) => ({ amountMinor, currency: "SEK" });

  beforeAll(async () => {
    database = await freshDatabase();
    await seedTestPhones(database.db);
    const env = readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64"), MIGRATE_ON_START: "false", TRUST_PROXY_HOPS: "1" });
    // As main.ts: buildApp registers the live load-shedding hooks itself.
    app = await buildApp({ env, logger: false, db: database.db, shed: { maxPoolWaiting: env.SHED_POOL_WAITING, maxLoopDelayMs: env.SHED_LOOP_DELAY_MS, poolWaiting: () => database.pool.waitingCount } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const made = await database.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: TEST_PHONES[1]!, firstName: "Ali", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "WAL001", categoryIds: ["economy"], zoneIds: ["Z001"] }, new Date()),
    );
    driverId = made.driverId;
    await database.db.updateTable("drivers").set({ country: "SE" }).where("driver_id", "=", driverId).execute();
    const now = new Date();
    await database.db.insertInto("earnings_entries").values([
      { entry_id: "ern_rw1", driver_id: driverId, trip_id: null, kind: "trip", currency: "SEK", amount_minor: 20000, gross_minor: null, commission_minor: null, cash_minor: 21500, at: now },
      { entry_id: "ern_rw2", driver_id: driverId, trip_id: null, kind: "trip", currency: "SEK", amount_minor: 12516, gross_minor: null, commission_minor: null, cash_minor: 13400, at: now },
    ]).execute();
    const challenge = await call(base, "POST", "/api/v1/auth/otp/request", { phone: TEST_PHONES[1]!, app: "driver" });
    expect(challenge.status, JSON.stringify(challenge.json)).toBe(200);
    const verify = await call(base, "POST", "/api/v1/auth/otp/verify", { phone: TEST_PHONES[1]!, sessionId: challenge.json.sessionId, code: TEST_CODE });
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    auth = { authorization: `Bearer ${verify.json.accessToken}` };
  });
  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  it("GET /driver/earnings?period=week: cash collected 349,00 kr and moveraBalance owedToMovera 23,84 kr", async () => {
    const res = await call(base, "GET", "/api/v1/driver/earnings?period=week", undefined, auth);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.currency).toBe("SEK");
    expect(res.json.periods).toHaveLength(1);
    expect(res.json.periods[0].cashCollected).toEqual(SEK(34900));
    expect(res.json.periods[0].net).toEqual(SEK(32516));
    expect(res.json.moveraBalance).toEqual({ owedToMovera: SEK(2384), moveraOwesYou: SEK(0) });
  });

  it("GET /driver/pay-movera: the same amount, the reference; off by default (no link)", async () => {
    const res = await call(base, "GET", "/api/v1/driver/pay-movera", undefined, auth);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.enabled).toBe(false);
    expect(res.json.owedToMovera).toEqual(SEK(2384));
    expect(res.json.reference).toMatch(new RegExp(`^${driverId}-\\d{6}$`));
    expect(res.json.payLink).toBeUndefined();
  });

  it("on (the admin's live setting): the payment link comes as it is", async () => {
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-SE", version: 1, document: JSON.stringify({ country: "SE", currency: "SEK", driverPayRequest: { enabled: true, dayOfMonth: 1, payLink: "https://pay.sumup.com/b2c/MOVERA1", minAmount: SEK(0) } }), published_at: new Date(), published_by: null }).execute();
    const res = await call(base, "GET", "/api/v1/driver/pay-movera", undefined, auth);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ enabled: true, payLink: "https://pay.sumup.com/b2c/MOVERA1", minAmount: SEK(0), owedToMovera: SEK(2384) });
  });

  it("no sign-in: 401 on both", async () => {
    expect((await call(base, "GET", "/api/v1/driver/pay-movera")).status).toBe(401);
    expect((await call(base, "GET", "/api/v1/driver/earnings?period=week")).status).toBe(401);
  });
});
