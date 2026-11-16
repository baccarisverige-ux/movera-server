import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RIDE_CHECK_SCAN, SAME_FIX_KEY, SAME_FIX_SINCE_KEY } from "../../src/safety/rideCheckServer.js";
import { rideCheckSettingsOf } from "../../src/trips/onTripSettings.js";
import { bookAndAccept, drive, Sim, type Driver, type Rider } from "../e2e/harness.js";

/**
 * Owner 2026-11-15 "Yes, detect it (Rec.)" (decisions/session-2026-11-06.md "Owner button answers before sleep"; GPS
 * supervisor SF-2): a phone that keeps sending exactly the SAME fix during a trip (a frozen GPS, or a native phone
 * standing still that re-sends the same OS fix) adds no trace row, so the long-stop check never saw the stop. The time the
 * phone keeps sending that one fix now counts as standing time, measured on the server's clock between the sends.
 * A phone that stopped sending is NOT a long stop (that is the silence check).
 */
let sim: Sim;
let rider: Rider;
let driver: Driver;

// On the straight line Sergels torg → Medborgarplatsen (the route the off-route check uses without a road router).
const MOVING = { lat: 59.3285, lng: 18.0668 };
const STILL = { lat: 59.32345, lng: 18.0692 };
const STOP_SECONDS = rideCheckSettingsOf(undefined).stopMinutes * 60;
const SCAN_SECONDS = rideCheckSettingsOf(undefined).scanEverySeconds;

beforeAll(async () => {
  sim = await Sim.start();
  rider = await sim.rider(0);
  driver = await sim.driver(1);
  // Only the fixes each test sends, no periodic heartbeat fixes in between.
  sim.driverApps.delete(driver);
});
afterAll(async () => {
  await sim?.stop();
});

type SentFix = { lat: number; lng: number; accuracy: number; measuredAt: string; moving?: boolean; speedMps?: number };
const fixAt = (at: { lat: number; lng: number }, measuredAt: Date, accuracy = 5): SentFix => ({ lat: at.lat, lng: at.lng, accuracy, measuredAt: measuredAt.toISOString() });
const pass = (seconds: number) => {
  sim.clock.now = new Date(sim.clock.now.getTime() + seconds * 1000);
};
/** One send of the app (every 10 s), then the jobs that came due. */
async function send(fix: SentFix): Promise<void> {
  const res = await driver.post("/driver/location", { fixes: [fix] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await sim.tick();
}
/** The phone sends this one fix again every 10 s for `seconds` (the first send is now). */
async function repeat(fix: SentFix, seconds: number): Promise<void> {
  await send(fix);
  for (let t = 10; t <= seconds; t += 10) {
    pass(10);
    await send(fix);
  }
}
const rideCheck = async (tripId: string) => (await rider.trip(tripId))["rideCheck"] as { checkId: string; trigger: string } | undefined;
const asked = (tripId: string) => sim.db.selectFrom("ride_checks").select(["side", "trigger", "position"]).where("trip_id", "=", tripId).orderBy("side").execute();
const traceRows = async (tripId: string, fix: SentFix) => (await sim.db.selectFrom("trip_locations").select("measured_at").where("trip_id", "=", tripId).where("measured_at", "=", new Date(fix.measuredAt)).execute()).length;
/** A ride-check scan booked by hand for now (as if a job asked for one although no fix came). */
async function scanNow(tripId: string): Promise<void> {
  await sim.db.deleteFrom("timers").where("kind", "=", RIDE_CHECK_SCAN).where("ref_id", "=", tripId).execute();
  await sim.db.updateTable("trips").set({ ride_check_log: JSON.stringify({ ...((await sim.db.selectFrom("trips").select("ride_check_log").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).ride_check_log as object), nextScanAt: undefined }) }).where("trip_id", "=", tripId).execute();
  await sim.db.insertInto("timers").values({ kind: RIDE_CHECK_SCAN, ref_id: tripId, due_at: sim.clock.now, payload: JSON.stringify({}) }).execute();
  await sim.tick();
}

/** A trip with the rider on board (in_trip), boarded long ago enough, the car under way at MOVING. */
async function onTrip(): Promise<string> {
  pass(3600);
  await driver.moveTo({ lat: 59.3335, lng: 18.0655 });
  const { tripId } = await bookAndAccept(sim, rider, driver);
  await drive(driver, tripId, "in_trip");
  pass(STOP_SECONDS + 10);
  await driver.moveTo(MOVING);
  await sim.tick();
  pass(SCAN_SECONDS + 5);
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
  expect(sim.timerErrors).toEqual([]);
});

describe("long stop on the same fix sent again and again (owner 2026-11-15 'Yes, detect it')", () => {
  it("the same fix repeated for longer than the long-stop time on a trip → long_stop is asked, once", async () => {
    const tripId = await onTrip();
    const frozen = fixAt(STILL, sim.clock.now);
    // One scan interval of slack: the standing time counts from the first scan that saw the fix.
    await repeat(frozen, STOP_SECONDS + SCAN_SECONDS + 10);
    const check = await rideCheck(tripId);
    expect(check).toMatchObject({ trigger: "long_stop" });
    // Still ONE trace row for the fix (no duplicate rows: the trace feeds the paid distance).
    expect(await traceRows(tripId, frozen)).toBe(1);
    const rows = await asked(tripId);
    expect(rows.map((r) => [r.side, r.trigger])).toEqual([["driver", "long_stop"], ["rider", "long_stop"]]);
    const position = (typeof rows[0]!.position === "string" ? JSON.parse(rows[0]!.position) : rows[0]!.position) as { lat: number; measured: { value: number; unit: string } };
    expect(position.lat).toBeCloseTo(STILL.lat, 5);
    expect(position.measured).toEqual({ value: STOP_SECONDS / 60, unit: "min" });

    // No double fire: the phone keeps sending the same fix; the same check stays, no second pair of rows.
    await repeat(frozen, 60);
    expect((await rideCheck(tripId))?.checkId).toBe(check!.checkId);
    expect(await asked(tripId)).toHaveLength(2);
  });

  it("the same fix repeated for shorter than the long-stop time → not asked; the car moves on → the count starts again", async () => {
    const tripId = await onTrip();
    const first = fixAt(STILL, sim.clock.now);
    await repeat(first, STOP_SECONDS - 30);
    expect(await rideCheck(tripId)).toBeUndefined();
    // The car moves on (a new fix, 150 m away), then the phone repeats that one for less than the long-stop time.
    // Together the two runs are longer than the long-stop time, but neither stop is.
    pass(10);
    const second = fixAt({ lat: 59.32211, lng: 18.06983 }, sim.clock.now);
    await repeat(second, STOP_SECONDS - 30);
    expect(await rideCheck(tripId)).toBeUndefined();
    expect(await asked(tripId)).toHaveLength(0);
  });

  it("the phone stops sending → no long_stop, however long it is silent (the silence check is the one for that)", async () => {
    const tripId = await onTrip();
    const last = fixAt(STILL, sim.clock.now);
    // It repeats the fix for a while (shorter than the long-stop time), then nothing comes any more.
    await repeat(last, STOP_SECONDS - 30);
    const before = await sim.db.selectFrom("driver_locations").select("received_at").where("driver_id", "=", driver.id).executeTakeFirstOrThrow();
    pass(STOP_SECONDS * 3);
    // No send books a scan; also a scan run by hand finds no long stop (the silent time is not standing time).
    expect(await sim.db.selectFrom("timers").select("due_at").where("kind", "=", RIDE_CHECK_SCAN).where("ref_id", "=", tripId).executeTakeFirst()).toBeUndefined();
    await scanNow(tripId);
    expect(await rideCheck(tripId)).toBeUndefined();
    expect(await asked(tripId)).toHaveLength(0);
    const after = await sim.db.selectFrom("driver_locations").select("received_at").where("driver_id", "=", driver.id).executeTakeFirstOrThrow();
    expect(after.received_at.getTime()).toBe(before.received_at.getTime());
  });

  it("a fix sent ONCE and then silence → no long_stop", async () => {
    const tripId = await onTrip();
    await send(fixAt(STILL, sim.clock.now));
    pass(STOP_SECONDS * 3);
    await scanNow(tripId);
    expect(await rideCheck(tripId)).toBeUndefined();
  });

  it("a normal moving trip (a new fix each send) → unchanged: nothing asked, and no standing time is kept", async () => {
    const tripId = await onTrip();
    // 30 m further each 10 s along the route, for longer than the long-stop time.
    const steps = Math.ceil((STOP_SECONDS + SCAN_SECONDS + 10) / 10);
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      await send(fixAt({ lat: MOVING.lat + (STILL.lat - MOVING.lat) * k, lng: MOVING.lng + (STILL.lng - MOVING.lng) * k }, sim.clock.now));
      pass(10);
    }
    expect(await rideCheck(tripId)).toBeUndefined();
    expect(await asked(tripId)).toHaveLength(0);
    const log = (await sim.db.selectFrom("trips").select("ride_check_log").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).ride_check_log as Record<string, string>;
    // The kept "same fix since" is never older than one scan interval while the car moves.
    expect(sim.clock.now.getTime() - Date.parse(log[SAME_FIX_SINCE_KEY]!)).toBeLessThanOrEqual((SCAN_SECONDS + 20) * 1000);
    expect(log[SAME_FIX_KEY]).toBeDefined();
  });

  it("a standing phone that re-stamps its fix (web: same place, new time each send) → long_stop as before", async () => {
    const tripId = await onTrip();
    for (let t = 0; t <= STOP_SECONDS + SCAN_SECONDS + 10; t += 10) {
      await send(fixAt(STILL, sim.clock.now));
      pass(10);
    }
    expect(await rideCheck(tripId)).toMatchObject({ trigger: "long_stop" });
    expect(await asked(tripId)).toHaveLength(2);
  });

  it("the car stood (new fixes), then the GPS froze: both parts together make the long stop", async () => {
    const tripId = await onTrip();
    const half = Math.ceil(STOP_SECONDS / 2 / 10) * 10;
    for (let t = 0; t < half; t += 10) {
      await send(fixAt(STILL, sim.clock.now));
      pass(10);
    }
    expect(await rideCheck(tripId)).toBeUndefined();
    await repeat(fixAt(STILL, sim.clock.now), half + SCAN_SECONDS + 10);
    expect(await rideCheck(tripId)).toMatchObject({ trigger: "long_stop" });
  });

  it("a repeated fix worse than 50 m accuracy does not count (as for every long-stop fix)", async () => {
    const tripId = await onTrip();
    await repeat(fixAt(STILL, sim.clock.now, 80), STOP_SECONDS + SCAN_SECONDS + 10);
    expect(await rideCheck(tripId)).toBeUndefined();
  });

  it("a phone whose clock is minutes behind and that MOVES is not a long stop (standing time is the server's clock only)", async () => {
    const tripId = await onTrip();
    const behind = (STOP_SECONDS + 60) * 1000;
    const steps = Math.ceil((STOP_SECONDS + SCAN_SECONDS + 10) / 10);
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      await send(fixAt({ lat: MOVING.lat + (STILL.lat - MOVING.lat) * k, lng: MOVING.lng + (STILL.lng - MOVING.lng) * k }, new Date(sim.clock.now.getTime() - behind)));
      pass(10);
    }
    expect(await rideCheck(tripId)).toBeUndefined();
  });

  it("MF-1: a fix, then silence, then the same fix ONCE more → no long_stop (silent time is not standing time); it goes on repeating → long_stop from the second send", async () => {
    const tripId = await onTrip();
    const frozen = fixAt(STILL, sim.clock.now);
    await send(frozen);
    pass(180);
    expect(180).toBeGreaterThan(STOP_SECONDS);
    await send(frozen);
    expect(await rideCheck(tripId)).toBeUndefined();
    expect(await asked(tripId)).toHaveLength(0);
    // Also after one more scan interval of repeats (far less than the long-stop time since the second send).
    await repeat(frozen, SCAN_SECONDS + 10);
    expect(await rideCheck(tripId)).toBeUndefined();
    // The phone keeps repeating: the count started again at the second send.
    pass(10);
    await repeat(frozen, STOP_SECONDS);
    expect(await rideCheck(tripId)).toMatchObject({ trigger: "long_stop" });
    const rows = await asked(tripId);
    const position = (typeof rows[0]!.position === "string" ? JSON.parse(rows[0]!.position) : rows[0]!.position) as { measured: { value: number }; measured_at?: string };
    // Minutes since the second send, not the silent 3 minutes on top.
    expect(position.measured.value).toBeLessThanOrEqual(STOP_SECONDS / 60 + 1);
    // SF-5: the kept position carries the real time of the fix, not a made-up one.
    expect(position.measured_at).toBe(frozen.measuredAt);
  });

  it("MF-1: silence in the middle of a run of repeats starts the count again", async () => {
    const tripId = await onTrip();
    const frozen = fixAt(STILL, sim.clock.now);
    await repeat(frozen, STOP_SECONDS - 30);
    pass(180);
    await repeat(frozen, STOP_SECONDS - 30);
    expect(await rideCheck(tripId)).toBeUndefined();
  });

  it("SF-6: the same fix repeated at a middle stop the driver arrived at → not asked", async () => {
    const tripId = await onTrip();
    await sim.db.updateTable("trips").set({ stop_visits: JSON.stringify([{ index: 0, arrivedAt: sim.clock.now.toISOString() }]) }).where("trip_id", "=", tripId).execute();
    await repeat(fixAt(STILL, sim.clock.now), STOP_SECONDS + SCAN_SECONDS + 10);
    expect(await rideCheck(tripId)).toBeUndefined();
    expect(await asked(tripId)).toHaveLength(0);
  });

  it("SF-6: the same fix repeated within 300 m of the drop-off → not asked", async () => {
    const tripId = await onTrip();
    const dropoff = (await sim.db.selectFrom("trips").select("dropoff").where("trip_id", "=", tripId).executeTakeFirstOrThrow()).dropoff as { lat: number; lng: number };
    // About 110 m north of the drop-off.
    await repeat(fixAt({ lat: Number(dropoff.lat) + 0.001, lng: Number(dropoff.lng) }, sim.clock.now), STOP_SECONDS + SCAN_SECONDS + 10);
    expect((await rideCheck(tripId))?.trigger).not.toBe("long_stop");
    expect((await asked(tripId)).filter((r) => r.trigger === "long_stop")).toHaveLength(0);
  });

  it("SF-6: the trip ended while the phone keeps repeating the fix → no check", async () => {
    const tripId = await onTrip();
    const frozen = fixAt(STILL, sim.clock.now);
    await repeat(frozen, STOP_SECONDS - 30);
    await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("trip_id", "=", tripId).execute();
    pass(10);
    await repeat(frozen, 60);
    // Also a scan that was still booked for the ended trip asks nothing.
    await sim.db.deleteFrom("timers").where("kind", "=", RIDE_CHECK_SCAN).where("ref_id", "=", tripId).execute();
    await sim.db.insertInto("timers").values({ kind: RIDE_CHECK_SCAN, ref_id: tripId, due_at: sim.clock.now, payload: JSON.stringify({}) }).execute();
    await sim.tick();
    expect(await asked(tripId)).toHaveLength(0);
    expect(await rideCheck(tripId)).toBeUndefined();
  });

  // Owner 2026-11-16 "Skip if car was moving" (tunnel: the GPS freezes while the car drives on).
  it("tunnel: the last real fix said the car was moving, then that fix is repeated longer than the long-stop time → no long_stop", async () => {
    const tripId = await onTrip();
    await repeat({ ...fixAt(STILL, sim.clock.now), moving: true, speedMps: 14 }, STOP_SECONDS + SCAN_SECONDS + 10);
    expect(await rideCheck(tripId)).toBeUndefined();
    expect(await asked(tripId)).toHaveLength(0);
  });

  it("tunnel: a repeated fix with a speed of 1 m/s or more counts as moving also without the moving flag; below 1 m/s it is standing", async () => {
    const tripId = await onTrip();
    await repeat({ ...fixAt(STILL, sim.clock.now), speedMps: 1 }, STOP_SECONDS + SCAN_SECONDS + 10);
    expect(await rideCheck(tripId)).toBeUndefined();
    pass(10);
    await repeat({ ...fixAt(STILL, sim.clock.now), speedMps: 0.9 }, STOP_SECONDS + SCAN_SECONDS + 10);
    expect(await rideCheck(tripId)).toMatchObject({ trigger: "long_stop" });
  });

  it("the last real fix said the car stood still (moving false, speed 0), then it is repeated → long_stop", async () => {
    const tripId = await onTrip();
    await repeat({ ...fixAt(STILL, sim.clock.now), moving: false, speedMps: 0 }, STOP_SECONDS + SCAN_SECONDS + 10);
    expect(await rideCheck(tripId)).toMatchObject({ trigger: "long_stop" });
  });
});
