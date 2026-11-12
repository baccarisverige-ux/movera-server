import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heardAgainAt } from "../../src/drivers/presence.js";
import { seedDriver } from "../../src/drivers/service.js";
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

  it("no fix from ANY driver for 6 minutes while the jobs keep running (network cut in front of the server): nobody set offline; the silent one goes noFixMinutes after fixes come back", async () => {
    const kept = { a: a.position, b: b.position };
    for (const d of [a, b, c]) d.position = null;
    await sim.advance(6 * 60);
    expect(await statuses()).toEqual(["online", "online", "online"]);
    // Fixes reach the server again from A and B; C stays silent.
    a.position = kept.a;
    b.position = kept.b;
    await sim.advance(4 * 60);
    expect(await statuses()).toEqual(["online", "online", "online"]);
    await sim.advance(90);
    expect(await statuses()).toEqual(["online", "online", "offline"]);
  });

  /* Supervisor NO-GO on d95724d (F1–F4): the grace must always end. */

  it("F1: a quiet night, all 3 phones die while the server runs: offline within deafSince + 10 min cap + noFixMinutes, not never", async () => {
    for (const d of [a, b, c]) d.position = null;
    await sim.advance(6 * 60);
    // A sudden stop of every phone counts as the server not hearing: no one set offline at the usual 5 min.
    expect(await statuses()).toEqual(["online", "online", "online"]);
    // The last fix came at the start; the silence is seen at about 1.5 min; cap 10 min; then 5 min: all gone by 17 min.
    await sim.advance(11 * 60);
    expect(await statuses()).toEqual(["offline", "offline", "offline"]);
    const row = await sim.db.selectFrom("timers").select("payload").where("kind", "=", "no_fix_offline").executeTakeFirstOrThrow();
    expect(row.payload).toMatchObject({ deafSince: expect.any(String) });
    // A fix again (a driver goes online with a position): the deafness is over.
    await a.goOnline(PLACES.nearSergels);
    await sim.advance(30);
    expect((await sim.db.selectFrom("timers").select("payload").where("kind", "=", "no_fix_offline").executeTakeFirstOrThrow()).payload).not.toHaveProperty("deafSince");
  }, 120_000);

  it("F2: a booked driver offline while every online phone is silent loses the ride by its search start (dispatchAt) at the latest", async () => {
    const heldByB = await bookAndHold(b, 70);
    await tapOffline(b);
    // A third online driver with a dead phone, so the silence counts (3 online).
    const extra = await sim.db.transaction().execute((trx) =>
      seedDriver(trx, { phone: "+46700009123", firstName: "Extra", make: "Volvo", model: "V60", year: 2021, color: "Black", plate: "OUT123", categoryIds: ["economy"], zoneIds: ["Z001"] }, sim.clock.now));
    await sim.db.updateTable("drivers").set({ online_status: "online", online_since: sim.clock.now }).where("driver_id", "=", extra.driverId).execute();
    const state = (await sim.db.selectFrom("trips").select("reservation").where("trip_id", "=", heldByB).executeTakeFirstOrThrow()).reservation as { dispatchAt: string };
    for (const d of [a, c]) d.position = null;
    await sim.advance((Date.parse(state.dispatchAt) - sim.clock.now.getTime()) / 1000 + 60);
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
});
