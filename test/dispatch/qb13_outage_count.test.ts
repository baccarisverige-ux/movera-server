import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "../../src/ids.js";
import { missedInRow, missedInRowOf } from "../../src/dispatch/autoOffline.js";
import { OUTAGE_OPEN_GRACE_MS } from "../../src/realtime/outages.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertDriver, insertRider, insertTrip } from "../support/seed.js";

/**
 * S4 B1.16 Q-B13 (owner W1 Q78 "Do not count it", 2026-11-11; contract v0.18.120 autoOffline.outage): an Exclusive or
 * hand-sent offer that EXPIRED while a server copy's live link was down (its sent..answered time overlaps an outage
 * window any copy recorded) is skipped by the auto-offline count, and by the admin Dispatch count (missedInRowOf).
 * A declined one still counts; one outside every window still counts; an open window counts until seen_at + 60 s.
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
beforeEach(async () => {
  await sql`DELETE FROM realtime_outages`.execute(database.db);
});

const T0 = new Date("2026-11-16T10:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

/** One Exclusive sent at `sent` s, answered (declined or expired) 14 s later. */
async function offer(driverId: string, status: "expired" | "declined" | "claimed", sent: number) {
  const tripId = await insertTrip(database.db, rider, { status: "cancelled_by_rider" });
  await database.db
    .insertInto("offers")
    .values({ offer_id: newId("ofr"), trip_id: tripId, driver_id: driverId, kind: "exclusive", status, round: 1, currency: "SEK", fare_minor: 25000, driver_earnings_minor: 20000, pickup_meters: 900, pickup_eta_seconds: 120, sent_at: at(sent), expires_at: at(sent + 14), answered_at: at(sent + 14), group_id: null, reason_code: null, decline_reason: null })
    .execute();
}

async function outage(down: number, up: number | null, seen = down) {
  await sql`INSERT INTO realtime_outages (copy_id, down_at, seen_at, up_at) VALUES ('copy-a', ${at(down)}, ${at(seen)}, ${up === null ? null : at(up)})`.execute(database.db);
}

async function counts(driverId: string) {
  const one = await missedInRow(database.db, driverId, null);
  const many = (await missedInRowOf(database.db, [{ driverId, onlineSince: null }])).get(driverId) ?? 0;
  return [one, many];
}

describe("Q-B13: an Exclusive that expired while the live link was down never counts", () => {
  it("expired inside a closed outage window: skipped (neither counts nor ends the run); outside: counts", async () => {
    const driver = await insertDriver(database.db);
    await offer(driver, "expired", 0); // 0..14, before the outage: counts
    await offer(driver, "expired", 100); // 100..114, inside 105..200: skipped
    await offer(driver, "expired", 190); // 190..204, overlaps the end: skipped
    await offer(driver, "expired", 300); // after: counts
    await outage(105, 200);
    expect(await counts(driver)).toEqual([2, 2]);
  });

  it("a declined offer inside the window still counts (the driver answered it)", async () => {
    const driver = await insertDriver(database.db);
    await offer(driver, "declined", 100);
    await offer(driver, "expired", 120);
    await outage(90, 200);
    expect(await counts(driver)).toEqual([1, 1]);
  });

  it("a skipped offer does not end the run: an accept before it still ends it", async () => {
    const driver = await insertDriver(database.db);
    await offer(driver, "expired", 0);
    await offer(driver, "claimed", 50);
    await offer(driver, "expired", 100); // skipped
    await offer(driver, "expired", 300); // counts
    await outage(90, 200);
    expect(await counts(driver)).toEqual([1, 1]);
  });

  it("an open window (copy still down) counts until its seen_at + 60 s, not for ever", async () => {
    const driver = await insertDriver(database.db);
    await offer(driver, "expired", 100); // inside [90, 130 + 60]
    await offer(driver, "expired", 400); // after 190: counts
    await outage(90, null, 130);
    expect(OUTAGE_OPEN_GRACE_MS).toBe(60_000);
    expect(await counts(driver)).toEqual([1, 1]);
  });

  it("any copy's window counts (offer feeds may be on any copy)", async () => {
    const driver = await insertDriver(database.db);
    await offer(driver, "expired", 100);
    await sql`INSERT INTO realtime_outages (copy_id, down_at, seen_at, up_at) VALUES ('copy-b', ${at(101)}, ${at(101)}, ${at(103)})`.execute(database.db);
    expect(await counts(driver)).toEqual([0, 0]);
  });
});
