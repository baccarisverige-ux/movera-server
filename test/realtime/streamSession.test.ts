import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { signAccessToken } from "../../src/auth/jwt.js";
import { CONFIG_CHANNEL } from "../../src/config/service.js";
import { TRIP_EVENTS_CHANNEL } from "../../src/db/tripLog.js";
import { readEnv } from "../../src/env.js";
import { ADMIN_EVENTS_CHANNEL, LIVE } from "../../src/realtime/adminEvents.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import * as sessionWatch from "../../src/realtime/sessionWatch.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, fixedRouter } from "../support/world.js";
import { readFileSync } from "node:fs";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";

/**
 * B1.15 (owner W1 Q76, S04 C1 / P7): an open stream ends within 60 s when its SESSION ends (sign-out, a new phone,
 * an account change, an admin's role change or deactivation, any revoke), never because its access token expired.
 * Each server copy re-checks the session rows of all its open streams with ONE batched query per interval
 * (STREAM_SESSION_CHECK_MS, default 30 s); a preview token's stream ends at the token's own 15-minute end. Before closing,
 * the stream sends the SSE comment `: session ended; sign in again`; the app's reconnect then gets the 401 reason.
 */

const SECRET = "session-watch-secret".padEnd(48, "s");
const CHECK_MS = 300;
const ENV = (extra: Record<string, string> = {}) => readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET, STREAM_SESSION_CHECK_MS: String(CHECK_MS), ...extra });

/** Riders of this file (extra test phones, seeded in beforeAll). */
const PHONES = Array.from({ length: 16 }, (_, i) => `+467017407${String(10 + i)}`);

let database: TestDatabase;
let app: FastifyInstance;
let hub: NotificationHub;
let base: string;

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db, PHONES);
  const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 1, document: JSON.stringify(pricing), published_at: new Date(), published_by: null }).execute();
  hub = new NotificationHub(database.url, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL, ADMIN_EVENTS_CHANNEL]);
  await hub.start();
  app = await buildApp({ env: ENV(), logger: false, db: database.db, router: fixedRouter, hub });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await app.close();
  await hub.stop();
  await database.drop();
});

type Sse = { comments: string[]; status: number; ended: boolean; endedAt: number; close: () => void };

function listen(at: string, path: string, headers: Record<string, string>): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const out: Sse = { comments: [], status: 0, ended: false, endedAt: 0, close: () => undefined };
    const end = () => {
      if (!out.ended) out.endedAt = Date.now();
      out.ended = true;
    };
    const req = http.get(`${at}${path}`, { headers: { ...headers, accept: "text/event-stream" } }, (res) => {
      out.status = res.statusCode ?? 0;
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (block.startsWith(": ")) out.comments.push(block.slice(2));
        }
      });
      res.on("end", end);
      res.on("close", end);
      out.close = () => req.destroy();
      resolve(out);
    });
    req.on("error", (error) => (out.ended ? undefined : reject(error)));
  });
}
const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return check();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real OTP sign-in (a new phone each time: no refresh token is reused). */
async function otpSignIn(phone: string, appName: "rider" | "driver") {
  const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone, app: appName } });
  const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone, sessionId: challenge.json().sessionId, code: TEST_CODE } });
  const body = verify.json() as { accessToken: string; refreshToken: string };
  return { headers: { authorization: `Bearer ${body.accessToken}` } as Record<string, string>, refreshToken: body.refreshToken };
}

describe("B1.15 streams end with their session (<= 60 s)", () => {
  it("STREAM_SESSION_CHECK_MS defaults to 30 s and may not exceed 60 s (the 60 s promise)", () => {
    expect(readEnv({ MOVERA_ENV: "development" }).STREAM_SESSION_CHECK_MS).toBe(30_000);
    expect(() => readEnv({ MOVERA_ENV: "development", STREAM_SESSION_CHECK_MS: "60001" })).toThrow();
  });

  it("sign-out: the rider's open settings stream gets ': session ended; sign in again' and closes; its reconnect gets 401 session_ended", async () => {
    const rider = await otpSignIn(PHONES[0]!, "rider");
    const sse = await listen(base, "/rider/config/stream?zoneId=Z001", rider.headers);
    expect(sse.status).toBe(200);
    expect((await call(app, "POST", "/auth/sign-out", rider.headers)).statusCode).toBe(204);
    const at = Date.now();
    expect(await until(() => sse.ended, 5 * CHECK_MS)).toBe(true);
    expect(sse.endedAt - at).toBeLessThan(3 * CHECK_MS);
    expect(sse.comments).toContain(sessionWatch.SESSION_ENDED_COMMENT);
    const again = await call(app, "GET", "/rider/config/stream?zoneId=Z001", { ...rider.headers, accept: "text/event-stream" });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ code: "unauthenticated", reason: "session_ended" });
  });

  it("a new-phone driver sign-in closes the old phone's offer feed and settings stream; the new phone's streams stay open", async () => {
    const phone = "+46701740631";
    await seedTestPhones(database.db, [phone]);
    const old = await otpSignIn(phone, "driver");
    const offers = await listen(base, "/driver/offers/stream", old.headers);
    const settings = await listen(base, "/driver/config/stream?zoneId=Z001", old.headers);
    expect([offers.status, settings.status]).toEqual([200, 200]);
    const fresh = await otpSignIn(phone, "driver");
    const kept = await listen(base, "/driver/offers/stream", fresh.headers);
    expect(kept.status).toBe(200);
    expect(await until(() => offers.ended && settings.ended, 5 * CHECK_MS)).toBe(true);
    expect(offers.comments).toContain(sessionWatch.SESSION_ENDED_COMMENT);
    await sleep(3 * CHECK_MS);
    expect(kept.ended).toBe(false);
    kept.close();
    const again = await call(app, "GET", "/driver/offers/stream", { ...old.headers, accept: "text/event-stream" });
    expect(again.json()).toMatchObject({ reason: "signed_in_elsewhere" });
  });

  it("a stream stays open across a token refresh (the session row lives on; access-token expiry never closes a stream)", async () => {
    const rider = await otpSignIn(PHONES[1]!, "rider");
    const sse = await listen(base, "/rider/config/stream?zoneId=Z001", rider.headers);
    const refreshed = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken: rider.refreshToken } });
    expect(refreshed.statusCode).toBe(200);
    await sleep(4 * CHECK_MS);
    expect(sse.ended).toBe(false);
    sse.close();
  });

  it("any revoke of the session row (an account change, a script, by hand) closes the stream", async () => {
    const rider = await otpSignIn(PHONES[2]!, "rider");
    const sse = await listen(base, "/rider/config/stream?zoneId=Z001", rider.headers);
    await sleep(CHECK_MS);
    expect(sse.ended).toBe(false);
    const sid = JSON.parse(Buffer.from(rider.headers.authorization!.split(".")[1]!, "base64url").toString()).sid as string;
    await database.db.updateTable("auth_sessions").set({ revoked_at: new Date(), revoked_reason: "account_changed" }).where("session_id", "=", sid).execute();
    expect(await until(() => sse.ended, 5 * CHECK_MS)).toBe(true);
  });

  it("an admin's role change closes his live-events stream on the same tick (admin rights re-read)", async () => {
    const admin = await adminSession(app, database.db, "super");
    const sse = await listen(base, LIVE.path, admin.headers);
    expect(sse.status).toBe(200);
    await sleep(2 * CHECK_MS);
    expect(sse.ended).toBe(false);
    await database.db.updateTable("admins").set({ role: "viewer" }).where("admin_id", "=", admin.adminId).execute();
    expect(await until(() => sse.ended, 5 * CHECK_MS)).toBe(true);
    expect(sse.comments).toContain(sessionWatch.SESSION_ENDED_COMMENT);
  });

  it("a preview token's stream (no session row) stays open until the token's own end, then closes", async () => {
    const now = new Date();
    const token = signAccessToken({ sub: "preview:rider:Z001", actor: "rider", sid: "prv_watchtest", zones: ["Z001"], pv: true }, SECRET, 3, now);
    const sse = await listen(base, "/rider/config/stream?zoneId=Z001", { authorization: `Bearer ${token}` });
    expect(sse.status).toBe(200);
    await sleep(1000);
    expect(sse.ended).toBe(false);
    expect(await until(() => sse.ended, 4000)).toBe(true);
    expect(sse.comments).toContain(sessionWatch.SESSION_ENDED_COMMENT);
  });

  it("Rule 33 cost: 30 open streams of 10 sessions = ONE session query per interval (no per-stream query)", async () => {
    const sessions = await Promise.all([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => otpSignIn(PHONES[i]!, "rider")));
    const streams = (await Promise.all(sessions.map((s) => Promise.all([0, 1, 2].map(() => listen(base, "/rider/config/stream?zoneId=Z001", s.headers)))))).flat();
    expect(streams.every((s) => s.status === 200)).toBe(true);
    const watch = sessionWatch.watchOf(app)!;
    const before = watch.checks;
    await sleep(10 * CHECK_MS);
    const queries = watch.checks - before;
    for (const s of streams) s.close();
    console.log(`B1.15 cost: 30 streams / 10 sessions, ${10 * CHECK_MS} ms -> ${queries} session queries`);
    expect(queries).toBeGreaterThanOrEqual(7);
    expect(queries).toBeLessThanOrEqual(11);
    expect(streams.some((s) => s.ended)).toBe(false);
  });

  it("Rule 33 cost: 1200 sessions are checked in 3 queries of at most 500 ids (keeps the primary-key index path); unknown sessions end", async () => {
    const watch = new sessionWatch.SessionWatch(database.db, { everyMs: 60_000, warn: () => undefined });
    let ended = 0;
    const stops = Array.from({ length: 1200 }, (_, i) => watch.add({ sessionId: `ses_none_${i}`, actor: "rider" }, () => (ended += 1)));
    await watch.check();
    for (const stop of stops) stop();
    expect(sessionWatch.SESSION_CHECK_BATCH).toBe(500);
    expect(watch.checks).toBe(3);
    expect(ended).toBe(1200);
  });

  it("Rule 33: a sign-out on copy A closes the same session's stream on copy B (the session row, no NOTIFY needed)", async () => {
    const app2 = await buildApp({ env: ENV(), logger: false, db: database.db, router: fixedRouter, hub });
    await app2.listen({ host: "127.0.0.1", port: 0 });
    const base2 = `http://127.0.0.1:${(app2.server.address() as AddressInfo).port}/api/v1`;
    try {
      const rider = await otpSignIn(PHONES[13]!, "rider");
      const onB = await listen(base2, "/rider/config/stream?zoneId=Z001", rider.headers);
      expect(onB.status).toBe(200);
      expect((await call(app, "POST", "/auth/sign-out", rider.headers)).statusCode).toBe(204);
      expect(await until(() => onB.ended, 5 * CHECK_MS)).toBe(true);
    } finally {
      await app2.close();
    }
  });
});
