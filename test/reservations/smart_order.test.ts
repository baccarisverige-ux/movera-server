import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DISPATCH } from "../../src/dispatch/engine.js";
import { smartOrder } from "../../src/reservations/service.js";
import { leaveAtOf } from "../../src/reservations/plan.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/** Owner 2026-11-03 "smart assign" and "leave on time" (contract.json#bookLater.liveFixes.leaveOnTime). */
let database: TestDatabase;
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});

describe("leave on time", () => {
  it("leaveAt = pickup − arriveEarlyMin − drive", () => {
    expect(leaveAtOf(new Date("2026-11-05T08:00:00Z"), 900, 10).toISOString()).toBe("2026-11-05T07:35:00.000Z");
  });
  it("3 steps: early (10 min before), on time, then any near driver; a live ride keeps its order; after pickup the nearest first", async () => {
    const now = new Date("2026-11-05T07:30:00Z");
    const trip = { kind: "scheduled", scheduled_at: new Date("2026-11-05T08:00:00Z"), zone_id: "Z-none" } as never;
    const km = (minutes: number) => (DISPATCH.score.pickupKmh * minutes) / 60;
    // 30 min to pickup: early = drive ≤ 20 min, on time = ≤ 30 min.
    const ranked = [{ id: "late", km: km(40) }, { id: "onTime", km: km(25) }, { id: "early", km: km(15) }];
    expect((await smartOrder(database.db, trip, ranked, now)).map((r) => r.id)).toEqual(["early", "onTime", "late"]);
    // Step 2 when nobody is early; step 3 when nobody is on time either.
    expect((await smartOrder(database.db, trip, [ranked[0]!, ranked[1]!], now)).map((r) => r.id)).toEqual(["onTime", "late"]);
    expect((await smartOrder(database.db, trip, [ranked[0]!], now)).map((r) => r.id)).toEqual(["late"]);
    expect((await smartOrder(database.db, { ...(trip as object), kind: "live" } as never, ranked, now)).map((r) => r.id)).toEqual(["late", "onTime", "early"]);
    const after = new Date("2026-11-05T08:05:00Z");
    expect((await smartOrder(database.db, trip, ranked, after)).map((r) => r.id)).toEqual(["late", "onTime", "early"]);
  });
});
