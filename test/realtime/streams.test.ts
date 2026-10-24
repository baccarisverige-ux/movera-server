import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { CONFIG_CHANNEL } from "../../src/config/service.js";
import { TRIP_EVENTS_CHANNEL } from "../../src/db/tripLog.js";
import { readEnv } from "../../src/env.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { NORRMALM, SODERMALM, call, fixedRouter, signIn } from "../support/world.js";
import { readFileSync } from "node:fs";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";

let database: TestDatabase;
let app: FastifyInstance;
let hub: NotificationHub;
let base: string;
let firstRider: Record<string, string>;

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  const pricing = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/pricing_document.json`, "utf8"));
  await database.db.insertInto("config_live").values({ doc: "pricing", zone_id: "Z001", version: 1, document: JSON.stringify(pricing), published_at: new Date(), published_by: null }).execute();
  hub = new NotificationHub(database.url, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL]);
  await hub.start();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "stream-test-secret".padEnd(48, "s") }), logger: false, db: database.db, router: fixedRouter, hub });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await app.close();
  await hub.stop();
  await database.drop();
});

type Sse = { events: Array<{ id: string; data: Record<string, unknown> }>; comments: string[]; status: number; headers: http.IncomingHttpHeaders; ended: boolean; close: () => void };

/** Opens an SSE connection like a phone would and collects what arrives. */
function listen(path: string, headers: Record<string, string>): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const out: Sse = { events: [], comments: [], status: 0, headers: {}, ended: false, close: () => undefined };
    const req = http.get(`${base}${path}`, { headers: { ...headers, accept: "text/event-stream" } }, (res) => {
      out.status = res.statusCode ?? 0;
      out.headers = res.headers;
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
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

async function bookTrip(rider: Record<string, string>) {
  const quote = (await call(app, "POST", "/quotes", rider, { pickup: NORRMALM, dropoff: SODERMALM, stops: [], categoryIds: ["economy"] })).json().quotes[0];
  return (await call(app, "POST", "/trips", rider, { quoteId: quote.quoteId, categoryId: "economy", pickup: NORRMALM, dropoff: SODERMALM, stops: [], kind: "live", paymentMethod: "cash" })).json();
}

describe("trip stream", () => {
  it("replays from the cursor, then sends new events live, redacted for the rider", async () => {
    const rider = (firstRider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers);
    const trip = await bookTrip(rider);
    const sse = await listen(`/trips/${trip.tripId}/events?after=1`, rider);
    expect(sse.status).toBe(200);
    expect(sse.headers["content-type"]).toContain("text/event-stream");
    expect(sse.headers["x-api-version"]).toBe("0.5");
    expect(await until(() => sse.events.length === 1)).toBe(true);
    expect(sse.events[0]).toMatchObject({ id: "2", data: { tripId: trip.tripId, sequence: 2, kind: "trip_projection", projection: { status: "searching" } } });

    await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
    expect(await until(() => sse.events.length === 2)).toBe(true);
    expect(sse.events[1]).toMatchObject({ id: "3", data: { sequence: 3, version: 4, projection: { status: "cancelled_by_rider" } } });
    expect(sse.events[1]!.data["projection"]).not.toHaveProperty("driverEarnings");
    sse.close();
  });

  it("Last-Event-ID resumes after that sequence; an admin sees the money split", async () => {
    const rider = (await signIn(app, TEST_PHONES[2]!, "rider")).headers;
    const trip = await bookTrip(rider);
    const admin = await adminSession(app, database.db, "super");
    const sse = await listen(`/trips/${trip.tripId}/events`, { ...admin.headers, "last-event-id": "1" });
    expect(await until(() => sse.events.length === 1)).toBe(true);
    expect(sse.events[0]!.data).toMatchObject({ sequence: 2, projection: { driverEarnings: { amountMinor: 15760 } } });
    sse.close();
  });

  it("another rider cannot open it", async () => {
    const owner = (await signIn(app, TEST_PHONES[3]!, "rider")).headers;
    const trip = await bookTrip(owner);
    const stranger = (await signIn(app, TEST_PHONES[4]!, "rider")).headers;
    const res = await fetch(`${base}/trips/${trip.tripId}/events`, { headers: { ...stranger, accept: "text/event-stream" } });
    expect(res.status).toBe(404);
  });

  it("closing the server ends open streams", async () => {
    const extra = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "stream-test-secret".padEnd(48, "s") }), logger: false, db: database.db, router: fixedRouter, hub });
    await extra.listen({ host: "127.0.0.1", port: 0 });
    const rider = (await signIn(app, TEST_PHONES[5]!, "rider")).headers;
    const trip = await bookTrip(rider);
    const port = (extra.server.address() as AddressInfo).port;
    const done = new Promise<boolean>((resolve) => {
      http.get(`http://127.0.0.1:${port}/api/v1/trips/${trip.tripId}/events`, { headers: { ...rider, accept: "text/event-stream" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(true));
      });
    });
    await new Promise((r) => setTimeout(r, 100));
    await extra.close();
    expect(await done).toBe(true);
  });
});

describe("config stream", () => {
  it("config_published arrives when the admin publishes the rider document", async () => {
    // Signing in again within 30 s is refused (resend limit), so reuse the first rider's session.
    const rider = firstRider;
    const sse = await listen("/rider/config/stream?zoneId=Z001", rider);
    expect(sse.status).toBe(200);
    const owner = await adminSession(app, database.db, "super");
    const doc = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/rider_app_config.json`, "utf8"));
    await app.inject({ method: "PUT", url: "/api/v1/admin/config/rider_app_config", headers: { ...owner.headers, "content-type": "application/json", "idempotency-key": "stream-put-key-000001" }, payload: { expectedVersion: 1, zoneId: "Z001", document: doc } });
    await call(app, "POST", "/admin/config/rider_app_config/publish", owner.headers, { expectedVersion: 2, zoneId: "Z001" });
    expect(await until(() => sse.events.length === 1)).toBe(true);
    expect(sse.events[0]).toMatchObject({ id: "1", data: { kind: "config_published", doc: "rider_app_config", zoneId: "Z001", version: 1 } });
    sse.close();
    // Reconnecting with an older Last-Event-ID gets the newest version at once.
    const again = await listen("/rider/config/stream?zoneId=Z001", { ...rider, "last-event-id": "0" });
    expect(await until(() => again.events.length === 1)).toBe(true);
    again.close();
  });
});

describe("listen connection", () => {
  it("after the database drops the listen connection, the hub reconnects and streams catch up", async () => {
    const rider = (await signIn(app, TEST_PHONES[1]!, "rider")).headers;
    const trip = await bookTrip(rider);
    const sse = await listen(`/trips/${trip.tripId}/events?after=2`, rider);
    await new Promise((r) => setTimeout(r, 100));
    await database.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'movera-server-listen' AND datname = current_database()");
    // A change made while the hub is away is still delivered once it is back.
    await call(app, "POST", `/trips/${trip.tripId}/cancel`, rider, { expectedVersion: 3, reasonCode: "plans_changed" });
    expect(await until(() => sse.events.length === 1, 5000)).toBe(true);
    expect(sse.events[0]!.data).toMatchObject({ sequence: 3, projection: { status: "cancelled_by_rider" } });
    sse.close();
  });
});

describe("driver offer feed", () => {
  it("replays the driver's offer events from ?after= as a JSON page", async () => {
    const driver = (await signIn(app, TEST_PHONES[1]!, "driver")).headers;
    const page = await fetch(`${base}/driver/offers/stream?after=0`, { headers: driver });
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ items: [], nextCursor: null });
    const sse = await listen("/driver/offers/stream", driver);
    expect(sse.status).toBe(200);
    expect(sse.headers["content-type"]).toContain("text/event-stream");
    sse.close();
  });
});
