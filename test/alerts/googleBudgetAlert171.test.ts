import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findCauses } from "../../src/alerts/detector.js";
import { googleDay } from "../../src/maps/googleBudget.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";

/**
 * v0.18.171 (contract.json#googleRoadLines.budgetAlert): system_health:google_routes_budget:<CC> in every country's
 * book: important (the warning) when today's road-line calls, all countries together, reach 600; critical at 2,000 calls
 * in all. A new Los Angeles day clears it.
 */
let database: TestDatabase;
const now = new Date("2026-11-27T20:00:00Z");
beforeAll(async () => {
  database = await freshDatabase();
});
afterAll(async () => {
  await database.drop();
});
beforeEach(async () => {
  await database.db.deleteFrom("google_route_calls_daily").execute();
});
const used = (country: string, kind: "quote" | "road_line", calls: number) => database.db.insertInto("google_route_calls_daily").values({ day: googleDay(now), country, kind, calls }).execute();
const budget = async (at = now) => (await findCauses(database.db, at)).filter((c) => c.key.startsWith("system_health:google_routes_budget"));

describe("the Google budget alert (v0.18.171)", () => {
  it("599 road-line calls: none; 600 (SE + FR): the warning in every country's book", async () => {
    await used("SE", "road_line", 400);
    await used("FR", "road_line", 199);
    expect(await budget()).toEqual([]);
    await database.db.updateTable("google_route_calls_daily").set({ calls: 200 }).where("country", "=", "FR").execute();
    const alerts = await budget();
    const countries = [...new Set((await database.db.selectFrom("zones").select("country").execute()).map((z) => z.country))].sort();
    expect(alerts.map((c) => c.key).sort()).toEqual(countries.map((c) => `system_health:google_routes_budget:${c}`));
    for (const a of alerts) expect(a).toMatchObject({ kind: "system_health", level: "important", zoneId: null });
  });

  it("2,000 calls in all: critical; the next Los Angeles day: gone", async () => {
    await used("SE", "quote", 1400);
    await used("FR", "road_line", 600);
    const alerts = await budget();
    expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) expect(a.level).toBe("critical");
    expect(await budget(new Date("2026-11-28T08:30:00Z"))).toEqual([]);
  });
});
