import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_PHONES } from "../../src/auth/testPhones.js";
import { newId } from "../../src/ids.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertRider, insertTrip } from "../support/seed.js";
import { call, signIn, testWorld } from "../support/world.js";

/**
 * S21 / contract v0.18.124 C10 (contract.json#driverTripHistory; owner G11 Q10 "Load from server (Recommended)", full-audit
 * Q9 "Yes, on the server (Recommended)", Rules decisions/driver-g11.md): GET /driver/trips lists the driver's own ended
 * trips from the server, so a reinstall or a new phone shows the same history (Rules
 * audits/impact/findings-g18-g23-2026-11-17.md: PROVEN empty history). Fail-before: the route did not exist (404).
 * earned = the trip's own earnings entries, the same sum GET /driver/earnings puts in net. Sweden (SEK) and France (EUR).
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-17T10:00:00Z") };
let me: { id: string; headers: Record<string, string> };
let other: { id: string; headers: Record<string, string> };
let rider: Record<string, string>;
const trips: Record<string, string> = {};

async function driver(phone: string) {
  const headers = (await signIn(app, phone, "driver")).headers;
  const profile = (await call(app, "GET", "/driver/profile", headers)).json();
  return { id: profile.driverId as string, headers };
}

async function trip(driverId: string, status: string, createdAt: string, currency = "SEK") {
  const id = await insertTrip(database.db, await insertRider(database.db), { status, driverId });
  await database.db.updateTable("trips").set({ created_at: new Date(createdAt), updated_at: new Date(createdAt), currency, ...(status === "accepted" ? {} : { ended_at: new Date(createdAt) }) }).where("trip_id", "=", id).execute();
  return id;
}

async function entry(driverId: string, tripId: string | null, kind: string, amount: number, currency: string, cash: number | null = null) {
  await database.db.insertInto("earnings_entries").values({ entry_id: newId("ern"), driver_id: driverId, trip_id: tripId, kind: kind as never, currency, amount_minor: amount, gross_minor: null, commission_minor: null, cash_minor: cash, at: clock.now }).execute();
}

beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
  me = await driver(TEST_PHONES[1]!);
  other = await driver(TEST_PHONES[2]!);
  rider = (await signIn(app, TEST_PHONES[0]!, "rider")).headers;
  trips.done = await trip(me.id, "completed", "2026-11-17T08:00:00Z");
  await database.db.updateTable("trips").set({ distance_meters: 6_800 }).where("trip_id", "=", trips.done).execute();
  await entry(me.id, trips.done, "trip", 15_000, "SEK", 25_000);
  await entry(me.id, trips.done, "pickup_pay", 1_000, "SEK");
  await entry(me.id, trips.done, "tip", 2_000, "SEK", 2_000);
  await entry(me.id, trips.done, "bonus", 3_000, "SEK");
  trips.cancelled = await trip(me.id, "cancelled_by_rider", "2026-11-17T07:00:00Z");
  await entry(me.id, trips.cancelled, "fee_share", 4_500, "SEK");
  trips.noShow = await trip(me.id, "no_show", "2026-11-16T20:00:00Z");
  trips.paris = await trip(me.id, "completed", "2026-10-02T12:00:00Z", "EUR");
  await entry(me.id, trips.paris, "trip", 1_800, "EUR", 0);
  trips.active = await trip(me.id, "accepted", "2026-11-17T09:00:00Z");
  trips.others = await trip(other.id, "completed", "2026-11-17T08:30:00Z");
  await entry(other.id, trips.others, "trip", 9_999, "SEK");
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("S21 GET /driver/trips: the driver's ride history from the server", () => {
  it("lists only his own ended trips, newest first, with earned = his earnings entries", async () => {
    const res = await call(app, "GET", "/driver/trips", me.headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((t: { tripId: string }) => t.tripId)).toEqual([trips.done, trips.cancelled, trips.noShow, trips.paris]);
    expect(body.nextCursor).toBeNull();
    const [done, cancelled, noShow, paris] = body.items;
    expect(done.status).toBe("completed");
    expect(done.earned).toEqual({ amountMinor: 21_000, currency: "SEK" });
    expect(done.cashCollected).toEqual({ amountMinor: 27_000, currency: "SEK" });
    expect(done.endedAt).toBe("2026-11-17T08:00:00.000Z");
    expect(done.distanceMeters).toBe(6_800);
    expect(cancelled.earned).toEqual({ amountMinor: 4_500, currency: "SEK" });
    expect(cancelled.cashCollected).toBeUndefined();
    expect(noShow.earned).toEqual({ amountMinor: 0, currency: "SEK" });
    expect(paris.earned).toEqual({ amountMinor: 1_800, currency: "EUR" });
    expect(paris.cashCollected).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(trips.others);
  });

  it("is the same on a new phone (a fresh sign-in reads the same list)", async () => {
    const again = await signIn(app, TEST_PHONES[1]!, "driver");
    const res = await call(app, "GET", "/driver/trips", again.headers);
    expect(res.json().items).toHaveLength(4);
  });

  it("matches GET /driver/earnings net (same entries, same sum)", async () => {
    const report = (await call(app, "GET", "/driver/earnings?period=day&currency=SEK", me.headers)).json();
    const net = report.periods.reduce((a: number, p: { net: { amountMinor: number } }) => a + p.net.amountMinor, 0);
    const listed = (await call(app, "GET", "/driver/trips", me.headers)).json().items.filter((t: { earned: { currency: string } }) => t.earned.currency === "SEK").reduce((a: number, t: { earned: { amountMinor: number } }) => a + t.earned.amountMinor, 0);
    expect(listed).toBe(net);
  });

  it("pages with nextCursor", async () => {
    const first = (await call(app, "GET", "/driver/trips?limit=3", me.headers)).json();
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await call(app, "GET", `/driver/trips?limit=3&cursor=${encodeURIComponent(first.nextCursor)}`, me.headers)).json();
    expect(second.items.map((t: { tripId: string }) => t.tripId)).toEqual([trips.paris]);
    expect(second.nextCursor).toBeNull();
  });

  it("filters by status and by month", async () => {
    const done = (await call(app, "GET", "/driver/trips?status=completed", me.headers)).json();
    expect(done.items.map((t: { tripId: string }) => t.tripId)).toEqual([trips.done, trips.paris]);
    const october = (await call(app, "GET", "/driver/trips?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z", me.headers)).json();
    expect(october.items.map((t: { tripId: string }) => t.tripId)).toEqual([trips.paris]);
  });

  it("refuses a bad status, a too large limit, a bad cursor and a rider", async () => {
    const status = await call(app, "GET", "/driver/trips?status=accepted", me.headers);
    expect(status.statusCode).toBe(400);
    expect(status.json()).toMatchObject({ reason: "invalid_status" });
    expect((await call(app, "GET", "/driver/trips?limit=51", me.headers)).statusCode).toBe(400);
    const cursor = await call(app, "GET", "/driver/trips?cursor=bad", me.headers);
    expect(cursor.statusCode).toBe(400);
    expect((await call(app, "GET", "/driver/trips", rider)).statusCode).toBe(403);
    expect((await call(app, "GET", "/driver/trips", {})).statusCode).toBe(401);
  });
});
