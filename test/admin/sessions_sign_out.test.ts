import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_REVOKED_CHANNEL, SessionCache, sessionCache } from "../../src/auth/sessionCache.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { readEnv } from "../../src/env.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertTrip } from "../support/seed.js";
import { call, fixedRouter } from "../support/world.js";
import { TEST_CODE } from "../../src/auth/service.js";

/**
 * Contract v0.18.149 (owner decisions/driver-g12.md Q6 "Real, riders + drivers (Recommended)", contract.json#adminSessions):
 * an admin sees a rider's or a driver's signed-in sessions (device, platform, last seen, created; never the address)
 * and signs one or all out with a reason. The person's next call is 401 with reason signed_out_by_movera, so the app
 * shows "You were signed out by Movera". Zone-scoped, idempotent, audited with the reason. A driver with a current
 * trip is refused (409 sign_out_on_trip): he is signed out only after the trip ends. The revoke goes through the one
 * revoke path of the session check cache (movera-server#306, sessionsRevoked): every copy forgets the session at once.
 * Fail-before: none of the four routes existed (404) and a revoked session only ever said session_ended.
 */
let database: TestDatabase;
let app: FastifyInstance;
let hub: NotificationHub;
let otherCopy: NotificationHub;
let superAdmin: Record<string, string>;
let viewer: Record<string, string>;
const clock = { now: new Date("2026-11-20T09:00:00Z") };
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  hub = new NotificationHub(database.url, [SESSION_REVOKED_CHANNEL]);
  await hub.start();
  otherCopy = new NotificationHub(database.url, [SESSION_REVOKED_CHANNEL]);
  await otherCopy.start();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "admin-sessions-secret".padEnd(48, "s") }), logger: false, db: database.db, clock: () => clock.now, router: fixedRouter, hub });
  superAdmin = (await adminSession(app, database.db, "super", { now: clock.now })).headers;
  viewer = (await adminSession(app, database.db, "viewer", { now: clock.now })).headers;
});
afterAll(async () => {
  await app.close();
  await hub.stop();
  await otherCopy.stop();
  await database.drop();
});

/** A fresh sign-in from a phone with this user agent (a second phone of the same rider is a second session). */
async function signInFrom(phone: string, appName: "rider" | "driver", userAgent: string) {
  const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", headers: { "user-agent": userAgent }, payload: { phone, app: appName } });
  const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", headers: { "user-agent": userAgent }, payload: { phone, sessionId: challenge.json().sessionId, code: TEST_CODE } });
  expect(verify.statusCode, verify.body).toBe(200);
  const body = verify.json() as { accessToken: string; refreshToken: string };
  const sid = JSON.parse(Buffer.from(body.accessToken.split(".")[1]!, "base64url").toString()).sid as string;
  const sub = JSON.parse(Buffer.from(body.accessToken.split(".")[1]!, "base64url").toString()).sub as string;
  return { headers: { authorization: `Bearer ${body.accessToken}` } as Record<string, string>, refreshToken: body.refreshToken, sid, sub };
}
const refresh = (refreshToken: string) => app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken } });
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return check();
};
type SessionView = { sessionId: string; app: string; device: string | null; platform: string; appVersion: string | null; lastSeenAt: string; createdAt: string };

describe("GET /admin/{riders|drivers}/{id}/sessions (v0.18.149)", () => {
  it("lists the rider's active sessions, newest first: device, platform, app version, last seen, created; no address", async () => {
    const a = await signInFrom(TEST_PHONES[0]!, "rider", IPHONE_UA);
    clock.now = new Date(clock.now.getTime() + 60_000);
    const b = await signInFrom(TEST_PHONES[0]!, "rider", ANDROID_UA);
    await database.db.insertInto("push_devices").values({ token: "tok-android-1", actor: "rider", subject_id: b.sub, session_id: b.sid, provider: "fcm", platform: "android", app_version: "1.4.2", locale: "sv", updated_at: clock.now }).execute();
    const res = await call(app, "GET", `/admin/riders/${a.sub}/sessions`, viewer);
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as SessionView[];
    expect(items.map((s) => s.sessionId)).toEqual([b.sid, a.sid]);
    expect(items[0]).toMatchObject({ app: "rider", platform: "android", device: "Android phone", appVersion: "1.4.2" });
    expect(items[1]).toMatchObject({ app: "rider", platform: "ios", device: "iPhone", appVersion: null, createdAt: new Date("2026-11-20T09:00:00Z").toISOString() });
    expect(res.body).not.toMatch(/"ip"|127\.0\.0\.1|userAgent/);
  });

  it("an unknown rider is 404; a zone admin who never saw the rider is 403 zone_out_of_scope", async () => {
    expect((await call(app, "GET", "/admin/riders/r_nobody/sessions", viewer)).json().reason).toBe("rider_not_found");
    const zoneViewer = (await adminSession(app, database.db, "viewer", { zoneIds: ["Z999"], now: clock.now })).headers;
    const a = await signInFrom(TEST_PHONES[0]!, "rider", IPHONE_UA);
    const res = await call(app, "GET", `/admin/riders/${a.sub}/sessions`, zoneViewer);
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("zone_out_of_scope");
  });
});

describe("POST /admin/{riders|drivers}/{id}/sessions/sign-out (v0.18.149)", () => {
  it("needs riders.block (a viewer is 403) and a reason (400 reason_required)", async () => {
    const a = await signInFrom(TEST_PHONES[1]!, "rider", IPHONE_UA);
    expect((await call(app, "POST", `/admin/riders/${a.sub}/sessions/sign-out`, viewer, { sessionId: a.sid, reason: "Lost phone" })).statusCode).toBe(403);
    const noReason = await call(app, "POST", `/admin/riders/${a.sub}/sessions/sign-out`, superAdmin, { sessionId: a.sid, reason: "  " });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().reason).toBe("reason_required");
    const neither = await call(app, "POST", `/admin/riders/${a.sub}/sessions/sign-out`, superAdmin, { reason: "Lost phone" });
    expect(neither.statusCode).toBe(400);
    expect((await call(app, "GET", "/rider/profile", a.headers)).statusCode).toBe(200);
  });

  it("one session: that phone is refused at once with signed_out_by_movera (call and refresh), the other phone keeps working; audited; a repeat is the same answer", async () => {
    const a = await signInFrom(TEST_PHONES[2]!, "rider", IPHONE_UA);
    const b = await signInFrom(TEST_PHONES[2]!, "rider", ANDROID_UA);
    expect((await call(app, "GET", "/rider/profile", a.headers)).statusCode).toBe(200);
    const key = "sess-one-key-0000001";
    const res = await call(app, "POST", `/admin/riders/${a.sub}/sessions/sign-out`, superAdmin, { sessionId: a.sid, reason: "Rider lost the phone" }, key);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().signedOut).toBe(1);
    expect((res.json().items as SessionView[]).map((s) => s.sessionId)).toEqual([b.sid]);
    const refused = await call(app, "GET", "/rider/profile", a.headers);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().reason).toBe("signed_out_by_movera");
    const refreshed = await refresh(a.refreshToken);
    expect(refreshed.statusCode).toBe(401);
    expect(refreshed.json().reason).toBe("signed_out_by_movera");
    expect((await call(app, "GET", "/rider/profile", b.headers)).statusCode).toBe(200);
    const row = await database.db.selectFrom("auth_sessions").select(["revoked_at", "revoked_reason"]).where("session_id", "=", a.sid).executeTakeFirstOrThrow();
    expect(row.revoked_reason).toBe("signed_out_by_movera");
    const tokens = await database.db.selectFrom("refresh_tokens").select("expires_at").where("session_id", "=", a.sid).execute();
    expect(tokens.every((t) => t.expires_at.getTime() <= clock.now.getTime())).toBe(true);
    const audits = await database.db.selectFrom("admin_audit").selectAll().where("action", "=", "rider.sessions_sign_out").where("target_id", "=", a.sub).execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({ reason: "Rider lost the phone", all: false, sessionIds: [a.sid] });
    const again = await call(app, "POST", `/admin/riders/${a.sub}/sessions/sign-out`, superAdmin, { sessionId: a.sid, reason: "Rider lost the phone" }, key);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(res.json());
    expect(await database.db.selectFrom("admin_audit").select("audit_id").where("action", "=", "rider.sessions_sign_out").where("target_id", "=", a.sub).execute()).toHaveLength(1);
  });

  it("a session that is not this person's active one is 404 session_not_found", async () => {
    const a = await signInFrom(TEST_PHONES[3]!, "rider", IPHONE_UA);
    const other = await signInFrom(TEST_PHONES[4]!, "rider", IPHONE_UA);
    const res = await call(app, "POST", `/admin/riders/${a.sub}/sessions/sign-out`, superAdmin, { sessionId: other.sid, reason: "Wrong one" });
    expect(res.statusCode).toBe(404);
    expect(res.json().reason).toBe("session_not_found");
    expect((await call(app, "GET", "/rider/profile", other.headers)).statusCode).toBe(200);
  });

  it("all: every session of the rider ends, the push devices of those sessions are forgotten", async () => {
    const a = await signInFrom(TEST_PHONES[5]!, "rider", IPHONE_UA);
    const b = await signInFrom(TEST_PHONES[5]!, "rider", ANDROID_UA);
    await database.db.insertInto("push_devices").values({ token: "tok-all-1", actor: "rider", subject_id: b.sub, session_id: b.sid, provider: "fcm", platform: "android", app_version: "1.4.2", locale: "sv", updated_at: clock.now }).execute();
    const res = await call(app, "POST", `/admin/riders/${a.sub}/sessions/sign-out`, superAdmin, { all: true, reason: "Account taken over" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ signedOut: 2, items: [] });
    for (const s of [a, b]) expect((await call(app, "GET", "/rider/profile", s.headers)).json().reason).toBe("signed_out_by_movera");
    expect(await database.db.selectFrom("push_devices").select("token").where("session_id", "in", [a.sid, b.sid]).execute()).toHaveLength(0);
    // all: true again ends nothing: 200 signedOut 0, and no second audit row (nothing changed).
    const none = await call(app, "POST", `/admin/riders/${a.sub}/sessions/sign-out`, superAdmin, { all: true, reason: "Account taken over" });
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json()).toMatchObject({ signedOut: 0, items: [] });
    expect(await database.db.selectFrom("admin_audit").select("action").where("action", "=", "rider.sessions_sign_out").where("target_id", "=", a.sub).execute()).toHaveLength(1);
  });

  it("session check cache (movera-server#306): a session cached on ANOTHER copy is forgotten there at once (NOTIFY)", async () => {
    const a = await signInFrom(TEST_PHONES[1]!, "rider", IPHONE_UA);
    expect((await call(app, "GET", "/rider/profile", a.headers)).statusCode).toBe(200);
    expect(sessionCache.active(a.sid, clock.now.getTime())).toBe(true);
    // Copy B: its own cache, fed only by its own LISTEN connection, holds the session as active.
    const copyB = new SessionCache(5000);
    const stop = otherCopy.subscribe(SESSION_REVOKED_CHANNEL, (payload) => {
      if (payload !== null && typeof payload["sessionId"] === "string") copyB.forget(payload["sessionId"]);
    });
    try {
      copyB.put(a.sid, clock.now.getTime(), clock.now.getTime() + 86_400_000);
      expect(copyB.active(a.sid, clock.now.getTime())).toBe(true);
      const res = await call(app, "POST", `/admin/riders/${a.sub}/sessions/sign-out`, superAdmin, { sessionId: a.sid, reason: "Shared phone" });
      expect(res.statusCode, res.body).toBe(200);
      // This copy: refused at once, well inside the 5 s window.
      expect((await call(app, "GET", "/rider/profile", a.headers)).json().reason).toBe("signed_out_by_movera");
      // Copy B: forgotten as soon as the NOTIFY arrives (no 5 s wait; the clock does not move).
      expect(await until(() => !copyB.active(a.sid, clock.now.getTime()))).toBe(true);
    } finally {
      stop();
    }
  });

  it("driver: needs drivers.activate and his zone; refused 409 sign_out_on_trip while he has a current trip; after the trip a free online driver goes offline", async () => {
    const d = await signInFrom(TEST_PHONES[0]!, "driver", ANDROID_UA);
    await database.db.updateTable("drivers").set({ zone_ids: ["Z001"], online_status: "online", online_since: clock.now }).where("driver_id", "=", d.sub).execute();
    const list = await call(app, "GET", `/admin/drivers/${d.sub}/sessions`, viewer);
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json().items as SessionView[]).map((s) => [s.sessionId, s.app])).toEqual([[d.sid, "driver"]]);
    const outside = (await adminSession(app, database.db, "compliance", { zoneIds: ["Z999"], now: clock.now })).headers;
    expect((await call(app, "POST", `/admin/drivers/${d.sub}/sessions/sign-out`, outside, { all: true, reason: "Check" })).json().reason).toBe("zone_out_of_scope");
    expect((await call(app, "POST", `/admin/drivers/${d.sub}/sessions/sign-out`, viewer, { all: true, reason: "Check" })).statusCode).toBe(403);

    const riderId = (await signInFrom(TEST_PHONES[1]!, "rider", IPHONE_UA)).sub;
    const tripId = await insertTrip(database.db, riderId, { status: "in_trip", driverId: d.sub });
    const onTrip = await call(app, "POST", `/admin/drivers/${d.sub}/sessions/sign-out`, superAdmin, { all: true, reason: "Stolen phone" });
    expect(onTrip.statusCode).toBe(409);
    expect(onTrip.json().reason).toBe("sign_out_on_trip");
    expect((await call(app, "GET", "/driver/profile", d.headers)).statusCode).toBe(200);

    await database.db.updateTable("trips").set({ status: "completed", ended_at: clock.now }).where("trip_id", "=", tripId).execute();
    const done = await call(app, "POST", `/admin/drivers/${d.sub}/sessions/sign-out`, superAdmin, { all: true, reason: "Stolen phone" });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().signedOut).toBe(1);
    expect((await call(app, "GET", "/driver/profile", d.headers)).json().reason).toBe("signed_out_by_movera");
    expect((await refresh(d.refreshToken)).json().reason).toBe("signed_out_by_movera");
    const driver = await database.db.selectFrom("drivers").select("online_status").where("driver_id", "=", d.sub).executeTakeFirstOrThrow();
    expect(driver.online_status).toBe("offline");
    const audits = await database.db.selectFrom("admin_audit").selectAll().where("action", "=", "driver.sessions_sign_out").where("target_id", "=", d.sub).execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.zone_id).toBe("Z001");
  });
});
