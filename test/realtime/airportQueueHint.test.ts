import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { AIRPORT_QUEUE_CHANNEL } from "../../src/airportQueue/service.js";
import { TEST_PHONES, seedTestPhones } from "../../src/auth/testPhones.js";
import { CONFIG_CHANNEL } from "../../src/config/service.js";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { OFFER_EVENTS_CHANNEL, TRIP_EVENTS_CHANNEL } from "../../src/db/tripLog.js";
import { readEnv } from "../../src/env.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, fixedRouter, signIn } from "../support/world.js";

/**
 * v0.18.145 (contract.json#loadCut.airportQueueLive, S4c load cut): a NOTIFY on the airport queue channel naming a
 * driver sends { eventId, kind: "airport_queue_changed", areaId, occurredAt, serverTime } on that driver's
 * GET /driver/config/stream and GET /driver/stream, and on nobody else's.
 */
let database: TestDatabase;
let app: FastifyInstance;
let hub: NotificationHub;
let base: string;
const driverDoc = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/config/driver_app_config.json`, "utf8")) as Record<string, unknown>;

beforeAll(async () => {
  database = await freshDatabase();
  await seedTestPhones(database.db);
  hub = new NotificationHub(database.url, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL, OFFER_EVENTS_CHANNEL, AIRPORT_QUEUE_CHANNEL]);
  await hub.start();
  app = await buildApp({ env: readEnv({ MOVERA_ENV: "staging", DATABASE_URL: database.url, JWT_SECRET: "airport-hint-test-secret".padEnd(48, "s") }), logger: false, db: database.db, router: fixedRouter, hub });
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

async function driver(phone: string) {
  const headers = (await signIn(app, phone, "driver")).headers;
  const driverId = (await call(app, "GET", "/driver/profile", headers)).json().driverId as string;
  await database.db.updateTable("drivers").set({ zone_ids: ["Z001"] }).where("driver_id", "=", driverId).execute();
  return { headers, driverId };
}
const hint = (driverId: string) => sql`SELECT pg_notify(${AIRPORT_QUEUE_CHANNEL}, ${JSON.stringify({ driverId, areaId: "AQ-BMA" })})`.execute(database.db);

describe("airport_queue_changed on the driver streams (v0.18.145)", () => {
  for (const path of ["/driver/config/stream?zoneId=Z001", "/driver/stream?zoneId=Z001"]) {
    it(`${path.split("?")[0]}: his own hint arrives, another driver's does not`, async () => {
      const me = await driver(TEST_PHONES[path.includes("config") ? 0 : 1]!);
      const other = await driver(TEST_PHONES[2]!);
      const sse = await listen(path, me.headers);
      expect(sse.status).toBe(200);
      await pause(300);
      await hint(other.driverId);
      await hint(me.driverId);
      expect(await until(() => sse.events.some((e) => e.data.kind === "airport_queue_changed"))).toBe(true);
      await pause(300);
      const got = sse.events.filter((e) => e.data.kind === "airport_queue_changed");
      expect(got).toHaveLength(1);
      expect(Object.keys(got[0]!.data).sort()).toEqual(["areaId", "eventId", "kind", "occurredAt", "serverTime"]);
      expect(got[0]!.data.areaId).toBe("AQ-BMA");
      sse.close();
    });
  }
});
