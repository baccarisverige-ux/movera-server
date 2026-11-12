import { sql } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heardAgainAt } from "../../src/drivers/presence.js";
import { ensureMaintenanceTimers, maintenanceHandlers } from "../../src/jobs/maintenance.js";
import { TimerWorker } from "../../src/jobs/timers.js";
import { dispatchHandlers } from "../../src/dispatch/runtime.js";
import { rideHandlers } from "../../src/trips/ride.js";
import { pricingHandlers } from "../../src/pricing/surge.js";
import { fakeOsrm, PLACES, Sim, type Driver, type Json, type Rider } from "./harness.js";

/**
 * S4 B1.23 (GLOBAL-SAFE-PLAN V27.1, Q83, gate event "6 min server outage"): after an outage longer than noFixMinutes
 * (5 min) the first no-position run set EVERY online driver offline (their last fix is old only because the server
 * could not hear them), and a booked ride whose offline check fell in the outage was released at once. Now the server
 * gives everyone noFixMinutes from the moment it can hear again; a driver who is really silent still goes offline then.
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;
let c: Driver;

beforeEach(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-05T05:00:00Z") });
  // The real server runs the maintenance jobs too (the no-position job among them); the harness worker does not.
  sim.worker = new TimerWorker(sim.db, {
    handlers: { ...dispatchHandlers, ...rideHandlers, ...pricingHandlers, ...maintenanceHandlers },
    logger: { warn: () => undefined, error: (data, message) => sim.timerErrors.push({ data, message }) },
    clock: () => sim.clock.now,
  });
  await ensureMaintenanceTimers(sim.db, sim.clock.now);
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, PLACES.odenplan);
  c = await sim.driver(0, PLACES.nearSergels);
});
afterEach(async () => {
  await sim.stop();
  await osrm.close();
});

const status = async (d: Driver) => (await sim.db.selectFrom("drivers").select("online_status").where("driver_id", "=", d.id).executeTakeFirstOrThrow()).online_status;
const statuses = async () => [await status(a), await status(b), await status(c)];
const minutes = (m: number) => new Date(sim.clock.now.getTime() + m * 60_000).toISOString();
const reasons = async (d: Driver) => (await sim.db.selectFrom("notifications").select("kind").where("subject_id", "=", d.id).execute()).map((n) => n.kind);

async function bookAndHold(d: Driver, inMinutes: number): Promise<string> {
  const at = minutes(inMinutes);
  const quote = (await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at })).body["quotes"][0];
  const res = await rider.post("/trips", { quoteId: quote.quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const tripId = res.body["tripId"] as string;
  const accepted = await d.post(`/driver/reservations/${tripId}/accept`, { expectedVersion: (await rider.trip(tripId)).version });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  return tripId;
}
const holder = async (tripId: string) => (await sim.db.selectFrom("trips").select(["status", "driver_id"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow()) as Json;
const offlineCheckAt = async (tripId: string) =>
  (await sim.db.selectFrom("timers").select("due_at").where("kind", "=", "resv_offline_check").where("ref_id", "=", tripId).executeTakeFirstOrThrow()).due_at;
async function tapOffline(d: Driver) {
  const p = (await d.get("/driver/profile")).body;
  expect((await d.post("/driver/availability", { expectedVersion: p["version"], onlineStatus: "offline" })).status).toBe(200);
}
/** The server is down: no fix reaches it and no job runs, then it starts again and its worker runs what came due. */
async function outage(seconds: number) {
  sim.clock.now = new Date(sim.clock.now.getTime() + seconds * 1000);
  await ensureMaintenanceTimers(sim.db, sim.clock.now);
  await sim.tick();
}

describe("B1.23: no mass offline after an outage", () => {
  it("a 6-minute outage, restart: the first run sets 0 drivers offline and releases no booked ride; a silent driver goes after the grace", async () => {
    // A holds a booked ride and stays online; B holds one and is offline until his go-online time (as the app asks).
    const heldByA = await bookAndHold(a, 70);
    const heldByB = await bookAndHold(b, 70);
    await tapOffline(b);
    expect(await statuses()).toEqual(["online", "offline", "online"]);
    // Normal running up to 5 minutes before B's offline check, the apps sending a fix every 30 s.
    const check = await offlineCheckAt(heldByB);
    await sim.advance((check.getTime() - 5 * 60_000 - sim.clock.now.getTime()) / 1000);
    expect(await statuses()).toEqual(["online", "offline", "online"]);

    await outage(6 * 60);
    // The first run after the restart: nobody set offline, no booked ride released.
    expect(await statuses()).toEqual(["online", "offline", "online"]);
    expect(await holder(heldByA)).toMatchObject({ status: "accepted", driver_id: a.id });
    expect(await holder(heldByB)).toMatchObject({ status: "accepted", driver_id: b.id });

    // The apps reach the server again; C's phone stays silent. B can go online now (he could not during the outage).
    c.position = null;
    await sim.advance(30);
    await b.goOnline(PLACES.odenplan);
    await sim.advance(4 * 60);
    expect(await statuses()).toEqual(["online", "online", "online"]);
    // noFixMinutes (5) after the restart C has still sent nothing: offline, with the no_position reason.
    await sim.advance(90);
    expect(await statuses()).toEqual(["online", "online", "offline"]);
    expect(await reasons(c)).toContain("set_offline");
    expect(await holder(heldByA)).toMatchObject({ status: "accepted", driver_id: a.id });
    expect(await holder(heldByB)).toMatchObject({ status: "accepted", driver_id: b.id });
    expect(await reasons(b)).not.toContain("reservation_lost");
    expect(sim.timerErrors).toEqual([]);
  });

  it("no regression: a booked driver still offline when the grace ends loses the ride then, not at the restart", async () => {
    const heldByB = await bookAndHold(b, 70);
    await tapOffline(b);
    const check = await offlineCheckAt(heldByB);
    await sim.advance((check.getTime() - 5 * 60_000 - sim.clock.now.getTime()) / 1000);
    await outage(6 * 60);
    expect(await holder(heldByB)).toMatchObject({ status: "accepted", driver_id: b.id });
    await sim.advance(4 * 60);
    expect(await holder(heldByB)).toMatchObject({ status: "accepted", driver_id: b.id });
    await sim.advance(90);
    expect((await holder(heldByB))["status"]).toBe("requested");
    expect(await reasons(b)).toContain("reservation_lost");
  });

  it("no regression: without an outage, one driver sending fixes while another sends none still sets the silent one offline at 5 min", async () => {
    c.position = null;
    await sim.advance(4 * 60 + 30);
    expect(await statuses()).toEqual(["online", "online", "online"]);
    await sim.advance(60);
    expect(await statuses()).toEqual(["online", "online", "offline"]);
    expect(await reasons(c)).toContain("set_offline");
  });

  it("a network cut in front of the server (jobs keep running, no fix from ANY driver) is NOT an outage: silent drivers go at noFixMinutes as before", async () => {
    for (const d of [a, b, c]) d.position = null;
    await sim.advance(4 * 60 + 30);
    expect(await statuses()).toEqual(["online", "online", "online"]);
    await sim.advance(60);
    expect(await statuses()).toEqual(["offline", "offline", "offline"]);
  });

  /* Supervisor NO-GO #1 and #2 on d95724d / 54fc842: one signal only (a run > 60 s late with no fix stored since its due time). */

  for (const every of [120, 540]) {
    it(`P7 flapping: A sends one fix every ${every} s, B and C send none, server up: B and C offline at 5 min; A as on main`, async () => {
      const at = PLACES.nearSergels;
      for (const d of [a, b, c]) d.position = null;
      for (let s = 5; s <= 60 * 60; s += 5) {
        sim.clock.now = new Date(sim.clock.now.getTime() + 5000);
        if (s % every === 0) await a.post("/driver/location", { fixes: [a.fix(at)] });
        a.position = null;
        await sim.tick();
        if (s === 6 * 60) expect([await status(b), await status(c)]).toEqual(["offline", "offline"]);
      }
      // A's longest gap: under noFixMinutes (120 s) keeps him online; over it (540 s) he went at 5 min, as on main.
      expect(await status(a)).toBe(every * 1000 < 5 * 60_000 ? "online" : "offline");
      expect([await status(b), await status(c)]).toEqual(["offline", "offline"]);
    }, 300_000);
  }

  it("P9: a 40-minute outage, restart: nobody set offline at the first run; the silent ones go noFixMinutes after the restart", async () => {
    await outage(40 * 60);
    expect(await statuses()).toEqual(["online", "online", "online"]);
    b.position = null;
    await sim.advance(4 * 60 + 30);
    expect(await statuses()).toEqual(["online", "online", "online"]);
    await sim.advance(60);
    expect(await statuses()).toEqual(["online", "offline", "online"]);
  }, 120_000);

  it("P10: a network cut (server up, every phone silent 4 min), then a 6-minute outage: no mass offline at the restart", async () => {
    const kept = [a.position, b.position, c.position] as const;
    for (const d of [a, b, c]) d.position = null;
    await sim.advance(4 * 60);
    expect(await statuses()).toEqual(["online", "online", "online"]);
    await outage(6 * 60);
    expect(await statuses()).toEqual(["online", "online", "online"]);
    [a.position, b.position, c.position] = kept;
    await sim.advance(6 * 60);
    expect(await statuses()).toEqual(["online", "online", "online"]);
  }, 120_000);

  it("F2: the booked grace never runs past the ride's dispatchAt: an outage ending 2 min before it releases the ride by then", async () => {
    const heldByB = await bookAndHold(b, 70);
    await tapOffline(b);
    const state = (await sim.db.selectFrom("trips").select("reservation").where("trip_id", "=", heldByB).executeTakeFirstOrThrow()).reservation as { dispatchAt: string };
    const check = await offlineCheckAt(heldByB);
    await sim.advance((check.getTime() - 60_000 - sim.clock.now.getTime()) / 1000);
    // Down from 1 min before the check to 2 min before dispatchAt: the 5-min grace would end 3 min after dispatchAt.
    await outage((Date.parse(state.dispatchAt) - 2 * 60_000 - sim.clock.now.getTime()) / 1000);
    expect((await holder(heldByB))["driver_id"]).toBe(b.id);
    await sim.advance(2 * 60 + 10);
    expect((await holder(heldByB))["driver_id"]).toBeNull();
    expect(await reasons(b)).toContain("reservation_lost");
  }, 180_000);

  it("F4: a lagging worker (each run 61+ s late) while fixes ARE stored is no outage: a silent driver among senders goes offline", async () => {
    c.position = null;
    for (let i = 0; i < 8; i += 1) {
      for (let s = 0; s < 3; s += 1) {
        sim.clock.now = new Date(sim.clock.now.getTime() + 30_500);
        await a.heartbeat();
        await b.heartbeat();
      }
      await sim.tick();
    }
    // 12 minutes on: C has sent nothing for far more than 5 minutes.
    expect(await statuses()).toEqual(["online", "online", "offline"]);
  }, 120_000);

  it("F3: a parked no-position timer (due 'infinity') is no outage signal and never breaks the booked offline check", async () => {
    const heldByB = await bookAndHold(b, 70);
    await tapOffline(b);
    await sim.db.updateTable("timers").set({ due_at: sql`'infinity'::timestamptz`, attempts: 8 }).where("kind", "=", "no_fix_offline").execute();
    expect(await heardAgainAt(sim.db, sim.clock.now)).toBeNull();
    const check = await offlineCheckAt(heldByB);
    await sim.advance((check.getTime() - sim.clock.now.getTime()) / 1000 + 10);
    expect((await holder(heldByB))["driver_id"]).toBeNull();
    expect(sim.timerErrors).toEqual([]);
  }, 180_000);

  /* Supervisor NO-GO #3 on 2f7324b: a fix stored before the worker's first run after an outage. */

  /** Down `seconds`; on return A's fix is stored `fixFirstMs` before the worker's first no-position run. */
  async function outageThenFix(seconds: number, fixFirstMs: number) {
    sim.clock.now = new Date(sim.clock.now.getTime() + seconds * 1000);
    await ensureMaintenanceTimers(sim.db, sim.clock.now);
    sim.clock.now = new Date(sim.clock.now.getTime() + fixFirstMs);
    await a.heartbeat();
    sim.clock.now = new Date(sim.clock.now.getTime() + 1000);
    await sim.tick();
  }
  const heardAgainStored = async () => ((await sim.db.selectFrom("timers").select("payload").where("kind", "=", "no_fix_offline").executeTakeFirstOrThrow()).payload as { heardAgainAt?: string }).heardAgainAt;

  it("R1: a 6-minute outage; A's phone posts a fix 2 s before the worker's first no-position run: still nobody set offline", async () => {
    await sim.advance(60);
    await outageThenFix(6 * 60, 2000);
    expect(await statuses()).toEqual(["online", "online", "online"]);
  }, 120_000);

  it("R2: the same order with booked driver B offline whose check fell in the outage: the ride is not released at the restart", async () => {
    const heldByB = await bookAndHold(b, 70);
    await tapOffline(b);
    const check = await offlineCheckAt(heldByB);
    await sim.advance((check.getTime() - 5 * 60_000 - sim.clock.now.getTime()) / 1000);
    await outageThenFix(6 * 60, 2000);
    expect(await holder(heldByB)).toMatchObject({ status: "accepted", driver_id: b.id });
    expect([await status(a), await status(c)]).toEqual(["online", "online"]);
  }, 120_000);

  it("throttle: a fix sent just before an outage does not hide the first fix after it (the outage is marked by that fix)", async () => {
    await sim.advance(60);
    await a.heartbeat();
    sim.clock.now = new Date(sim.clock.now.getTime() + 100_000);
    const back = sim.clock.now.toISOString();
    await a.heartbeat();
    expect(await heardAgainStored()).toBe(back);
  }, 120_000);

  it("throttle: two fixes inside 10 s run the outage check once (one statement on the timers row per copy per 10 s)", async () => {
    await sim.advance(60);
    sim.clock.now = new Date(sim.clock.now.getTime() + 11_000);
    const original = pg.Client.prototype.query;
    const texts: string[] = [];
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
      const first = args[0];
      texts.push(typeof first === "string" ? first : String((first as { text?: string })?.text ?? ""));
      return (original as (...x: unknown[]) => unknown).apply(this, args);
    } as typeof original;
    try {
      await a.heartbeat();
      sim.clock.now = new Date(sim.clock.now.getTime() + 5000);
      await b.heartbeat();
    } finally {
      pg.Client.prototype.query = original;
    }
    expect(texts.filter((t) => t.includes("no_fix_offline") || /update "?timers"?/i.test(t)).length).toBe(1);
  }, 120_000);
});
