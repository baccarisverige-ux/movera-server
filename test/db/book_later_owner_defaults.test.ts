import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/** v0.18.19 live MED 4: zones still on the old built-in reservation times get the owner values; own choices stay. */
let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

const doc = (normalOnline: number, reminders: number[], airportReminders: number[]) => ({
  reservations: { rideTypes: { normal: { onlineBeforeMin: normalOnline, spareMin: 15, reminderMin: reminders }, airport: { onlineBeforeMin: 60, spareMin: 15, reminderMin: airportReminders } } },
});

describe("migration 0064: owner defaults for zones on the old values", () => {
  it("30 min → 60 min and [60, 15] → [120]; an admin's own values are kept", async () => {
    const db = database.db;
    await db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z-old", version: 1, document: JSON.stringify(doc(30, [60, 15], [60, 15])), published_at: new Date(), published_by: null }).execute();
    await db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: "Z-own", version: 1, document: JSON.stringify(doc(45, [90], [60, 15])), published_at: new Date(), published_by: null }).execute();
    await database.pool.query(readFileSync("migrations/0064_book_later_owner_defaults.sql", "utf8"));
    const read = async (zone: string) => (await db.selectFrom("config_live").select("document").where("zone_id", "=", zone).executeTakeFirstOrThrow()).document as ReturnType<typeof doc>;
    const old = await read("Z-old");
    expect(old.reservations.rideTypes.normal).toMatchObject({ onlineBeforeMin: 60, reminderMin: [120] });
    expect(old.reservations.rideTypes.airport.reminderMin).toEqual([120]);
    const own = await read("Z-own");
    expect(own.reservations.rideTypes.normal).toMatchObject({ onlineBeforeMin: 45, reminderMin: [90] });
    expect(own.reservations.rideTypes.airport.reminderMin).toEqual([120]);
  });
});
