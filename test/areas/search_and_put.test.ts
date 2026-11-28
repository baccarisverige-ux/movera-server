import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedAreas } from "../../src/areas/seed.js";
import { PLACES, Sim, type Driver, type Json } from "../e2e/harness.js";

/**
 * v0.18.172 (contract.json#preferredAreas.search / put; plan §2.6 search_only_areas + preferred_areas_put):
 * the search answers areas of his zones only (never an address), accents ignored; PUT saves several ids, dedupes,
 * refuses too many (400 too_many_areas) and unknown / inactive / other-zone ids (400 area_not_found), replays by key.
 */
let sim: Sim;
let driver: Driver;
beforeAll(async () => {
  sim = await Sim.start({ now: new Date("2026-11-28T10:00:00Z") });
  await seedAreas(sim.db);
  driver = await sim.driver(0, PLACES.nearSergels);
  await sim.db.updateTable("drivers").set({ zone_ids: ["Z001"] }).where("driver_id", "=", driver.id).execute();
});
afterAll(async () => {
  await sim.stop();
});
const names = (b: Json) => (b["items"] as Json[]).map((a) => a["name"]);

describe("GET /driver/areas/search", () => {
  it("'söd' finds Södermalm and Södertälje first, areas only, in his zone only", async () => {
    const res = await driver.get("/driver/areas/search?q=s%C3%B6d");
    expect(res.status).toBe(200);
    expect(names(res.body).slice(0, 2).sort()).toEqual(["Södermalm", "Södertälje"]);
    for (const a of res.body["items"] as Json[]) {
      expect(Object.keys(a).sort()).toEqual(expect.arrayContaining(["areaId", "name", "kind", "kindLabel", "zoneId", "country"]));
      expect(a["zoneId"]).toBe("Z001");
      expect(["kommun", "stadsdelsomrade"]).toContain(a["kind"]);
      expect(a).not.toHaveProperty("polygons");
    }
  });
  it("accents and case are ignored ('SODER' = 'Söder')", async () => {
    expect(names((await driver.get("/driver/areas/search?q=SODER")).body)).toContain("Södermalm");
  });
  it("another zone's areas are hidden (Paris from a Stockholm driver)", async () => {
    expect((await driver.get("/driver/areas/search?q=paris")).body["items"]).toEqual([]);
    expect((await driver.get("/driver/areas/search?q=juvisy")).body["items"]).toEqual([]);
  });
  it("an address-like text finds no address (areas only)", async () => {
    const res = await driver.get("/driver/areas/search?q=" + encodeURIComponent("Klockarvägen 37"));
    expect(res.status).toBe(200);
    expect(res.body["items"]).toEqual([]);
  });
  it("an empty q lists his zone's areas A-Z, at most limit", async () => {
    const res = await driver.get("/driver/areas/search?limit=5");
    expect(res.body["items"]).toHaveLength(5);
    expect(names(res.body)).toEqual([...names(res.body)].sort((a, b) => a.localeCompare(b, "sv")));
  });
});

describe("PUT /driver/preferred-areas", () => {
  it("saves several ids (deduped, order kept) and the driver view names them", async () => {
    const res = await driver.put("/driver/preferred-areas", { areaIds: ["SE-SDO-SODERMALM", "SE-K-0181", "SE-SDO-SODERMALM"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body["preferredAreaIds"]).toEqual(["SE-SDO-SODERMALM", "SE-K-0181"]);
    expect((res.body["preferredAreas"] as Json[]).map((a) => a["name"])).toEqual(["Södermalm", "Södertälje"]);
    expect((await driver.get("/driver/profile")).body["preferredAreaIds"]).toEqual(["SE-SDO-SODERMALM", "SE-K-0181"]);
  });
  it("more than preferredAreasMax ids: 400 too_many_areas, nothing saved", async () => {
    const all = ((await driver.get("/driver/areas/search?limit=20")).body["items"] as Json[]).map((a) => a["areaId"]);
    const res = await driver.put("/driver/preferred-areas", { areaIds: all.slice(0, 11) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_request", reason: "too_many_areas" });
    expect((await driver.get("/driver/profile")).body["preferredAreaIds"]).toEqual(["SE-SDO-SODERMALM", "SE-K-0181"]);
  });
  it("unknown, inactive or other-zone ids: 400 area_not_found", async () => {
    await sim.db.updateTable("areas").set({ active: false }).where("area_id", "=", "SE-K-0186").execute();
    for (const id of ["SE-K-9999", "SE-K-0186", "FR-A-75104"]) {
      const res = await driver.put("/driver/preferred-areas", { areaIds: [id] });
      expect(res.status, id).toBe(400);
      expect(res.body).toMatchObject({ reason: "area_not_found", details: [`areaId:${id}`] });
    }
    await sim.db.updateTable("areas").set({ active: true }).where("area_id", "=", "SE-K-0186").execute();
  });
  it("only area ids are accepted: an address or a point in the body is refused", async () => {
    const res = await driver.put("/driver/preferred-areas", { areaIds: ["SE-K-0181"], address: "Klockarvägen 37", lat: 59.19, lng: 17.62 });
    expect(res.status).toBe(400);
  });
  it("the same Idempotency-Key replays the first answer", async () => {
    const a = await sim.request("PUT", "/driver/preferred-areas", driver.token, { areaIds: ["SE-K-0184"] }, { key: "0d6f3a52-6c0e-4c11-9b55-1f2a3b4c5d6e" });
    const b = await sim.request("PUT", "/driver/preferred-areas", driver.token, { areaIds: ["SE-K-0184"] }, { key: "0d6f3a52-6c0e-4c11-9b55-1f2a3b4c5d6e" });
    expect(a.status).toBe(200);
    expect(b.body["preferredAreaIds"]).toEqual(a.body["preferredAreaIds"]);
  });
  it("[] clears the list", async () => {
    const res = await driver.put("/driver/preferred-areas", { areaIds: [] });
    expect(res.body["preferredAreaIds"]).toEqual([]);
    expect(res.body["preferredAreas"]).toEqual([]);
  });
});
