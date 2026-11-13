import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { insertRider, insertTrip } from "../support/seed.js";
import { adminSession } from "../support/admin.js";
import { testWorld } from "../support/world.js";

/**
 * G34 A2 (contract v0.18.83 adminListFilters.scheduledBefore; owner 2026-11-13 12:24 UTC "Exact contract filter"):
 * GET /admin/trips takes scheduledBefore. A live trip always passes; a booked ride passes only when its scheduledAt is at
 * or before the value. It only narrows, with the other filters. The Dashboard's waiting read:
 * ?status=requested&status=searching&status=offered&scheduledBefore=<now>.
 */

let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-13T12:00:00.000Z") };
let admin: Record<string, string>;
const id: Record<string, string> = {};
const minutes = (n: number) => new Date(clock.now.getTime() + n * 60_000);

beforeAll(async () => {
  database = await freshDatabase();
  const db = database.db;
  app = await testWorld(db, database.url, clock);
  const plan: Array<[string, "live" | "scheduled", string, Date | null]> = [
    ["liveSearching", "live", "searching", null],
    ["liveOffered", "live", "offered", null],
    ["liveCompleted", "live", "completed", null],
    // A booked ride whose send is late (still requested after its pickup time): stays on the Dashboard.
    ["bookedLate", "scheduled", "requested", minutes(-5)],
    // Exactly at the value: passes ("at or before").
    ["bookedNow", "scheduled", "requested", minutes(0)],
    // Not due yet: never read by the Dashboard.
    ["bookedLater", "scheduled", "requested", minutes(1)],
    ["bookedTomorrow", "scheduled", "requested", minutes(24 * 60)],
    ["bookedSearching", "scheduled", "searching", minutes(-1)],
  ];
  for (const [name, kind, status, at] of plan) {
    const rider = await insertRider(db);
    const tripId = await insertTrip(db, rider, { status, kind });
    await db.updateTable("trips").set({ zone_id: "Z001", scheduled_at: at } as never).where("trip_id", "=", tripId).execute();
    id[name] = tripId;
  }
  admin = (await adminSession(app, db, "super", { now: clock.now })).headers;
});

afterAll(async () => {
  await app?.close();
  await database.drop();
});

const ids = async (query: string) => {
  const res = await app.inject({ method: "GET", url: `/api/v1/admin/trips?limit=200&${query}`, headers: admin });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { items: Array<{ tripId: string }>; total?: number };
  return { ids: body.items.map((t) => t.tripId).sort(), total: body.total };
};
const names = (...keys: string[]) => keys.map((k) => id[k]!).sort();

describe("G34 A2: GET /admin/trips?scheduledBefore", () => {
  it("the Dashboard's waiting read: live waiting trips + booked rides due at or before the value; not-due booked rides never", async () => {
    const got = await ids(`status=requested&status=searching&status=offered&scheduledBefore=${encodeURIComponent(clock.now.toISOString())}`);
    expect(got.ids).toEqual(names("liveSearching", "liveOffered", "bookedLate", "bookedNow", "bookedSearching"));
    // total counts the same filtered query.
    expect(got.total).toBe(5);
  });

  it("only narrows: with no other filter every live trip passes, booked rides only when due", async () => {
    const got = await ids(`scheduledBefore=${encodeURIComponent(minutes(1).toISOString())}`);
    expect(got.ids).toEqual(names("liveSearching", "liveOffered", "liveCompleted", "bookedLate", "bookedNow", "bookedLater", "bookedSearching"));
    const scheduledOnly = await ids(`kind=scheduled&scheduledBefore=${encodeURIComponent(clock.now.toISOString())}`);
    expect(scheduledOnly.ids).toEqual(names("bookedLate", "bookedNow", "bookedSearching"));
  });

  it("without scheduledBefore the list is unchanged (Reservations keeps kind=scheduled)", async () => {
    expect((await ids("kind=scheduled")).ids).toEqual(names("bookedLate", "bookedNow", "bookedLater", "bookedTomorrow", "bookedSearching"));
    expect((await ids("")).ids).toHaveLength(8);
  });

  it("a malformed value is 400 invalid_request", async () => {
    for (const bad of ["yesterday", "2026-13-01T00:00:00Z", "12:00"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/admin/trips?scheduledBefore=${encodeURIComponent(bad)}`, headers: admin });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json()).toMatchObject({ code: "invalid_request" });
    }
  });
});
