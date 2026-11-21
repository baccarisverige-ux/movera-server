import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_REVOKED_CHANNEL, SessionCache, sessionCache } from "../../src/auth/sessionCache.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { call, fixedRouter, signIn } from "../support/world.js";

/**
 * S4c fix 3 (Rules audits/impact/stress-s4b-2026-11-20.md "S4c": one auth_sessions read per request): each server
 * copy keeps "this rider / driver session is active" for at most SESSION_CACHE_MS (default 5000, 0 = off, only with
 * a LISTEN hub). Every revoke NOTIFYs movera_session_revoked at commit, so a revoked session is refused at once on
 * every copy; a change that sends no NOTIFY (a hand edit) is refused within the window at the latest.
 */
let database: TestDatabase;
let app: FastifyInstance;
let hub: NotificationHub;
const clock = { now: new Date("2026-11-20T09:00:00Z") };

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  hub = new NotificationHub(database.url, [SESSION_REVOKED_CHANNEL]);
  await hub.start();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "session-cache-secret".padEnd(48, "s") }), logger: false, db: database.db, clock: () => clock.now, router: fixedRouter, hub });
});
afterAll(async () => {
  await app.close();
  await hub.stop();
  await database.drop();
});

const until = async (check: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await check()) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return check();
};
const profile = (headers: Record<string, string>) => call(app, "GET", "/rider/profile", headers);
const sidOf = (headers: Record<string, string>) => JSON.parse(Buffer.from(headers.authorization!.split(".")[1]!, "base64url").toString()).sid as string;

describe("SessionCache (unit)", () => {
  it("keeps an active session until its time, forgets on revoke, clears on a LISTEN reconnect; 0 = off", () => {
    const cache = new SessionCache(5000);
    cache.put("s1", 1_000, 1_000_000);
    expect(cache.active("s1", 5_999)).toBe(true);
    expect(cache.active("s1", 6_000)).toBe(false);
    cache.put("s2", 1_000, 3_000);
    expect(cache.active("s2", 2_999)).toBe(true);
    expect(cache.active("s2", 3_000)).toBe(false);
    cache.put("s3", 1_000, 1_000_000);
    cache.forget("s3");
    expect(cache.active("s3", 1_001)).toBe(false);
    cache.put("s4", 1_000, 1_000_000);
    cache.clear();
    expect(cache.active("s4", 1_001)).toBe(false);
    const off = new SessionCache(0);
    off.put("s5", 1_000, 1_000_000);
    expect(off.active("s5", 1_001)).toBe(false);
  });
});

describe("session check cache with a LISTEN hub (S4c fix 3)", () => {
  it("is on with the default SESSION_CACHE_MS 5000 when the app has a hub", () => {
    expect(readEnv({ MOVERA_ENV: "staging", DATABASE_URL: "postgres://x/y", JWT_SECRET: "j".repeat(48) }).SESSION_CACHE_MS).toBe(5000);
    expect(sessionCache.ms).toBe(5000);
  });

  it("the window can never be set above 10 s (owner OK 2026-11-21: at most 5 s, Fable cap 10 s)", () => {
    const base = { MOVERA_ENV: "staging", DATABASE_URL: "postgres://x/y", JWT_SECRET: "j".repeat(48) };
    expect(readEnv({ ...base, SESSION_CACHE_MS: "10000" }).SESSION_CACHE_MS).toBe(10_000);
    expect(() => readEnv({ ...base, SESSION_CACHE_MS: "10001" })).toThrow();
  });

  it("sign-out: the session is refused at once, inside the cache window", async () => {
    const { headers } = await signIn(app, TEST_PHONES[0]!, "rider");
    expect((await profile(headers)).statusCode).toBe(200);
    expect(sessionCache.active(sidOf(headers), clock.now.getTime())).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/sign-out", headers: { ...headers, "content-type": "application/json" }, body: "" })).statusCode).toBe(204);
    expect((await profile(headers)).statusCode).toBe(401);
  });

  it("a revoke on ANOTHER copy (only its NOTIFY reaches this one) is refused within the window", async () => {
    const { headers } = await signIn(app, TEST_PHONES[1]!, "rider");
    expect((await profile(headers)).statusCode).toBe(200);
    const sid = sidOf(headers);
    // Another copy revokes: the row changes and its NOTIFY arrives here; this copy's code path is not used.
    await database.db.transaction().execute(async (trx) => {
      await trx.updateTable("auth_sessions").set({ revoked_at: clock.now, revoked_reason: "signed_out" }).where("session_id", "=", sid).execute();
      await sql`SELECT pg_notify(${SESSION_REVOKED_CHANNEL}, ${JSON.stringify({ sessionId: sid })})`.execute(trx);
    });
    expect(await until(async () => (await profile(headers)).statusCode === 401)).toBe(true);
  });

  it("a hand edit with no NOTIFY is refused once the window ends (at most SESSION_CACHE_MS)", async () => {
    const { headers } = await signIn(app, TEST_PHONES[2]!, "rider");
    expect((await profile(headers)).statusCode).toBe(200);
    await database.db.updateTable("auth_sessions").set({ revoked_at: clock.now, revoked_reason: "signed_out" }).where("session_id", "=", sidOf(headers)).execute();
    // Inside the window this copy still has it as active (the read it saves).
    expect((await profile(headers)).statusCode).toBe(200);
    clock.now = new Date(clock.now.getTime() + 5000);
    expect((await profile(headers)).statusCode).toBe(401);
  });

  it("a driver signing in on another phone: the old phone is refused at once", async () => {
    const first = await signIn(app, TEST_PHONES[3]!, "driver");
    expect((await call(app, "GET", "/driver/profile", first.headers)).statusCode).toBe(200);
    // A second phone (a fresh sign-in, not the test world's refresh) ends the first session.
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone: TEST_PHONES[3], app: "driver" } });
    const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone: TEST_PHONES[3], sessionId: res.json().sessionId, code: TEST_CODE } });
    expect(verify.statusCode, verify.body).toBe(200);
    expect(await until(async () => (await call(app, "GET", "/driver/profile", first.headers)).json().reason === "signed_in_elsewhere")).toBe(true);
  });

  it("admin sessions are never cached (role changes must bite at once)", async () => {
    expect(sessionCache.cachesActor("admin")).toBe(false);
    expect(sessionCache.cachesActor("rider")).toBe(true);
    expect(sessionCache.cachesActor("driver")).toBe(true);
  });
});
