import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TripRow } from "../../src/db/tripLog.js";
import { DRIVER_TRIP_PUSH, pushDriverTripMoment } from "../../src/notifications/driverTripPush.js";
import { listNotifications, markNotificationRead, notify } from "../../src/notifications/service.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * Audit apps-every-control 2026-11-20 N4: a French row "Course annulée. Le passager a annulé la course." in the Swedish
 * driver app. The bell kept the text in the language of the moment it was written. Now the list shows the reader's
 * language: his own, else his zone's country's (§87 rule), for notices that carry every language (data.texts).
 */
let database: TestDatabase;
const now = new Date("2026-11-20T12:00:00Z");

beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

async function driverWithTrip(language: string | null) {
  const riderId = await insertRider(database.db);
  const driverId = await insertDriver(database.db);
  await database.db.updateTable("drivers").set({ language }).where("driver_id", "=", driverId).execute();
  const tripId = await insertTrip(database.db, riderId, { driverId, status: "accepted" });
  const trip = (await database.db.selectFrom("trips").selectAll().where("trip_id", "=", tripId).executeTakeFirstOrThrow()) as TripRow;
  return { driverId, trip };
}
const bell = async (driverId: string) => (await listNotifications(database.db, { audience: "driver", subjectId: driverId }, { limit: 10 })).items;

describe("N4: a driver notice reads in the driver's language now, not the one at send time", () => {
  it("written in French, the driver now uses Swedish: the bell shows Swedish (fail-before: French)", async () => {
    const { driverId, trip } = await driverWithTrip("fr");
    await pushDriverTripMoment(database.db, driverId, trip, "rider_cancelled", now);
    expect((await bell(driverId))[0]).toMatchObject({ title: DRIVER_TRIP_PUSH.title.fr });
    await database.db.updateTable("drivers").set({ language: "sv" }).where("driver_id", "=", driverId).execute();
    const [row] = await bell(driverId);
    expect(row).toMatchObject({ title: DRIVER_TRIP_PUSH.title.sv, body: DRIVER_TRIP_PUSH.texts.rider_cancelled.sv });
    expect((row as { data?: Record<string, unknown> }).data).toEqual({ tripId: trip.trip_id, moment: "rider_cancelled" });
  });

  it("no own language: the driver's zone's country decides (SE: Swedish), fail-before: as written", async () => {
    const { driverId } = await driverWithTrip(null);
    await database.db.updateTable("drivers").set({ country: "SE" }).where("driver_id", "=", driverId).execute();
    const t = DRIVER_TRIP_PUSH;
    await notify(database.db, { audience: "driver", subjectId: driverId, kind: t.kind, title: t.title.fr, body: t.texts.rider_cancelled.fr, data: { texts: { title: t.title, body: t.texts.rider_cancelled } } }, now);
    expect((await bell(driverId))[0]).toMatchObject({ title: t.title.sv, body: t.texts.rider_cancelled.sv });
  });
  it("POST read answers in the same language as the list (fail-before: the stored language)", async () => {
    const { driverId, trip } = await driverWithTrip("fr");
    await pushDriverTripMoment(database.db, driverId, trip, "rider_cancelled", now);
    await database.db.updateTable("drivers").set({ language: "sv" }).where("driver_id", "=", driverId).execute();
    const [row] = await bell(driverId);
    const read = await markNotificationRead(database.db, { audience: "driver", subjectId: driverId }, (row as { notificationId: string }).notificationId, now);
    expect(read).toMatchObject({ title: DRIVER_TRIP_PUSH.title.sv, body: DRIVER_TRIP_PUSH.texts.rider_cancelled.sv });
  });
});
