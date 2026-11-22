import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eraseDueAccounts } from "../../src/accounts/deletion.js";
import { SESSION_REVOKED_CHANNEL, sessionCache } from "../../src/auth/sessionCache.js";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * Launch merge task (plan/MERGE-PLAN-LAUNCH-2026-11-21.md 3d): account deletion (v0.18.134) and the session check cache
 * (S4c fix 3) were built apart. Every code path that ends a rider / driver session must tell the cache
 * (sessionsRevoked: forget here + NOTIFY every copy), or a closed account keeps answering for SESSION_CACHE_MS:
 *   - the deletion request revokes every session of the account;
 *   - the erase job deletes the session rows.
 */

let database: TestDatabase;
let app: FastifyInstance;
let hub: NotificationHub;
const clock = { now: new Date("2026-11-21T10:00:00Z") };
const DAY = 86_400_000;
const heard: string[] = [];

beforeAll(async () => {
  database = await freshDatabase();
  hub = new NotificationHub(database.url, [SESSION_REVOKED_CHANNEL]);
  await hub.start();
  hub.subscribe(SESSION_REVOKED_CHANNEL, (payload) => {
    if (payload !== null && typeof payload["sessionId"] === "string") heard.push(payload["sessionId"]);
  });
  app = await testWorld(database.db, database.url, clock, { hub });
});
afterAll(async () => {
  await app.close();
  await hub.stop();
  await database.drop();
});

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return check();
};
const sidOf = (headers: Record<string, string>) => JSON.parse(Buffer.from(headers.authorization!.split(".")[1]!, "base64url").toString()).sid as string;

describe("account deletion tells the session check cache (sessionsRevoked)", () => {
  it("the cache is on in this world (a LISTEN hub, default 5 s)", () => {
    expect(sessionCache.ms).toBe(5000);
  });

  it("rider deletion request: her session is refused at once, inside the cache window, and every copy is told", async () => {
    const { headers } = await signIn(app, TEST_PHONES[3]!, "rider");
    expect((await call(app, "GET", "/rider/profile", headers)).statusCode).toBe(200);
    const sid = sidOf(headers);
    expect(sessionCache.active(sid, clock.now.getTime())).toBe(true);
    expect((await call(app, "POST", "/account/deletion", headers)).statusCode).toBe(202);
    // No clock step: still inside the 5 s window. Without sessionsRevoked this copy answers 200 from its cache.
    expect(sessionCache.active(sid, clock.now.getTime())).toBe(false);
    expect((await call(app, "GET", "/rider/profile", headers)).statusCode).toBe(401);
    expect(await until(() => heard.includes(sid))).toBe(true);
  });

  it("driver deletion request: the same", async () => {
    const { headers } = await signIn(app, TEST_PHONES[4]!, "driver");
    expect((await call(app, "GET", "/driver/profile", headers)).statusCode).toBe(200);
    const sid = sidOf(headers);
    expect(sessionCache.active(sid, clock.now.getTime())).toBe(true);
    expect((await call(app, "POST", "/driver/account/deletion", headers)).statusCode).toBe(202);
    expect(sessionCache.active(sid, clock.now.getTime())).toBe(false);
    expect((await call(app, "GET", "/driver/profile", headers)).statusCode).toBe(401);
    expect(await until(() => heard.includes(sid))).toBe(true);
  });

  it("the erase job deletes the session rows: a session still in the cache is refused at once, and every copy is told", async () => {
    // An account closed by a hand edit 31 days ago (no request through the app), so its session was never revoked
    // and is still active in this copy's cache when the erase job deletes the row.
    const { headers } = await signIn(app, TEST_PHONES[5]!, "rider");
    expect((await call(app, "GET", "/rider/profile", headers)).statusCode).toBe(200);
    const sid = sidOf(headers);
    const riderId = (await database.db.selectFrom("riders").select("rider_id").where("phone", "=", TEST_PHONES[5]!).executeTakeFirstOrThrow()).rider_id;
    await database.db.updateTable("riders").set({ deletion_requested_at: new Date(clock.now.getTime() - 31 * DAY) }).where("rider_id", "=", riderId).execute();
    await database.db.deleteFrom("config_live").where("doc", "=", "country_rules").where("zone_id", "=", "standard-SE").execute();
    await database.db.insertInto("config_live").values({ doc: "country_rules", zone_id: "standard-SE", version: 3, document: JSON.stringify({ country: "SE", accountDeletion: { eraseEnabled: true, eraseAfterDays: 30 } }), published_at: clock.now, published_by: null }).execute();
    expect(sessionCache.active(sid, clock.now.getTime())).toBe(true);
    const done = await eraseDueAccounts(database.db, clock.now);
    expect(done.erased).toBeGreaterThanOrEqual(1);
    expect(await database.db.selectFrom("auth_sessions").select("session_id").where("session_id", "=", sid).executeTakeFirst()).toBeUndefined();
    expect(sessionCache.active(sid, clock.now.getTime())).toBe(false);
    expect((await call(app, "GET", "/rider/profile", headers)).statusCode).toBe(401);
    expect(await until(() => heard.includes(sid))).toBe(true);
  });
});
