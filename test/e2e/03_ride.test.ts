import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { fakeOsrm, PLACES, Sim, type Admin, type Driver, type Rider } from "./harness.js";

const fares = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/fares.json`, "utf8")) as { cases: Array<{ id: string; expect: { total: { amountMinor: number }; driverEarnings: { amountMinor: number }; moveraShare: { amountMinor: number } } }> };
const plain = fares.cases.find((c) => c.id === "economy_plain")!.expect;

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let near: Driver;
let far: Driver;
let owner: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  near = await sim.driver(1, PLACES.nearSergels);
  far = await sim.driver(2, PLACES.odenplan);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});

describe("scenario 3: request → offer → accept → arrive → start → complete", () => {
  it("the three apps follow one ride over the live streams; fare and earnings match fixtures/fares.json", async () => {
    const nearFeed = await near.offerFeed();
    const farFeed = await far.offerFeed();
    const { tripId, trip } = await rider.book();
    expect(trip).toMatchObject({ status: "searching", version: expect.any(Number), fare: plain.total });
    const riderEvents = await rider.events(tripId);
    const adminEvents = await owner.events(tripId);
    await sim.tick();

    // Exclusive first, to the best ranked (nearest) driver only.
    const offered = await nearFeed.waitFor((e) => e.data["offer"]?.["tripId"] === tripId);
    expect(offered.data).toMatchObject({ kind: "offer_created", offer: { tripId, status: "open" } });
    expect(farFeed.events.filter((e) => e.data["offer"]?.["tripId"] === tripId)).toEqual([]);
    const offer = offered.data["offer"];
    expect(offer.driverEarnings).toEqual(plain.driverEarnings);
    await riderEvents.reach("offered");

    const accepted = await near.accept(offer);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: "accepted", driverEarnings: plain.driverEarnings });
    const seen = await riderEvents.reach("accepted");
    // The rider sees the driver and the car; never the driver's money.
    expect(seen).toMatchObject({ tripId, driver: { driverId: near.id, vehicle: { plate: "TST 002" } } });
    expect(seen).not.toHaveProperty("driverEarnings");
    expect((await adminEvents.reach("accepted")).driverEarnings).toEqual(plain.driverEarnings);

    for (const [path, status] of [["head-to-pickup", "driver_to_pickup"], ["arrive", "arrived"], ["board", "rider_onboard"], ["start", "in_trip"]] as const) {
      if (path === "arrive") await near.moveTo(PLACES.sergels);
      const res = await near.command(tripId, path);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe(status);
      await riderEvents.reach(status);
    }
    await sim.advance(60);
    await near.moveTo(PLACES.medborgar);
    await sim.advance(17 * 60);
    await near.moveTo(PLACES.medborgar);
    const done = await near.command(tripId, "complete");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: "completed", fare: plain.total, driverEarnings: plain.driverEarnings });
    const final = await riderEvents.reach("completed");
    expect(final.fare).toEqual(plain.total);

    // Every app reads the same trip id, status, driver, car and money.
    const views = { rider: await rider.trip(tripId), driver: await near.trip(tripId), admin: await owner.trip(tripId) };
    for (const view of Object.values(views)) {
      expect(view).toMatchObject({ tripId, status: "completed", fare: plain.total, driver: { driverId: near.id, vehicle: { plate: "TST 002" } } });
      expect(view.version).toBe(views.rider.version);
    }
    expect(views.driver.driverEarnings).toEqual(plain.driverEarnings);
    expect(views.admin.driverEarnings).toEqual(plain.driverEarnings);

    // Movera's share = fare − driver earnings (fixture moveraShare); the driver's ledger has the trip.
    const entry = await sim.db.selectFrom("earnings_entries").selectAll().where("trip_id", "=", tripId).where("kind", "=", "trip").executeTakeFirstOrThrow();
    expect(Number(entry.amount_minor)).toBe(plain.driverEarnings.amountMinor);
    expect(Number(entry.gross_minor) - Number(entry.amount_minor)).toBe(plain.moveraShare.amountMinor);
    expect(Number(entry.cash_minor)).toBe(plain.total.amountMinor);
    // The driver's earnings report: gross, commission and net agree with the trip (pickup pay is Movera's, on top).
    const [day] = (await near.get("/driver/earnings?period=day")).body.periods;
    const pickupPay = views.driver.pickupPay?.amountMinor ?? 0;
    expect(day).toMatchObject({ tripCount: 1, gross: plain.total, commission: plain.moveraShare, cashCollected: plain.total, pickupPay: { amountMinor: pickupPay } });
    expect(day.net.amountMinor).toBe(plain.driverEarnings.amountMinor + pickupPay);

    // The stream sequence never goes back and every version is newer than the last.
    const versions = riderEvents.events.map((e) => e.data["version"] as number);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    const ids = riderEvents.events.map((e) => Number(e.id));
    expect(new Set(ids).size).toBe(ids.length);

    // Both rate; the driver is free again.
    expect((await rider.post(`/trips/${tripId}/rating`, { stars: 5 })).status).toBeLessThan(300);
    expect((await near.post(`/trips/${tripId}/rating`, { stars: 5 })).status).toBeLessThan(300);
    expect((await near.get("/driver/profile")).body.onlineStatus).toBe("online");
    expect((await rider.get("/rider/trips/active")).status).toBe(204);
  });
});
