import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedAreas } from "../../src/areas/seed.js";
import { PLACES, Sim, type Admin, type Driver, type Json } from "../e2e/harness.js";

/**
 * v0.18.172 (contract.json#preferredAreas.admin; GM edit 4): GET /admin/areas (zones.read), PATCH /admin/areas/{areaId}
 * (zones.edit, audit line), a zone-scoped admin sees only his zones; the admin driver view shows preferredAreas; the zone
 * setting DriverAppConfig.reservations.preferredAreasMax limits PUT /driver/preferred-areas.
 */
let sim: Sim;
let owner: Admin;
let driver: Driver;
beforeAll(async () => {
  sim = await Sim.start({ now: new Date("2026-11-28T10:00:00Z") });
  await seedAreas(sim.db);
  owner = await sim.owner();
  driver = await sim.driver(0, PLACES.nearSergels);
  await sim.db.updateTable("drivers").set({ zone_ids: ["Z001"] }).where("driver_id", "=", driver.id).execute();
});
afterAll(async () => {
  await sim.stop();
});
const patch = (admin: Admin, id: string, body: Json, key: string) => sim.request("PATCH", `/admin/areas/${id}`, admin.token, body, { key });

describe("admin areas", () => {
  it("lists a zone's areas with source, licence and the derived flag, paged", async () => {
    const res = await owner.get("/admin/areas?zoneId=Z001");
    expect(res.status).toBe(200);
    expect(res.body["items"]).toHaveLength(37);
    expect(res.body["nextCursor"]).toBeNull();
    expect(res.body["items"].find((a: Json) => a.areaId === "SE-SDO-SODERMALM")).toMatchObject({ derived: true, source: "SCB RegSO 2025", licence: "CC0", active: true, nameOverride: null });
    const fr = await owner.get("/admin/areas?zoneId=FR-PC");
    expect(fr.body["items"]).toHaveLength(100);
    expect(typeof fr.body["nextCursor"]).toBe("string");
    expect((await owner.get("/admin/areas?zoneId=FR-PC&q=juvisy")).body["items"].map((a: Json) => a.areaId)).toEqual(["FR-C-91326"]);
  });
  it("switches an area off and renames it, with an audit line; the driver search follows", async () => {
    const res = await patch(owner, "SE-K-0181", { active: false, nameOverride: "Södertälje stad" }, "8a1b2c3d-0000-4000-8000-000000000001");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ areaId: "SE-K-0181", active: false, name: "Södertälje stad", officialName: "Södertälje" });
    expect((await driver.get("/driver/areas/search?q=sodertalje")).body["items"]).toEqual([]);
    const audit = await sim.db.selectFrom("admin_audit").select(["action", "target_id"]).where("action", "=", "area.update").execute();
    expect(audit).toEqual([{ action: "area.update", target_id: "SE-K-0181" }]);
    expect((await patch(owner, "SE-K-0181", { active: true, nameOverride: null }, "8a1b2c3d-0000-4000-8000-000000000002")).body).toMatchObject({ active: true, name: "Södertälje" });
  });
  it("a zone-scoped admin sees and changes only his zones; a viewer cannot edit", async () => {
    const paris = await sim.admin("super", ["FR-PC"]);
    expect((await paris.get("/admin/areas?zoneId=Z001")).body).toMatchObject({ reason: "zone_out_of_scope" });
    expect(((await paris.get("/admin/areas")).body["items"] as Json[]).every((a) => a.zoneId === "FR-PC")).toBe(true);
    expect((await patch(paris, "SE-K-0181", { active: false }, "8a1b2c3d-0000-4000-8000-000000000003")).body).toMatchObject({ reason: "zone_out_of_scope" });
    const viewer = await sim.admin("viewer");
    expect((await viewer.get("/admin/areas?zoneId=Z001")).status).toBe(200);
    expect((await patch(viewer, "SE-K-0181", { active: false }, "8a1b2c3d-0000-4000-8000-000000000004")).body).toMatchObject({ reason: "missing_permission" });
  });
  it("the admin driver view shows his preferred areas", async () => {
    await driver.put("/driver/preferred-areas", { areaIds: ["SE-SDO-SODERMALM"] });
    const res = await owner.get(`/admin/drivers/${driver.id}`);
    expect(res.body["preferredAreaIds"]).toEqual(["SE-SDO-SODERMALM"]);
    expect(res.body["preferredAreas"][0]).toMatchObject({ areaId: "SE-SDO-SODERMALM", name: "Södermalm", kind: "stadsdelsomrade" });
  });
  it("the zone setting preferredAreasMax limits the driver's list", async () => {
    await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...((doc.reservations as Json | undefined) ?? {}), preferredAreasMax: 2 } }));
    const res = await driver.put("/driver/preferred-areas", { areaIds: ["SE-K-0181", "SE-K-0184", "SE-K-0186"] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: "too_many_areas", details: ["max:2"] });
    expect((await driver.put("/driver/preferred-areas", { areaIds: ["SE-K-0181", "SE-K-0184"] })).status).toBe(200);
  });
});
