import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { seedAreas } from "../../src/areas/seed.js";
import { PLACES, Sim, type Driver, type Json } from "../e2e/harness.js";
import { PT } from "./area_points.js";

/**
 * v0.18.172 (contract.json#preferredAreas.at; plan §2.6 area_at): GET /driver/areas/at answers the smallest active area of
 * the driver's zones that holds the point (a district beats its kommun, an arrondissement beats Paris and 75, a commune
 * beats its département); no area = 200 { area: null, containing: [] }; bad point = 400 invalid_point; nothing written,
 * and the point is never in the log at any level (GM edit 2).
 */
let sim: Sim;
let driver: Driver;
beforeAll(async () => {
  sim = await Sim.start({ now: new Date("2026-11-28T10:00:00Z") });
  await seedAreas(sim.db);
  driver = await sim.driver(0, PLACES.nearSergels);
  // Both seeded zones, so the Paris points can be asked too.
  await sim.db.updateTable("drivers").set({ zone_ids: ["Z001", "FR-PC"] }).where("driver_id", "=", driver.id).execute();
});
afterAll(async () => {
  await sim.stop();
});
const at = async (p: { lat: number; lng: number }) => driver.get(`/driver/areas/at?lat=${p.lat}&lng=${p.lng}`);
const ids = (b: Json) => (b["containing"] as Json[]).map((a) => a["areaId"]);

describe("GET /driver/areas/at", () => {
  it("a point in Södermalm: the district, then its kommun", async () => {
    const res = await at(PT.medborgarplatsen);
    expect(res.status).toBe(200);
    expect(res.body["area"]).toMatchObject({ areaId: "SE-SDO-SODERMALM", name: "Södermalm", kind: "stadsdelsomrade", zoneId: "Z001", parentName: "Stockholm" });
    expect(ids(res.body)).toEqual(["SE-SDO-SODERMALM", "SE-K-0180"]);
    expect(JSON.stringify(res.body)).not.toContain("polygon");
  });
  it("Paris 4e beats the city of Paris and département 75", async () => {
    const res = await at(PT.paris4);
    expect(res.body["area"]["areaId"]).toBe("FR-A-75104");
    expect(ids(res.body)).toEqual(["FR-A-75104", "FR-CITY-PARIS", "FR-D-75"]);
  });
  it("Juvisy-sur-Orge: the commune beats département 91", async () => {
    const res = await at(PT.juvisy);
    expect(res.body["area"]).toMatchObject({ areaId: "FR-C-91326", name: "Juvisy-sur-Orge", kind: "commune" });
    expect(ids(res.body)).toEqual(["FR-C-91326", "FR-D-91"]);
  });
  it("Södertälje: the kommun", async () => {
    expect((await at(PT.sodertalje)).body["area"]).toMatchObject({ areaId: "SE-K-0181", name: "Södertälje", kind: "kommun" });
  });
  it("the sea, Göteborg and Lyon: 200 with no area", async () => {
    for (const p of [PT.sea, PT.goteborg, PT.lyon]) {
      const res = await at(p);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ area: null, containing: [] });
    }
  });
  it("an area of another zone or switched off is never returned", async () => {
    await sim.db.updateTable("drivers").set({ zone_ids: ["Z001"] }).where("driver_id", "=", driver.id).execute();
    expect((await at(PT.paris4)).body).toEqual({ area: null, containing: [] });
    await sim.db.updateTable("areas").set({ active: false }).where("area_id", "=", "SE-SDO-SODERMALM").execute();
    expect((await at(PT.medborgarplatsen)).body["area"]["areaId"]).toBe("SE-K-0180");
    await sim.db.updateTable("areas").set({ active: true }).where("area_id", "=", "SE-SDO-SODERMALM").execute();
    await sim.db.updateTable("drivers").set({ zone_ids: ["Z001", "FR-PC"] }).where("driver_id", "=", driver.id).execute();
  });
  it("a bad or missing lat / lng is 400 invalid_point", async () => {
    for (const q of ["", "?lat=59.3", "?lng=18", "?lat=abc&lng=18", "?lat=91&lng=18", "?lat=59&lng=181", "?lat=&lng="]) {
      const res = await driver.get(`/driver/areas/at${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body).toMatchObject({ code: "invalid_request", reason: "invalid_point" });
    }
  });
  it("writes nothing to the database", async () => {
    const counts = async () => (await sim.db.selectFrom("areas").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n + "/" + (await sim.db.selectFrom("drivers").select(["preferred_area_ids", "home_area"]).where("driver_id", "=", driver.id).executeTakeFirstOrThrow()).preferred_area_ids.join(",");
    const before = await counts();
    await at(PT.medborgarplatsen);
    expect(await counts()).toBe(before);
  });
  it("the point never reaches the server log, at any level (trace)", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk, _e, done) => (lines.push(String(chunk)), done()) });
    // The same secret as the running sim, so the driver's token is valid and the handler really runs.
    const env = { ...sim.env, LOG_LEVEL: "trace" as const };
    const app = await buildApp({ env, logger: { stream }, db: sim.db, clock: () => sim.clock.now });
    try {
      const ok = await app.inject({ method: "GET", url: "/api/v1/driver/areas/at?lat=59.31437&lng=18.07357", headers: { authorization: `Bearer ${driver.token}`, "x-api-version": "0.5" } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()["area"]["areaId"]).toBe("SE-SDO-SODERMALM");
      const bad = await app.inject({ method: "GET", url: "/api/v1/driver/areas/at?lat=59.31437&lng=999.07357", headers: { authorization: `Bearer ${driver.token}`, "x-api-version": "0.5" } });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
    const log = lines.join("");
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain("59.31437");
    expect(log).not.toContain("18.07357");
  });
});
