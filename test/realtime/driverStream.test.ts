import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { CONFIG_CHANNEL } from "../../src/config/service.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { OFFER_EVENTS_CHANNEL, TRIP_EVENTS_CHANNEL } from "../../src/db/tripLog.js";
import { readEnv } from "../../src/env.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { loadSnapshot } from "../../src/telemetry/load.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, fixedRouter, signIn } from "../support/world.js";

/**
 * Contract v0.18.122 (L20 stream; owner 2026-11-17 "Yes, with switch (Rec.)", Rules audits/load/l20-1-design.md §3,
 * contract.json#driverOneStream): GET /driver/stream = the offer feed and the driver config stream on one connection,
 * id '<offer sequence>.<config version>'; DriverAppConfig.realtime.oneStream (default false).
 * Rule 36: fails on main (no /driver/stream: 404; no realtime in GET /driver/config; a bad realtime is saved).
 */
let database: TestDatabase;
let app: FastifyInstance;
let hub: NotificationHub;
let base: string;
const driverDoc = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/driver_app_config.json`, "utf8")) as Record<string, unknown>;

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  hub = new NotificationHub(database.url, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL, OFFER_EVENTS_CHANNEL]);
  await hub.start();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "one-stream-test-secret".padEnd(48, "s") }), logger: false, db: database.db, router: fixedRouter, hub });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1`;
  await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z001", version: 1, document: JSON.stringify(driverDoc), published_at: new Date(), published_by: null }).execute();
});
afterAll(async () => {
  await app.close();
  await hub.stop();
  await database.drop();
});

type Sse = { events: Array<{ id: string; data: Record<string, unknown> }>; cursors: string[]; comments: string[]; status: number; body: string; ended: boolean; close: () => void };
function listen(path: string, headers: Record<string, string>): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const out: Sse = { events: [], cursors: [], comments: [], status: 0, body: "", ended: false, close: () => undefined };
    const req = http.get(`${base}${path}`, { headers: { ...headers, accept: "text/event-stream" } }, (res) => {
      out.status = res.statusCode ?? 0;
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (out.status !== 200) return void (out.body += chunk);
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.startsWith(":")) out.comments.push(block.slice(1).trim());
          else {
            const id = /^id: (.*)$/m.exec(block)?.[1] ?? "";
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (data) out.events.push({ id, data: JSON.parse(data) });
            else if (id) out.cursors.push(id);
          }
        }
      });
      res.on("end", () => (out.ended = true));
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
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function driverWith(phone: string) {
  const headers = (await signIn(app, phone, "driver")).headers;
  const driverId = (await call(app, "GET", "/driver/profile", headers)).json().driverId as string;
  await database.db.updateTable("drivers").set({ zone_ids: ["Z001"] }).where("driver_id", "=", driverId).execute();
  const offer = async (sequence: number, notify = true) => {
    await database.db.insertInto("offer_events").values({ driver_id: driverId, sequence, event_id: `evt_${driverId}_${sequence}`, kind: "offer_created", offer: JSON.stringify({ offerId: `of_${sequence}`, status: "open" }), occurred_at: new Date() }).execute();
    if (notify) await sql`SELECT pg_notify(${OFFER_EVENTS_CHANNEL}, ${JSON.stringify({ driverId, sequence })})`.execute(database.db);
  };
  return { headers, driverId, offer };
}
async function publishDriverDoc(version: number) {
  await database.db.updateTable("config_live").set({ version, document: JSON.stringify({ ...driverDoc, version }), published_at: new Date() }).where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
  await sql`SELECT pg_notify(${CONFIG_CHANNEL}, ${JSON.stringify({ doc: "driver_app_config", zoneId: "Z001", version })})`.execute(database.db);
}

describe("GET /driver/stream (v0.18.122, one live connection per driver phone)", () => {
  it("one stream carries both event kinds, unchanged, with the id '<offer sequence>.<config version>'", async () => {
    const { headers, offer } = await driverWith(TEST_PHONES[0]!);
    const sse = await listen("/driver/stream?zoneId=Z001", headers);
    expect(sse.status).toBe(200);
    // Opened without a cursor: the offer half starts at its head (as the offer feed), the config half at the live version.
    expect(await until(() => sse.cursors.length === 1)).toBe(true);
    expect(sse.cursors).toEqual(["0.1"]);
    await offer(1);
    expect(await until(() => sse.events.length === 1)).toBe(true);
    expect(sse.events[0]).toMatchObject({ id: "1.1", data: { kind: "offer_created", sequence: 1, offer: { offerId: "of_1" } } });
    await publishDriverDoc(2);
    expect(await until(() => sse.events.length === 2)).toBe(true);
    expect(sse.events[1]).toMatchObject({ id: "1.2", data: { kind: "config_published", doc: "driver_app_config", zoneId: "Z001", version: 2 } });
    await offer(2);
    expect(await until(() => sse.events.length === 3)).toBe(true);
    expect(sse.events[2]!.id).toBe("2.2");
    // The data objects are the ones of the old streams (same keys).
    expect(Object.keys(sse.events[0]!.data).sort()).toEqual(["eventId", "kind", "occurredAt", "offer", "sequence", "serverTime"]);
    expect(Object.keys(sse.events[1]!.data).sort()).toEqual(["doc", "eventId", "kind", "occurredAt", "publishedAt", "serverTime", "version", "zoneId"]);
    sse.close();
  });

  it("resume by id: Last-Event-ID '1.2' replays offers 2+ exactly once and no old config; '1.0' also sends the newest document", async () => {
    const { headers, offer } = await driverWith(TEST_PHONES[1]!);
    for (const s of [1, 2, 3]) await offer(s, false);
    const live = (await database.db.selectFrom("config_live").select("version").where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").executeTakeFirstOrThrow()).version;
    const resumed = await listen("/driver/stream?zoneId=Z001", { ...headers, "last-event-id": `1.${live}` });
    expect(await until(() => resumed.events.length === 2)).toBe(true);
    await pause(200);
    expect(resumed.events.map((e) => e.id)).toEqual([`2.${live}`, `3.${live}`]);
    expect(resumed.events.every((e) => e.data.kind === "offer_created")).toBe(true);
    expect(resumed.cursors).toEqual([]);
    resumed.close();
    const older = await listen("/driver/stream?zoneId=Z001&after=1.0", headers);
    expect(await until(() => older.events.length === 3)).toBe(true);
    await pause(200);
    expect(older.events.filter((e) => e.data.kind === "config_published").map((e) => e.data.version)).toEqual([live]);
    expect(older.events.filter((e) => e.data.kind === "offer_created").map((e) => e.data.sequence)).toEqual([2, 3]);
    older.close();
    // A plain number is the offer sequence (config half 0).
    const plain = await listen("/driver/stream?zoneId=Z001", { ...headers, "last-event-id": "2" });
    expect(await until(() => plain.events.length === 2)).toBe(true);
    expect(plain.events.map((e) => e.data.kind).sort()).toEqual(["config_published", "offer_created"]);
    plain.close();
    // Not one or two whole numbers: 400.
    const bad = await fetch(`${base}/driver/stream?zoneId=Z001`, { headers: { ...headers, accept: "text/event-stream", "last-event-id": "1.x" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_request" });
  });

  it("one open stream per phone: opening /driver/stream adds exactly 1 to the open-streams count (two old streams add 2)", async () => {
    const { headers } = await driverWith(TEST_PHONES[2]!);
    const open = () => (loadSnapshot() as { streams: { open: number } }).streams.open;
    const before = open();
    const one = await listen("/driver/stream?zoneId=Z001", headers);
    expect(await until(() => open() === before + 1)).toBe(true);
    await pause(100);
    expect(open()).toBe(before + 1);
    one.close();
    expect(await until(() => open() === before)).toBe(true);
    const offers = await listen("/driver/offers/stream", headers);
    const config = await listen("/driver/config/stream?zoneId=Z001", headers);
    expect(await until(() => open() === before + 2)).toBe(true);
    offers.close();
    config.close();
    expect(await until(() => open() === before)).toBe(true);
  });

  it("the old routes are unchanged: plain ids on the offer feed and the config stream; only drivers may open the one stream", async () => {
    const { headers, offer } = await driverWith(TEST_PHONES[3]!);
    await offer(1, false);
    const offers = await listen("/driver/offers/stream?after=0", headers);
    expect(await until(() => offers.events.length === 1)).toBe(true);
    expect(offers.events[0]!.id).toBe("1");
    offers.close();
    const config = await listen("/driver/config/stream?zoneId=Z001", { ...headers, "last-event-id": "0" });
    expect(await until(() => config.events.length === 1)).toBe(true);
    expect(config.events[0]!.id).toMatch(/^\d+$/);
    config.close();
    const rider = (await signIn(app, TEST_PHONES[4]!, "rider")).headers;
    const no = await fetch(`${base}/driver/stream`, { headers: { ...rider, accept: "text/event-stream" } });
    expect(no.status).toBe(403);
  });

  it("SF-2: without Accept: text/event-stream the one stream answers 400 (no JSON answer on /driver/stream) and opens nothing", async () => {
    const { headers } = await driverWith(TEST_PHONES[5]!);
    const before = (loadSnapshot() as { streams: { open: number } }).streams.open;
    for (const accept of [undefined, "application/json"]) {
      const res = await fetch(`${base}/driver/stream?zoneId=Z001`, { headers: accept ? { ...headers, accept } : headers });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
      expect(JSON.stringify(await res.json())).toContain("event_stream_required");
    }
    expect((loadSnapshot() as { streams: { open: number } }).streams.open).toBe(before);
  });
  it("DriverAppConfig.realtime.oneStream: served false when missing; PUT refuses a realtime that is not { oneStream: boolean }", async () => {
    const { headers } = await driverWith(TEST_PHONES[5]!);
    const res = await call(app, "GET", "/driver/config?zoneId=Z001", headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().realtime).toEqual({ oneStream: false });
    const admin = (await adminSession(app, database.db, "super")).headers;
    for (const realtime of [true, "on", { oneStream: "yes" }, { oneStream: 1 }, { oneStream: null }]) {
      const put = await call(app, "PUT", "/admin/config/driver_app_config", admin, { expectedVersion: 1, zoneId: "Z001", document: { ...driverDoc, realtime } });
      expect(put.statusCode, JSON.stringify(realtime)).toBe(400);
      expect(put.json()).toMatchObject({ code: "invalid_request", reason: "invalid_document" });
    }
    await database.db.updateTable("config_live").set({ document: JSON.stringify({ ...driverDoc, realtime: { oneStream: true } }) }).where("doc", "=", "driver_app_config").where("zone_id", "=", "Z001").execute();
    expect((await call(app, "GET", "/driver/config?zoneId=Z001", headers)).json().realtime).toEqual({ oneStream: true });
  });
});
