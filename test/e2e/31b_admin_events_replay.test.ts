import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { AddressInfo } from "node:net";
import { buildApp } from "../../src/app.js";
import { ADMIN_EVENTS_CHANNEL, LIVE } from "../../src/realtime/adminEvents.js";
import { NotificationHub } from "../../src/realtime/hub.js";
import { Sim, Stream, type Admin } from "./harness.js";

/**
 * contract v0.18.47 §69 (503 fix, Rules plan/FIX-503-ADMIN-BURST-2026-11-06.md): on staging every new admin stream without a
 * cursor replayed the last 24 h (5571 events in 5 s); the panel reloaded lists per event, the DB pool filled -> 503.
 * No cursor = from now; a cursor with more than replayMax unseen = ONE resync, then live; rule 33: a cursor from copy A works on copy B.
 */
let sim: Sim;
let owner: Admin;
beforeAll(async () => {
  sim = await Sim.start();
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
});

const db = () => sim.database.db;
async function add(prefix: string, n: number): Promise<number> {
  const rows = Array.from({ length: n }, (_, i) => ({ type: "trip.changed", entity_id: `${prefix}-${i}`, zone_id: "Z001" }));
  for (let i = 0; i < rows.length; i += 500) await db().insertInto("admin_live_events").values(rows.slice(i, i + 500)).execute();
  return top();
}
async function top(): Promise<number> {
  const row = await db().selectFrom("admin_live_events").select((eb) => eb.fn.max("sequence").as("top")).executeTakeFirst();
  return Number(row?.top ?? 0);
}
async function live(entity: string): Promise<void> {
  await db().transaction().execute(async (trx) => {
    await trx.insertInto("admin_live_events").values({ type: "trip.changed", entity_id: entity, zone_id: "Z001" }).execute();
    await sql`SELECT pg_notify(${ADMIN_EVENTS_CHANNEL}, '{}')`.execute(trx);
  });
}
const named = (s: Stream, prefix: string) => s.events.filter((e) => String(e.data["entityId"] ?? "").startsWith(prefix));
const resyncs = (s: Stream) => s.events.filter((e) => e.data["type"] === "resync");

describe("GET /admin/events replay limit (v0.18.47 §69)", () => {
  it("replayMax is 500 in the contract copy", () => {
    expect(LIVE.replayMax).toBe(500);
  });

  it("a stream WITHOUT a cursor starts from now: none of 5571 old events, no resync; a new event still arrives", async () => {
    await add("old", 5571);
    const s = await sim.stream("/admin/events", owner.token);
    await live("fresh-1");
    await s.waitFor((e) => e.data["entityId"] === "fresh-1");
    // Fail-before: the stream replayed every kept event after 0 (5571 'old-*' events).
    expect(named(s, "old-")).toHaveLength(0);
    expect(resyncs(s)).toHaveLength(0);
    s.close();
  });

  it("a cursor 10 behind gets exactly those 10 unseen events, then live", async () => {
    const at = await top();
    await add("ten", 10);
    const s = await sim.stream("/admin/events", owner.token, String(at));
    await s.waitFor((e) => e.data["entityId"] === "ten-9");
    await live("fresh-2");
    await s.waitFor((e) => e.data["entityId"] === "fresh-2");
    expect(named(s, "ten-").map((e) => e.data["entityId"])).toEqual(Array.from({ length: 10 }, (_, i) => `ten-${i}`));
    expect(resyncs(s)).toHaveLength(0);
    s.close();
  });

  it("a cursor 600 behind (more than replayMax) gets ONE resync with its own cursor, not 600 events, then live", async () => {
    const at = await top();
    await add("many", 600);
    const s = await sim.stream("/admin/events", owner.token, String(at));
    const r = await s.waitFor((e) => e.data["type"] === "resync");
    expect(r.id).toBe(String(at));
    await live("fresh-3");
    await s.waitFor((e) => e.data["entityId"] === "fresh-3");
    // Fail-before: all 600 'many-*' events were replayed and no resync was sent.
    expect(named(s, "many-")).toHaveLength(0);
    expect(resyncs(s)).toHaveLength(1);
    s.close();
  });

  it("rule 33: a cursor from server copy A, reconnected on copy B, gets exactly the unseen events (none twice, none missed)", async () => {
    const hub2 = new NotificationHub(sim.database.url, [ADMIN_EVENTS_CHANNEL]);
    await hub2.start();
    const app2 = await buildApp({ env: sim.env, logger: false, db: db(), clock: () => sim.clock.now, hub: hub2 });
    await app2.listen({ host: "127.0.0.1", port: 0 });
    const base2 = `http://127.0.0.1:${(app2.server.address() as AddressInfo).port}/api/v1`;
    try {
      const a = await sim.stream("/admin/events", owner.token);
      await live("copyA-1");
      const seen = await a.waitFor((e) => e.data["entityId"] === "copyA-1");
      a.close();
      await add("gap", 5);
      const b = new Stream(`${base2}/admin/events`, owner.token);
      await b.open(seen.id);
      await b.waitFor((e) => e.data["entityId"] === "gap-4");
      await live("copyB-live");
      await b.waitFor((e) => e.data["entityId"] === "copyB-live");
      const ids = b.events.map((e) => String(e.data["entityId"]));
      expect(ids.filter((x) => x.startsWith("gap-"))).toEqual(["gap-0", "gap-1", "gap-2", "gap-3", "gap-4"]);
      expect(ids).not.toContain("copyA-1");
      expect(new Set(ids).size).toBe(ids.length);
      expect(resyncs(b)).toHaveLength(0);
      b.close();
    } finally {
      await app2.close();
      await hub2.stop();
    }
  });
});
