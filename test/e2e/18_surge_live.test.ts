import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";
import { freeDriversIn, runSmartSurge } from "../../src/pricing/surge.js";
import { surgeLevel } from "../../src/pricing/surgeLive.js";
import { readFileSync } from "node:fs";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";

/**
 * Contract v0.7.2, owner Pricing answers of 2026-10-28: smart surge counts only free drivers inside the zone now;
 * one SurgeSample per zone and minute feeds the admin's Surge tab (surge now, demand chart, rider price check, surge
 * timeline); the driver's Home map gets coloured zones (a level, never the multiplier); one admin is enough.
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;
let owner: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, PLACES.atSea);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

const check = () => sim.db.transaction().execute((trx) => runSmartSurge(trx, sim.clock.now));
const flat = (m: number, minutes: number, expectedVersion = 0) => ({
  expectedVersion,
  startAt: sim.clock.now.toISOString(),
  endAt: new Date(sim.clock.now.getTime() + minutes * 60_000).toISOString(),
  points: [{ atMin: 0, multiplier: m }, { atMin: minutes, multiplier: m }],
});

describe("free drivers (contract.json#smartSurge.ratio)", () => {
  it("counts only online drivers whose fresh GPS fix is inside the zone", async () => {
    // a is near Sergels torg (Z001); b is online far out at sea.
    expect(await freeDriversIn(sim.db, "Z001", sim.clock.now)).toBe(1);
    await b.moveTo(PLACES.odenplan);
    expect(await freeDriversIn(sim.db, "Z001", sim.clock.now)).toBe(2);
    // A fix that reached the server more than 120 s ago does not count.
    await sim.db.updateTable("driver_locations").set({ received_at: new Date(sim.clock.now.getTime() - 121_000) }).where("driver_id", "=", b.id).execute();
    expect(await freeDriversIn(sim.db, "Z001", sim.clock.now)).toBe(1);
    await b.moveTo(PLACES.odenplan);
    expect(await freeDriversIn(sim.db, "Z001", sim.clock.now)).toBe(2);
    await b.moveTo(PLACES.atSea);
    expect(await freeDriversIn(sim.db, "Z001", sim.clock.now)).toBe(1);
  });
});

describe("the Surge tab's real data (contract.json#surgeLive)", () => {
  it("serves the surge now, the demand chart, the rider price check and the timeline from the samples", async () => {
    await check();
    const before = await owner.get("/admin/surge/now?zoneIds=Z001");
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.zones, JSON.stringify(before.body)).toEqual([expect.objectContaining({ zoneId: "Z001", multiplier: 1, source: "off", freeDrivers: 1 })]);

    // One admin is enough (v0.7.2): an ops admin starts a surge at once.
    const ops = await sim.admin("ops", ["Z001"]);
    const started = await ops.put("/admin/zones/Z001/surge", flat(2, 120));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await sim.advance(60);
    await a.moveTo(PLACES.nearSergels);
    await check();
    // A rider sees the surge price and leaves without booking.
    expect((await rider.quote({ categoryIds: ["economy"] })).body["quotes"][0].surgeMultiplier).toBe(2);
    const now = (await owner.get("/admin/surge/now")).body.zones.find((z: Json) => z["zoneId"] === "Z001");
    expect(now).toMatchObject({ multiplier: 2, source: "manual", scheduleId: started.body.scheduleId });

    // 31 minutes later the start's effect is known; then the admin stops the surge.
    for (let i = 0; i < 31; i++) {
      await sim.advance(60);
      await a.moveTo(PLACES.nearSergels);
      await check();
    }
    const stopped = await ops.post("/admin/zones/Z001/surge/end", { expectedVersion: started.body.version });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    await sim.advance(60);
    await check();

    const history = await owner.get("/admin/zones/Z001/surge/history?hours=2&bucketMin=10");
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(history.body.bucketMin).toBe(10);
    expect(history.body.points.length).toBeGreaterThan(2);
    expect(Math.max(...history.body.points.map((p: Json) => p["multiplier"]))).toBe(2);
    expect(history.body.points.every((p: Json) => p["freeDrivers"] === 1)).toBe(true);
    // The quote was made 33 minutes ago: it is in the last hour's price check.
    expect(history.body.priceCheck).toEqual({ windowMin: 60, saw: 1, left: 1, leftPct: 100 });
    const kinds = history.body.timeline.map((item: Json) => item["kind"]);
    expect(kinds).toEqual(["manual_stop", "manual_start"]);
    const start = history.body.timeline[1];
    expect(start).toMatchObject({ multiplier: 2, previous: 1, by: ops.id, effect: { drivers: 0, ridesPct: 0, leftPct: 100 } });

    expect((await owner.get("/admin/zones/Z001/surge/history?bucketMin=7")).status).toBe(400);
    const elsewhere = await sim.admin("ops", ["Z002"]);
    expect((await elsewhere.get("/admin/zones/Z001/surge/history")).status).toBe(403);
    expect((await elsewhere.get("/admin/surge/now")).body.zones.some((z: Json) => z["zoneId"] === "Z001")).toBe(false);
  }, 60_000);
});

describe("the driver's surge map (contract.json#driverSurgeMap)", () => {
  it("colours the zones with a surge by level, never with the multiplier", async () => {
    for (const { multiplier, level } of JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/surge_levels.json`, "utf8")).cases) expect(surgeLevel(multiplier)).toBe(level);
    // Only Z001 matters here: another test file may leave a surge in another zone of the shared database.
    expect(((await a.get("/driver/surge-map")).body.zones as Json[]).some((z) => z["zoneId"] === "Z001")).toBe(false);
    const high = await owner.put("/admin/zones/Z001/surge", flat(3, 30));
    expect(high.status, JSON.stringify(high.body)).toBe(200);
    const map = await a.get("/driver/surge-map");
    expect(map.status).toBe(200);
    expect((map.body.zones as Json[]).filter((z) => z["zoneId"] === "Z001")).toEqual([{ zoneId: "Z001", level: "high", bounds: expect.objectContaining({ south: expect.any(Number), west: expect.any(Number), north: expect.any(Number), east: expect.any(Number) }) }]);
    expect(JSON.stringify(map.body)).not.toMatch(/multiplier|"3"|×/);
    expect((await rider.get("/driver/surge-map")).status).toBe(403);
    await owner.post("/admin/zones/Z001/surge/end", { expectedVersion: high.body.version });
  });
});
