import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { TRIP_EVENTS_CHANNEL } from "../../src/db/tripLog.js";
import { GPS_LOCK_TIMEOUT_MS } from "../../src/drivers/service.js";
import { RIDE_CHECK_SCAN } from "../../src/safety/rideCheckServer.js";
import { rideCheckSettingsOf } from "../../src/trips/onTripSettings.js";
import { bookAndAccept, drive, Sim, type Driver, type Json, type Rider } from "./harness.js";

/**
 * S7 wave B2, owner Sitting W2 2026-11-15 (decisions/session-2026-11-06.md "Sitting W2"):
 *
 * Q113 (B3.2) "Yes, skip repeats": POST /driver/location writes no `location` trip event and no NOTIFY for a fix that is
 * not new (the same fix sent again, or an older batch). The send still counts (driver_locations.received_at), and the
 * long-stop ride-check scan is booked on EVERY send, also for an older batch (safety gap R18).
 *
 * Q112 (B3.1) "Yes, short limit": the GPS transaction never waits longer than GPS_LOCK_TIMEOUT_MS for a row lock; it then
 * answers 503 server_busy with Retry-After (the answer the driver app's sender already pauses on and sends again after),
 * stores nothing, and the same fix sent again is taken.
 */
let sim: Sim;
let rider: Rider;
let driver: Driver;
let listener: pg.Client;
/** Every movera_trip_events NOTIFY the database delivered, as its payload. */
const notices: Json[] = [];

// On the straight line Sergels torg → Medborgarplatsen (the route the off-route check uses without a road router).
const MOVING = { lat: 59.3285, lng: 18.0668 };
const STILL = { lat: 59.32345, lng: 18.0692 };

beforeAll(async () => {
  sim = await Sim.start();
  rider = await sim.rider(0);
  driver = await sim.driver(1);
  // Only the fixes each test sends, no periodic heartbeat fixes in between.
  sim.driverApps.delete(driver);
  listener = new pg.Client({ connectionString: sim.database.url });
  await listener.connect();
  listener.on("notification", (message) => notices.push(JSON.parse(message.payload ?? "{}") as Json));
  await listener.query(`LISTEN ${TRIP_EVENTS_CHANNEL}`);
});
afterAll(async () => {
  await listener?.end();
  await sim?.stop();
});

const fixAt = (at: { lat: number; lng: number }, measuredAt: Date) => ({ lat: at.lat, lng: at.lng, accuracy: 5, measuredAt: measuredAt.toISOString() });
const send = (fixes: Array<ReturnType<typeof fixAt>>) => driver.post("/driver/location", { fixes });
const pass = (seconds: number) => {
  sim.clock.now = new Date(sim.clock.now.getTime() + seconds * 1000);
};
/** NOTIFY is delivered at commit; the listener connection gets it a moment later. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));
const locationEvents = async (tripId: string) =>
  (await sql<{ measured: string }>`SELECT location->>'measuredAt' AS measured FROM trip_events WHERE trip_id = ${tripId} AND kind = 'location' ORDER BY sequence`.execute(sim.db)).rows.map((r) => r.measured);
const noticesOf = (tripId: string) => notices.filter((n) => n["tripId"] === tripId).length;
const scanTimer = (tripId: string) => sim.db.selectFrom("timers").select(["due_at"]).where("kind", "=", RIDE_CHECK_SCAN).where("ref_id", "=", tripId).executeTakeFirst();
const stored = () => sim.db.selectFrom("driver_locations").select(["measured_at", "received_at", "lat"]).where("driver_id", "=", driver.id).executeTakeFirstOrThrow();
const traceTimes = async (tripId: string) => (await sim.db.selectFrom("trip_locations").select("measured_at").where("trip_id", "=", tripId).orderBy("measured_at").execute()).map((r) => r.measured_at.toISOString());

/** A trip with the rider on board (in_trip), the car under way at MOVING. */
async function onTrip(): Promise<string> {
  pass(3600);
  await driver.moveTo({ lat: 59.3335, lng: 18.0655 });
  const { tripId } = await bookAndAccept(sim, rider, driver);
  await drive(driver, tripId, "in_trip");
  pass(10);
  await driver.moveTo(MOVING);
  await settle();
  return tripId;
}
// Each test has its own trip; whatever it left open is closed here (also when the test failed half-way).
afterEach(async () => {
  const open = await sim.db.selectFrom("trips").select("trip_id").where("driver_id", "=", driver.id).where("status", "not in", ["completed", "cancelled_by_admin", "cancelled_by_rider", "cancelled_by_driver", "no_show", "expired"]).execute();
  for (const { trip_id } of open) {
    await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", trip_id).execute();
    await sim.db.deleteFrom("timers").where("ref_id", "=", trip_id).execute();
  }
  await sim.db.updateTable("drivers").set({ online_status: "online" }).where("driver_id", "=", driver.id).execute();
});

describe("Q113 (B3.2): no trip event or NOTIFY for a fix that is not new", () => {
  it("the same fix sent again: counted (received_at), scan booked, but no location event and no NOTIFY", async () => {
    const tripId = await onTrip();
    pass(10);
    const fix = fixAt(STILL, sim.clock.now);
    expect((await send([fix])).status).toBe(200);
    await settle();
    const events = await locationEvents(tripId);
    const told = noticesOf(tripId);
    expect(events.at(-1)).toBe(fix.measuredAt);
    const first = await stored();

    // A phone standing still sends its last OS fix again, with the OS's own time, on every tick (10 s).
    await sim.db.deleteFrom("timers").where("kind", "=", RIDE_CHECK_SCAN).where("ref_id", "=", tripId).execute();
    for (let i = 0; i < 3; i++) {
      pass(10);
      const again = await send([fix]);
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body["accepted"]).toBe(1);
    }
    await settle();
    expect(await locationEvents(tripId)).toEqual(events);
    expect(noticesOf(tripId)).toBe(told);
    // Kept (G5): the send still counts, so the driver is neither stale nor set offline, and the position is unchanged.
    const now = await stored();
    expect(now.measured_at.toISOString()).toBe(fix.measuredAt);
    expect(now.received_at.getTime()).toBe(first.received_at.getTime() + 30_000);
    // Safety (R18): the long-stop scan is booked on every send.
    expect(await scanTimer(tripId)).toBeDefined();
    expect(sim.timerErrors).toEqual([]);
  });

  it("a new fix still writes one location event and one NOTIFY (also the same place with a newer time: the web's re-stamped fix)", async () => {
    const tripId = await onTrip();
    pass(10);
    const fix = fixAt(STILL, sim.clock.now);
    expect((await send([fix])).status).toBe(200);
    await settle();
    const events = await locationEvents(tripId);
    const told = noticesOf(tripId);

    pass(10);
    const restamped = fixAt(STILL, sim.clock.now);
    expect((await send([restamped])).status).toBe(200);
    pass(10);
    const moved = fixAt({ lat: STILL.lat - 0.001, lng: STILL.lng }, sim.clock.now);
    expect((await send([moved])).status).toBe(200);
    await settle();
    expect(await locationEvents(tripId)).toEqual([...events, restamped.measuredAt, moved.measuredAt]);
    expect(noticesOf(tripId)).toBe(told + 2);
    expect((await stored()).lat).toBeCloseTo(moved.lat, 6);
  });

  it("R18: an older batch writes no event or NOTIFY, fills the trace, and still books the long-stop scan", async () => {
    const tripId = await onTrip();
    pass(60);
    const newest = fixAt(STILL, sim.clock.now);
    expect((await send([newest])).status).toBe(200);
    await settle();
    const events = await locationEvents(tripId);
    const told = noticesOf(tripId);
    await sim.db.deleteFrom("timers").where("kind", "=", RIDE_CHECK_SCAN).where("ref_id", "=", tripId).execute();

    // Out of order on a bad connection: the fixes measured before the stored one arrive after it.
    const older = [40, 20].map((ago) => fixAt(STILL, new Date(Date.parse(newest.measuredAt) - ago * 1000)));
    pass(5);
    const res = await send(older);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body["accepted"]).toBe(2);
    await settle();
    expect(await locationEvents(tripId)).toEqual(events);
    expect(noticesOf(tripId)).toBe(told);
    expect((await stored()).measured_at.toISOString()).toBe(newest.measuredAt);
    expect(await traceTimes(tripId)).toEqual(expect.arrayContaining(older.map((f) => f.measuredAt)));
    expect(await scanTimer(tripId)).toBeDefined();
  });

  it("R18: the car stands still, the newest fix arrives first and the standing fixes after it → long_stop is still asked", async () => {
    const stopMinutes = rideCheckSettingsOf(undefined).stopMinutes;
    expect(stopMinutes).toBeLessThanOrEqual(8); // the held-back fixes must still be younger than the 10 min the server takes
    const tripId = await onTrip();
    const stoppedAt = sim.clock.now.getTime() + 30_000;
    // The car stops at STILL 30 s later and stands there; the phone has no connection for stopMinutes + 1 min.
    pass(30 + (stopMinutes + 1) * 60);
    const newest = fixAt(STILL, sim.clock.now);
    expect((await send([newest])).status).toBe(200);
    await sim.tick();
    // That scan saw only the fix under way and the newest one: not a long stop yet.
    expect((await rider.trip(tripId))["rideCheck"]).toBeUndefined();
    expect(await scanTimer(tripId)).toBeUndefined();

    // Now the fixes the phone kept while it stood there arrive: all older than the stored one.
    const held: Array<ReturnType<typeof fixAt>> = [];
    for (let t = stoppedAt; t < Date.parse(newest.measuredAt); t += 30_000) held.push(fixAt(STILL, new Date(t)));
    pass(2);
    const res = await send(held);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body["accepted"]).toBe(held.length);
    // The scan is booked (at the next allowed scan time) and finds the long stop from the fix times.
    expect(await scanTimer(tripId)).toBeDefined();
    pass(35);
    await sim.tick();
    expect((await rider.trip(tripId))["rideCheck"]).toMatchObject({ trigger: "long_stop" });
    expect(sim.timerErrors).toEqual([]);
  });
});

describe("Q112 (B3.1): the GPS write waits at most GPS_LOCK_TIMEOUT_MS for a row lock, then answers 'try again'", () => {
  it("a held trip-row lock: 503 server_busy with Retry-After within the limit, nothing stored; the same fix sent again is taken", async () => {
    const tripId = await onTrip();
    pass(10);
    const before = await stored();
    const events = await locationEvents(tripId);
    const told = noticesOf(tripId);
    const keys = Number((await sim.db.selectFrom("idempotency_keys").select(sql<string>`count(*)`.as("n")).where("subject_id", "=", driver.id).executeTakeFirstOrThrow()).n);

    // A trip command that is stuck holds the trip row (the lock every command takes: db/tripLog.ts lockTrip).
    const holder = new pg.Client({ connectionString: sim.database.url });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT trip_id FROM trips WHERE trip_id = $1 FOR NO KEY UPDATE", [tripId]);

    const fix = fixAt(STILL, sim.clock.now);
    const started = Date.now();
    const posting = send([fix]);
    try {
      const limit = GPS_LOCK_TIMEOUT_MS + 3000;
      const answer = await Promise.race([posting, new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), limit))]);
      const waited = Date.now() - started;
      expect(answer, `POST /driver/location still waits for the trip row after ${limit} ms`).not.toBe("waiting");
      const refused = answer as Awaited<typeof posting>;
      // The retryable answer the driver app's sender handles (live_driver_services.dart sendNow: 429/503 + Retry-After).
      expect(refused.status, JSON.stringify(refused.body)).toBe(503);
      expect(refused.body).toMatchObject({ code: "unavailable", reason: "server_busy", retryable: true });
      expect(refused.headers.get("retry-after")).toBe("2");
      expect(waited).toBeGreaterThanOrEqual(GPS_LOCK_TIMEOUT_MS - 100);

      // Nothing of the refused send was kept: the phone still has the fix and sends it again.
      expect((await stored()).measured_at.getTime()).toBe(before.measured_at.getTime());
      expect(await traceTimes(tripId)).not.toContain(fix.measuredAt);
      expect(await locationEvents(tripId)).toEqual(events);
      expect(Number((await sim.db.selectFrom("idempotency_keys").select(sql<string>`count(*)`.as("n")).where("subject_id", "=", driver.id).executeTakeFirstOrThrow()).n)).toBe(keys);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
      await posting.catch(() => undefined);
    }

    // The driver app's resend: after Retry-After (2 s) the next tick sends the fix it still holds, with a new key.
    pass(10);
    const again = await send([fix]);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body["accepted"]).toBe(1);
    await settle();
    expect((await stored()).measured_at.toISOString()).toBe(fix.measuredAt);
    expect(await traceTimes(tripId)).toContain(fix.measuredAt);
    expect(await locationEvents(tripId)).toEqual([...events, fix.measuredAt]);
    expect(noticesOf(tripId)).toBe(told + 1);

    // And one more tick with the same fix (a phone standing still): no second event (Q113).
    pass(10);
    expect((await send([fix])).status).toBe(200);
    await settle();
    expect(await locationEvents(tripId)).toEqual([...events, fix.measuredAt]);
    expect(noticesOf(tripId)).toBe(told + 1);
    expect(sim.timerErrors).toEqual([]);
  }, 30_000);
});
