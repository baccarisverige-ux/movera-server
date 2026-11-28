import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbDailyGuard, googleDay } from "../../src/maps/googleBudget.js";
import { GoogleRoutesRouter } from "../../src/maps/googleRoutes.js";
import { encodePolyline } from "../../src/maps/polyline.js";
import { EstimateRouter } from "../../src/maps/routing.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { eastDeg, MID, roadWorld, type RoadWorld } from "../support/roadLines171.js";

/**
 * v0.18.171 (contract.json#googleRoadLines.dailyBudget / dayBoundary; owner 2026-11-27 1,400 prices / 600 road lines of
 * 2,000 a day): one budget for all countries, on the America/Los_Angeles day. Road lines stop first (re-routes at 80%
 * of their share, the drive to the pickup at 100%); quotes go on to the whole limit.
 */
let database: TestDatabase;
const clock = { now: new Date("2026-11-27T20:00:00Z") };
let fetched = 0;
const fakeFetch = (async () => {
  fetched += 1;
  return new Response(JSON.stringify({ routes: [{ duration: "300s", distanceMeters: 2500, polyline: { encodedPolyline: encodePolyline([{ lat: 59.33, lng: 18.06 }, { lat: 59.32, lng: 18.07 }]) } }] }));
}) as unknown as typeof fetch;
let router: GoogleRoutesRouter;
const A = { lat: 59.33, lng: 18.06 };
const B = { lat: 59.32, lng: 18.07 };

beforeAll(async () => {
  database = await freshDatabase();
  router = new GoogleRoutesRouter("test-key-not-real", new EstimateRouter(), { fetch: fakeFetch, now: () => clock.now.getTime(), daily: dbDailyGuard(database.db, () => clock.now) });
});
afterAll(async () => {
  await database.drop();
});
beforeEach(async () => {
  fetched = 0;
  await database.db.deleteFrom("google_route_calls_daily").execute();
});

const used = async (rows: Array<{ country: string; kind: "quote" | "road_line"; calls: number }>) => {
  for (const r of rows) await database.db.insertInto("google_route_calls_daily").values({ day: googleDay(clock.now), ...r }).execute();
};

describe("the daily Google budget (v0.18.171)", () => {
  it("the split: re-routes stop at 80% of the road-line share, the drive to the pickup at 100%; quotes go on", async () => {
    await used([{ country: "SE", kind: "road_line", calls: 480 }]);
    expect((await router.route([A, B], { budget: { kind: "road_line", stage: "reroute", country: "SE" } })).source).toBe("estimate");
    expect(fetched).toBe(0);
    expect((await router.route([A, B], { budget: { kind: "road_line", stage: "pickup", country: "SE" } })).source).toBe("google");
    expect(fetched).toBe(1);
    await database.db.updateTable("google_route_calls_daily").set({ calls: 600 }).execute();
    expect((await router.route([A, B], { budget: { kind: "road_line", stage: "pickup", country: "SE" } })).source).toBe("estimate");
    expect(fetched).toBe(1);
    // The quotes' share is kept for them.
    expect((await router.route([A, B], { budget: { kind: "quote", country: "SE" } })).source).toBe("google");
    expect(fetched).toBe(2);
    const rows = await database.db.selectFrom("google_route_calls_daily").select(["kind", "calls"]).orderBy("kind").execute();
    expect(rows).toEqual([{ kind: "quote", calls: 1 }, { kind: "road_line", calls: 600 }]);
  });

  it("SE + FR together stop at the limit", async () => {
    await used([{ country: "SE", kind: "quote", calls: 1200 }, { country: "FR", kind: "quote", calls: 799 }]);
    expect((await router.route([A, B], { budget: { kind: "quote", country: "FR" } })).source).toBe("google");
    expect((await router.route([A, B], { budget: { kind: "quote", country: "SE" } })).source).toBe("estimate");
    expect(fetched).toBe(1);
  });

  it("a call just after Los Angeles midnight counts on the new day", async () => {
    await database.db.insertInto("google_route_calls_daily").values({ day: "2026-11-27", country: "SE", kind: "quote", calls: 2000 }).execute();
    clock.now = new Date("2026-11-28T07:59:00Z"); // 23:59 in Los Angeles on the 27th (PST, UTC-8)
    expect(googleDay(clock.now)).toBe("2026-11-27");
    expect((await router.route([A, B], { budget: { kind: "quote", country: "SE" } })).source).toBe("estimate");
    clock.now = new Date("2026-11-28T08:01:00Z"); // 00:01 on the 28th in Los Angeles
    expect((await router.route([A, B], { budget: { kind: "quote", country: "SE" } })).source).toBe("google");
    const day = await database.db.selectFrom("google_route_calls_daily").select([(eb) => eb.cast<string>("day", "text").as("day"), "calls"]).where("calls", "=", 1).executeTakeFirstOrThrow();
    expect(day.day).toBe("2026-11-28");
    clock.now = new Date("2026-11-27T20:00:00Z");
  });
});

describe("re-routes stop before the drive to the pickup on GET /routes/driving (v0.18.171)", () => {
  let w: RoadWorld;
  beforeAll(async () => {
    w = await roadWorld();
  });
  afterAll(async () => {
    await w.close();
  });
  it("at 80% of the road-line share an off-route re-route answers stored with 0 calls", async () => {
    await w.reset();
    const { tripId } = await w.accepted();
    await w.database.db.insertInto("google_route_calls_daily").values({ day: googleDay(w.clock.now), country: "SE", kind: "road_line", calls: 480 }).execute();
    w.google.calls = 0;
    const off = { lat: MID.lat, lng: MID.lng + eastDeg(120) };
    await w.moveTo(off);
    w.wait(61);
    expect((await w.nav(off)).source).toBe("stored");
    expect(w.google.calls).toBe(0);
    expect((await w.trip(tripId)).google_route_calls).toBe(2);
  });
});
