import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../../src/http/errors.js";
import { TRIP_EVENTS_CHANNEL, appendTripEvent, checkVersion, lockTrip, tripEventsAfter } from "../../src/db/tripLog.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertRider, insertTrip } from "../support/seed.js";

let database: TestDatabase;
let listener: pg.Client;
const notes: Array<{ tripId: string; sequence: number; riderId?: string; zoneId?: string; scheduled?: boolean; driverId?: string }> = [];

beforeAll(async () => {
  database = await freshDatabase();
  listener = new pg.Client({ connectionString: database.url });
  await listener.connect();
  listener.on("notification", (message) => notes.push(JSON.parse(message.payload ?? "{}")));
  await listener.query(`LISTEN ${TRIP_EVENTS_CHANNEL}`);
});
afterAll(async () => {
  await listener.end();
  await database.drop();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// LISTEN/NOTIFY delivery time depends on load; poll for the expected state instead of a fixed sleep.
async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check() && Date.now() < end) await sleep(20);
}
async function newTrip(): Promise<string> {
  return insertTrip(database.db, await insertRider(database.db));
}

describe("lockTrip", () => {
  it("an unknown trip is 404 trip_not_found", async () => {
    await expect(database.db.transaction().execute((trx) => lockTrip(trx, "trp_missing"))).rejects.toMatchObject({
      code: "not_found",
      options: { reason: "trip_not_found" },
    });
  });

  it("holds the row: a second command on the same trip waits for the first", async () => {
    const tripId = await newTrip();
    const order: string[] = [];
    const first = database.db.transaction().execute(async (trx) => {
      await lockTrip(trx, tripId);
      order.push("first locked");
      await sleep(150);
      order.push("first done");
    });
    await sleep(30);
    const second = database.db.transaction().execute(async (trx) => {
      await lockTrip(trx, tripId);
      order.push("second locked");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first locked", "first done", "second locked"]);
  });
});

describe("checkVersion", () => {
  it("passes on the current version", () => expect(() => checkVersion(4, 4, () => ({}))).not.toThrow());

  it("a stale version is 409 version_mismatch carrying the current projection", () => {
    const error = (() => {
      try {
        checkVersion(5, 4, () => ({ tripId: "trp_1", version: 5 }));
      } catch (caught) {
        return caught;
      }
    })() as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.body("r1")).toEqual({
      code: "version_mismatch",
      message: "The trip changed since you last saw it.",
      requestId: "r1",
      retryable: false,
      projection: { tripId: "trp_1", version: 5 },
    });
  });

  it("a missing expectedVersion is 400 expected_version_missing", () => {
    expect(() => checkVersion(1, undefined, () => ({}))).toThrow(expect.objectContaining({ code: "invalid_request", options: { reason: "expected_version_missing" } }));
  });
});

describe("appendTripEvent", () => {
  it("numbers events 1, 2, 3 … per trip and keeps the trip's cursor in step", async () => {
    const a = await newTrip();
    const b = await newTrip();
    const append = (tripId: string) =>
      database.db.transaction().execute((trx) => appendTripEvent(trx, { tripId, kind: "trip_projection", version: 1, projection: { tripId } }));
    expect((await append(a)).sequence).toBe(1);
    expect((await append(a)).sequence).toBe(2);
    expect((await append(b)).sequence).toBe(1);
    expect((await append(a)).sequence).toBe(3);
    const trip = await database.db.selectFrom("trips").select("sequence").where("trip_id", "=", a).executeTakeFirstOrThrow();
    expect(Number(trip.sequence)).toBe(3);
    const events = await tripEventsAfter(database.db, a, 1);
    expect(events.map((event) => Number(event.sequence))).toEqual([2, 3]);
    expect(events[0]).toMatchObject({ kind: "trip_projection", version: 1, projection: { tripId: a } });
    expect(events[0]!.event_id).toMatch(/^evt_[0-9A-Z]{26}$/);
  });

  it("many commands at once on one trip still give 1…N with no gap and no repeat", async () => {
    const tripId = await newTrip();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        database.db.transaction().execute(async (trx) => {
          const trip = await lockTrip(trx, tripId);
          await appendTripEvent(trx, { tripId, kind: i % 3 === 0 ? "location" : "trip_projection", version: trip.version, location: { lat: 59.3, lng: 18.0 } });
        }),
      ),
    );
    const events = await tripEventsAfter(database.db, tripId, 0);
    expect(events.map((event) => Number(event.sequence))).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("a rolled-back command leaves no event, no cursor bump and no notification", async () => {
    const tripId = await newTrip();
    notes.length = 0;
    await expect(
      database.db.transaction().execute(async (trx) => {
        await appendTripEvent(trx, { tripId, kind: "trip_projection", version: 1 });
        throw new ApiError("invalid_transition", "No.");
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await sleep(100);
    expect(notes.filter((note) => note.tripId === tripId)).toEqual([]);
    expect(await tripEventsAfter(database.db, tripId, 0)).toEqual([]);
    await database.db.transaction().execute((trx) => appendTripEvent(trx, { tripId, kind: "trip_projection", version: 1 }));
    await waitUntil(() => notes.some((note) => note.tripId === tripId));
    // The committed event's notification has arrived; a rolled-back one would have been delivered before it.
    expect(notes.filter((note) => note.tripId === tripId)).toEqual([{ tripId, sequence: 1, riderId: expect.any(String), zoneId: expect.any(String), scheduled: false }]);
  });

  it("the notification arrives only after commit", async () => {
    const tripId = await newTrip();
    notes.length = 0;
    await database.db.transaction().execute(async (trx) => {
      await appendTripEvent(trx, { tripId, kind: "driver_arrived", version: 2 });
      await sleep(100);
      expect(notes.filter((note) => note.tripId === tripId)).toEqual([]);
    });
    await waitUntil(() => notes.some((note) => note.tripId === tripId));
    expect(notes.filter((note) => note.tripId === tripId)).toEqual([{ tripId, sequence: 1, riderId: expect.any(String), zoneId: expect.any(String), scheduled: false }]);
  });

  it("an event kind outside the contract is refused by the database", async () => {
    const tripId = await newTrip();
    await expect(
      database.db.transaction().execute((trx) => appendTripEvent(trx, { tripId, kind: "teleported" as never, version: 1 })),
    ).rejects.toThrow(/check constraint/);
  });
});
