import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../../src/contract/contract.js";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Admin, type Driver, type Json, type Rider } from "./harness.js";

type Case = { id: string; expect: { total: Json; fareLines: Json[]; driverEarnings: Json } };
const fares = JSON.parse(readFileSync(`${CONTRACTS_DIR}/fixtures/fares.json`, "utf8")) as { cases: Case[] };
const fixture = (id: string) => fares.cases.find((c) => c.id === id)!.expect;

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let owner: Admin;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  owner = await sim.owner();
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
afterEach(async () => {
  osrm.set({ distance: 8000, duration: 1080 });
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
});

/** `km` due north of Sergels torg (1° of latitude = 111.195 km on the contract's earth). */
const north = (km: number) => ({ lat: PLACES.sergels.lat + km / 111.19508, lng: PLACES.sergels.lng });

/** On board, the car drives 0.4 km in one minute (fixes every 30 s), as in fixtures/fares.json end_early_minimum. */
async function shortRide(): Promise<string> {
  const { tripId } = await bookAndAccept(sim, rider, a);
  await drive(a, tripId, "in_trip");
  await a.moveTo(PLACES.sergels);
  await sim.advance(30);
  await a.moveTo(north(0.2));
  await sim.advance(30);
  await a.moveTo(north(0.4));
  return tripId;
}

describe("scenario 7: end early, complete far from the drop-off, minimum fare (N9)", () => {
  it("the rider ends early after 0.4 km and 1 min: the minimum applies (minimum_adjust), as fixtures/fares.json end_early_minimum", async () => {
    const tripId = await shortRide();
    const expected = fixture("end_early_minimum");
    const res = await rider.command(tripId, "end-early", { reasonCode: "plans_changed" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "cancelled_by_rider", fare: expected.total });
    expect(res.body.fareLines).toEqual(expected.fareLines);
    const admin = await owner.trip(tripId);
    expect(admin.driverEarnings).toEqual(expected.driverEarnings);
    expect((await a.trip(tripId)).fare).toEqual(expected.total);
    // The ride can be rated after an early end.
    expect((await rider.post(`/trips/${tripId}/rating`, { stars: 4 })).status).toBeLessThan(300);
  });

  it("the driver completes 400 m from the pickup, far from the drop-off: paid what was driven, not the booked 217 kr", async () => {
    const tripId = await shortRide();
    const expected = fixture("end_early_minimum");
    const res = await a.command(tripId, "complete");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "completed", fare: expected.total, driverEarnings: expected.driverEarnings });
    expect((await rider.trip(tripId)).fare).toEqual(expected.total);
  });

  it("completing at the drop-off keeps the booked fare", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    await sim.advance(18 * 60);
    await a.moveTo(PLACES.medborgar);
    const res = await a.command(tripId, "complete");
    expect(res.body).toMatchObject({ status: "completed", fare: { amountMinor: 21700 } });
  });

  it("a short Priority ride (1 km, 2 min): raised to the category minimum, as fixtures/fares.json minimum_kicks_in, through to the final fare", async () => {
    osrm.set({ distance: 1000, duration: 120 });
    const expected = fixture("minimum_kicks_in");
    const dropoff = { address: "1 km north", ...north(1) };
    const { tripId, quote } = await bookAndAccept(sim, rider, a, { categoryId: "priority", dropoff });
    expect(quote.total).toEqual(expected.total);
    expect(quote.fareLines).toEqual(expected.fareLines);
    await drive(a, tripId, "in_trip");
    await sim.advance(120);
    await a.moveTo(dropoff);
    const done = await a.command(tripId, "complete");
    expect(done.body).toMatchObject({ status: "completed", fare: expected.total, driverEarnings: expected.driverEarnings });
  });
});
