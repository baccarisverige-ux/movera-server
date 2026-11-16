import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tripNotice } from "../../src/db/tripLog.js";
import { NotificationHub, type Listener } from "../../src/realtime/hub.js";

/**
 * S7 0.15 (owner W2 Q120 part 1 "Yes, all three", 2026-11-15): the hub called EVERY listener of a channel for every
 * NOTIFY (10,000 open trip streams = 10,000 calls per trip event, each only to find "not my trip"). Now a listener
 * says which payloads it is for (`match`), and a NOTIFY runs only the listeners it fits, plus the listeners that gave
 * none. The catch-up signal after a reconnect still reaches every listener, "first" before "spread" (PM-1 / B1.16
 * unchanged). Fake pg client only (F26): no database, no real sleeps.
 */

let clients: pg.Client[];

beforeEach(() => {
  clients = [];
  vi.spyOn(pg.Client.prototype, "connect").mockImplementation(async function (this: pg.Client) {
    clients.push(this);
  } as unknown as pg.Client["connect"]);
  vi.spyOn(pg.Client.prototype, "query").mockImplementation((async () => ({ rows: [] })) as unknown as pg.Client["query"]);
  vi.spyOn(pg.Client.prototype, "end").mockImplementation((async () => undefined) as unknown as pg.Client["end"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const URL = "postgres://movera:movera@127.0.0.1:5432/none";
type Match = Array<Record<string, string | number | boolean>>;
/** subscribe with `match` (typed loosely so this file also loads on the code before the fix, which ignores it). */
const sub = (h: NotificationHub, channel: string, fn: Listener, match?: Match, catchUp?: "first" | "spread") =>
  (h.subscribe as unknown as (channel: string, fn: Listener, options: { match?: Match; catchUp?: "first" | "spread" }) => () => void).call(h, channel, fn, { ...(match ? { match } : {}), ...(catchUp ? { catchUp } : {}) });
const current = (h: NotificationHub) => (h as unknown as { client: pg.Client | undefined }).client!;
const send = (h: NotificationHub, channel: string, payload: unknown) => current(h).emit("notification", { channel, payload: typeof payload === "string" ? payload : JSON.stringify(payload) });

describe("S7 0.15: a NOTIFY runs only the listeners it is for", () => {
  it("10,000 trip listeners: a trip event calls 1 of them, not 10,000", async () => {
    const hub = new NotificationHub(URL, ["trips"]);
    await hub.start();
    let calls = 0;
    const got: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      sub(hub, "trips", (payload) => {
        calls += 1;
        if (payload !== null) got.push(`trp_${i}`);
      }, [{ tripId: `trp_${i}` }]);
    }
    send(hub, "trips", { tripId: "trp_4711", sequence: 3 });
    console.log(`0.15 proof: 10,000 trip listeners, one trip event: ${calls} listener call(s)`);
    expect(got).toEqual(["trp_4711"]);
    expect(calls).toBe(1);
    await hub.stop();
  });

  it("each field has its own index; a listener that fits on two entries is called once", async () => {
    const hub = new NotificationHub(URL, ["trips"]);
    await hub.start();
    const seen: string[] = [];
    const on = (name: string) => () => void seen.push(name);
    sub(hub, "trips", on("trip A"), [{ tripId: "trp_a" }]);
    sub(hub, "trips", on("trip B"), [{ tripId: "trp_b" }]);
    sub(hub, "trips", on("rider 1"), [{ riderId: "rdr_1" }]);
    sub(hub, "trips", on("rider 2"), [{ riderId: "rdr_2" }]);
    sub(hub, "trips", on("zone 1 or driver 1"), [{ zoneId: "zon_1" }, { driverId: "drv_1" }]);
    sub(hub, "trips", on("zone 2 or driver 2"), [{ zoneId: "zon_2" }, { driverId: "drv_2" }]);
    send(hub, "trips", { tripId: "trp_a", riderId: "rdr_1", zoneId: "zon_1", driverId: "drv_1" });
    expect(seen).toEqual(["trip A", "rider 1", "zone 1 or driver 1"]);
    seen.length = 0;
    // The driver of zone 2 on a trip of zone 1: found by his driver id.
    send(hub, "trips", { tripId: "trp_b", riderId: "rdr_9", zoneId: "zon_1", driverId: "drv_2" });
    expect(seen).toEqual(["trip B", "zone 1 or driver 1", "zone 2 or driver 2"]);
    seen.length = 0;
    // A value under another field name is not a match (a trip id is never read as a rider id).
    send(hub, "trips", { tripId: "rdr_1", riderId: "trp_a" });
    expect(seen).toEqual([]);
    // A value of another type, or none, matches nobody ("7" is not 7, "true" is not true).
    sub(hub, "trips", on("text 7"), [{ tripId: "7" }]);
    sub(hub, "trips", on("text true"), [{ riderId: "true" }]);
    send(hub, "trips", { tripId: 7, riderId: true, zoneId: { a: 1 }, driverId: null });
    expect(seen).toEqual([]);
    await hub.stop();
  });

  it("an entry with two fields needs both: a driver's booked-rides listener is not run by the ordinary trip events of his zone", async () => {
    const hub = new NotificationHub(URL, ["trips"]);
    await hub.start();
    let calls = 0;
    const hints: string[] = [];
    // 2,000 online drivers of zone Z001, as realtime/streams.ts subscribes them (driver_reservations_changed).
    for (let i = 0; i < 2_000; i++) {
      sub(hub, "trips", (payload) => {
        calls += 1;
        if (payload !== null) hints.push(`drv_${i}`);
      }, [{ reservations: true, zoneId: "Z001" }, { reservations: true, driverId: `drv_${i}` }], "spread");
    }
    const row = { rider_id: "rdr_1", zone_id: "Z001", scheduled_at: null, driver_id: "drv_5" };
    // A live trip's event (a GPS fix, a step) in that zone, with one of those drivers on it: nobody is run.
    send(hub, "trips", tripNotice("trp_live", 1, row));
    // A booked ride's ordinary event (not a list change) in that zone: nobody either.
    send(hub, "trips", tripNotice("trp_booked", 2, { ...row, scheduled_at: new Date() }));
    expect(calls).toBe(0);
    // A booked ride's list change in another zone that names driver 5: only he.
    send(hub, "trips", tripNotice("trp_booked", 3, { ...row, zone_id: "Z002", scheduled_at: new Date() }, true));
    expect(hints).toEqual(["drv_5"]);
    // A booked ride's list change in Z001: every driver of the zone, each once (driver 5 fits both entries).
    hints.length = 0;
    send(hub, "trips", tripNotice("trp_booked", 4, { ...row, scheduled_at: new Date() }, true));
    console.log(`0.15 proof (driver hint): 2,000 driver listeners; 2 ordinary trip events ran 0 of them; a booked-ride list change of the zone ran ${hints.length}`);
    expect(hints.length).toBe(2_000);
    expect(new Set(hints).size).toBe(2_000);
    await hub.stop();
  });

  it("a listener without `match` still gets every NOTIFY of its channel, and the order stays the subscribe order", async () => {
    const hub = new NotificationHub(URL, ["trips", "offers"]);
    await hub.start();
    const seen: string[] = [];
    sub(hub, "trips", () => void seen.push("1 all"));
    sub(hub, "trips", () => void seen.push("2 trip A"), [{ tripId: "trp_a" }]);
    sub(hub, "trips", () => void seen.push("3 all"));
    sub(hub, "trips", () => void seen.push("4 rider 1"), [{ riderId: "rdr_1" }]);
    sub(hub, "trips", () => void seen.push("5 trip B"), [{ tripId: "trp_b" }]);
    sub(hub, "trips", () => void seen.push("6 all (empty list)"), []);
    sub(hub, "offers", () => void seen.push("offers: driver 1"), [{ driverId: "drv_1" }]);
    send(hub, "trips", { tripId: "trp_a", riderId: "rdr_1", driverId: "drv_1" });
    expect(seen).toEqual(["1 all", "2 trip A", "3 all", "4 rider 1", "6 all (empty list)"]);
    seen.length = 0;
    send(hub, "trips", { tripId: "trp_zzz" });
    expect(seen).toEqual(["1 all", "3 all", "6 all (empty list)"]);
    seen.length = 0;
    // Another channel's listeners are never touched, whatever the payload says.
    send(hub, "offers", { driverId: "drv_1", tripId: "trp_a" });
    expect(seen).toEqual(["offers: driver 1"]);
    await hub.stop();
  });

  it("a payload that cannot be read is the catch-up signal for every listener of the channel, as before", async () => {
    const hub = new NotificationHub(URL, ["trips"]);
    await hub.start();
    const seen: Array<[string, unknown]> = [];
    sub(hub, "trips", (p) => void seen.push(["all", p]));
    sub(hub, "trips", (p) => void seen.push(["trip A", p]), [{ tripId: "trp_a" }]);
    sub(hub, "trips", (p) => void seen.push(["trip B", p]), [{ tripId: "trp_b" }]);
    send(hub, "trips", "{not json");
    expect(seen).toEqual([["all", null], ["trip A", null], ["trip B", null]]);
    seen.length = 0;
    send(hub, "trips", "null");
    expect(seen).toEqual([["all", null], ["trip A", null], ["trip B", null]]);
    await hub.stop();
  });

  it("a listener that an earlier listener of the same NOTIFY unsubscribed is not run", async () => {
    const hub = new NotificationHub(URL, ["trips"]);
    await hub.start();
    const seen: string[] = [];
    const offs: Array<() => void> = [];
    sub(hub, "trips", () => {
      seen.push("first");
      offs[0]!();
    }, [{ tripId: "trp_a" }]);
    offs.push(sub(hub, "trips", () => void seen.push("second"), [{ tripId: "trp_a" }]));
    send(hub, "trips", { tripId: "trp_a" });
    expect(seen).toEqual(["first"]);
    await hub.stop();
  });

  it("an unsubscribed listener is out of the index, and the index keeps nothing of it", async () => {
    const hub = new NotificationHub(URL, ["trips"]);
    await hub.start();
    let calls = 0;
    const offs: Array<() => void> = [];
    for (let i = 0; i < 100; i++) offs.push(sub(hub, "trips", () => void (calls += 1), [{ tripId: `trp_${i}` }, { reservations: true, riderId: "rdr_1" }]));
    expect(hub.subscriberCount()).toBe(100);
    for (const off of offs.slice(0, 99)) off();
    send(hub, "trips", { tripId: "trp_5", riderId: "rdr_1", reservations: true });
    expect(calls).toBe(1);
    offs[99]!();
    offs[99]!();
    send(hub, "trips", { tripId: "trp_99", riderId: "rdr_1", reservations: true });
    expect(calls).toBe(1);
    expect(hub.subscriberCount()).toBe(0);
    const index = (hub as unknown as { index: Map<string, Map<string, unknown>> }).index;
    expect([...index.values()].map((fieldSets) => fieldSets.size)).toEqual([0]);
    await hub.stop();
  });
});

describe("S7 0.15: the catch-up after a reconnect is unchanged (PM-1 / B1.16)", () => {
  it("every listener is told, matched or not: first the 'first' ones in subscribe order, then the 'spread' ones", async () => {
    vi.useFakeTimers();
    const hub = new NotificationHub(URL, ["trips", "config"], undefined, { catchUpBatch: 2, catchUpEveryMs: 100 });
    await hub.start();
    const seen: string[] = [];
    const on = (name: string) => (payload: unknown) => void seen.push(payload === null ? name : `${name}!`);
    sub(hub, "trips", on("trip A"), [{ tripId: "trp_a" }]);
    sub(hub, "trips", on("settings rider 1"), [{ riderId: "rdr_1" }], "spread");
    sub(hub, "trips", on("trip B"), [{ tripId: "trp_b" }]);
    sub(hub, "trips", on("settings zone 1"), [{ reservations: true, zoneId: "zon_1" }, { reservations: true, driverId: "drv_1" }], "spread");
    sub(hub, "trips", on("admin feed"));
    sub(hub, "config", on("settings doc"), [{ zoneId: "zon_1" }, { doc: "zones" }], "spread");
    sub(hub, "config", on("cache"));
    // The reconnect wait is 500–1000 ms at random; with 0 it is exactly 500 ms.
    vi.spyOn(Math, "random").mockReturnValue(0);
    current(hub).emit("error", new Error("simulated: connection lost"));
    await vi.advanceTimersByTimeAsync(500);
    expect(hub.healthSnapshot()).toMatchObject({ status: "ok", reconnects: 1 });
    // At once: every "first" listener; the first batch (2) of the "spread" ones.
    expect(seen).toEqual(["trip A", "trip B", "admin feed", "cache", "settings rider 1", "settings zone 1"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual(["trip A", "trip B", "admin feed", "cache", "settings rider 1", "settings zone 1", "settings doc"]);
    // And the new connection's NOTIFY goes through the index again.
    seen.length = 0;
    send(hub, "trips", { tripId: "trp_b" });
    expect(seen).toEqual(["trip B!", "admin feed!"]);
    await hub.stop();
  });
});
