import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { WAITLIST_PER_IP_PER_HOUR } from "../../src/auth/waitlist.js";
import { contract } from "../../src/contract/contract.js";
import { readEnv } from "../../src/env.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/** Contract v0.15.0 §24 (owner 2026-10-29, sign-in group 1): the waiting list (decision 5) and test accounts (decision 6). */

let database: TestDatabase;
let app: FastifyInstance;
let production: FastifyInstance;
const clock = { now: new Date("2026-10-29T10:00:00Z") };
const advance = (seconds: number) => (clock.now = new Date(clock.now.getTime() + seconds * 1000));
const SECRET = "test-secret-".padEnd(48, "x");
let ipCounter = 0;
const freshIp = () => `10.9.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, clock: () => clock.now });
  production = await buildApp({
    env: readEnv({ MOVERA_ENV: "production", DATABASE_URL: database.url, JWT_SECRET: SECRET, DOCUMENT_FILES_KEY: Buffer.alloc(32, 7).toString("base64") }),
    logger: false,
    db: database.db,
    clock: () => clock.now,
  });
});
afterAll(async () => {
  await app.close();
  await production.close();
  await database.drop();
});
beforeEach(() => {
  advance(3600);
});

function join(payload: unknown, ip = freshIp(), server: FastifyInstance = app) {
  return server.inject({ method: "POST", url: "/api/v1/auth/waitlist", remoteAddress: ip, headers: { "content-type": "application/json" }, payload: payload as object });
}

type Auth = { waitlist: { perIpPerHour: number }; testAccounts: { statuses: string[] } };
const AUTH = (contract as unknown as { auth: Auth }).auth;

describe("POST /auth/waitlist", () => {
  it("the limit is the contract's", () => {
    expect(WAITLIST_PER_IP_PER_HOUR).toBe(AUTH.waitlist.perIpPerHour);
  });

  it("saves a restricted number (also on production, where every number is restricted)", async () => {
    const restricted = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", headers: { "content-type": "application/json" }, payload: { phone: "+46705550101", app: "driver" } });
    expect(restricted.json()).toMatchObject({ reason: "sign_in_restricted" });
    const res = await join({ phone: "+46705550101", app: "driver", locale: "sv" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "saved", requestId: expect.any(String) });
    const prod = await join({ phone: "+33612345678", app: "rider", locale: "fr" }, freshIp(), production);
    expect(prod.statusCode).toBe(200);
    const rows = await database.db.selectFrom("sign_in_waitlist").selectAll().where("phone", "in", ["+46705550101", "+33612345678"]).orderBy("phone").execute();
    expect(rows.map((r) => [r.phone, r.app, r.locale, r.count])).toEqual([
      ["+33612345678", "rider", "fr", 1],
      ["+46705550101", "driver", "sv", 1],
    ]);
  });

  it("asking again keeps one row: count and lastAt go up, firstAt stays", async () => {
    await join({ phone: "+46705550202", app: "rider" });
    const first = clock.now.toISOString();
    advance(120);
    await join({ phone: "+46705550202", app: "rider", locale: "en" });
    const row = await database.db.selectFrom("sign_in_waitlist").selectAll().where("phone", "=", "+46705550202").executeTakeFirstOrThrow();
    expect(row.count).toBe(2);
    expect(row.first_at.toISOString()).toBe(first);
    expect(row.last_at.toISOString()).toBe(clock.now.toISOString());
    expect(row.locale).toBe("en");
  });

  it.each([
    [{ phone: "0701234567", app: "rider" }, "invalid_phone"],
    [{ phone: "+46705550303" }, "invalid_body"],
    [{ phone: "+46705550303", app: "admin" }, "invalid_body"],
    [{ phone: "+46705550303", app: "rider", locale: "de" }, "invalid_body"],
  ])("%j is 400 %s", async (payload, reason) => {
    const res = await join(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_request", reason });
  });

  it("is rate limited per address: 429 waitlist_too_many with Retry-After", async () => {
    const ip = freshIp();
    for (let n = 0; n < WAITLIST_PER_IP_PER_HOUR; n++) {
      expect((await join({ phone: `+4670555${String(1000 + n)}`, app: "rider" }, ip)).statusCode).toBe(200);
    }
    advance(600);
    const res = await join({ phone: "+46705559999", app: "rider" }, ip);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: "rate_limited", reason: "waitlist_too_many" });
    expect(res.headers["retry-after"]).toBe("3000");
    expect((await join({ phone: "+46705559999", app: "rider" })).statusCode).toBe(200);
  });
});

describe("GET /admin/waitlist", () => {
  it("lists newest first, pages with a cursor, filters by app; needs an admin", async () => {
    await join({ phone: "+46705551111", app: "driver" });
    advance(1);
    await join({ phone: "+46705552222", app: "rider", locale: "sv" });
    advance(1);
    await join({ phone: "+46705553333", app: "driver" });
    // v0.18.54 §76: the full number only with riders.viewSensitive (support); a viewer gets it masked.
    const admin = await adminSession(app, database.db, "support", { now: clock.now });
    const viewer = await adminSession(app, database.db, "viewer", { now: clock.now });
    const masked = await app.inject({ method: "GET", url: "/api/v1/admin/waitlist?limit=1", headers: viewer.headers });
    expect(masked.statusCode).toBe(200);
    expect((masked.json() as { items: { phone: string }[] }).items.map((i) => i.phone)).toEqual(["+46\u2022\u2022\u2022\u2022\u2022\u2022\u202233"]);
    const page = await app.inject({ method: "GET", url: "/api/v1/admin/waitlist?limit=2", headers: admin.headers });
    expect(page.statusCode).toBe(200);
    const body = page.json() as { items: { phone: string; app: string; count: number; firstAt: string; lastAt: string; locale?: string }[]; nextCursor: string | null };
    expect(body.items.map((i) => i.phone)).toEqual(["+46705553333", "+46705552222"]);
    expect(body.items[1]).toEqual({ phone: "+46705552222", app: "rider", locale: "sv", count: 1, firstAt: expect.any(String), lastAt: expect.any(String) });
    expect(body.nextCursor).not.toBeNull();
    const next = await app.inject({ method: "GET", url: `/api/v1/admin/waitlist?limit=2&cursor=${body.nextCursor}`, headers: admin.headers });
    expect((next.json() as typeof body).items[0]!.phone).toBe("+46705551111");
    const drivers = await app.inject({ method: "GET", url: "/api/v1/admin/waitlist?app=driver&limit=200", headers: admin.headers });
    expect((drivers.json() as typeof body).items.every((i) => i.app === "driver")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/waitlist" })).statusCode).toBe(401);
  });
});

describe("GET /auth/test-accounts", () => {
  it("lists every test number per app with its account's status (test before the first sign-in)", async () => {
    const [riderPhone, driverPhone] = TEST_PHONES as [string, string];
    await database.db.insertInto("riders").values({ rider_id: "rdr_testacct1", phone: riderPhone, email: null, language: null, first_name: "Ada" }).execute();
    await database.db.insertInto("drivers").values({ driver_id: "drv_testacct1", phone: driverPhone, online_since: null, vehicle_id: null, scheduled_rides: null }).execute();
    const admin = await adminSession(app, database.db, "viewer", { now: clock.now });
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/test-accounts", headers: admin.headers });
    expect(res.statusCode).toBe(200);
    const accounts = (res.json() as { accounts: { phone: string; app: string; status: string; name?: string }[] }).accounts;
    expect(accounts).toHaveLength(TEST_PHONES.length * 2);
    expect(accounts).toContainEqual({ phone: riderPhone, app: "rider", status: "active", name: "Ada" });
    expect(accounts).toContainEqual({ phone: driverPhone, app: "driver", status: "pending" });
    expect(accounts).toContainEqual({ phone: riderPhone, app: "driver", status: "test" });
    for (const account of accounts) expect(AUTH.testAccounts.statuses).toContain(account.status);
  });

  it("owner 2026-11-03: needs a signed-in admin (401 signed out or with a bad token)", async () => {
    const signedOut = await app.inject({ method: "GET", url: "/api/v1/auth/test-accounts" });
    expect(signedOut.statusCode).toBe(401);
    expect(signedOut.body).not.toContain(TEST_PHONES[0] as string);
    const bogus = await app.inject({ method: "GET", url: "/api/v1/auth/test-accounts", headers: { authorization: "Bearer not-a-token" } });
    expect(bogus.statusCode).toBe(401);
  });

  it("does not exist on production (404)", async () => {
    const res = await production.inject({ method: "GET", url: "/api/v1/auth/test-accounts" });
    expect(res.statusCode).toBe(404);
  });
});
