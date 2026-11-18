import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../src/ids.js";
import { autoOfflineIfDue, missedInRow, missedInRowOf } from "../../src/dispatch/autoOffline.js";
import { FeedQueue } from "../../src/dispatch/runtime/offers.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * Owner 2026-11-16 "It's not when driver decline ! It count when driver ignore" + "Yes, only ignored count (Rec.)" +
 * "And only exclusive / And it's about exclusive ride not radar" (contract v0.18.120 autoOffline.declined; corrects
 * Rules decisions/driver-g4.md:25-26): the in-a-row count takes ONLY Exclusive offers (also hand-sent to one driver,
 * kind assigned) the driver let EXPIRE. A decline never counts and does not reset the run; a Radar offer, ignored or
 * declined, never counts and does not reset it; an accept resets it. missedInRowOf (admin "Missed in a row") is the same.
 */
let database: TestDatabase;
let rider: string;
beforeAll(async () => {
  database = await freshDatabase();
  rider = await insertRider(database.db);
});
afterAll(async () => {
  await database.drop();
});

const T0 = new Date("2026-11-16T10:00:00Z");
let n = 0;
type Kind = "exclusive" | "assigned" | "radar";
type Status = "expired" | "declined" | "claimed";

/** Answered offers of one new driver, oldest first, one per minute. */
async function driverWith(...offers: Array<[Kind, Status]>) {
  const driverId = await insertDriver(database.db);
  for (const [kind, status] of offers) {
    const tripId = await insertTrip(database.db, rider, { status: "cancelled_by_rider" });
    const sent = new Date(T0.getTime() + (n += 1) * 60_000);
    await database.db
      .insertInto("offers")
      .values({ offer_id: newId("ofr"), trip_id: tripId, driver_id: driverId, kind, status, round: 1, currency: "SEK", fare_minor: 25000, driver_earnings_minor: 20000, pickup_meters: 900, pickup_eta_seconds: 120, sent_at: sent, expires_at: new Date(sent.getTime() + 14_000), answered_at: new Date(sent.getTime() + 14_000), group_id: null, reason_code: null, decline_reason: null })
      .execute();
  }
  return driverId;
}

async function counts(driverId: string) {
  const one = await missedInRow(database.db, driverId, null);
  const many = (await missedInRowOf(database.db, [{ driverId, onlineSince: null }])).get(driverId) ?? 0;
  return [one, many];
}

describe("auto-offline counts only Exclusive offers the driver let expire (owner 2026-11-16)", () => {
  it("ignore, decline, ignore = 2 (not 3, and not a reset to 1)", async () => {
    expect(await counts(await driverWith(["exclusive", "expired"], ["exclusive", "declined"], ["exclusive", "expired"]))).toEqual([2, 2]);
  });

  it("declines alone never count: 12 declined Exclusive and hand-sent offers = 0", async () => {
    const all = Array.from({ length: 12 }, (_, k): [Kind, Status] => [k % 2 ? "assigned" : "exclusive", "declined"]);
    expect(await counts(await driverWith(...all))).toEqual([0, 0]);
  });

  it("a decline is the newest answer: the run before it stands (2), it is not set back", async () => {
    expect(await counts(await driverWith(["exclusive", "expired"], ["exclusive", "expired"], ["exclusive", "declined"]))).toEqual([2, 2]);
  });

  it("hand-sent (assigned): an ignored one counts, a declined one is skipped", async () => {
    expect(await counts(await driverWith(["assigned", "expired"], ["assigned", "declined"], ["exclusive", "expired"], ["assigned", "declined"], ["assigned", "expired"]))).toEqual([3, 3]);
  });

  it("an accept still resets; a decline after it does not count", async () => {
    expect(await counts(await driverWith(["exclusive", "expired"], ["exclusive", "expired"], ["exclusive", "claimed"], ["exclusive", "declined"], ["exclusive", "expired"]))).toEqual([1, 1]);
  });

  it("only Exclusive: Exclusive ignored, Radar ignored, Exclusive ignored = 2; Radar never counts and never resets", async () => {
    expect(await counts(await driverWith(["exclusive", "expired"], ["radar", "expired"], ["exclusive", "expired"]))).toEqual([2, 2]);
    expect(await counts(await driverWith(["exclusive", "expired"], ["radar", "declined"], ["exclusive", "expired"]))).toEqual([2, 2]);
    expect(await counts(await driverWith(["radar", "expired"], ["radar", "declined"], ["radar", "expired"]))).toEqual([0, 0]);
  });
});

describe("a decline never sets the driver offline", () => {
  async function zoneWithLimit(limit: number, driverId: string) {
    const zoneId = `aoi-${driverId.slice(-12)}`;
    await database.db.insertInto("config_live").values({ doc: "driver_app_config", zone_id: zoneId, version: 1, document: JSON.stringify({ offers: { autoOffline: { missedExclusive: limit } } }), published_at: T0, published_by: null }).execute();
    await database.db.updateTable("drivers").set({ online_status: "online", online_since: T0 }).where("driver_id", "=", driverId).execute();
    const tripId = await insertTrip(database.db, rider, { status: "cancelled_by_rider" });
    await database.db.updateTable("trips").set({ zone_id: zoneId }).where("trip_id", "=", tripId).execute();
    return tripId;
  }
  const status = async (driverId: string) => (await database.db.selectFrom("drivers").select("online_status").where("driver_id", "=", driverId).executeTakeFirstOrThrow()).online_status;
  const lastEvent = async (driverId: string) => (await database.db.selectFrom("offer_events").select("offer").where("driver_id", "=", driverId).orderBy("sequence", "desc").executeTakeFirstOrThrow()).offer as Record<string, unknown>;

  it("limit 2, ignore + decline: still online (the decline does not count)", async () => {
    const driverId = await driverWith(["exclusive", "expired"], ["exclusive", "declined"]);
    const tripId = await zoneWithLimit(2, driverId);
    expect(await database.db.transaction().execute((trx) => autoOfflineIfDue(trx, driverId, tripId, new Date(T0.getTime() + 86_400_000)))).toBe(false);
    expect(await status(driverId)).toBe("online");
  });

  it("the offer feed: a declined offer event never runs the check, even with the run already at the limit; an expired one does", async () => {
    // Two ignored offers and a limit the admin lowered to 2 afterwards: the run is at the limit, the driver still online.
    const driverId = await driverWith(["exclusive", "expired"], ["exclusive", "expired"]);
    const tripId = await zoneWithLimit(2, driverId);
    const now = new Date(T0.getTime() + 86_400_000);
    for (const kind of ["exclusive", "assigned"]) {
      const queue = new FeedQueue();
      queue.push(driverId, "offer_updated", { offerId: newId("ofr"), tripId, kind, status: "declined" });
      await database.db.transaction().execute((trx) => queue.flush(trx, now));
      expect(await status(driverId)).toBe("online");
      expect(await lastEvent(driverId)).not.toHaveProperty("driverOffline");
    }
    const queue = new FeedQueue();
    queue.push(driverId, "offer_updated", { offerId: newId("ofr"), tripId, kind: "exclusive", status: "expired" });
    await database.db.transaction().execute((trx) => queue.flush(trx, now));
    expect(await status(driverId)).toBe("offline");
    expect(await lastEvent(driverId)).toMatchObject({ status: "expired", driverOffline: true });
  });
});
