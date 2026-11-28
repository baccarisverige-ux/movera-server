import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFIG_CHANNEL } from "../../src/config/service.js";
import { TRIP_EVENTS_CHANNEL } from "../../src/db/tripLog.js";
import { ADMIN_EVENTS_CHANNEL } from "../../src/realtime/adminEvents.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase } from "../support/db.js";
import { roadWorld, type RoadWorld } from "../support/roadLines171.js";
import { call } from "../support/world.js";

/**
 * v0.18.171 (contract.json#googleRoadLines.riderEvent; plan 3.6, the leak): eta.legRoute is on the rider's copy of the
 * location event only. The driver stream, the admin stream and GET /trips/{id}/events for the driver and the admin never
 * carry it; the rider's do. Both paths go through realtime/events.ts eventEnvelope.
 */
let w: RoadWorld;
let hub: NotificationHub;
let base: string;
let tripId: string;
let admin: Record<string, string>;

beforeAll(async () => {
  const database = await freshDatabase();
  hub = new NotificationHub(database.url, [TRIP_EVENTS_CHANNEL, CONFIG_CHANNEL, ADMIN_EVENTS_CHANNEL]);
  await hub.start();
  w = await roadWorld({ hub, database });
  await w.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(w.app.server.address() as AddressInfo).port}/api/v1`;
  await w.reset();
  tripId = (await w.accepted()).tripId;
  admin = (await adminSession(w.app, w.database.db, "super", { now: w.clock.now })).headers;
});
afterAll(async () => {
  await w.close();
  await hub.stop();
});

type Event = { kind: string; eta?: Record<string, unknown> };

/** The events an SSE stream of this trip sends from the start (after=0), until it has sent `count` of them. */
function streamEvents(headers: Record<string, string>, count: number): Promise<Event[]> {
  return new Promise((resolve, reject) => {
    const out: Event[] = [];
    const req = http.get(`${base}/trips/${tripId}/events?after=0`, { headers: { ...headers, accept: "text/event-stream" } }, (res) => {
      expect(res.statusCode).toBe(200);
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (data) out.push(JSON.parse(data.slice(6)) as Event);
          if (out.length >= count) {
            req.destroy();
            resolve(out);
          }
        }
      });
    });
    req.on("error", (error) => (out.length >= count ? undefined : reject(error)));
    setTimeout(() => {
      req.destroy();
      resolve(out);
    }, 4000);
  });
}

const locations = (events: Event[]) => events.filter((e) => e.kind === "location" && e.eta);

describe("eta.legRoute only on the rider's copy (v0.18.171)", () => {
  it("GET /trips/{id}/events: the rider's carries it, the driver's and the admin's never", async () => {
    const list = async (headers: Record<string, string>) => (await call(w.app, "GET", `/trips/${tripId}/events?after=0&limit=200`, headers)).json().items as Event[];
    const rider = locations(await list(w.rider()));
    expect(rider.length).toBeGreaterThan(0);
    expect(rider[0]!.eta).toHaveProperty("legRoute");
    for (const headers of [w.driver.headers, admin]) {
      const seen = locations(await list(headers));
      expect(seen.length).toBe(rider.length);
      for (const e of seen) expect(e.eta).not.toHaveProperty("legRoute");
    }
  });

  it("the driver stream and the admin stream never carry it; the rider stream does", async () => {
    const total = (await call(w.app, "GET", `/trips/${tripId}/events?after=0&limit=200`, w.rider())).json().items.length as number;
    const rider = locations(await streamEvents(w.rider(), total));
    expect(rider.length).toBeGreaterThan(0);
    expect(rider[0]!.eta).toHaveProperty("legRoute");
    for (const headers of [w.driver.headers, admin]) {
      const seen = locations(await streamEvents(headers, total));
      expect(seen.length).toBe(rider.length);
      for (const e of seen) expect(e.eta).not.toHaveProperty("legRoute");
    }
  });
});
