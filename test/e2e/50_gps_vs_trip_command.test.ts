import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { PLACES, Sim, bookAndAccept, drive, type Driver, type Json, type Rider } from "./harness.js";

/**
 * S5 (sup1 P11, GM safety review condition 2): a driver's GPS batches (POST /driver/location) race the Finish + Collect
 * cash command of the same trip. The trip lock is FOR NO KEY UPDATE and the GPS step writes the trip row last
 * (drivers/service.ts storeFixes), so the GPS trace insert no longer waits for the command. Whatever order the two
 * transactions take: no deadlock and no busy answer, nothing the command wrote is lost (status, version, fare, cash),
 * and the trip's event sequence has no lost or doubled step.
 */
let sim: Sim;
let rider: Rider;
let driver: Driver;

beforeAll(async () => {
  sim = await Sim.start();
  rider = await sim.rider(0);
  driver = await sim.driver(1, PLACES.nearSergels);
  // Only the race's own fixes, no periodic heartbeat fixes in between.
  sim.driverApps.delete(driver);
});
afterAll(async () => {
  await sim?.stop();
});

const ROUNDS = 3;
const GPS_POSTS = 6;

describe("S5: GPS posts racing Finish + Collect cash on the same trip", () => {
  it.each(Array.from({ length: ROUNDS }, (_, i) => i + 1))("round %i: no deadlock, no lost update", async () => {
    await driver.moveTo(PLACES.nearSergels);
    const { tripId } = await bookAndAccept(sim, rider, driver);
    await drive(driver, tripId, "in_trip");
    await driver.moveTo(PLACES.medborgar);
    const shown = await driver.get(`/driver/trips/${tripId}/complete-preview`);
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    const before = await driver.trip(tripId);

    // Each batch newer than the last one stored, so each takes the whole GPS path (trace, event, timers, trip row).
    const batches = Array.from({ length: GPS_POSTS }, (_, i) => ({ fixes: [driver.fix({ lat: PLACES.medborgar.lat + (i + 1) * 1e-5, lng: PLACES.medborgar.lng })] }));
    const [done, ...gps] = await Promise.all([
      driver.command(tripId, "complete", { expectedVersion: before["version"], previewId: shown.body["previewId"], cashCollected: shown.body["cashDue"] }),
      ...batches.map((batch) => driver.post("/driver/location", batch)),
    ]);

    expect(done!.status, JSON.stringify(done!.body)).toBe(200);
    expect(gps.map((r) => r.status), JSON.stringify(gps.map((r) => r.body))).toEqual(Array(GPS_POSTS).fill(200));
    expect(done!.body["status"]).toBe("completed");
    expect(done!.body["fare"]).toEqual(shown.body["total"]);

    // Nothing the command wrote was overwritten by a GPS transaction.
    const row = await sim.db.selectFrom("trips").select(["status", "version", "fare_minor", "currency", "sequence"]).where("trip_id", "=", tripId).executeTakeFirstOrThrow();
    expect({ status: row.status, version: Number(row.version), fare: { amountMinor: Number(row.fare_minor), currency: row.currency } }).toEqual({
      status: "completed",
      version: done!.body["version"],
      fare: shown.body["total"],
    });
    const seen: Json = await rider.trip(tripId);
    expect({ status: seen["status"], version: seen["version"], fare: seen["fare"] }).toEqual({ status: "completed", version: done!.body["version"], fare: shown.body["total"] });

    // The trip's event log: one event per sequence step, none lost, none doubled (every writer bumps trips.sequence).
    const log = await sql<{ n: string; distinct_n: string; max_seq: string | null; min_seq: string | null }>`
      SELECT count(*) AS n, count(DISTINCT sequence) AS distinct_n, max(sequence) AS max_seq, min(sequence) AS min_seq
      FROM trip_events WHERE trip_id = ${tripId}`.execute(sim.db);
    const events = log.rows[0]!;
    expect({ n: Number(events.n), distinct: Number(events.distinct_n), min: Number(events.min_seq), max: Number(events.max_seq) }).toEqual({
      n: Number(row.sequence),
      distinct: Number(row.sequence),
      min: 1,
      max: Number(row.sequence),
    });

    // A GPS batch that landed on the trip left its trace row; one that was the newest also left one location event (an
    // older batch, overtaken by a newer one in this race, only fills the trace: E4 in storeFixes).
    const trace = await sim.db.selectFrom("trip_locations").select(sql<string>`count(*)`.as("n")).where("trip_id", "=", tripId).where("measured_at", ">=", new Date(batches[0]!.fixes[0]!.measuredAt)).executeTakeFirstOrThrow();
    const located = await sql<{ n: string }>`SELECT count(*) AS n FROM trip_events WHERE trip_id = ${tripId} AND kind = 'location' AND (location->>'measuredAt')::timestamptz >= ${new Date(batches[0]!.fixes[0]!.measuredAt)}`.execute(sim.db);
    expect(Number(located.rows[0]!.n)).toBeLessThanOrEqual(Number(trace.n));
    expect(Number(trace.n)).toBeLessThanOrEqual(GPS_POSTS);
    expect(sim.timerErrors).toEqual([]);
  });
});
