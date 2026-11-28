import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedAreas } from "../../src/areas/seed.js";
import { fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "../e2e/harness.js";
import { PT } from "../areas/area_points.js";

/**
 * v0.18.172 (contract.json#preferredAreas.order / visibility; plan §2.6 preferred_first_order, preferred_none_in_area,
 * preferred_does_not_widen): GET /driver/reservations?scope=open lists rides whose pickup lies in one of his areas first,
 * each group by scheduledAt, with inPreferredArea; none in his areas = every ride by time; a ride hidden by listTo stays
 * hidden inside his area, and homeNear still measures Driver.homeArea. The list is the same <=200 rows as before.
 */
let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let driver: Driver;
let owner: Admin;
const ENDED = ["completed", "cancelled_by_rider", "cancelled_by_admin", "expired", "cancelled_by_system", "no_show", "failed", "cancelled_by_driver"];

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url, now: new Date("2026-11-05T05:00:00Z") });
  await seedAreas(sim.db);
  rider = await sim.rider(0);
  driver = await sim.driver(1, PLACES.nearSergels);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
beforeEach(async () => {
  await sim.db.updateTable("trips").set({ status: "cancelled_by_admin" }).where("status", "not in", ENDED).execute();
  await sim.db.updateTable("drivers").set({ preferred_area_ids: [], home_area: null }).where("driver_id", "=", driver.id).execute();
  await listTo("all");
});

async function listTo(rule: string) {
  await sim.publish(owner, "driver_app_config", "Z001", (doc) => ({ ...doc, reservations: { ...((doc.reservations as Json | undefined) ?? {}), listTo: rule, listHomeKm: 2 } }));
}
const minutes = (m: number) => new Date(sim.clock.now.getTime() + m * 60_000).toISOString();
/** Books a ride `m` minutes ahead, then puts its pickup at `pickup` (the quote's own pickup is Sergels torg). */
async function book(m: number, pickup: { lat: number; lng: number }): Promise<string> {
  const at = minutes(m);
  const quotes = await rider.quote({ categoryIds: ["economy"], kind: "scheduled", scheduledAt: at });
  expect(quotes.status, JSON.stringify(quotes.body)).toBe(201);
  const res = await rider.post("/trips", { quoteId: quotes.body["quotes"][0].quoteId, categoryId: "economy", pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [], kind: "scheduled", scheduledAt: at, paymentMethod: "cash" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await sim.db.updateTable("trips").set({ pickup: JSON.stringify({ address: "test", ...pickup }) }).where("trip_id", "=", res.body["tripId"]).execute();
  return res.body["tripId"];
}
const open = async () => (await driver.get("/driver/reservations?scope=open")).body["items"] as Json[];

describe("preferred areas order the open booked rides", () => {
  it("preferred first (each group by time), then the rest; inPreferredArea on every item", async () => {
    const in10 = await book(4 * 60, PT.medborgarplatsen);
    const out09 = await book(3 * 60, PT.sergels);
    const in11 = await book(5 * 60, PT.medborgarplatsen);
    expect((await driver.put("/driver/preferred-areas", { areaIds: ["SE-SDO-SODERMALM"] })).status).toBe(200);
    const items = await open();
    expect(items.map((i) => i["tripId"])).toEqual([in10, in11, out09]);
    expect(items.map((i) => i["inPreferredArea"])).toEqual([true, true, false]);
  });
  it("an empty list keeps today's order (all by time, none preferred)", async () => {
    const a = await book(4 * 60, PT.medborgarplatsen);
    const b = await book(3 * 60, PT.sergels);
    const items = await open();
    expect(items.map((i) => i["tripId"])).toEqual([b, a]);
    expect(items.every((i) => i["inPreferredArea"] === false)).toBe(true);
  });
  it("none in his areas: the others still show, by time (owner 'show the others')", async () => {
    const a = await book(4 * 60, PT.sergels);
    const b = await book(3 * 60, PT.sergels);
    await driver.put("/driver/preferred-areas", { areaIds: ["SE-K-0181"] });
    const items = await open();
    expect(items.map((i) => i["tripId"])).toEqual([b, a]);
    expect(items.map((i) => i["inPreferredArea"])).toEqual([false, false]);
  });
  it("an area switched off by admin stops counting for the order", async () => {
    const a = await book(4 * 60, PT.medborgarplatsen);
    const b = await book(3 * 60, PT.sergels);
    await driver.put("/driver/preferred-areas", { areaIds: ["SE-SDO-SODERMALM"] });
    await sim.db.updateTable("areas").set({ active: false, updated_at: new Date() }).where("area_id", "=", "SE-SDO-SODERMALM").execute();
    expect((await open()).map((i) => i["tripId"])).toEqual([b, a]);
    await sim.db.updateTable("areas").set({ active: true, updated_at: new Date() }).where("area_id", "=", "SE-SDO-SODERMALM").execute();
  });
  it("scope=accepted keeps time order and carries inPreferredArea", async () => {
    const later = await book(5 * 60, PT.sergels);
    const sooner = await book(4 * 60, PT.medborgarplatsen);
    await driver.put("/driver/preferred-areas", { areaIds: ["SE-SDO-SODERMALM"] });
    for (const id of [later, sooner]) expect((await driver.post(`/driver/reservations/${id}/accept`, {})).status).toBe(200);
    const items = (await driver.get("/driver/reservations?scope=accepted")).body["items"] as Json[];
    expect(items.map((i) => [i["tripId"], i["inPreferredArea"]])).toEqual([[sooner, true], [later, false]]);
  });
});

describe("preferred areas never widen who sees a ride", () => {
  it("listTo homeNear hides a ride in his area when he has no home near it; homeNear still uses home_area", async () => {
    const id = await book(4 * 60, PT.medborgarplatsen);
    await driver.put("/driver/preferred-areas", { areaIds: ["SE-SDO-SODERMALM"] });
    await listTo("homeNear");
    expect((await open()).map((i) => i["tripId"])).not.toContain(id);
    // A home point near the pickup (Driver.homeArea, PUT /driver/home-area, kept) makes it visible again.
    expect((await driver.put("/driver/home-area", { lat: PT.medborgarplatsen.lat, lng: PT.medborgarplatsen.lng })).status).toBe(200);
    const items = await open();
    expect(items.map((i) => i["tripId"])).toContain(id);
    expect(items.find((i) => i["tripId"] === id)!["inPreferredArea"]).toBe(true);
  });
});
