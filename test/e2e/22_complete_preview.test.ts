import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookAndAccept, drive, fakeOsrm, PLACES, Sim, type Driver, type Json, type Rider } from "./harness.js";

/**
 * Contract v0.17.3 §26 (owner 2026-10-29, live bug A, "Server's final price (Recommended)"): the driver app asks
 * GET /driver/trips/{tripId}/complete-preview before Collect cash, and the amount it shows is the fare complete sets.
 * Owner decision 28: completing farther than 300 m from the drop-off is an early end (what was driven + minimum).
 */

let sim: Sim;
let osrm: Awaited<ReturnType<typeof fakeOsrm>>;
let rider: Rider;
let a: Driver;
let b: Driver;

beforeAll(async () => {
  osrm = await fakeOsrm({ distance: 8000, duration: 1080 });
  sim = await Sim.start({ osrmUrl: osrm.url });
  rider = await sim.rider(0);
  a = await sim.driver(1, PLACES.nearSergels);
  b = await sim.driver(2, null);
});
afterAll(async () => {
  await sim.stop();
  await osrm.close();
});
afterEach(async () => {
  const active = await rider.get("/rider/trips/active");
  if (active.status === 200) await rider.command(active.body.tripId, "cancel", { reasonCode: "plans_changed" });
  await sim.advance(5);
  await a.moveTo(PLACES.nearSergels);
});

/** A live cash ride with a middle stop, accepted by A (as test/e2e/17_pricing_v071.test.ts). */
async function bookWithStop(): Promise<string> {
  const trip = { pickup: PLACES.sergels, dropoff: PLACES.medborgar, stops: [{ address: "Odenplan", ...PLACES.odenplan }] };
  const quoted = await rider.quote({ ...trip, categoryIds: ["economy"] });
  const booked = await rider.post("/trips", { quoteId: quoted.body["quotes"][0].quoteId, categoryId: "economy", ...trip, kind: "live", paymentMethod: "cash" });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const tripId = booked.body["tripId"];
  await sim.tick();
  const offer = await a.offerFor(tripId);
  expect((await a.accept(offer!)).status).toBe(200);
  return tripId;
}

const preview = (driver: Driver, tripId: string) => driver.get(`/driver/trips/${tripId}/complete-preview`);
const sum = (lines: Json[]) => lines.reduce((total: number, l: Json) => total + l["amount"]["amountMinor"], 0);

describe("complete-preview (contract v0.17.3 §26)", () => {
  it("one fix at the pickup, 0 km, far from the drop-off: early end at the category minimum, and complete charges the same", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const booked = (await a.trip(tripId))["fare"];
    const before = await a.trip(tripId);

    const shown = await preview(a, tripId);
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect(shown.body.earlyEnd).toBe(true);
    expect(shown.body.fareLines.map((l: Json) => l["code"])).toContain("minimum_adjust");
    expect(shown.body.total.amountMinor).toBeLessThan(booked.amountMinor);
    // The live bug: economy minimum 49 kr + 10 % app fee = 54 kr (fixtures/fares.json end_early_minimum), not the booked fare.
    expect(shown.body.total).toEqual({ amountMinor: 5400, currency: "SEK" });
    expect(sum(shown.body.fareLines)).toBe(shown.body.total.amountMinor);
    expect(shown.body.cashDue).toEqual(shown.body.total);
    // Read-only: nothing on the trip moved.
    expect((await a.trip(tripId))["version"]).toBe(before["version"]);
    expect((await a.trip(tripId))["fare"]).toEqual(booked);

    const done = await a.command(tripId, "complete", { cashCollected: shown.body.cashDue });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.fare).toEqual(shown.body.total);
    expect(done.body.fareLines).toEqual(shown.body.fareLines);
    expect(done.body.driverEarnings).toEqual(shown.body.driverEarnings);
    expect((await rider.trip(tripId))["fare"]).toEqual(shown.body.total);
  });

  it("at the drop-off: the booked fare plus the waiting at a middle stop, equal to what complete sets", async () => {
    const tripId = await bookWithStop();
    // Waiting at the pickup past the free minutes, then at the middle stop.
    await drive(a, tripId, "arrived");
    await sim.advance(8 * 60);
    await drive(a, tripId, "in_trip");
    const booked = (await a.trip(tripId))["fare"];
    const at = async (verb: "arrive" | "leave") => a.post(`/driver/trips/${tripId}/stops/0/${verb}`, { expectedVersion: (await a.trip(tripId))["version"] });
    expect((await at("arrive")).status).toBe(200);
    await sim.advance(3 * 60);
    expect((await at("leave")).status).toBe(200);
    await sim.advance(10 * 60);
    await a.moveTo(PLACES.medborgar);

    const shown = await preview(a, tripId);
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect(shown.body.earlyEnd).toBe(false);
    expect(shown.body.total.amountMinor).toBeGreaterThan(booked.amountMinor);
    expect(shown.body.fareLines.map((l: Json) => l["code"])).toEqual(expect.arrayContaining(["waiting", "stop_waiting"]));

    const done = await a.command(tripId, "complete", { cashCollected: shown.body.cashDue });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.fare).toEqual(shown.body.total);
    expect(done.body.fareLines).toEqual(shown.body.fareLines);
    expect(done.body.driverEarnings).toEqual(shown.body.driverEarnings);
  });

  it("at the drop-off with nothing added: the booked fare", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "in_trip");
    const booked = (await a.trip(tripId))["fare"];
    await sim.advance(18 * 60);
    await a.moveTo(PLACES.medborgar);
    const shown = await preview(a, tripId);
    expect(shown.body).toMatchObject({ tripId, earlyEnd: false, total: booked, cashDue: booked });
    const done = await a.command(tripId, "complete", { cashCollected: shown.body.cashDue });
    expect(done.body.fare).toEqual(booked);
  });

  it("only the trip's driver, only on board", async () => {
    const { tripId } = await bookAndAccept(sim, rider, a);
    await drive(a, tripId, "arrived");
    const early = await preview(a, tripId);
    expect(early.status).toBe(409);
    expect(early.body.reason).toBe("trip_not_on_board");
    await drive(a, tripId, "in_trip");
    expect((await preview(b, tripId)).status).toBe(404);
    expect((await rider.get(`/driver/trips/${tripId}/complete-preview`)).status).toBe(403);
    await a.moveTo(PLACES.medborgar);
    expect((await a.command(tripId, "complete")).status).toBe(200);
    expect((await preview(a, tripId)).body.reason).toBe("trip_not_on_board");
  });
});
