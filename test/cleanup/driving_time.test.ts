import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countedSeconds } from "../../src/drivers/drivingTime.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/** Checker 5 (decisions/driving-time-limits.md): a booked ride accepted early counts only from when the driver must leave. */
let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => database.drop());

describe("counted driving time of a booked ride", () => {
  it("accepted the day before: the pickup leg counts from pickup time − ETA, not from the accept", async () => {
    const rider = await insertRider(database.db);
    const driver = await insertDriver(database.db);
    const tripId = await insertTrip(database.db, rider, { status: "completed", driverId: driver });
    const t = (s: string) => new Date(`2026-11-02T${s}:00Z`);
    await database.db.updateTable("trips").set({
      kind: "scheduled", scheduled_at: t("10:00"), accepted_at: new Date("2026-11-01T18:00:00Z"), eta: JSON.stringify({ etaSeconds: 900 }),
      arrived_at: t("09:58"), boarded_at: t("10:05"), ended_at: t("10:35"), updated_at: t("10:35"),
    }).where("trip_id", "=", tripId).execute();
    // 09:45 → 09:58 to the pickup (13 min) + 10:05 → 10:35 on board (30 min); the 7 min waiting never counts.
    expect(await countedSeconds(database.db, driver, new Date("2026-11-01T12:00:00Z"), t("12:00"))).toBe(43 * 60);
  });
});
