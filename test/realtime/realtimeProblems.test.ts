import http from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import type { Principal } from "../../src/auth/guard.js";
import { CONFIG_CHANNEL, cacheLiveDocumentsOn, liveDocument } from "../../src/config/service.js";
import { TRIP_EVENTS_CHANNEL, tripNotice } from "../../src/db/tripLog.js";
import type { Db } from "../../src/db/db.js";
import { readEnv } from "../../src/env.js";
import { ADMIN_EVENTS_CHANNEL, AdminLiveFeed, LIVE } from "../../src/realtime/adminEvents.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { openEventStream } from "../../src/realtime/sse.js";
import { INCIDENT_EVENTS_CHANNEL } from "../../src/safety/incidents.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { NORRMALM, SODERMALM, call, fixedRouter, signIn } from "../support/world.js";
import { readFileSync } from "node:fs";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";

/**
 * Global plan step 65 (T5, audits/global-plan-2026-11-08/AUDIT-S04.md E1): one test per realtime problem the audit
 * names. Each `it.fails` FAILS today on purpose (the problem is real); the wave B1/B3 fix flips it to `it`.
 * Each carries a one-line reason and the code file:line. Do not "fix" a test here: fix the server.
 */

const CHANNELS = [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL, ADMIN_EVENTS_CHANNEL, INCIDENT_EVENTS_CHANNEL];
const ENV = () => readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "stream-test-secret".padEnd(48, "s"), STREAM_SESSION_CHECK_MS: "300", STREAM_CLOSE_SPREAD_MS: "1000" });

let database: TestDatabase;
let app: FastifyInstance;
let hub: NotificationHub;
let base: string;
let uncache: () => void = () => undefined;

/** Faults and counters on the app's database handle (the stream reads; transactions use their own handle). */
const faults = { tripEventsReads: 0, configLiveReads: 0 };
const counts = { configLive: 0 };
let faulty: Db;

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 1, document: JSON.stringify(pricing), published_at: new Date(), published_by: null }).execute();
  faulty = new Proxy(database.db, {
    get(target, prop) {
      if (prop === "selectFrom") {
        return (table: string) => {
          if (table === "trip_events" && faults.tripEventsReads > 0) {
            faults.tripEventsReads -= 1;
            throw new Error("simulated pool timeout");
          }
          if (table === "config_live" && faults.configLiveReads > 0) {
            faults.configLiveReads -= 1;
            throw new Error("simulated pool timeout");
          }
          if (table === "config_live") counts.configLive += 1;
          return (target.selectFrom as (t: string) => unknown)(table);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Db;
  hub = new NotificationHub(database.url, CHANNELS);
  await hub.start();
  // B1.8: the live-document cache on, wired exactly as src/main.ts does it (before buildApp, on the same hub).
  uncache = cacheLiveDocumentsOn(hub);
  app = await buildApp({ env: ENV(), logger: false, db: faulty, router: fixedRouter, hub });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  uncache();
  await app.close();
  await hub.stop();
  await database.drop();
});

type Sse = { events: Array<{ id: string; data: Record<string, unknown> }>; status: number; ended: boolean; close: () => void };

function listen(at: string, path: string, headers: Record<string, string>): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const out: Sse = { events: [], status: 0, ended: false, close: () => undefined };
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
          if (block.startsWith(":")) continue;
          const id = /^id: (.*)$/m.exec(block)?.[1] ?? "";
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (data) out.events.push({ id, data: JSON.parse(data) });
        }
      });
      res.on("end", () => (out.ended = true));
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kinds = (sse: Sse, kind: string) => sse.events.filter((e) => e.data["kind"] === kind);

async function bookTrip(rider: Record<string, string>) {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  return (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
}
/** Kills exactly this copy's LISTEN backend (Rule 33: the other copy keeps its own). */
async function killListen(h: NotificationHub): Promise<void> {
  const pid = (h as unknown as { client: pg.Client & { processID: number } }).client.processID;
  await database.pool.query("SELECT pg_terminate_backend($1)", [pid]);
}

describe("T5 realtime problems (AUDIT-S04, fail today)", () => {
  // A2 / P11: the pump catches, logs and stops; nothing reads again until an unrelated NOTIFY.
  it("A2/P11: a failed trip stream read is retried, so the cancel arrives without a later NOTIFY (src/realtime/streams.ts:69-70)", async () => {
    const rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    const trip = await bookTrip(rider);
    const sse = await listen(base, `/trips/${trip.tripId}/events?after=2`, rider);
    await sleep(150);
    faults.tripEventsReads = 1;
    await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
    const got = await until(() => sse.events.length === 1, 6000);
    faults.tripEventsReads = 0;
    sse.close();
    expect(got).toBe(true);
  });

  it("A2: a failed FIRST replay is retried, so a stream opened while the DB is busy still gets the missed events (src/realtime/streams.ts:80)", async () => {
    const rider = (await signIn(app, TEST_PHONES[1]!, "rider")).headers;
    const trip = await bookTrip(rider);
    faults.tripEventsReads = 1;
    const sse = await listen(base, `/trips/${trip.tripId}/events?after=0`, rider);
    const got = await until(() => sse.events.length >= 2, 6000);
    faults.tripEventsReads = 0;
    sse.close();
    expect(got).toBe(true);
  });

  it("A2: a failed settings-stream config read is retried, so the new version arrives without a later NOTIFY (src/realtime/streams.ts:139)", async () => {
    const rider = (await signIn(app, TEST_PHONES[2]!, "rider")).headers;
    const sse = await listen(base, "/rider/config/stream?zoneId=Z001", rider);
    await sleep(200);
    const top = Number((await database.pool.query("SELECT max(version) AS v FROM config_live WHERE doc = 'rider_app_config' AND zone_id = 'Z001'")).rows[0]?.v ?? 0);
    const before = kinds(sse, "config_published").length;
    faults.configLiveReads = 1;
    await database.pool.query("INSERT INTO config_live (doc, zone_id, version, document, published_at, published_by) VALUES ('rider_app_config', 'Z001', $1, '{}', now(), NULL)", [top + 1]);
    await database.pool.query("SELECT pg_notify($1, $2)", [CONFIG_CHANNEL, JSON.stringify({ doc: "rider_app_config", zoneId: "Z001", version: top + 1 })]);
    const got = await until(() => kinds(sse, "config_published").length > before, 6000);
    faults.configLiveReads = 0;
    sse.close();
    expect(got).toBe(true);
  });

  // A3 / P3, fixed by B1.8 (#174, src/config/service.ts liveDocument in-flight map) with the cache on as in production.
  it("A3/P3 (B1.8): 100 settings streams and one real publish make ONE config_live read per (doc, zone); every stream gets the new version once (src/config/service.ts liveDocument, src/realtime/streams.ts sent)", async () => {
    const zoneId = "Z003";
    const owner = await adminSession(app, database.db, "super");
    const sample = { ...JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/rider_app_config.json`, "utf8")), zoneId };
    // A draft is saved first; the counter is reset right before the publish itself (the admin draft read uses config_live too).
    const draftUp = async () => {
      const got = await call(app, "GET", `/admin/config/rider_app_config?zoneId=${zoneId}`, owner.headers);
      // No document yet (404 config_not_found): the first draft is saved at version 1.
      const at = got.statusCode === 404 ? 1 : (got.json().version as number);
      const put = await call(app, "PUT", "/admin/config/rider_app_config", owner.headers, { expectedVersion: at, zoneId, document: sample });
      expect(put.statusCode, put.body).toBe(200);
      return put.json().version as number;
    };
    const publish = async (expectedVersion: number) => {
      const done = await call(app, "POST", "/admin/config/rider_app_config/publish", owner.headers, { expectedVersion, zoneId });
      expect(done.statusCode, done.body).toBe(200);
      return done.json().version as number;
    };
    const first = await publish(await draftUp());
    const rider = (await signIn(app, TEST_PHONES[2]!, "rider")).headers;
    const streams = await Promise.all(Array.from({ length: 100 }, () => listen(base, `/rider/config/stream?zoneId=${zoneId}`, rider)));
    expect(streams.every((s) => s.status === 200)).toBe(true);
    await sleep(300);
    const draft = await draftUp();
    counts.configLive = 0;
    const next = await publish(draft);
    expect(next).toBe(first + 1);
    const gotAll = await until(() => streams.every((s) => kinds(s, "config_published").length >= 1), 6000);
    await sleep(300);
    const reads = counts.configLive;
    for (const s of streams) s.close();
    console.log(`A3/P3 proof (B1.8): 100 settings streams, 1 publish -> ${reads} config_live read(s)`);
    expect(gotAll).toBe(true);
    // One shared read for (rider_app_config, Z003): the zone has its own document, so a read is one config_live select.
    expect(reads).toBe(1);
    // Each stream sends the new version exactly once, with that version as the event id ("last version sent").
    for (const s of streams) {
      const published = kinds(s, "config_published");
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({ id: String(next), data: { doc: "rider_app_config", zoneId, version: next } });
    }
  });

  // Rule 33 / supervisor finding 7: a publish made by ANOTHER server copy reaches this copy only as a NOTIFY; nothing
  // here clears the cache first. Only the forget listener (subscribed before every stream, cacheLiveDocumentsOn in
  // main.ts) empties it, so the streams miss together and share one read instead of serving the old cached version.
  it("A3/P3 (B1.8) + Rule 33: a publish by another copy (config_live write + NOTIFY, no local cache clear) makes ONE read for 50 streams; each gets the new version once", async () => {
    const zoneId = "Z004";
    const doc = "rider_app_config";
    const sample = { ...JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/rider_app_config.json`, "utf8")), zoneId, version: 1, publishedAt: new Date().toISOString() };
    await database.pool.query("INSERT INTO config_live (doc, zone_id, version, document, published_at, published_by) VALUES ($1, $2, 1, $3, now(), NULL)", [doc, zoneId, JSON.stringify(sample)]);
    const rider = (await signIn(app, TEST_PHONES[2]!, "rider")).headers;
    const streams = await Promise.all(Array.from({ length: 50 }, () => listen(base, `/rider/config/stream?zoneId=${zoneId}`, rider)));
    expect(streams.every((s) => s.status === 200)).toBe(true);
    await sleep(300);
    // The stream opens read (and cached) version 1; the cache holds it when the other copy publishes.
    expect((await liveDocument(faulty, doc, zoneId))?.version).toBe(1);
    counts.configLive = 0;
    // What publishDraft does on the other copy: the row and the NOTIFY in one transaction (delivered at commit).
    const other = await database.pool.connect();
    const publishedAt = new Date().toISOString();
    try {
      await other.query("BEGIN");
      await other.query("UPDATE config_live SET version = 2, document = $3, published_at = now() WHERE doc = $1 AND zone_id = $2", [doc, zoneId, JSON.stringify({ ...sample, version: 2, publishedAt })]);
      await other.query("SELECT pg_notify($1, $2)", [CONFIG_CHANNEL, JSON.stringify({ doc, zoneId, version: 2, publishedAt })]);
      await other.query("COMMIT");
    } finally {
      other.release();
    }
    const gotAll = await until(() => streams.every((s) => kinds(s, "config_published").length >= 1), 3000);
    await sleep(300);
    const reads = counts.configLive;
    for (const s of streams) s.close();
    console.log(`A3/P3 other-copy proof (B1.8): 50 settings streams, 1 other-copy publish -> ${reads} config_live read(s)`);
    expect(gotAll).toBe(true);
    expect(reads).toBe(1);
    for (const s of streams) {
      const published = kinds(s, "config_published");
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({ id: "2", data: { doc, zoneId, version: 2, publishedAt } });
    }
  });

  // A5 / P5: the hint listeners return on the null catch-up signal after a LISTEN reconnect. B1.18: the close is
  // spread over STREAM_CLOSE_SPREAD_MS (1 s in this file, see ENV; 30 s by default, test/realtime/reconnectHints.test.ts).
  it("A5/P5: after a LISTEN reconnect the rider's settings stream closes, so the app reconnects and re-reads the trip it may have missed (src/realtime/streams.ts:155)", async () => {
    const rider = (await signIn(app, TEST_PHONES[3]!, "rider")).headers;
    const trip = await bookTrip(rider);
    const sse = await listen(base, "/rider/config/stream?zoneId=Z001", rider);
    await sleep(300);
    await killListen(hub);
    await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
    const ended = await until(() => sse.ended, 5000);
    sse.close();
    expect(ended).toBe(true);
  });

  it("A5: after a LISTEN reconnect the driver's settings stream closes (driver_reservations_changed hint may be lost) (src/realtime/streams.ts:164)", async () => {
    await seedTestPhones(database.db, ["+46701740621"]);
    const driver = (await signIn(app, "+46701740621", "driver")).headers;
    const sse = await listen(base, "/driver/config/stream?zoneId=Z001", driver);
    expect(sse.status).toBe(200);
    await sleep(300);
    await killListen(hub);
    const ended = await until(() => sse.ended, 5000);
    sse.close();
    expect(ended).toBe(true);
  });

  // Rule 33 variant of A5: two copies, only copy A's LISTEN drops; copy B delivers, copy A loses the hint silently.
  it("A5 + Rule 33: with 2 copies, the copy whose LISTEN dropped closes its rider stream (the app reconnects); the other keeps delivering (src/realtime/streams.ts:130, src/realtime/hub.ts:59)", async () => {
    const hub2 = new NotificationHub(database.url, CHANNELS);
    await hub2.start();
    const app2 = await buildApp({ env: ENV(), logger: false, db: database.db, router: fixedRouter, hub: hub2 });
    await app2.listen({ host: "127.0.0.1", port: 0 });
    const base2 = `http://127.0.0.1:${(app2.server.address() as AddressInfo).port}/api/v1`;
    try {
      const rider = (await signIn(app, TEST_PHONES[4]!, "rider")).headers;
      const trip = await bookTrip(rider);
      const onA = await listen(base, "/rider/config/stream?zoneId=Z001", rider);
      const onB = await listen(base2, "/rider/config/stream?zoneId=Z001", rider);
      await sleep(300);
      await killListen(hub);
      // Copy B may still get hints from the booking's own earlier changes, so wait for a NEW one after the cancel.
      const hintsBefore = kinds(onB, "rider_trip_changed").length;
      const cancelled = await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
      expect(cancelled.statusCode).toBe(200);
      expect(await until(() => kinds(onB, "rider_trip_changed").length > hintsBefore)).toBe(true);
      const endedA = await until(() => onA.ended, 4000);
      const endedB = onB.ended;
      onA.close();
      onB.close();
      expect(endedA).toBe(true);
      expect(endedB).toBe(false);
    } finally {
      await app2.close();
      await hub2.stop();
    }
  });

  // C / P7: fixed by B1.15 (src/realtime/sessionWatch.ts): each copy re-checks its streams' session rows every
  // STREAM_SESSION_CHECK_MS (300 ms here, default 30 s), so sign-out ends the stream.
  it("P7: a rider's open settings stream ends after POST /auth/sign-out (src/realtime/sessionWatch.ts)", async () => {
    const rider = (await signIn(app, TEST_PHONES[5]!, "rider")).headers;
    const sse = await listen(base, "/rider/config/stream?zoneId=Z001", rider);
    expect(sse.status).toBe(200);
    expect((await call(app, "POST", "/auth/sign-out", rider)).statusCode).toBe(204);
    expect((await call(app, "GET", "/rider/config?zoneId=Z001", rider)).statusCode).toBe(401);
    const ended = await until(() => sse.ended, 5000);
    sse.close();
    expect(ended).toBe(true);
  });

  // A1 / P4: bigserial taken at insert; fixed by B6 (src/realtime/settled.ts): the feed reads from a settled floor.
  it("A1/P4: admin live feed sends an event whose transaction commits after a later sequence", async () => {
    const perms = [...new Set(Object.values(LIVE.types).map((t) => t.permission))];
    const who = { actor: "admin", subjectId: "adm_t5", sessionId: "ses_t5", zones: ["*"], perms } as Principal;
    const feed = new AdminLiveFeed(database.db, hub, { warn: () => undefined });
    const sent: number[] = [];
    const sub = { who, last: 0, catchingUp: true, send: (row: { sequence: string }) => sent.push(Number(row.sequence)), cursor: () => undefined, close: () => undefined };
    const top = await database.pool.query<{ top: string | null }>("SELECT max(sequence) AS top FROM admin_live_events");
    sub.last = Number(top.rows[0]!.top ?? 0);
    const leave = await feed.join(sub);
    const a = new pg.Client({ connectionString: database.url });
    const b = new pg.Client({ connectionString: database.url });
    await a.connect();
    await b.connect();
    try {
      await a.query("BEGIN");
      const seqA = Number((await a.query("INSERT INTO admin_live_events (type, entity_id, zone_id) VALUES ('trip.changed', 'trp_a', 'Z001') RETURNING sequence")).rows[0].sequence);
      await a.query("SELECT pg_notify($1, $2)", [ADMIN_EVENTS_CHANNEL, JSON.stringify({ sequence: seqA })]);
      await b.query("BEGIN");
      const seqB = Number((await b.query("INSERT INTO admin_live_events (type, entity_id, zone_id) VALUES ('trip.changed', 'trp_b', 'Z001') RETURNING sequence")).rows[0].sequence);
      await b.query("SELECT pg_notify($1, $2)", [ADMIN_EVENTS_CHANNEL, JSON.stringify({ sequence: seqB })]);
      await b.query("COMMIT");
      expect(await until(() => sent.includes(seqB))).toBe(true);
      await a.query("COMMIT");
      await sleep(1500);
      console.log(`A1/P4 proof: sequences ${seqA} (commits last) and ${seqB}; feed sent [${sent.join(",")}]`);
      expect(sent).toContain(seqA);
    } finally {
      leave();
      await a.end();
      await b.end();
    }
  });

  // B3 / P8: no cursor = after 0 = the whole incident history (closed incidents included) on every admin load.
  // Fixed by S7 W2 Q126 (v0.18.126): no cursor starts from the open incidents.
  it("B3/P8: the admin incident stream opened without a cursor does not replay closed old incidents (src/safety/routes.ts:94)", async () => {
    const old = new Date(Date.now() - 60 * 86_400_000);
    const n = 300;
    const top = await database.pool.query<{ top: string | null }>("SELECT max(sequence) AS top FROM incident_events");
    const start = Number(top.rows[0]!.top ?? 0);
    for (let i = 1; i <= n; i += 1) {
      const id = `inc_t5_${i}`;
      await database.pool.query("INSERT INTO incidents (incident_id, kind, severity, status, raised_by, zone_id, opened_at, updated_at) VALUES ($1, 'sos', 'high', 'resolved', 'system', 'Z001', $2, $2)", [id, old]);
      await database.pool.query("INSERT INTO incident_events (sequence, event_id, incident_id, kind, zone_id, incident, occurred_at) VALUES ($1, $2, $3, 'incident_closed', 'Z001', $4, $5)", [start + i, `evt_t5_${i}`, id, JSON.stringify({ incidentId: id, status: "resolved", zoneId: "Z001" }), old]);
    }
    const admin = await adminSession(app, database.db, "super");
    const sse = await listen(base, "/admin/incidents/stream", admin.headers);
    await sleep(1500);
    const replayed = sse.events.length;
    sse.close();
    console.log(`B3/P8 proof: ${n} closed 60-day-old incident events; a new stream without a cursor got ${replayed}`);
    expect(replayed).toBe(0);
  });

  // B5 / P10: send() returns raw.write()'s boolean and no caller looks at it; nothing pauses or closes a stuck reader.
  it.fails("B5/P10: a stream whose reader never drains is closed above a buffer cap (src/realtime/sse.ts:60-63)", () => {
    class StuckSocket extends EventEmitter {
      writableLength = 0;
      writeHead() {}
      write(chunk: string) {
        this.writableLength += chunk.length;
        return false;
      }
      end() {}
    }
    const raw = new StuckSocket();
    const reply = { hijack: () => undefined, raw, getHeaders: () => ({}) } as unknown as FastifyReply;
    const request = { server: {}, raw: new EventEmitter() } as unknown as FastifyRequest;
    const stream = openEventStream(request, reply, 60_000);
    const big = { blob: "x".repeat(2000) };
    for (let i = 1; i <= 20_000 && !stream.closed(); i += 1) stream.send(i, big);
    const buffered = raw.writableLength;
    const closed = stream.closed();
    stream.close();
    console.log(`B5/P10 proof: stuck reader, 20,000 x 2 KB sends -> ${Math.round(buffered / 1e6)} MB buffered, closed=${closed}`);
    expect(closed).toBe(true);
  });

  // A4: no keepAlive on the LISTEN client, no ping, and /healthz says nothing about realtime.
  it("A4: the LISTEN client uses TCP keepAlive (src/realtime/hub.ts:31)", () => {
    const client = (hub as unknown as { client: { connection: { _keepAlive?: boolean } } }).client;
    expect(client.connection._keepAlive).toBe(true);
  });

  it("A4/E2: /healthz reports realtime (LISTEN up/down, open streams) (src/app.ts:193-199)", async () => {
    const res = await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/healthz`);
    const body = (await res.json()) as { realtime: Record<string, unknown> };
    expect(body.realtime).toMatchObject({ status: "ok", reconnects: expect.any(Number), subscribers: expect.any(Number) });
  });

  it("A4: a LISTEN health check that hangs reconnects and tells every stream to catch up", async () => {
    const h = new NotificationHub(database.url, CHANNELS, undefined, { everyMs: 100, timeoutMs: 50 });
    await h.start();
    try {
      let catchUps = 0;
      h.subscribe(TRIP_EVENTS_CHANNEL, (payload) => void (payload === null && (catchUps += 1)));
      // The socket "died without a close": queries never answer.
      const client = (h as unknown as { client: pg.Client }).client;
      client.query = (() => new Promise(() => undefined)) as unknown as pg.Client["query"];
      expect(await until(() => catchUps >= 1, 4000)).toBe(true);
      expect(h.healthSnapshot()).toMatchObject({ status: "ok", reconnects: 1 });
      expect((h as unknown as { client: pg.Client }).client).not.toBe(client);
    } finally {
      await h.stop();
    }
    expect(h.healthSnapshot().status).toBe("down");
  });

  // Not a problem today (passes): every NOTIFY payload is a small doorbell, far under PostgreSQL's 8000-byte limit.
  it("NOTIFY payloads stay far under the 8000-byte limit (src/db/tripLog.ts:128-145, src/config/service.ts:204)", () => {
    const longId = "x".repeat(64);
    const trip = JSON.stringify(tripNotice(`trp_${longId}`, Number.MAX_SAFE_INTEGER, { rider_id: `rdr_${longId}`, zone_id: `Z_${longId}`, scheduled_at: new Date(), driver_id: `drv_${longId}` }, true));
    const config = JSON.stringify({ doc: "driver_app_config", zoneId: `Z_${longId}`, version: Number.MAX_SAFE_INTEGER, publishedAt: new Date().toISOString() });
    expect(Buffer.byteLength(trip)).toBeLessThan(1000);
    expect(Buffer.byteLength(config)).toBeLessThan(1000);
  });

  // Kept as a regression (passes, P1): a client that disconnects is unsubscribed at once.
  it("P1: closing 10 trip streams removes their listeners (src/realtime/streams.ts:240)", async () => {
    const rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
    const trip = await bookTrip(rider);
    const before = hub.subscriberCount();
    const streams = await Promise.all(Array.from({ length: 10 }, () => listen(base, `/trips/${trip.tripId}/events?after=2`, rider)));
    await until(() => hub.subscriberCount() === before + 10);
    expect(hub.subscriberCount()).toBe(before + 10);
    for (const s of streams) s.close();
    expect(await until(() => hub.subscriberCount() === before)).toBe(true);
  });
});
