import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildApp } from "../../src/app.js";
import { TEST_CODE } from "../../src/auth/service.js";
import { seedTestPhones } from "../../src/auth/testPhones.js";
import { CONFIG_CHANNEL } from "../../src/config/service.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { TRIP_EVENTS_CHANNEL } from "../../src/db/tripLog.js";
import { readEnv } from "../../src/env.js";
import { ADMIN_EVENTS_CHANNEL } from "../../src/realtime/adminEvents.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { APP_STREAMS_PER_SESSION_LOG } from "../../src/realtime/sse.js";
import { loadSnapshot } from "../../src/telemetry/load.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { fixedRouter } from "../support/world.js";

/**
 * S7 W2 Q125 (Q-B3, B3.11; owner 2026-11-15 "A) count and log above N = 3, refuse later"): app streams (rider / driver)
 * are counted per session on each server copy. Opening a 4th while 3 are open is logged (warn, once per open above 3) and
 * counted in GET /internal/load `streams.appOverPerSession`; nothing is refused (still 200). Admin streams keep their own caps.
 */

const SECRET = "q125-streams-secret".padEnd(48, "s");
const PHONES = ["+46701741251", "+46701741252"];
let database: TestDatabase;
let app: FastifyInstance;
let hub: NotificationHub;
let base: string;
const warnings: Array<{ msg: string; data: Record<string, unknown> }> = [];

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db, PHONES);
  const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 1, document: JSON.stringify(pricing), published_at: new Date(), published_by: null }).execute();
  hub = new NotificationHub(database.url, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL, ADMIN_EVENTS_CHANNEL]);
  await hub.start();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: SECRET }), logger: false, db: database.db, router: fixedRouter, hub });
  app.addHook("onRequest", async (request) => {
    // logger: false gives every request the same logger object: wrap it once.
    if ((request.log as { q125?: boolean }).q125) return;
    (request.log as { q125?: boolean }).q125 = true;
    const warn = request.log.warn.bind(request.log);
    request.log.warn = ((data: Record<string, unknown>, msg: string) => {
      warnings.push({ msg, data });
      warn(data, msg);
    }) as typeof request.log.warn;
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await app.close();
  await hub.stop();
  await database.drop();
});

type Sse = { status: number; ended: boolean; close: () => void };
function listen(path: string, headers: Record<string, string>): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const out: Sse = { status: 0, ended: false, close: () => undefined };
    const req = http.get(`${base}${path}`, { headers: { ...headers, accept: "text/event-stream" } }, (res) => {
      out.status = res.statusCode ?? 0;
      res.resume();
      res.on("close", () => (out.ended = true));
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
async function signIn(phone: string, appName: "rider" | "driver") {
  const challenge = await app.inject({ method: "POST", url: "/api/v1/auth/otp/request", payload: { phone, app: appName } });
  const verify = await app.inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { phone, sessionId: challenge.json().sessionId, code: TEST_CODE } });
  return { authorization: `Bearer ${(verify.json() as { accessToken: string }).accessToken}` };
}
const over = () => (loadSnapshot().streams as { appOverPerSession: number }).appOverPerSession;
const overWarnings = () => warnings.filter((w) => w.msg === "app streams per session over the limit");

describe("S7 Q125: app streams per session are counted and logged above 3, never refused", () => {
  it("the limit is 3", () => {
    expect(APP_STREAMS_PER_SESSION_LOG).toBe(3);
  });

  it("3 streams of one rider session: no log; a 4th and 5th: 200 (not refused), logged and counted; closing brings it back under", async () => {
    const rider = await signIn(PHONES[0]!, "rider");
    const before = over();
    const first = await Promise.all([0, 1, 2].map(() => listen("/rider/config/stream?zoneId=Z001", rider)));
    expect(first.map((s) => s.status)).toEqual([200, 200, 200]);
    expect(overWarnings()).toHaveLength(0);
    expect(over()).toBe(before);
    const fourth = await listen("/rider/config/stream?zoneId=Z001", rider);
    const fifth = await listen("/rider/config/stream?zoneId=Z001", rider);
    expect([fourth.status, fifth.status]).toEqual([200, 200]);
    expect(await until(() => over() === before + 2)).toBe(true);
    expect(overWarnings()).toHaveLength(2);
    expect(overWarnings()[0]!.data).toMatchObject({ actor: "rider", open: 4, limit: 3 });
    expect(overWarnings()[1]!.data).toMatchObject({ open: 5 });
    expect(over()).toBe(before + 2);
    // Closing three brings the session back to 2; one more open (the 3rd) is not over.
    const openNow = (loadSnapshot().streams as { open: number }).open;
    fourth.close();
    fifth.close();
    first[0]!.close();
    expect(await until(() => fourth.ended && fifth.ended && first[0]!.ended)).toBe(true);
    // Wait until the server saw the three closes.
    expect(await until(() => (loadSnapshot().streams as { open: number }).open === openNow - 3)).toBe(true);
    const again = await listen("/rider/config/stream?zoneId=Z001", rider);
    expect(again.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(overWarnings()).toHaveLength(2);
    for (const s of [...first, again]) s.close();
  });

  it("the count is per session: two sessions with 3 streams each are not over", async () => {
    warnings.length = 0;
    const a = await signIn(PHONES[1]!, "driver");
    const b = await signIn(PHONES[0]!, "rider");
    const streams = [
      ...(await Promise.all([0, 1, 2].map(() => listen("/driver/config/stream?zoneId=Z001", a)))),
      ...(await Promise.all([0, 1, 2].map(() => listen("/rider/config/stream?zoneId=Z001", b)))),
    ];
    expect(streams.every((s) => s.status === 200)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(overWarnings()).toHaveLength(0);
    for (const s of streams) s.close();
  });
});
