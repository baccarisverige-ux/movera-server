import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

/** Contract v0.11.0 §20 zones from the server (owner 2026-10-28, decision #9). */

let sim: Sim;
let rider: Rider;
let driver: Driver;
let owner: Admin;

beforeAll(async () => {
  sim = await Sim.start();
  rider = await sim.rider(0);
  driver = await sim.driver(1, null);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
});

const names = { sv: "Lyon centrum", fr: "Lyon centre", en: "Lyon centre" };
const lyon = [[45.79, 4.78], [45.79, 4.92], [45.71, 4.92], [45.71, 4.78]];
const zoneOf = async (admin: Admin, zoneId: string): Promise<Json> => ((await admin.get("/admin/zones")).body["zones"] as Json[]).find((z) => z["zoneId"] === zoneId)!;
const GARE_DE_LYON = { address: "Gare de Lyon", lat: 48.8443, lng: 2.3744 };
const CONCORDE = { address: "Place de la Concorde", lat: 48.8656, lng: 2.3212 };

describe("seed (migration 0027)", () => {
  it("Paris & Île-de-France, CDG, ORY and Grand Tunis exist, closed, with names and outlines", async () => {
    const res = await owner.get("/admin/zones");
    expect(res.status).toBe(200);
    const byId = new Map((res.body["zones"] as Json[]).map((z) => [z["zoneId"], z]));
    expect(byId.get("FR-PC")).toMatchObject({ names: { sv: "Paris & Île-de-France", fr: "Paris & Île-de-France", en: "Paris & Île-de-France" }, country: "FR", currency: "EUR", timeZone: "Europe/Paris", kind: "operating", open: false, version: 1, bounds: { south: 48.12, west: 1.45, north: 49.24, east: 3.56 } });
    expect(byId.get("FR-PC")!["polygon"].length).toBeGreaterThan(10);
    expect(byId.get("CDG")).toMatchObject({ kind: "airport", open: false, country: "FR" });
    expect(byId.get("ORY")).toMatchObject({ kind: "airport", open: false, country: "FR" });
    expect(byId.get("TN-TC")).toMatchObject({ names: { fr: "Grand Tunis" }, country: "TN", currency: "TND", timeZone: "Africa/Tunis", open: false });
    // Existing zones keep their rectangle as their outline and get names.
    expect(byId.get("Z001")).toMatchObject({ names: { sv: "Stockholm län", en: "Stockholm County" }, open: true });
    expect(byId.get("Z001")!["polygon"]).toHaveLength(4);
  });

  it("the apps get only the open zones", async () => {
    const all = (await rider.get("/rider/zones")).body["zones"] as Json[];
    expect(all.every((z) => z["open"] === true)).toBe(true);
    expect(all.map((z) => z["zoneId"])).toContain("Z001");
    expect(all.map((z) => z["zoneId"])).not.toContain("FR-PC");
    expect((await driver.get("/driver/zones?country=FR")).body).toEqual({ zones: [] });
    expect((await rider.get("/rider/zones?country=fr")).status).toBe(400);
  });
});

describe("not here yet", () => {
  it("a pickup in a closed zone or no zone gets no price; opened, Paris prices; booking a quote of a zone closed since is refused", async () => {
    const closed = await rider.quote({ pickup: CONCORDE, dropoff: GARE_DE_LYON });
    expect(closed.status).toBe(403);
    expect(closed.body).toMatchObject({ code: "forbidden", reason: "service_not_available" });
    // Inside the FR-PC rectangle, outside the region's outline (near Chartres).
    const corner = await rider.quote({ pickup: { address: "Near Chartres", lat: 48.45, lng: 1.5 }, dropoff: GARE_DE_LYON });
    expect(corner.body).toMatchObject({ reason: "service_not_available" });

    const zone = await zoneOf(owner, "Z001");
    const quotes = await rider.quote({ categoryIds: ["economy"] });
    expect(quotes.status).toBe(201);
    const closing = await owner.post("/admin/zones/Z001/close", { expectedVersion: zone["version"] });
    expect(closing.status).toBe(200);
    const q = quotes.body["quotes"][0];
    const book = await rider.post("/trips", { quoteId: q.quoteId, categoryId: "economy", pickup: { address: "Sergels torg", lat: 59.3326, lng: 18.0649 }, dropoff: { address: "Medborgarplatsen", lat: 59.3143, lng: 18.0735 }, stops: [], kind: "live", paymentMethod: "cash" });
    expect(book.status).toBe(403);
    expect(book.body).toMatchObject({ reason: "service_not_available" });
    const reopened = await owner.post("/admin/zones/Z001/open", { expectedVersion: closing.body["version"] });
    expect(reopened.body).toMatchObject({ open: true, version: zone["version"] + 2 });
  });
});

describe("admin", () => {
  it("creates a zone closed, with bounds and center from the outline, audited; the id is taken once", async () => {
    const res = await owner.post("/admin/zones", { zoneId: "FR-LY", names, country: "FR", currency: "EUR", timeZone: "Europe/Paris", polygon: lyon });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ zoneId: "FR-LY", names, open: false, kind: "operating", version: 1, bounds: { south: 45.71, west: 4.78, north: 45.79, east: 4.92 }, updatedBy: owner.id });
    expect(res.body["center"]["lat"]).toBeCloseTo(45.75);
    expect((await owner.post("/admin/zones", { zoneId: "FR-LY", names, country: "FR", currency: "EUR", timeZone: "Europe/Paris", polygon: lyon })).body).toMatchObject({ code: "conflict", reason: "zone_exists" });
    const audit = await sim.db.selectFrom("admin_audit").select(["action", "target_id"]).where("action", "like", "zone.%").execute();
    expect(audit).toContainEqual({ action: "zone.create", target_id: "FR-LY" });
  });

  it("refuses bad zones", async () => {
    const base = { zoneId: "FR-XX", names, country: "FR", currency: "EUR", timeZone: "Europe/Paris", polygon: lyon };
    const cases: Array<[Json, string | undefined]> = [
      [{ names: { sv: "a", fr: "b" } }, undefined],
      [{ polygon: lyon.slice(0, 2) }, undefined],
      [{ polygon: [...lyon, lyon[0]] }, "polygon_closed"],
      [{ polygon: [[45.79, 4.78], [45.71, 4.92], [45.79, 4.92], [45.71, 4.78]] }, "polygon_self_crossing"],
      [{ polygon: [[95, 4.78], [45.79, 4.92], [45.71, 4.92]] }, undefined],
      [{ currency: "SEK" }, "currency_not_country"],
      [{ kind: "city" }, undefined],
    ];
    for (const [change, reason] of cases) {
      const res = await owner.post("/admin/zones", { ...base, ...change });
      expect(res.status, JSON.stringify(change)).toBe(400);
      if (reason) expect(res.body["reason"]).toBe(reason);
    }
  });

  it("edits names and outline with expectedVersion; country, currency and timeZone never change", async () => {
    const zone = await zoneOf(owner, "FR-LY");
    const moved = [[45.8, 4.75], [45.8, 4.95], [45.7, 4.95], [45.7, 4.75], [45.75, 4.7]];
    const res = await owner.put("/admin/zones/FR-LY", { expectedVersion: zone["version"], polygon: moved, names: { ...names, en: "Greater Lyon" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: zone["version"] + 1, names: { en: "Greater Lyon" }, bounds: { south: 45.7, west: 4.7, north: 45.8, east: 4.95 } });
    const stale = await owner.put("/admin/zones/FR-LY", { expectedVersion: zone["version"], kind: "airport" });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "version_mismatch", projection: { zoneId: "FR-LY", version: zone["version"] + 1 } });
    expect((await owner.put("/admin/zones/FR-LY", { expectedVersion: res.body["version"], currency: "SEK" })).body).toMatchObject({ reason: "zone_field_fixed" });
    expect((await owner.put("/admin/zones/NOPE", { expectedVersion: 1, kind: "airport" })).status).toBe(404);
  });

  it("opens and closes (never deletes), each audited and sent as config_published", async () => {
    let zone = await zoneOf(owner, "FR-LY");
    const opened = await owner.post("/admin/zones/FR-LY/open", { expectedVersion: zone["version"], note: "test" });
    expect(opened.body).toMatchObject({ open: true });
    expect(((await rider.get("/rider/zones?country=FR")).body["zones"] as Json[]).map((z) => z["zoneId"])).toEqual(["FR-LY"]);
    zone = opened.body;
    const closed = await owner.post("/admin/zones/FR-LY/close", { expectedVersion: zone["version"] });
    expect(closed.body).toMatchObject({ open: false, version: zone["version"] + 1 });
    expect((await owner.post("/admin/zones/FR-LY/close", { expectedVersion: zone["version"] })).status).toBe(409);
    expect((await rider.get("/rider/zones?country=FR")).body["zones"]).toEqual([]);
    expect(await zoneOf(owner, "FR-LY")).toBeDefined();
    const actions = (await sim.db.selectFrom("admin_audit").select("action").where("target_id", "=", "FR-LY").execute()).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["zone.create", "zone.update", "zone.open", "zone.close"]));
  });

  it("scope: an admin sees and changes only its zones, creates only in a country it has a zone in; zones.edit is needed", async () => {
    const paris = await sim.admin("config", ["FR-PC"]);
    expect(((await paris.get("/admin/zones")).body["zones"] as Json[]).map((z) => z["zoneId"])).toEqual(["FR-PC"]);
    const fr = await zoneOf(owner, "FR-PC");
    expect((await paris.post("/admin/zones/Z001/close", { expectedVersion: 1 })).body).toMatchObject({ reason: "zone_out_of_scope" });
    expect((await paris.post("/admin/zones", { zoneId: "TN-SF", names, country: "TN", currency: "TND", timeZone: "Africa/Tunis", polygon: [[34.8, 10.7], [34.8, 10.8], [34.7, 10.8]] })).body).toMatchObject({ reason: "zone_out_of_scope" });
    const made = await paris.post("/admin/zones", { zoneId: "FR-MA", names, country: "FR", currency: "EUR", timeZone: "Europe/Paris", polygon: [[43.4, 5.3], [43.4, 5.5], [43.2, 5.5]] });
    expect(made.status).toBe(201);
    const renamed = await paris.put("/admin/zones/FR-PC", { expectedVersion: fr["version"], names: { sv: "Paris", fr: "Paris", en: "Paris" } });
    expect(renamed.status).toBe(200);
    const viewer = await sim.admin("viewer");
    expect((await viewer.get("/admin/zones")).status).toBe(200);
    expect((await viewer.post("/admin/zones/FR-PC/open", { expectedVersion: renamed.body["version"] })).body).toMatchObject({ reason: "missing_permission" });
  });
});
