import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCoversAllCountries } from "../../src/auth/guard.js";
import { googleDay } from "../../src/maps/googleBudget.js";
import { adminSession } from "../support/admin.js";
import { freshDatabase, type TestDatabase } from "../support/db.js";
import { call, testWorld } from "../support/world.js";

/**
 * v0.18.171 (contract.json#googleRoadLines.budgetSetting): GET /admin/maps/google-budget (settings.read) and PUT
 * (settings.publish + an admin who covers every country: adminCoversAllCountries next to adminCoversZone).
 */
let database: TestDatabase;
let app: FastifyInstance;
const clock = { now: new Date("2026-11-27T20:00:00Z") };
beforeAll(async () => {
  database = await freshDatabase();
  app = await testWorld(database.db, database.url, clock);
});
afterAll(async () => {
  await app.close();
  await database.drop();
});

describe("GET / PUT /admin/maps/google-budget (v0.18.171)", () => {
  it("GET answers the defaults and today's counts with nothing saved", async () => {
    const admin = await adminSession(app, database.db, "config", { now: clock.now });
    await database.db.insertInto("google_route_calls_daily").values([{ day: googleDay(clock.now), country: "SE", kind: "quote", calls: 7 }, { day: googleDay(clock.now), country: "FR", kind: "road_line", calls: 3 }]).execute();
    const res = await call(app, "GET", "/admin/maps/google-budget", admin.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ dailyLimit: 2000, quotesPerDay: 1400, roadLinesPerDay: 600, today: { day: "2026-11-27", quotes: 7, roadLines: 3 } });
  });

  it("PUT by an all-countries admin saves it (audited); quotesPerDay above dailyLimit is 400 invalid_budget", async () => {
    const admin = await adminSession(app, database.db, "config", { now: clock.now });
    const res = await call(app, "PUT", "/admin/maps/google-budget", admin.headers, { dailyLimit: 3000, quotesPerDay: 2000 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ dailyLimit: 3000, quotesPerDay: 2000, roadLinesPerDay: 1000 });
    expect((await call(app, "GET", "/admin/maps/google-budget", admin.headers)).json()).toMatchObject({ dailyLimit: 3000, quotesPerDay: 2000 });
    const audit = await database.db.selectFrom("admin_audit").select(["action", "admin_id"]).where("action", "=", "google_budget.publish").execute();
    expect(audit).toEqual([{ action: "google_budget.publish", admin_id: admin.adminId }]);
    const bad = await call(app, "PUT", "/admin/maps/google-budget", admin.headers, { dailyLimit: 1000, quotesPerDay: 1001 });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain("invalid_budget");
    const low = await call(app, "PUT", "/admin/maps/google-budget", admin.headers, { dailyLimit: 99, quotesPerDay: 0 });
    expect(low.statusCode).toBe(400);
  });

  it("admin scoped to SE only gets 403 on PUT, 200 on GET", async () => {
    const seZones = (await database.db.selectFrom("zones").select("zone_id").where("country", "=", "SE").execute()).map((z) => z.zone_id);
    const se = await adminSession(app, database.db, "config", { zoneIds: seZones, now: clock.now });
    const put = await call(app, "PUT", "/admin/maps/google-budget", se.headers, { dailyLimit: 2000, quotesPerDay: 1400 });
    expect(put.statusCode).toBe(403);
    expect(put.body).toContain("not_all_countries");
    expect((await call(app, "GET", "/admin/maps/google-budget", se.headers)).statusCode).toBe(200);
    expect(await adminCoversAllCountries(database.db, { actor: "admin", subjectId: "x", sessionId: "s", zones: seZones })).toBe(false);
    expect(await adminCoversAllCountries(database.db, { actor: "admin", subjectId: "x", sessionId: "s", zones: ["*"] })).toBe(true);
  });

  it("an admin without settings.read gets 403 on GET", async () => {
    const viewer = await adminSession(app, database.db, "viewer", { now: clock.now });
    expect((await call(app, "GET", "/admin/maps/google-budget", viewer.headers)).statusCode).toBe(403);
  });
});
